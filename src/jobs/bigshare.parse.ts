/**
 * Pure parsing for Bigshare Services' allotment-status site.
 *
 * Free of imports, network calls and prisma, the same split mufg.parse.ts and
 * checkAllotments.parse.ts take: it is the only part of the Bigshare path that
 * can be tested without hitting their servers with a real PAN.
 *
 * WHAT THIS TALKS TO, because none of it is documented and all of it can change
 * without notice. https://ipo.bigshareonline.com/ipo_status.html is a jQuery
 * page over a single ASP.NET WebMethod:
 *
 *   POST Data.aspx/FetchIpodetails  {Applicationno, Company, SelectionType,
 *                                    PanNo, txtcsdl, txtDPID, txtClId,
 *                                    ddlType, lang}  → one applicant, or none
 *
 * Simpler than MUFG in two ways, both verified against the live site on
 * 2026-08-15. There is no token round trip. And the captcha their form renders
 * never reaches the server: `generateCaptcha()` draws it in the browser, stashes
 * the answer in `sessionStorage`, and the submit handler compares the two
 * client-side before sending. The request we send is the request their page
 * sends once that check has passed.
 *
 * The company list is the harder half and lives in the same page — see
 * `parseBigshareCompanies`.
 */

/**
 * Bigshare's search modes, the `SelectionType` field. We only ever send PAN: it
 * is the one identifier the registrar holds for every application, and the only
 * one we have without the user typing it (`demat_accounts.pan`).
 */
export const BIGSHARE_MODE_PAN = 'PN';

/** Their "nothing on file", delivered in the DPID field rather than as a status. */
const NO_DATA = 'no data found';

/**
 * One entry of Bigshare's "--Select Company--" dropdown.
 *
 * `archived` is the wrinkle no other registrar has: Bigshare does not remove a
 * finished issue from the list, it wraps it in an HTML comment. See
 * `parseBigshareCompanies`.
 */
export type BigshareCompany = { clientId: string; name: string; archived: boolean };

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Tolerant number coercion, and the reason this file exists as its own module.
 *
 * `ALLOTED` is not a number. A non-allotted applicant comes back as the string
 * "NON-ALLOTTE" — truncated, presumably by a column width somewhere upstream —
 * so `Number()` yields NaN, and a NaN reaching `statusFor` fails every `<= 0`
 * test and reports a rejected application as ALLOTTED. Anything that is not a
 * number is not a share count.
 */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/,/g, '').trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

const OPTION_RE = /<option\s[^>]*\bvalue\s*=\s*"(\d+)"[^>]*>([\s\S]*?)<\/option>/gi;

function optionsIn(html: string, archived: boolean): BigshareCompany[] {
  const out: BigshareCompany[] = [];
  let m: RegExpExecArray | null;
  OPTION_RE.lastIndex = 0;
  while ((m = OPTION_RE.exec(html))) {
    const name = decodeEntities(m[2]).replace(/\s+/g, ' ').trim();
    if (!name) continue;
    out.push({ clientId: m[1], name, archived });
  }
  return out;
}

/**
 * The company dropdown, scraped out of the status page's own HTML.
 *
 * There is no list endpoint — unlike KFintech's JS bundle and MUFG's GetDetails
 * WebMethod, this `<select>` is hand-maintained markup served with the page.
 *
 * And Bigshare does not delete a finished issue from it, they comment it out:
 * on 2026-08-15 the list held 90 issues of which 89 sat inside `<!-- -->` blocks
 * and exactly one — TECHNOCRAFT VENTURES, then open — did not. So the commented
 * entries are read too. Their ids still answer FetchIpodetails (confirmed
 * against 9042 and 586), and parsing only the live one would mean an issue
 * becomes permanently uncheckable the moment Bigshare archives it — which for a
 * user who missed the 21:00–24:00 sweep window is the same dead button this
 * whole path exists to avoid.
 *
 * `archived` is carried rather than discarded so the caller can prefer a live
 * entry when the same company appears twice.
 */
export function parseBigshareCompanies(html: string): BigshareCompany[] {
  const select = html.match(
    /<select\s[^>]*\bid\s*=\s*"ddlCompany"[^>]*>([\s\S]*?)<\/select>/i,
  );
  if (!select) return [];
  const block = select[1];

  // Live entries are what is left once the commented regions are cut out, so
  // the two passes cannot double-count. `<option>--Select Company--</option>`
  // carries no value attribute and is skipped by OPTION_RE either way.
  const archived: BigshareCompany[] = [];
  const live = block.replace(/<!--([\s\S]*?)-->/g, (_all, inner: string) => {
    archived.push(...optionsIn(inner, true));
    return ' ';
  });

  // Live first: `matchCompanyByName` returns the first exact name match it sees
  // and only falls back to scoring after that, so ordering is what makes a live
  // entry win over an archived one of the same name.
  return [...optionsIn(live, false), ...archived];
}

/**
 * Structurally identical to checkAllotments.parse.ts's AllotmentMatch, declared
 * here rather than imported for the same reason mufg.parse.ts declares its own:
 * this module stays import-free. The two are asserted compatible where they
 * meet, in checkAllotments.ts.
 */
export type AllotmentMatch = {
  applicationNo: string | null;
  dpClientId: string | null;
  applicantName: string | null;
  sharesApplied: number | null;
  sharesAllotted: number;
};

type FetchIpodetailsRow = {
  APPLICATION_NO?: unknown;
  DPID?: unknown;
  Name?: unknown;
  APPLIED?: unknown;
  ALLOTED?: unknown;
};

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const out = decodeEntities(String(value)).trim();
  return out === '' ? null : out;
}

/**
 * FetchIpodetails → the application on file, or null when there is none yet.
 *
 * Bigshare answers with a single object rather than a list — one PAN holds one
 * application per issue — but it is wrapped in an array so `pickMatch` and
 * `statusFor` stay registrar-neutral and need no Bigshare branch.
 *
 * Null rather than an empty array, matching `parseKfintechAllotmentBody` and
 * `parseMufgAllotment`: the caller treats it as "not released yet", stamps
 * `allotment_checked_at` and leaves the application APPLIED. Their "nothing on
 * file" arrives as `DPID: "No data found"` with every other field blank and an
 * HTTP 200, so the status code cannot be used to tell the two apart.
 */
export function parseBigshareAllotment(body: unknown): AllotmentMatch[] | null {
  const row = (body as { d?: unknown } | null)?.d as FetchIpodetailsRow | null | undefined;
  if (!row || typeof row !== 'object') return null;

  const dpClientId = text(row.DPID);
  if (dpClientId !== null && dpClientId.toLowerCase() === NO_DATA) return null;

  const match: AllotmentMatch = {
    applicationNo: text(row.APPLICATION_NO),
    dpClientId,
    applicantName: text(row.Name),
    sharesApplied: toNumberOrNull(row.APPLIED),
    // "NON-ALLOTTE" and every other non-number mean nothing was allotted.
    sharesAllotted: toNumberOrNull(row.ALLOTED) ?? 0,
  };

  // A row carrying none of the three facts we came for is a shape change or an
  // empty envelope, not an application — same guard, and same reasoning, as
  // parseMufgAllotment's. Reporting it would mark a real application
  // NOT_ALLOTTED on the strength of nothing.
  const usable =
    match.applicationNo !== null || match.applicantName !== null || match.sharesApplied !== null;
  return usable ? [match] : null;
}
