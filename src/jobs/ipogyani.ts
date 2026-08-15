/**
 * Pure mapping for the ipogyani.com provider.
 *
 * Kept separate from parse.ts for one reason: there is nothing to parse. Where
 * ipowatch needs ~400 lines of regex table walking to reassemble an IPO from
 * three page types, ipogyani serves the whole thing as JSON from a single
 * endpoint, already in ISO dates. So this file is field mapping and nothing
 * else, and the ipowatch parsers stay untouched next door.
 *
 * A WORD OF WARNING, same as everywhere else in this function: /api/ipos is
 * undocumented. It is the endpoint ipogyani's own site calls, it can change
 * shape without notice, and every rule below exists because the live payload
 * on 2026-08-13 said so — not because anyone promised it.
 *
 * Like parse.ts, this file must stay inside supabase/functions/sync-ipos/: the
 * Supabase CLI's bundler roots at supabase/ and parent-directory imports are
 * not reliably included in the deployed eszip.
 */
import {
  type GmpReading,
  type IpoRecord,
  normalizeName,
  statusFor,
  symbolFromSlug,
} from './syncIpos.parse.js';

/**
 * One row of https://ipogyani.com/api/ipos.
 *
 * Only the fields we consume are declared. The live payload also carries
 * financials, KPIs, issue objectives, an AI listing-gain prediction and a
 * sentiment score — none of which the app models, and none of which should be
 * added here without a column to put them in.
 */
export type IpogyaniIpo = {
  name: string;
  slug: string;
  /** 'Mainboard' | 'NSE SME' | 'BSE SME'. Never names the exchange for Mainboard. */
  exchange: string;
  openDate: string | null;
  closeDate: string | null;
  allotmentDate: string | null;
  listDate: string | null;
  priceMin: number | null;
  priceMax: number | null;
  lotSize: number | null;
  issueSizeCr: number | null;
  gmp: number | null;
  gmpLastUpdated: string | null;
  subscription?: { total?: number | null } | null;
  registrar?: string | null;
};

// ---------------------------------------------------------------------------
// registrar
//
// The one field here that changes what the app *does* rather than what it
// shows. Before this, every synced IPO inherited the column default of
// 'KFINTECH' and a link to ipostatus.kfintech.com, because — as
// 20260811000006_default_registrar_kfintech.sql says — no earlier feed gave
// any signal to say otherwise. This one does, and on the live book it says
// that assumption is wrong for 5 of 11 mainboard issues.
// ---------------------------------------------------------------------------

export type Registrar = { name: string; url: string | null };

/**
 * Canonical registrar per `normalizeName` key.
 *
 * Keyed through normalizeName rather than on the raw string because the feed
 * spells one registrar several ways — "Kfin Technologies Ltd." and "KFin
 * Technologies Limited", "Bigshare Services Pvt. Ltd." and "Bigshare Services
 * Pvt.Ltd." (no space) — and all of them have to reach the same URL.
 *
 * Every URL was fetched and confirmed to load. A registrar whose allotment
 * page could not be confirmed gets a null rather than a guess: the button in
 * app/ipos/[id].tsx is conditional on registrar_url, so a null hides it, and a
 * hidden button beats one that opens the wrong registrar.
 */
const REGISTRARS: Record<string, Registrar> = {
  kfintechnologies: { name: 'KFintech', url: 'https://ipostatus.kfintech.com/' },
  mufgintime: {
    name: 'MUFG Intime',
    url: 'https://in.mpms.mufg.com/Initial_Offer/public-issues.html',
  },
  // Link Intime rebranded to MUFG Intime and linkintime.co.in no longer
  // resolves at all, so the old name has to land on the new site — it still
  // appears in rows written before the rebrand.
  linkintime: {
    name: 'MUFG Intime',
    url: 'https://in.mpms.mufg.com/Initial_Offer/public-issues.html',
  },
  bigshareservices: { name: 'Bigshare', url: 'https://ipo.bigshareonline.com/ipo_status.html' },
  cameocorporateservices: { name: 'Cameo', url: 'https://ipo.cameoindia.com/' },
  maashitlasecurities: {
    name: 'Maashitla',
    url: 'https://maashitla.com/allotment-status/public-issues',
  },
  skylinefinancialservices: { name: 'Skyline', url: 'https://www.skylinerta.com/ipo.php' },
  purvasharegistry: {
    name: 'Purva Sharegistry',
    url: 'https://www.purvashare.com/investor-service/ipo-query',
  },
  // Alankit's allotment page 404s; the name is still worth showing.
  alankitassignments: { name: 'Alankit', url: null },
};

/**
 * A feed registrar string → the canonical name and its allotment page.
 *
 * An unrecognised registrar is not dropped: it keeps the feed's own spelling
 * and gets a null URL. Registrars we have never seen are still real, and
 * naming one correctly with no link is better than either silence or the
 * KFintech link this column used to default to.
 */
export function resolveRegistrar(raw: string | null | undefined): Registrar | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  return REGISTRARS[normalizeName(text)] ?? { name: text, url: null };
}

/** One row's registrar, addressed the way the `ipos` upsert key addresses it. */
export type RegistrarAssignment = Registrar & {
  symbol: string;
  open_date: string | null;
};

/**
 * The registrar assignments a batch of feed rows implies.
 *
 * Deliberately keyed by (symbol, open_date) rather than folded into IpoRecord:
 * the upsert writes whole rows per provider, so a registrar on IpoRecord would
 * be nulled by NSE — which runs first and knows no registrar — on every issue
 * ipogyani does not also cover. index.ts applies these as narrow updates
 * instead, the same way syncKfintechCompanies does.
 */
export function registrarAssignments(
  rows: IpogyaniIpo[],
  records: IpoRecord[],
): RegistrarAssignment[] {
  const byName = priorIndex(records);
  const out: RegistrarAssignment[] = [];

  for (const row of rows) {
    const registrar = resolveRegistrar(row.registrar);
    if (!registrar) continue;
    // Only rows that survived ipogyaniIpoRow have an `ipos` row to update —
    // SME and undateable rows were dropped there and must be skipped here too.
    const record = byName.get(`${normalizeName(row.name)}|${row.openDate}`);
    if (!record) continue;
    out.push({ ...registrar, symbol: record.symbol, open_date: record.open_date });
  }

  return out;
}

/**
 * Zero is how this feed spells "not announced yet" for the issue fields —
 * every one of the 18 live rows had a number in every slot, including the
 * upcoming issues whose price band and lot size are genuinely still unknown.
 *
 * Distinguishing the two matters because ipogyani runs last and its record
 * wins the upsert: a confident 0 would blank a price band ipowatch got right.
 * No real IPO has a zero price band, lot size or issue size, so the collapse
 * is safe here — it is NOT safe for GMP, which see.
 */
function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The provider_slug both the reading and the slug index are keyed on.
 *
 * They have to agree exactly or `resolveIpoId`'s first rung silently never
 * fires, so the normalisation lives in one place rather than being spelled out
 * at each end.
 */
export function ipogyaniSlug(raw: IpogyaniIpo): string {
  return String(raw.slug ?? '').trim().toLowerCase();
}

/** `${normalizeName}|${open_date}` → whatever an earlier provider wrote this run. */
export function priorIndex(records: IpoRecord[]): Map<string, IpoRecord> {
  const index = new Map<string, IpoRecord>();
  for (const record of records) {
    if (!record.open_date) continue;
    index.set(`${normalizeName(record.company_name)}|${record.open_date}`, record);
  }
  return index;
}

/**
 * One /api/ipos row → IpoRecord, or null for a row we deliberately do not track.
 *
 * `prior` carries what NSE, BSE and ipowatch produced earlier in the same run.
 * ipogyani publishes no exchange trading symbol at all and says only
 * "Mainboard" rather than which exchange an issue lists on, so both are taken
 * from whichever provider already decided them. Without that, every issue
 * would get a second `ipos` row under a synthesised symbol — the same reason
 * `ipowatchIpoRow` takes `priorSymbols`.
 */
export function ipogyaniIpoRow(
  raw: IpogyaniIpo,
  prior: Map<string, IpoRecord> = new Map(),
  today = new Date().toISOString().slice(0, 10),
): IpoRecord | null {
  // SME issues are out of scope for the automated pipeline, exactly as in
  // ipowatchIpoRow. 7 of the 18 live rows are SME; the app still lets a user
  // add one by hand.
  if (String(raw.exchange ?? '').toUpperCase().includes('SME')) return null;

  const company = String(raw.name ?? '').trim();
  const open = raw.openDate || null;
  // A row we cannot key is worse than a missing row: it can't participate in
  // the (symbol, open_date) unique index, so the upsert would duplicate it
  // on every run.
  if (!company || !open) return null;

  const previous = prior.get(`${normalizeName(company)}|${open}`);
  const symbol = previous?.symbol || symbolFromSlug(raw.slug);
  if (!symbol) return null;

  const record: IpoRecord = {
    symbol,
    company_name: company,
    exchange: previous?.exchange ?? 'NSE',
    segment: 'MAINBOARD',
    // Not mapped from raw.status: ipogyani's vocabulary is presentational
    // ('open' | 'lastday' | 'allot' | 'listing' | 'upcoming') and does not line
    // up with the ipo_status enum. index.ts re-derives the lifecycle at the end
    // of every run anyway.
    status: statusFor(open, raw.closeDate || null, today),
    open_date: open,
    close_date: raw.closeDate || null,
    listing_date: raw.listDate || null,
    price_band_min: positiveOrNull(raw.priceMin),
    price_band_max: positiveOrNull(raw.priceMax),
    lot_size: positiveOrNull(raw.lotSize),
    issue_size_cr: positiveOrNull(raw.issueSizeCr),
    allotment_date: raw.allotmentDate || null,
    source: 'IPOGYANI',
  };

  return previous ? fillGapsFrom(record, previous) : record;
}

/**
 * Fold an earlier provider's record into this one, filling only the fields
 * ipogyani left null.
 *
 * Same idea as `mergeIpowatchDetail`, and load-bearing for the same reason:
 * ipogyani runs last so its row wins the upsert, and running last must never
 * be able to blank a field an earlier provider populated.
 */
export function fillGapsFrom(record: IpoRecord, previous: IpoRecord): IpoRecord {
  return {
    ...record,
    close_date: record.close_date ?? previous.close_date,
    listing_date: record.listing_date ?? previous.listing_date,
    price_band_min: record.price_band_min ?? previous.price_band_min,
    price_band_max: record.price_band_max ?? previous.price_band_max,
    lot_size: record.lot_size ?? previous.lot_size,
    issue_size_cr: record.issue_size_cr ?? previous.issue_size_cr,
    allotment_date: record.allotment_date ?? previous.allotment_date,
  };
}

/** One /api/ipos row → GmpReading, or null when there is nothing to record. */
export function ipogyaniGmpRow(raw: IpogyaniIpo): GmpReading | null {
  // Same SME exclusion as ipogyaniIpoRow — no point keeping a grey market
  // reading for an issue that never lands in `ipos`.
  if (String(raw.exchange ?? '').toUpperCase().includes('SME')) return null;

  const slug = ipogyaniSlug(raw);
  const company = String(raw.name ?? '').trim();
  // observed_at is part of the ipo_gmp unique index, so a reading without one
  // cannot be deduplicated and must be dropped rather than stamped with now().
  const observedAt = raw.gmpLastUpdated || null;
  if (!slug || !company || !observedAt) return null;

  // Unlike the issue fields above, a zero here is ambiguous — it means both
  // "quoted at no premium" and "not quoted yet", and 5 of the 18 live rows sat
  // at 0 including issues whose price band was not out. Null keeps a false
  // floor off the chart, matching how ipowatch's "₹-" is read.
  const gmp = positiveOrNull(raw.gmp);
  const price = positiveOrNull(raw.priceMax);

  return {
    provider: 'IPOGYANI',
    // Distinct from ipowatch's slug for the same issue ('behari-lal-ipo' vs
    // 'behari-lal-engineering-ipo'), which is what lets the two providers share
    // the (provider, provider_slug, observed_at) unique index without colliding.
    provider_slug: slug,
    company_name: company,
    open_date: raw.openDate || null,
    observed_at: observedAt,
    gmp,
    // Computed, not taken from the payload's own `gmpPercent`, which disagrees
    // with its own arithmetic: Behari Lal came back as gmp 74 on a ₹285 cap
    // with gmpPercent 15.8, where 74/285 is 26% — and 26% is what ipogyani's
    // own GMP history for that issue says. It was also a flat 0 on 15 of 18
    // rows. The division is the trustworthy number.
    gmp_percent: gmp !== null && price !== null ? Math.round((gmp / price) * 10_000) / 100 : null,
    price,
    // The one figure ipowatch never quoted. 0 means the book has not opened,
    // not a genuinely zero-times subscription.
    sub_times: positiveOrNull(raw.subscription?.total),
    source_url: `https://ipogyani.com/ipo/${slug}`,
  };
}
