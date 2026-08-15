/**
 * Pure parsing for MUFG Intime's allotment-status site, formerly Link Intime.
 *
 * Free of imports, network calls and prisma, for the same reason as
 * syncIpos.parse.ts and checkAllotments.parse.ts: it is the only part of the
 * MUFG path that can be tested without hitting their servers with a real PAN.
 *
 * WHAT THIS TALKS TO, because none of it is documented and all of it can change
 * without notice. https://in.mpms.mufg.com/Initial_Offer/public-issues.html is
 * a jQuery page driving three ASP.NET WebMethods on IPO.aspx. Each returns
 * `{"d": "<an XML string>"}` — JSON on the outside, a DataSet on the inside:
 *
 *   POST IPO.aspx/GetDetails      {}                    → the company dropdown
 *   POST IPO.aspx/generateToken   {}                    → a bare nonce
 *   POST IPO.aspx/SearchOnPan     {clientid, PAN, IFSC,
 *                                  CHKVAL, token}       → the allotment rows
 *
 * The field names below are not guesses: they are read from MUFG's own render
 * function (`onDataBindPAN` in that page), which is the only specification
 * there is.
 *
 * A regex walk rather than an XML library, matching the house style in
 * syncIpos.parse.ts. These documents are two elements deep and machine-written.
 */

/** One entry of MUFG's "Please select company" dropdown. */
export type MufgCompany = { clientId: string; name: string };

/**
 * MUFG's search modes, the `CHKVAL` field. We only ever send PAN: it is the one
 * identifier the server holds for every application, and the only one we have
 * without the user typing it (`demat_accounts.pan`).
 */
export const MUFG_MODE_PAN = '1';

/** The XML lives inside `{"d": "…"}`; both scrapes unwrap it the same way. */
export function mufgEnvelope(body: unknown): string | null {
  const d = (body as { d?: unknown } | null)?.d;
  return typeof d === 'string' && d.trim() !== '' ? d : null;
}

function blocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function field(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : null;
}

/** The five entities a .NET DataSet actually emits. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function toNumberOrNull(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * MUFG suffixes every dropdown entry with its issue type — "Leap India Limited
 * - IPO", "Poojaa Precision Engg. Limited - SME IPO". Left in place, the tokens
 * "sme" and "ipo" would score against every candidate at once, so they come off
 * before the name is ever matched. (`nameTokens` already drops a bare "ipo"
 * word, but not the SME that precedes it, and stripping here keeps the stored
 * list honest about what the company is called.)
 */
function stripIssueSuffix(name: string): string {
  return name.replace(/\s*[-–]\s*(?:SME\s+)?(?:IPO|FPO|NCD|RIGHTS?)\s*$/i, '').trim();
}

/** GetDetails → the dropdown, or an empty list when MUFG has no live issue. */
export function parseMufgCompanies(xml: string): MufgCompany[] {
  const out: MufgCompany[] = [];
  for (const block of blocks(xml, 'Table')) {
    const clientId = field(block, 'company_id');
    const name = field(block, 'companyname');
    if (!clientId || !name) continue;
    const stripped = stripIssueSuffix(name);
    if (!stripped) continue;
    out.push({ clientId, name: stripped });
  }
  return out;
}

/**
 * SearchOnPan's `Table1/Msg`, MUFG's own complaint about the request.
 *
 * Worth surfacing rather than swallowing: "no records" and "Invalid Token" are
 * the same shape to us but mean opposite things — the first is an issue whose
 * allotment is not out, the second is this job being broken. Reported in the
 * sweep's sync_log message so a scraper that has stopped working cannot look
 * like a market with no results.
 */
export function mufgMessage(xml: string): string | null {
  for (const block of blocks(xml, 'Table1')) {
    const msg = field(block, 'Msg');
    if (msg) return msg;
  }
  return null;
}

/**
 * SearchOnPan → the applications on file, or null when there are none yet.
 *
 * Null rather than an empty array, matching `parseKfintechAllotmentBody`: the
 * caller treats it as "not released yet", stamps `allotment_checked_at` and
 * leaves the application APPLIED. A `Table1/Msg` is the same answer — MUFG puts
 * its "no records found" there, and their page shows that instead of a table.
 */
export function parseMufgAllotment(xml: string): AllotmentMatch[] | null {
  if (mufgMessage(xml)) return null;

  const rows = blocks(xml, 'Table');
  if (rows.length === 0) return null;

  const matches = rows.map((block) => ({
    // PEMNDG is the application number — their page renders it as the
    // "Application Details - …" heading.
    applicationNo: field(block, 'PEMNDG'),
    // MUFG's PAN search returns no DP/client id; that is a separate search mode.
    dpClientId: null,
    applicantName: field(block, 'NAME1'),
    sharesApplied: toNumberOrNull(field(block, 'SHARES')),
    sharesAllotted: toNumberOrNull(field(block, 'ALLOT')) ?? 0,
  }));

  // A row carrying none of the three facts we came for is a shape change, not
  // an application. Treating it as "not allotted" would silently mark a real
  // application NOT_ALLOTTED, so drop it and let the caller say "not yet".
  const usable = matches.filter(
    (m) => m.applicationNo !== null || m.applicantName !== null || m.sharesApplied !== null,
  );
  return usable.length === 0 ? null : usable;
}

/**
 * Structurally identical to checkAllotments.parse.ts's AllotmentMatch, declared
 * here rather than imported to keep this module import-free — the same reason
 * that file gives for copying pickMatch/statusFor out of lib/db/allotment.ts.
 * The two are asserted compatible where they meet, in checkAllotments.ts.
 */
export type AllotmentMatch = {
  applicationNo: string | null;
  dpClientId: string | null;
  applicantName: string | null;
  sharesApplied: number | null;
  sharesAllotted: number;
};
