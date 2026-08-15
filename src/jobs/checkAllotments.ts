/**
 * check-allotments — checks KFintech allotment status and writes the result
 * straight into ipo_applications. Two entry points, both driven from
 * routes/jobs.ts and routes/allotments.ts:
 *
 *  - `sweepAllotments()`: every application still waiting on a result, gated by
 *    whether its IPO's allotment_date is due yet. This is the scheduled sweep,
 *    run every 15 minutes by the external scheduler.
 *  - `checkApplications(ids)`: the app's "Check status" button. Identical
 *    check/persist logic against exactly the ids named, skipping the due-date
 *    gate — an explicit user tap is its own justification, unlike the sweep,
 *    which needs the gate to avoid hammering KFintech before results are
 *    plausibly out.
 *
 * This only exists because PAN is a plain column — a deliberate,
 * explicitly-confirmed exception to this project's usual "no plaintext
 * credential column" rule, made specifically so this job could read a PAN
 * without a user's device being involved at all. Every other secret on
 * demat_accounts stays encrypted; this is the one place that trade-off was made
 * on purpose.
 *
 * Ownership on the on-demand path used to need a second Supabase client built
 * from the caller's JWT, because the service-role client bypassed RLS. Here the
 * caller's id comes from the access token and the query filters on it directly,
 * so that whole dance collapses into a `where` clause — see routes/allotments.ts.
 *
 * A WORD OF WARNING, same as syncIpos: the KFintech endpoint below is
 * undocumented, reverse-engineered from their own frontend bundle. It can change
 * shape without notice. This job is written to degrade rather than break: one
 * application's failure never stops the batch. Only the scheduled sweep is
 * recorded in sync_log — logging every on-demand tap under the same provider tag
 * would make a genuinely broken schedule look healthy on the app's staleness
 * banner (see lib/db/ipos.ts).
 */
import { prisma } from '../db.js';
import {
  type AllotmentOutcome,
  isAllotmentCheckDue,
  parseKfintechAllotmentBody,
  pickMatch,
  statusFor,
} from './checkAllotments.parse.js';
import { resolveKfintechCompanyId } from './kfintechCompanies.js';
import { sendAllotmentPushes } from './push.js';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

const KFINTECH_QUERY_URL =
  'https://0uz601ms56.execute-api.ap-south-1.amazonaws.com/prod/api/query?type=pan';

/** A candidate that has passed the null/due checks — every field we need is present. */
export type DueRow = {
  id: string;
  userId: string;
  companyName: string;
  sharesApplied: number;
  applicationNo: string | null;
  companyId: string;
  pan: string;
};

export type CheckResult = {
  row: DueRow;
  outcome: 'resolved' | 'not-yet' | 'error';
  status?: AllotmentOutcome;
  sharesAllotted?: number;
  message?: string;
};

/** Everything the check needs, joined in one query. */
const candidateSelect = {
  id: true,
  userId: true,
  sharesApplied: true,
  applicationNo: true,
  ipo: {
    select: { id: true, companyName: true, kfintechCompanyId: true, allotmentDate: true },
  },
  dematAccount: { select: { pan: true } },
} as const;

type Candidate = {
  id: string;
  userId: string;
  sharesApplied: number;
  applicationNo: string | null;
  ipo: {
    id: string;
    companyName: string;
    kfintechCompanyId: string | null;
    allotmentDate: Date | null;
  };
  dematAccount: { pan: string | null };
};

/**
 * The IPO's KFintech company id, resolving it against KFintech's own dropdown
 * if it has none yet.
 *
 * The scheduled match pass only runs once ever (see syncIpos.ts), so without
 * this an IPO added afterwards — or one whose name is spelled differently
 * enough that the old exact match missed it, "Milky Mist" against "MILKY MIST
 * DAIRY FOOD LIMITED" — would never acquire an id, and its "Check status"
 * button would report "allotment not released yet" forever regardless of what
 * KFintech actually had.
 *
 * Several applications in one batch routinely share an IPO; the company list is
 * cached in kfintechCompanies.ts so that costs one fetch, not one per row.
 */
async function companyIdFor(ipo: Candidate['ipo']): Promise<string | null> {
  if (ipo.kfintechCompanyId) return ipo.kfintechCompanyId;
  return resolveKfintechCompanyId(ipo.id, ipo.companyName);
}

/**
 * Stamp allotment_checked_at without touching status/shares_allotted.
 *
 * Every path that constitutes an attempt stamps this — resolved, "not yet",
 * outright error, and the no-match/no-pan rejections alike. Only the resolved
 * path knows anything definitive, but "Last checked" answers "when did we last
 * try", not "when did we last succeed": leaving the failure paths unstamped made
 * a check that ran on every sweep and failed every time look like it had never
 * run at all.
 */
async function touchCheckedAt(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.ipoApplication.updateMany({
    where: { id: { in: ids } },
    data: { allotmentCheckedAt: new Date() },
  });
}

async function checkOne(row: DueRow): Promise<CheckResult> {
  try {
    const res = await fetch(KFINTECH_QUERY_URL, {
      headers: { ...BROWSER_HEADERS, reqparam: row.pan, client_id: row.companyId },
    });

    if (res.status === 404) {
      await touchCheckedAt([row.id]);
      return { row, outcome: 'not-yet' };
    }
    if (res.status === 429) throw new Error('KFintech is rate-limiting allotment checks');
    if (!res.ok) throw new Error(`KFintech allotment check responded ${res.status}`);

    const body = await res.json().catch(() => null);
    const matches = parseKfintechAllotmentBody(body);
    if (!matches) {
      await touchCheckedAt([row.id]);
      return { row, outcome: 'not-yet' };
    }

    const match = pickMatch(matches, row.applicationNo);
    const status: AllotmentOutcome = statusFor(match, row.sharesApplied);

    await prisma.ipoApplication.update({
      where: { id: row.id },
      data: {
        status,
        sharesAllotted: match.sharesAllotted,
        allotmentCheckedAt: new Date(),
      },
    });

    return { row, outcome: 'resolved', status, sharesAllotted: match.sharesAllotted };
  } catch (e) {
    // The attempt happened even though it blew up, so stamp it — but never let a
    // failure to stamp replace the error we're actually reporting.
    await touchCheckedAt([row.id]).catch(() => {});
    return { row, outcome: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** `date` columns carry no time; the gate compares on the YYYY-MM-DD string. */
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

function toDueRow(c: Candidate, companyId: string, pan: string): DueRow {
  return {
    id: c.id,
    userId: c.userId,
    companyName: c.ipo.companyName || 'your IPO',
    sharesApplied: c.sharesApplied,
    applicationNo: c.applicationNo,
    companyId,
    pan,
  };
}

// ---------------------------------------------------------------------------
// scheduled sweep
// ---------------------------------------------------------------------------

export type SweepSummary = { ok: boolean; checked: number; resolved: number; errors: string[] };

export async function sweepAllotments(): Promise<SweepSummary> {
  let ok = true;
  let checked = 0;
  let resolved = 0;
  const errors: string[] = [];

  try {
    const nowIso = new Date().toISOString();
    const candidates = (await prisma.ipoApplication.findMany({
      where: { status: 'APPLIED' },
      select: candidateSelect,
    })) as Candidate[];

    const due: DueRow[] = [];
    for (const c of candidates) {
      const allotmentDate = c.ipo.allotmentDate;
      const pan = c.dematAccount.pan;
      if (!allotmentDate || !pan) continue;
      // The due-date gate is checked before the company id is resolved, not
      // after: resolving can reach out to KFintech, and a sweep runs every 15
      // minutes over every outstanding application. Gating first keeps that
      // lookup to the rows actually about to be checked.
      if (!isAllotmentCheckDue(isoDay(allotmentDate), nowIso)) continue;
      const companyId = await companyIdFor(c.ipo);
      if (!companyId) continue;
      due.push(toDueRow(c, companyId, pan));
    }

    const results = await Promise.all(due.map(checkOne));
    checked = results.length;
    for (const result of results) {
      if (result.outcome === 'resolved') resolved += 1;
      else if (result.outcome === 'error' && result.message) errors.push(result.message);
    }

    await sendAllotmentPushes(results);
  } catch (e) {
    ok = false;
    errors.push(e instanceof Error ? e.message : String(e));
  }

  await prisma.syncLog.create({
    data: {
      provider: 'KFINTECH_ALLOTMENT_CHECK',
      ok,
      rowsUpserted: resolved,
      message:
        errors.length > 0
          ? `${checked} checked, ${resolved} resolved, ${errors.length} failed: ${errors.slice(0, 3).join('; ')}`
          : `${checked} checked, ${resolved} resolved`,
    },
  });

  return { ok, checked, resolved, errors };
}

// ---------------------------------------------------------------------------
// on-demand — the app's "Check status" button
// ---------------------------------------------------------------------------

export type OnDemandResult = {
  id: string;
  outcome: 'resolved' | 'not-yet' | 'no-match' | 'no-pan' | 'error';
  status?: AllotmentOutcome;
  shares_allotted?: number;
  shares_applied?: number;
  message?: string;
};

/**
 * Checks exactly the applications named, for one user.
 *
 * Scoping the query to `userId` is what stops someone reading another user's
 * allotment result by guessing an application id. A foreign or stale id simply
 * does not come back from the query and is silently dropped, rather than
 * erroring — erroring would leak whether it exists.
 */
export async function checkApplications(
  userId: string,
  ids: string[],
): Promise<OnDemandResult[]> {
  if (ids.length === 0) return [];

  const candidates = (await prisma.ipoApplication.findMany({
    where: { id: { in: ids }, userId },
    select: candidateSelect,
  })) as Candidate[];

  const results: OnDemandResult[] = [];
  const checkable: DueRow[] = [];
  /** Rejected before KFintech was ever asked — still attempts, so still stamped. */
  const rejected: string[] = [];

  for (const c of candidates) {
    const pan = c.dematAccount.pan;
    const companyId = await companyIdFor(c.ipo);

    if (!companyId) {
      rejected.push(c.id);
      results.push({ id: c.id, outcome: 'no-match', message: 'allotment not released yet' });
      continue;
    }
    if (!pan) {
      rejected.push(c.id);
      results.push({
        id: c.id,
        outcome: 'no-pan',
        message: 'The linked demat account has no PAN saved — add it before checking allotment.',
      });
      continue;
    }
    checkable.push(toDueRow(c, companyId, pan));
  }

  await touchCheckedAt(rejected);

  const checked = await Promise.all(checkable.map(checkOne));
  for (const c of checked) {
    results.push({
      id: c.row.id,
      outcome: c.outcome,
      status: c.status,
      shares_allotted: c.sharesAllotted,
      shares_applied: c.row.sharesApplied,
      message: c.message,
    });
  }

  await sendAllotmentPushes(checked);

  return results;
}
