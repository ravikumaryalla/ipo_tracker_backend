/**
 * check-allotments — checks a registrar's allotment status and writes the
 * result straight into ipo_applications. Two entry points, both driven from
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
 * TWO REGISTRARS. KFintech and MUFG Intime (ex-Link Intime) between them
 * register almost every issue in the book, and each answers only for its own.
 * Sending everything to KFintech — which is what this did until 2026-08-15 —
 * meant a MUFG issue answered 404 forever and its applications reported
 * "allotment not released yet" for good. `registrarFor` routes on the `ipos`
 * row's own registrar column, which the ipogyani feed already fills in.
 *
 * The fallback is deliberate: an unrecognised or missing registrar goes to
 * KFintech rather than nowhere. Registrar strings come from a scraped feed and
 * a wrong one should cost a wasted request, not a permanently dead button.
 *
 * A WORD OF WARNING, same as syncIpos: both endpoints below are undocumented,
 * reverse-engineered from the registrars' own frontends. They can change shape
 * without notice. This job is written to degrade rather than break: one
 * application's failure never stops the batch. Only the scheduled sweep is
 * recorded in sync_log — logging every on-demand tap under the same provider tag
 * would make a genuinely broken schedule look healthy on the app's staleness
 * banner (see lib/db/ipos.ts).
 */
import { prisma } from '../db.js';
import { jobLog } from '../util/jobLog.js';
import {
  type AllotmentMatch,
  type AllotmentOutcome,
  isAllotmentCheckDue,
  parseKfintechAllotmentBody,
  pickMatch,
  statusFor,
} from './checkAllotments.parse.js';
import { resolveKfintechCompanyId } from './kfintechCompanies.js';
import { mufgMessage, parseMufgAllotment } from './mufg.parse.js';
import { MUFG_REGISTRAR, resolveMufgCompanyId, searchMufgByPan } from './mufgCompanies.js';
import { sendAllotmentPushes } from './push.js';
import { normalizeName } from './syncIpos.parse.js';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

const KFINTECH_QUERY_URL =
  'https://0uz601ms56.execute-api.ap-south-1.amazonaws.com/prod/api/query?type=pan';

/** Who we ask. One per issue; `registrarFor` decides from the `ipos` row. */
export type Registrar = 'KFINTECH' | 'MUFG';

/** A candidate that has passed the null/due checks — every field we need is present. */
export type DueRow = {
  id: string;
  userId: string;
  companyName: string;
  sharesApplied: number;
  applicationNo: string | null;
  registrar: Registrar;
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
    select: {
      id: true,
      companyName: true,
      registrar: true,
      kfintechCompanyId: true,
      mufgCompanyId: true,
      allotmentDate: true,
    },
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
    registrar: string | null;
    kfintechCompanyId: string | null;
    mufgCompanyId: string | null;
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
/**
 * Which registrar answers for this issue.
 *
 * Matched on the normalized name so every spelling the feeds publish lands in
 * one place — "MUFG Intime", "MUFG Intime India Pvt. Ltd.", and the retired
 * "Link Intime India Private Limited" are all the same company, and
 * `normalizeName` already strips the punctuation and the legal suffixes that
 * separate them (see ipogyani.ts's REGISTRARS table, which does the same).
 *
 * Anything else — including null — falls through to KFintech. That is the
 * fallback the file header describes: a registrar string is scraped data, and a
 * wrong one should cost one wasted request rather than a dead button.
 */
export function registrarFor(registrar: string | null): Registrar {
  const key = normalizeName(registrar ?? '');
  return key.startsWith('mufg') || key.startsWith('linkintime') ? 'MUFG' : 'KFINTECH';
}

/**
 * Whether the registrar column is actually telling us something.
 *
 * `ipos.registrar` defaults to the string 'KFintech' at the column level, so a
 * row nobody has ever assigned a registrar to is indistinguishable by name from
 * one KFintech genuinely registers — as of this writing 55 of 61 rows carry
 * that default, and two of them (Lohia Corp, Indo-MIM) are sitting in MUFG's
 * dropdown right now. A bare 'KFintech' with no resolved company id is
 * therefore treated as "unknown", not as evidence.
 */
function registrarIsEvidence(ipo: Candidate['ipo']): boolean {
  if (ipo.kfintechCompanyId || ipo.mufgCompanyId) return true;
  return (
    registrarFor(ipo.registrar) === 'MUFG' || normalizeName(ipo.registrar ?? '') !== 'kfintech'
  );
}

/**
 * The registrar to ask and the company id to ask about, resolving the id
 * against that registrar's own dropdown if the issue has none yet.
 *
 * Order of confidence:
 *   1. An id we already resolved — nothing beats having asked before.
 *   2. MUFG's dropdown, when the label says MUFG or says nothing usable. Their
 *      list holds only issues currently open for checking, so a hit is strong
 *      evidence on both counts: they register it, and the result is out.
 *   3. KFintech, which is both the genuine answer for most issues and the
 *      fallback for a registrar string that turned out to be wrong.
 */
async function companyIdFor(
  ipo: Candidate['ipo'],
): Promise<{ registrar: Registrar; companyId: string } | null> {
  if (ipo.mufgCompanyId) return { registrar: 'MUFG', companyId: ipo.mufgCompanyId };
  if (ipo.kfintechCompanyId) return { registrar: 'KFINTECH', companyId: ipo.kfintechCompanyId };

  if (registrarFor(ipo.registrar) === 'MUFG' || !registrarIsEvidence(ipo)) {
    const mufgId = await resolveMufgCompanyId(ipo.id, ipo.companyName);
    if (mufgId) return { registrar: 'MUFG', companyId: mufgId };
  }

  const kfinId = await resolveKfintechCompanyId(ipo.id, ipo.companyName);
  return kfinId ? { registrar: 'KFINTECH', companyId: kfinId } : null;
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

/**
 * Ask KFintech. Returns null for "nothing on file yet", which their endpoint
 * says two ways — a 404, or a 200 carrying no rows.
 */
async function askKfintech(row: DueRow): Promise<AllotmentMatch[] | null> {
  const res = await fetch(KFINTECH_QUERY_URL, {
    headers: { ...BROWSER_HEADERS, reqparam: row.pan, client_id: row.companyId },
  });

  if (res.status === 404) return null;
  if (res.status === 429) throw new Error('KFintech is rate-limiting allotment checks');
  if (!res.ok) throw new Error(`KFintech allotment check responded ${res.status}`);

  return parseKfintechAllotmentBody(await res.json().catch(() => null));
}

/**
 * Ask MUFG Intime. Their "no records" arrives as a Table1/Msg rather than a
 * status code, and the same channel carries their complaints about the request
 * itself — so a message that does not read like "no records" is raised as an
 * error instead of being reported as a market with no result. That is what
 * makes a re-enabled captcha, or a changed token scheme, visible in sync_log
 * rather than indistinguishable from "not out yet".
 */
async function askMufg(row: DueRow): Promise<AllotmentMatch[] | null> {
  const xml = await searchMufgByPan(row.companyId, row.pan);

  const message = mufgMessage(xml);
  if (message && !/no\s+record|not\s+(yet\s+)?(available|released|allotted)/i.test(message)) {
    throw new Error(`MUFG Intime refused the query: ${message}`);
  }

  return parseMufgAllotment(xml);
}

async function checkOne(row: DueRow): Promise<CheckResult> {
  try {
    const matches = row.registrar === 'MUFG' ? await askMufg(row) : await askKfintech(row);
    if (!matches) {
      await touchCheckedAt([row.id]);
      return { row, outcome: 'not-yet' };
    }

    const match = pickMatch(matches, row.applicationNo, registrarLabel(row.registrar));
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

/** How a registrar is named in text a user reads. */
const registrarLabel = (registrar: Registrar): string =>
  registrar === 'MUFG' ? MUFG_REGISTRAR : 'KFintech';

function toDueRow(
  c: Candidate,
  resolved: { registrar: Registrar; companyId: string },
  pan: string,
): DueRow {
  return {
    id: c.id,
    userId: c.userId,
    companyName: c.ipo.companyName || 'your IPO',
    sharesApplied: c.sharesApplied,
    applicationNo: c.applicationNo,
    registrar: resolved.registrar,
    companyId: resolved.companyId,
    pan,
  };
}

/**
 * Run a batch, respecting what each registrar can take.
 *
 * KFintech keeps the unbounded fan-out it has always had — it is an API gateway
 * fronting a real API and has never objected. MUFG goes one at a time: it is a
 * single ASP.NET page, each search costs two round trips because the nonce is
 * single-use, and a burst from one IP is exactly the shape a rate limiter
 * exists to stop. The two groups still run concurrently with each other, so a
 * slow MUFG queue never delays a KFintech result.
 */
async function checkAll(rows: DueRow[]): Promise<CheckResult[]> {
  const mufg = rows.filter((r) => r.registrar === 'MUFG');
  const kfintech = rows.filter((r) => r.registrar !== 'MUFG');

  const [kfinResults, mufgResults] = await Promise.all([
    Promise.all(kfintech.map(checkOne)),
    (async () => {
      const out: CheckResult[] = [];
      for (const row of mufg) out.push(await checkOne(row));
      return out;
    })(),
  ]);

  return [...kfinResults, ...mufgResults];
}

// ---------------------------------------------------------------------------
// scheduled sweep
// ---------------------------------------------------------------------------

export type SweepSummary = { ok: boolean; checked: number; resolved: number; errors: string[] };

export async function sweepAllotments(): Promise<SweepSummary> {
  const log = jobLog('check-allotments');
  log.start();

  let ok = true;
  let checked = 0;
  let resolved = 0;
  let byRegistrar = '0 KFintech, 0 MUFG';
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
      // after: resolving can reach out to a registrar, and a sweep runs every 15
      // minutes over every outstanding application. Gating first keeps that
      // lookup to the rows actually about to be checked.
      if (!isAllotmentCheckDue(isoDay(allotmentDate), nowIso)) continue;
      const resolvedTo = await companyIdFor(c.ipo);
      if (!resolvedTo) continue;
      due.push(toDueRow(c, resolvedTo, pan));
    }

    byRegistrar = `${due.filter((d) => d.registrar !== 'MUFG').length} KFintech, ${
      due.filter((d) => d.registrar === 'MUFG').length
    } MUFG`;
    log.note(`${candidates.length} applied, ${due.length} due (${byRegistrar})`);

    const results = await checkAll(due);
    checked = results.length;
    let notYet = 0;
    for (const result of results) {
      if (result.outcome === 'resolved') resolved += 1;
      else if (result.outcome === 'not-yet') notYet += 1;
      else if (result.outcome === 'error' && result.message) errors.push(result.message);
    }

    log.note(
      `${checked} checked — ${resolved} resolved, ${notYet} not yet, ${errors.length} error(s)`,
    );
    // Capped at the same three the sync_log message keeps, so a batch that fails
    // wholesale cannot bury the summary lines above it.
    for (const message of errors.slice(0, 3)) log.note(`error: ${message}`);

    await sendAllotmentPushes(results);
  } catch (e) {
    ok = false;
    const message = e instanceof Error ? e.message : String(e);
    errors.push(message);
    log.note(`sweep failed: ${message}`);
  }

  // The provider tag stays KFINTECH_ALLOTMENT_CHECK even though the sweep now
  // covers two registrars: the app's staleness banner keys on this exact string,
  // and renaming it would read as "the allotment check has never run".
  await prisma.syncLog.create({
    data: {
      provider: 'KFINTECH_ALLOTMENT_CHECK',
      ok,
      rowsUpserted: resolved,
      message:
        errors.length > 0
          ? `${checked} checked (${byRegistrar}), ${resolved} resolved, ${errors.length} failed: ${errors.slice(0, 3).join('; ')}`
          : `${checked} checked (${byRegistrar}), ${resolved} resolved`,
    },
  });

  log.done(`${checked} checked, ${resolved} resolved, ${errors.length} error(s)`, ok);

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

  const log = jobLog('check-status');

  const candidates = (await prisma.ipoApplication.findMany({
    where: { id: { in: ids }, userId },
    select: candidateSelect,
  })) as Candidate[];

  // A gap here is a foreign or stale id, which the query drops on purpose (see
  // the doc comment) — silently to the caller, but worth seeing on the console.
  log.start(
    candidates.length === ids.length
      ? `${ids.length} requested`
      : `${ids.length} requested, ${candidates.length} owned by caller`,
  );

  const results: OnDemandResult[] = [];
  const checkable: DueRow[] = [];
  /** Rejected before any registrar was asked — still attempts, so still stamped. */
  const rejected: string[] = [];

  for (const c of candidates) {
    const pan = c.dematAccount.pan;
    const resolvedTo = await companyIdFor(c.ipo);

    if (!resolvedTo) {
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
    checkable.push(toDueRow(c, resolvedTo, pan));
  }

  await touchCheckedAt(rejected);

  const checked = await checkAll(checkable);
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

  // Tallied by outcome rather than listed per row: the rejections (no-match,
  // no-pan) are the ones worth seeing, and they never reach a registrar at all.
  const tally = new Map<OnDemandResult['outcome'], number>();
  for (const r of results) tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1);
  const summary = [...tally.entries()].map(([outcome, n]) => `${n} ${outcome}`).join(', ');

  log.done(summary || 'nothing to check', !tally.has('error'));

  return results;
}
