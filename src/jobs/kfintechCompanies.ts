/**
 * KFintech's allotment-status company list, fetched once and shared.
 *
 * This used to live inside syncIpos.ts, where a single scheduled pass was the
 * only caller. The "Check status" button now needs the same list — it resolves
 * a missing `kfintech_company_id` on demand rather than leaving the button dead
 * — and a direct import between two large job modules is worse than one small
 * module both depend on.
 *
 * Public data only: this is the dropdown their own homepage renders. No PAN and
 * no user rows are involved; the PAN-bearing query lives in checkAllotments.ts.
 */
import { prisma } from '../db.js';
import {
  type KfintechCompany,
  matchKfintechCompanyByName,
  parseKfintechCompanies,
} from './syncIpos.parse.js';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'application/json, text/plain, */*',
};

export const KFINTECH_BASE = 'https://ipostatus.kfintech.com';

/**
 * How long a fetched list stays good for.
 *
 * The list changes when KFintech onboards an issue — days apart, not minutes —
 * so this is about collapsing one user's burst of work, not about freshness.
 * A single "Check status" tap can cover 20 applications across several IPOs,
 * and each unresolved one would otherwise re-download the whole React bundle.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

let cached: { companies: KfintechCompany[]; expiresAt: number } | null = null;

/**
 * Shared by concurrent callers so a burst of requests arriving together makes
 * one request rather than N. Cleared in a `finally` so a failure is never the
 * thing everyone else waits on and then inherits.
 */
let inFlight: Promise<KfintechCompany[]> | null = null;

async function fetchKfintechCompanies(): Promise<KfintechCompany[]> {
  const homepage = await fetch(`${KFINTECH_BASE}/`, { headers: BROWSER_HEADERS });
  if (!homepage.ok) throw new Error(`KFintech homepage responded ${homepage.status}`);
  const html = await homepage.text();

  // KFintech has served this as both "/static/js/main.<hash>.js" and, since
  // 2026-08, "./static/js/main.<hash>.js" — tolerate either leading form and
  // always rebuild the URL with a single slash rather than trusting whichever
  // one shows up.
  const scriptMatch = html.match(/src="\.?\/?(static\/js\/main\.[a-z0-9]+\.js)"/);
  if (!scriptMatch) throw new Error('KFintech homepage did not reference a main.<hash>.js bundle');

  const bundleRes = await fetch(`${KFINTECH_BASE}/${scriptMatch[1]}`, { headers: BROWSER_HEADERS });
  if (!bundleRes.ok) throw new Error(`KFintech bundle responded ${bundleRes.status}`);
  const bundle = await bundleRes.text();

  const companies = parseKfintechCompanies(bundle);
  if (companies.length === 0) throw new Error('KFintech bundle yielded no company entries');
  return companies;
}

/**
 * The company list, from cache when it is still warm.
 *
 * Throws on a failed scrape rather than returning an empty list — an empty list
 * and "every company failed to match" are indistinguishable to a caller, and
 * the scheduled pass records that difference in sync_log.
 */
export async function getKfintechCompanies(): Promise<KfintechCompany[]> {
  if (cached && cached.expiresAt > Date.now()) return cached.companies;
  if (inFlight) return inFlight;

  inFlight = fetchKfintechCompanies()
    .then((companies) => {
      // Only successes are cached; a throw must leave the next caller free to
      // try again immediately.
      cached = { companies, expiresAt: Date.now() + CACHE_TTL_MS };
      return companies;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Drops the cache. For tests, and for a forced re-scrape. */
export function clearKfintechCompaniesCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * Record a resolved match on an `ipos` row.
 *
 * Deliberately not filtered on `createdBy: null`, the one documented exemption
 * to that rule — see the syncIpos.ts file header. Only these three additive
 * fields are ever written, never anything a user typed, which is what makes the
 * exemption safe and is why a manually-added IPO can get a KFintech match at
 * all.
 *
 * `registrar` is spelled exactly as `resolveRegistrar` spells it (ipogyani.ts).
 * The column is rendered straight into "Check allotment at …" on the IPO
 * screen, so two spellings would surface as two different registrars.
 */
export async function saveKfintechMatch(ipoId: string, clientId: string): Promise<void> {
  await prisma.ipo.update({
    where: { id: ipoId },
    data: {
      registrar: 'KFintech',
      registrarUrl: `${KFINTECH_BASE}/`,
      kfintechCompanyId: clientId,
    },
  });
}

/**
 * Resolve one IPO's KFintech company id on demand and persist it.
 *
 * This is the "Check status" button's path: the scheduled match pass runs once
 * ever (gated on a prior successful KFINTECH_MATCH row), so an IPO added after
 * that first success would otherwise never acquire an id and its button would
 * stay dead forever.
 *
 * Returns null rather than throwing on any failure — a KFintech outage must
 * degrade the check to "no match yet", not turn it into an error the user has
 * to interpret.
 */
export async function resolveKfintechCompanyId(
  ipoId: string,
  companyName: string,
): Promise<string | null> {
  try {
    const match = matchKfintechCompanyByName(companyName, await getKfintechCompanies());
    if (!match) return null;
    await saveKfintechMatch(ipoId, match.clientId);
    return match.clientId;
  } catch {
    return null;
  }
}
