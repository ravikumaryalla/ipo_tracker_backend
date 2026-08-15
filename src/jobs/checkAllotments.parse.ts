/**
 * Pure parsing and decision logic for check-allotments.
 *
 * Deliberately free of imports, `Deno.*`, and network calls — same reason as
 * supabase/functions/sync-ipos/parse.ts: it's the only part of this function
 * that can run under Node, so it's the only part that gets tested.
 *
 * `pickMatch` and `statusFor` are ports of the same-named functions in
 * lib/db/allotment.ts — same decision rules, copied rather than imported
 * because this file must stay inside supabase/functions/check-allotments/
 * (the Supabase CLI's bundler roots at supabase/, and parent-directory
 * imports are not reliably included in the deployed eszip — the exact
 * constraint sync-ipos/parse.ts already documents).
 */

/** India is UTC+5:30 and never observes DST, so a fixed offset is correct. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Three hours: 21:00 IST until midnight. */
const CHECK_WINDOW_MS = 3 * 60 * 60 * 1000;

/**
 * Whether it's time to check this IPO's allotment yet.
 *
 * Basis of Allotment typically finalises in the evening, so the sweep runs
 * for exactly one window: 21:00 IST on `allotmentDate` until midnight that
 * same night. The 15-minute cadence inside it comes from the cron
 * re-invoking this function, not from anything tracked here.
 *
 * The window deliberately closes at midnight rather than staying open until
 * a result appears. An allotment published the next morning — or a slipped
 * allotment_date — is therefore never picked up automatically; the app's
 * "Check status" button skips this gate entirely and is the fallback for
 * that case.
 */
export function isAllotmentCheckDue(allotmentDate: string, nowIso: string): boolean {
  const m = allotmentDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return false;

  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return false;

  const opensMs =
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 21, 0, 0) - IST_OFFSET_MS;
  return now.getTime() >= opensMs && now.getTime() < opensMs + CHECK_WINDOW_MS;
}

/** One application KFintech has on file against the queried PAN. */
export type KfintechAllotmentMatch = {
  applicationNo: string | null;
  dpClientId: string | null;
  applicantName: string | null;
  sharesApplied: number | null;
  sharesAllotted: number;
};

type QueryRow = {
  Appln_No?: unknown;
  DP_CLID?: unknown;
  Name?: unknown;
  App_Shares?: unknown;
  All_Shares?: unknown;
};

function toNumberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toMatch(raw: QueryRow): KfintechAllotmentMatch {
  return {
    applicationNo: raw.Appln_No != null ? String(raw.Appln_No) : null,
    dpClientId: raw.DP_CLID != null ? String(raw.DP_CLID) : null,
    applicantName: raw.Name != null ? String(raw.Name) : null,
    sharesApplied: toNumberOrNull(raw.App_Shares),
    sharesAllotted: toNumberOrNull(raw.All_Shares) ?? 0,
  };
}

/**
 * KFintech's query-endpoint JSON body → matches, or null when there's
 * nothing on file yet for this PAN/issue (not an error — just not out yet).
 */
export function parseKfintechAllotmentBody(body: unknown): KfintechAllotmentMatch[] | null {
  const rows: unknown[] = Array.isArray((body as { data?: unknown })?.data)
    ? (body as { data: unknown[] }).data
    : [];
  if (rows.length === 0) return null;
  return rows.map((row) => toMatch(row as QueryRow));
}

/**
 * Two applications on the same PAN (e.g. retail + shareholder category) come
 * back as two rows from KFintech. Application No. is the only thing that
 * tells them apart — with one candidate there's nothing to disambiguate, and
 * with several we refuse rather than silently attach the wrong one's shares.
 */
export function pickMatch(
  matches: KfintechAllotmentMatch[],
  applicationNo: string | null,
): KfintechAllotmentMatch {
  if (matches.length === 1) return matches[0];
  if (applicationNo) {
    const exact = matches.find((m) => m.applicationNo === applicationNo);
    if (exact) return exact;
  }
  throw new Error(
    'KFintech has more than one application on file for this PAN and issue, and this application ' +
      'has no application number saved to tell them apart.',
  );
}

export type AllotmentOutcome = 'ALLOTTED' | 'PARTIAL' | 'NOT_ALLOTTED';

export function statusFor(match: KfintechAllotmentMatch, fallbackApplied: number): AllotmentOutcome {
  if (match.sharesAllotted <= 0) return 'NOT_ALLOTTED';
  const applied = match.sharesApplied ?? fallbackApplied;
  return match.sharesAllotted < applied ? 'PARTIAL' : 'ALLOTTED';
}
