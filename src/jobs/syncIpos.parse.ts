/**
 * Pure parsing and matching logic for sync-ipos.
 *
 * Everything here is deliberately free of imports, `Deno.*`, and network calls,
 * for one reason: it is the only part of the sync that can be tested. index.ts
 * imports `jsr:@supabase/supabase-js` and calls `Deno.serve`, neither of which
 * Node can load, so anything left in that file is untestable by construction.
 *
 * The ipowatch.in work roughly tripled the amount of parsing, and the matching
 * ladder in `resolveIpoId` is the single place where a bug attaches a grey
 * market chart to the wrong company — which is worse than showing nothing. So
 * it lives here, takes plain Maps rather than a database client, and is covered
 * by parse.test.ts.
 *
 * This file must stay inside supabase/functions/sync-ipos/. The Supabase CLI's
 * bundler roots at supabase/ and parent-directory imports are not reliably
 * included in the deployed eszip.
 */

export type IpoRecord = {
  symbol: string;
  company_name: string;
  exchange: string;
  segment: 'MAINBOARD' | 'SME';
  status: 'UPCOMING' | 'OPEN' | 'CLOSED' | 'LISTED';
  open_date: string | null;
  close_date: string | null;
  /** Only the ipowatch listing-date table supplies this; NSE and BSE never do. */
  listing_date: string | null;
  price_band_min: number | null;
  price_band_max: number | null;
  lot_size: number | null;
  issue_size_cr: number | null;
  /** Only the ipowatch per-IPO detail page supplies this; NSE, BSE, and the ipowatch list page never do. */
  allotment_date: string | null;
  source: string;
};

/**
 * Collapse a provider's records to one row per IPO, silently — a duplicate is
 * not a row to write but a row to drop.
 *
 * Two passes, because `ipos` now carries two unique keys and a batch has to
 * respect both. The company key runs first: it is the real identity, since the
 * symbol is synthesised from the company name and the synthesis has changed
 * across releases (one issue has sat in the table as BEHARILALENGINEERING,
 * BEHARILAL and BLEL at once).
 *
 * This is required rather than tidy: a single multi-row INSERT ... ON CONFLICT
 * DO UPDATE that names the same key twice fails outright with Postgres 21000
 * ("cannot affect row a second time"), taking that provider's whole write with
 * it. NSE and BSE push into flat arrays with no key map of their own, and BSE
 * synthesises a symbol from the first 12 characters of the company name, so a
 * repeat is entirely plausible.
 *
 * Last wins, matching the per-provider Maps in syncIpos.ts and the provider
 * ordering there — later data is the more recent reading of the same issue.
 */
export function dedupeRecords(records: IpoRecord[]): IpoRecord[] {
  const byCompany = new Map<string, IpoRecord>();
  for (const record of records) {
    byCompany.set(`${normalizeName(record.company_name)}|${record.open_date ?? ''}`, record);
  }

  const bySymbol = new Map<string, IpoRecord>();
  for (const record of byCompany.values()) bySymbol.set(record.symbol, record);
  return [...bySymbol.values()];
}

/** An `ipos` row as the alignment pass needs it. */
export type ExistingIpo = { company_name: string; open_date: string | null };

/**
 * Rewrite an incoming record's company name to the one an existing row already
 * carries, when the two are the same issue under a different spelling.
 *
 * `ipos_company_idx` keys on the *normalized* name, which folds punctuation,
 * legal suffixes and the word "IPO" — but not a feed publishing a shorter name
 * than it did last week. "Lalithaa Jewellery" and "Lalithaa Jewellery Mart"
 * open on the same day and are one company, yet normalize to two different keys
 * and so land as two rows. No unique index can see that; this can, using the
 * same directional score the registrar matcher uses.
 *
 * Deliberately narrow, because a false merge silently destroys a real IPO:
 *
 *   - the open dates must be identical, not merely close
 *   - exactly one candidate may match; a tie means we do not know, so leave it
 *   - the score must clear NAME_MATCH_THRESHOLD in one direction or the other,
 *     since either side may be the longer name
 *
 * Renaming the record is enough to merge it: the name is the conflict key, so
 * the upsert then folds onto the existing row instead of inserting beside it.
 */
export function alignToExistingNames(records: IpoRecord[], existing: ExistingIpo[]): IpoRecord[] {
  if (existing.length === 0) return records;

  const known = new Set(existing.map((row) => `${normalizeName(row.company_name)}|${row.open_date}`));

  return records.map((record) => {
    const name = normalizeName(record.company_name);
    if (!name || known.has(`${name}|${record.open_date}`)) return record;

    const matches = existing.filter(
      (row) =>
        row.open_date === record.open_date &&
        normalizeName(row.company_name) !== name &&
        Math.max(
          nameMatchScore(record.company_name, row.company_name),
          nameMatchScore(row.company_name, record.company_name),
        ) >= NAME_MATCH_THRESHOLD,
    );
    if (matches.length !== 1) return record;

    return { ...record, company_name: matches[0].company_name };
  });
}

/** One grey-market reading, shaped for public.ipo_gmp. */
export type GmpReading = {
  provider: string;
  provider_slug: string;
  company_name: string;
  open_date: string | null;
  observed_at: string;
  gmp: number | null;
  gmp_percent: number | null;
  price: number | null;
  sub_times: number | null;
  source_url: string | null;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** India is UTC+5:30 and never observes DST, so a fixed offset is correct. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// primitives (moved verbatim from index.ts, now tested)
// ---------------------------------------------------------------------------

/** NSE dates look like "09-Aug-2026". Anything unparseable becomes null. */
export function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;

  const dmy = value.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (dmy) {
    const month = MONTHS.indexOf(dmy[2].toLowerCase());
    if (month >= 0) {
      return `${dmy[3]}-${String(month + 1).padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    }
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** "₹ 100 - 105" / "92.00 to 97.00" / "105" → [100, 105]. */
export function parsePriceBand(value: unknown): [number | null, number | null] {
  if (typeof value !== 'string') return [null, null];
  const numbers = value.replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length === 0) return [null, null];
  const min = Number(numbers[0]);
  const max = numbers.length > 1 ? Number(numbers[1]) : min;
  return [min, max];
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^0-9.\-]/g, '');
  // Number('') is 0, which would turn an empty or placeholder feed cell ("", "-")
  // into a confident zero — a subscription of 0x and "not quoted" are very
  // different claims. Require an actual digit.
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function statusFor(
  open: string | null,
  close: string | null,
  today = new Date().toISOString().slice(0, 10),
): IpoRecord['status'] {
  if (open && today < open) return 'UPCOMING';
  if (close && today > close) return 'CLOSED';
  if (open && close) return 'OPEN';
  return 'UPCOMING';
}

// ---------------------------------------------------------------------------
// HTML scrubbing
//
// Several feed columns are HTML fragments meant for a browser table. We only
// ever need the text, so a regex is sufficient — no DOM library required, which
// matters because Edge Functions cannot run one cheaply.
// ---------------------------------------------------------------------------

export function stripTags(html: unknown): string {
  if (typeof html !== 'string') return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(value: unknown): string {
  if (typeof value !== 'string') return '';
  return (
    value
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
      // &amp; is decoded last so "&amp;lt;" does not collapse into a real "<".
      .replace(/&(lt|gt|quot|apos|nbsp);/gi, (_, name) => NAMED_ENTITIES[name.toLowerCase()])
      .replace(/&amp;/gi, '&')
  );
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/**
 * The GMP feed gives a path ("/gmp/qt-foods-ipo/2299/"); the IPO list gives a
 * bare slug ("qt-foods-ipo"). Both normalise to the same key, which is the
 * bridge between the two feeds — verified to match on 30/30 live rows.
 *
 * Note the numeric ids in those paths are NOT a usable join key: the two feeds
 * number the same IPO differently (Q&T Foods is 2299 in one and 3145 in the
 * other), so an id-based join looks stable and is silently wrong.
 */
export function slugFromPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (!trimmed.includes('/')) return trimmed;

  const segments = trimmed.split('/').filter(Boolean);
  // Skip the leading section ("gmp", "ipo") and the trailing numeric id.
  const slug = segments.filter((s) => !/^\d+$/.test(s)).pop();
  return slug && slug !== 'gmp' && slug !== 'ipo' ? slug : null;
}

/**
 * Last-resort symbol when neither exchange publishes one — which is the common
 * case: 16 of 30 live issues have no NSE symbol and no BSE code.
 */
export function symbolFromSlug(slug: unknown): string {
  const base = String(slug ?? '')
    .toLowerCase()
    .replace(/-ipo$/, '');
  return base.replace(/[^a-z0-9]/g, '').toUpperCase().slice(0, 20);
}

const NAME_NOISE = /\b(ltd|limited|pvt|private|india|indian|the|inc|corp|corporation|company|co)\b/g;

/**
 * The significant words of a company name, noise stripped.
 *
 * "Q & T Foods Ltd. IPO" → ["q", "and", "t", "foods"].
 *
 * This is `normalizeName`'s pipeline stopped one step early, before the tokens
 * are welded into a single key. Exact matching wants the welded key; the fuzzy
 * pass in `nameMatchScore` needs the word boundaries that welding destroys —
 * "Milky Mist" and "MILKY MIST DAIRY FOOD LIMITED" share two whole words, but
 * as dense keys (`milkymist` / `milkymistdairyfood`) they are just two unequal
 * strings.
 */
export function nameTokens(name: unknown): string[] {
  return decodeEntities(String(name ?? ''))
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bipo\b/g, ' ')
    .replace(NAME_NOISE, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Collapses the many spellings of one company to a single key, so the two feeds
 * can be joined by name when the slug bridge is unavailable.
 *
 * "Q&T Foods", "Q&amp;T Foods", "Q & T Foods Ltd. IPO" and
 * "Q and T Foods Private Limited" must all produce the same string.
 */
export function normalizeName(name: unknown): string {
  return nameTokens(name).join('');
}

// ---------------------------------------------------------------------------
// fuzzy name matching
//
// The registrar writes a company's full legal name ("MILKY MIST DAIRY FOOD
// LIMITED"); we hold whatever the IPO feeds published, which is routinely the
// short trading name ("Milky Mist"). Exact key equality never joins those two.
//
// The measure below is deliberately *directional* — what fraction of OUR words
// the registrar's name accounts for — rather than a symmetric string-similarity
// ratio. A ratio penalises the registrar for the extra legal words it is
// obliged to carry: "milkymist" against "milkymistdairyfood" scores ~50% on a
// Levenshtein ratio and ~64% on a Dice bigram coefficient, so an 80% bar on
// either would reject the exact pair this exists to accept. Two of our two
// words appear verbatim on their side, which is the relationship that actually
// holds, and it scores 100%.
// ---------------------------------------------------------------------------

/** Minimum share of our tokens the registrar's name must account for. */
export const NAME_MATCH_THRESHOLD = 0.8;

/**
 * Total characters that must be covered before a score counts at all.
 *
 * Without this, a two-letter company name is one token long, so a single
 * incidental hit is 1/1 = 100% and it matches the first registrar entry that
 * happens to contain that fragment. Five characters is the shortest span that
 * is plausibly a company rather than a coincidence.
 */
const MIN_COVERED_CHARS = 5;

/**
 * Registrar entries for instruments we never track. KFintech's dropdown mixes
 * these in with equity IPOs, and their names are the issuer's name plus a
 * suffix — so "POWER FINANCE CORPORATION LIMITED - NCDS" covers every token of
 * a "Power Finance Corporation" equity row and scores a clean 100%.
 *
 * Under exact matching that entry was excluded by accident, because the trailing
 * "NCDS" made the dense keys unequal. Fuzzy matching removes that accident, so
 * the exclusion has to become deliberate.
 */
const NON_EQUITY_TOKENS = new Set([
  'ncd',
  'ncds',
  'bond',
  'bonds',
  'debenture',
  'debentures',
  'rights',
]);

/**
 * Skip a registrar entry that is marked as a non-equity instrument unless our
 * own name carries the same marker — a user who manually added an NCD should
 * still be able to match it, they just must not have one attached to their
 * equity application by accident.
 */
function skipNonEquity(ours: string[], theirs: string[]): boolean {
  const theirsIsDebt = theirs.some((token) => NON_EQUITY_TOKENS.has(token));
  if (!theirsIsDebt) return false;
  return !ours.some((token) => NON_EQUITY_TOKENS.has(token));
}

/**
 * A token counts as covered by an exact word hit, or by appearing anywhere in
 * the other side's welded key.
 *
 * The welded fallback is what handles the two sources disagreeing about where
 * the spaces go — "Electro Systems" against "ELECTROSYSTEMS HOLDINGS" shares no
 * whole word at all, yet both our words sit inside `electrosystemsholdings`.
 * It is gated at four characters because shorter fragments appear inside almost
 * anything ("in" is inside "industries", "infra", "international") and would
 * turn the threshold into a formality.
 */
function isCovered(token: string, candidates: string[], candidatesDense: string): boolean {
  for (const candidate of candidates) if (candidate === token) return true;
  return token.length >= 4 && candidatesDense.includes(token);
}

/**
 * `score` is the share of `ours` covered; `extra` is how many of `theirs` went
 * unused. `extra` is only ever a tie-breaker — between two entries that cover
 * our name equally well, the one carrying fewer unrelated words is the closer
 * name, which is what separates "MILKY MIST DAIRY FOOD LIMITED" from a
 * hypothetical "MILKY MIST DAIRY FOOD AND BEVERAGES HOLDINGS LIMITED".
 */
type TokenMatch = { score: number; extra: number };

function scoreTokens(ours: string[], theirs: string[]): TokenMatch {
  if (ours.length === 0 || theirs.length === 0) return { score: 0, extra: 0 };

  const oursDense = ours.join('');
  const theirsDense = theirs.join('');

  let covered = 0;
  let coveredChars = 0;
  for (const token of ours) {
    if (!isCovered(token, theirs, theirsDense)) continue;
    covered += 1;
    coveredChars += token.length;
  }

  if (coveredChars < MIN_COVERED_CHARS) return { score: 0, extra: 0 };

  let unused = 0;
  for (const token of theirs) if (!isCovered(token, ours, oursDense)) unused += 1;

  return { score: covered / ours.length, extra: unused };
}

/**
 * Strictly closer: a higher score, or the same score reached while dragging in
 * fewer unrelated words.
 *
 * Note what this deliberately cannot express — a *dead* tie, equal on both
 * counts. Callers treat that as no match rather than taking whichever the
 * iteration order happened to reach first. Preferring the best scorer over a
 * near-miss is a judgement call worth making; preferring one of two
 * indistinguishable companies is a coin flip, and the losing side of it shows a
 * stranger's allotment result on the user's own application.
 */
function isBetter(match: TokenMatch, best: TokenMatch): boolean {
  if (match.score !== best.score) return match.score > best.score;
  return match.extra < best.extra;
}

/**
 * 0..1 — the share of `ipoName`'s significant words that `registrarName`
 * accounts for. 1 whenever the two normalise to the same key, so exact matches
 * always sit at the top of the ladder.
 */
export function nameMatchScore(ipoName: unknown, registrarName: unknown): number {
  const ours = nameTokens(ipoName);
  const theirs = nameTokens(registrarName);
  if (ours.length === 0 || theirs.length === 0) return 0;
  if (ours.join('') === theirs.join('')) return 1;
  return scoreTokens(ours, theirs).score;
}

// ---------------------------------------------------------------------------
// ipowatch.in HTML tables
//
// ipowatch has no public API; these read the same server-rendered <table>
// markup a browser does. A regex walk is enough — the listing page's own
// "Showing N of N entries" footer confirms every row we need is present in
// the plain HTML with no client-side JS required to see the rest of it, so
// there is no pagination to defeat and no need for a DOM library just to walk
// two flat tables.
// ---------------------------------------------------------------------------

type HtmlRow = { cells: string[]; hrefs: (string | null)[] };

function extractHtmlRows(tableHtml: string): HtmlRow[] {
  const rows: HtmlRow[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(tableHtml))) {
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    const hrefs: (string | null)[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      cells.push(decodeEntities(stripTags(cellMatch[1])).trim());
      const href = cellMatch[1].match(/href="([^"]*)"/i);
      hrefs.push(href ? href[1] : null);
    }
    if (cells.length > 0) rows.push({ cells, hrefs });
  }
  return rows;
}

/** Find a `<table id="…">…</table>` block (TablePress tables carry a stable id). */
function tableById(html: string, id: string): string | null {
  const m = html.match(new RegExp(`<table[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)<\\/table>`, 'i'));
  return m ? m[1] : null;
}

/**
 * Find a `<table>…</table>` block by content rather than position or id — none
 * of ipowatch's tables (GMP, list, or per-IPO detail) carry a stable id or
 * class, so "the table containing all of these strings" is the only anchor
 * that survives ipowatch's next redesign. Each page can carry more than one
 * table with overlapping text, so callers should pass strings specific enough
 * to disambiguate (e.g. a distinctive label, not just "IPO").
 */
function findTableContaining(html: string, mustContain: string[]): string | null {
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(html))) {
    if (mustContain.every((needle) => m![1].includes(needle))) return m[1];
  }
  return null;
}

/** A key/value table ("IPO Open Date: | August 12, 2026") → { label → value }. */
function keyValueRows(tableHtml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of extractHtmlRows(tableHtml)) {
    if (row.cells.length < 2) continue;
    const label = row.cells[0].replace(/:$/, '').trim().toLowerCase();
    if (label) map.set(label, row.cells[1]);
  }
  return map;
}

export type IpowatchGmpRow = {
  company_name: string;
  url: string | null;
  gmp_cell: string;
  price_band_cell: string;
  est_listing_cell: string;
  date_cell: string;
  type_cell: string;
  last_updated_cell: string;
};

/**
 * ipowatch's live GMP table → one row per IPO. Columns are IPO Name | IPO GMP*
 * | Trend | Price Band | Est. Listing | Date | Type | Status | Last Updated.
 * Trend (an emoji) is dropped, and Status is recomputed via statusFor instead
 * of trusted from the source, since the source's own status text can lag.
 */
export function parseIpowatchGmpTable(html: string): IpowatchGmpRow[] {
  const table = findTableContaining(html, ['IPO Name', 'IPO GMP']);
  if (!table) return [];

  return extractHtmlRows(table)
    .filter((row) => row.cells.length >= 9 && row.cells[0] !== 'IPO Name')
    .map((row) => ({
      company_name: row.cells[0],
      url: row.hrefs[0],
      gmp_cell: row.cells[1],
      price_band_cell: row.cells[3],
      est_listing_cell: row.cells[4],
      date_cell: row.cells[5],
      type_cell: row.cells[6],
      last_updated_cell: row.cells[8],
    }));
}

export type IpowatchListingRow = {
  company_name: string;
  url: string | null;
  listing_date_cell: string;
  bse_symbol: string;
  nse_symbol: string;
};

/**
 * ipowatch's listing-date table → one row per IPO. Mainboard and SME ship as
 * two separate TablePress tables (ids `tablepress-30` / `tablepress-31` as of
 * 2026-08 — the caller fetches both). Columns: IPO | IPO Date | Listing Date |
 * ISIN | BSE Symbol | NSE Symbol.
 */
export function parseIpowatchListingTable(html: string, tableId: string): IpowatchListingRow[] {
  const table = tableById(html, tableId);
  if (!table) return [];

  return extractHtmlRows(table)
    .filter((row) => row.cells.length >= 6 && row.cells[0] !== 'IPO')
    .map((row) => ({
      company_name: row.cells[0],
      url: row.hrefs[0],
      listing_date_cell: row.cells[2],
      bse_symbol: row.cells[4],
      nse_symbol: row.cells[5],
    }));
}

/** "19 August 2026" → "2026-08-19"; junk → null. Used by the listing-date table. */
export function parseIpowatchFullDate(value: string): string | null {
  const m = value.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase().slice(0, 3));
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/**
 * "August 17, 2026" → "2026-08-17"; junk → null. Used by the per-IPO detail
 * page's "IPO Dates" table — a different day/month order and punctuation than
 * the listing-date table's "19 August 2026", confirmed against the live page.
 */
export function parseIpowatchLongDate(value: string): string | null {
  const m = value.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3));
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/**
 * Fields only an IPO's own detail page carries — none of the aggregate pages
 * supply lot size at all, and the GMP/list page's "Price Band" and "Issue
 * Size" (when present) are coarser than what the detail page gives directly.
 */
export type IpowatchIpoDetail = {
  price_band_min: number | null;
  price_band_max: number | null;
  issue_size_cr: number | null;
  lot_size: number | null;
  allotment_date: string | null;
};

/**
 * ipowatch's per-IPO detail page (e.g. /behari-lal-engineering-ipo/) → the
 * handful of fields the aggregate pages never carry. None of these tables
 * have an id or class, same as the GMP table, so each is found by a label
 * unique to it — verified against the live Behari Lal Engineering page on
 * 2026-08-11:
 *
 *   - "IPO Details": key/value rows including "IPO Price Band" ("₹271 to
 *     ₹285 Per Share") and "Issue Size" ("Approx ₹301.62 Crores").
 *   - "Market Lot": header row Application | Lot Size | Shares | Amount. The
 *     table's own "Lot Size" column is actually a lot *count* (how many lots
 *     that tier applies for), not shares-per-lot — the real lot size is the
 *     "Retail Minimum" row's Shares cell (1 lot × 52 shares = ₹14,820 at
 *     ₹285/share, confirmed against the live numbers).
 *   - "IPO Dates": key/value rows including "Basis of Allotment:" ("August
 *     17, 2026").
 *
 * Missing any one of these tables — a redesign, a withdrawn issue with a
 * thinner page — degrades that field to null rather than throwing; the
 * caller (mergeIpowatchDetail) then just keeps whatever the list page
 * already had.
 */
export function parseIpowatchIpoDetail(html: string): IpowatchIpoDetail {
  const detailTable = findTableContaining(html, ['IPO Price Band', 'Issue Size']);
  const details = detailTable ? keyValueRows(detailTable) : new Map<string, string>();
  const [priceBandMin, priceBandMax] = parsePriceBand(details.get('ipo price band') ?? '');

  const lotTable = findTableContaining(html, ['Retail Minimum', 'Lot Size']);
  const retailMinRow = lotTable
    ? extractHtmlRows(lotTable).find((row) => row.cells[0] === 'Retail Minimum')
    : undefined;
  const lotSize = retailMinRow ? toNumber(retailMinRow.cells[2]) : null;

  const datesTable = findTableContaining(html, ['Basis of Allotment']);
  const dates = datesTable ? keyValueRows(datesTable) : new Map<string, string>();
  const allotmentCell = dates.get('basis of allotment');

  return {
    price_band_min: priceBandMin,
    price_band_max: priceBandMax,
    issue_size_cr: toNumber(details.get('issue size') ?? ''),
    lot_size: lotSize,
    allotment_date: allotmentCell ? parseIpowatchLongDate(allotmentCell) : null,
  };
}

/**
 * Fold detail-page fields into a list-page IpoRecord. Only overwrites a field
 * when the detail page actually produced a value — a parse hiccup on one
 * table (page redesign, a withdrawn issue missing a section) degrades to
 * "keep what the list page already gave us" rather than blanking a field
 * that was previously populated.
 */
export function mergeIpowatchDetail(record: IpoRecord, detail: IpowatchIpoDetail): IpoRecord {
  return {
    ...record,
    price_band_min: detail.price_band_min ?? record.price_band_min,
    price_band_max: detail.price_band_max ?? record.price_band_max,
    issue_size_cr: detail.issue_size_cr ?? record.issue_size_cr,
    lot_size: detail.lot_size ?? record.lot_size,
    allotment_date: detail.allotment_date ?? record.allotment_date,
  };
}

/**
 * "12-14 August" → { open: 2026-08-12, close: 2026-08-14 }.
 *
 * Ranges that cross a month boundary name only the end month (e.g.
 * "31-7 August" means 31 July to 7 August) — the start day is assigned to the
 * previous month whenever it is numerically larger than the end day, since
 * within one calendar month an open date always precedes its close date.
 */
export function parseIpowatchDateRange(
  cell: string,
  today: string,
): { open: string | null; close: string | null } {
  const m = cell.trim().match(/^(\d{1,2})-(\d{1,2})\s+([A-Za-z]+)$/);
  if (!m) return { open: null, close: null };

  const endMonth = MONTHS.indexOf(m[3].toLowerCase().slice(0, 3));
  if (endMonth < 0) return { open: null, close: null };

  const day1 = Number(m[1]);
  const day2 = Number(m[2]);
  const startMonth = day1 > day2 ? (endMonth + 11) % 12 : endMonth;

  const todayYear = Number(today.slice(0, 4));
  const todayMonth = Number(today.slice(5, 7)) - 1;
  // No year is given; infer it from the run date, with the same December/
  // January rollover guard ipowatchObservedAtFrom uses below.
  let closeYear = todayYear;
  if (endMonth === 0 && todayMonth === 11) closeYear += 1;
  if (endMonth === 11 && todayMonth === 0) closeYear -= 1;
  let openYear = closeYear;
  if (startMonth === 11 && endMonth === 0) openYear -= 1;

  const open = `${openYear}-${String(startMonth + 1).padStart(2, '0')}-${String(day1).padStart(2, '0')}`;
  const close = `${closeYear}-${String(endMonth + 1).padStart(2, '0')}-${String(day2).padStart(2, '0')}`;
  return { open, close };
}

/** "₹53" → 53; "₹0" → 0; "₹-" → null (no quote, distinct from a real zero). */
export function parseIpowatchAmount(cell: string): number | null {
  const text = cell.replace(/₹/g, '').replace(/,/g, '').trim();
  if (!/\d/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** "₹338 (18.60%)" → 18.6; no parenthesised percent → null. */
export function parseIpowatchPercent(cell: string): number | null {
  const m = cell.match(/\((-?\d+(?:\.\d+)?)\s*%\)/);
  return m ? Number(m[1]) : null;
}

/**
 * ipowatch stamps GMP rows "11 Aug, 07:45" — no year, and in IST. Same
 * missing-year inference and December/January rollover guard the old
 * Chittorgarh feed needed, just a different literal format (comma before the
 * time; already free of markup, since the table extractor strips it).
 *
 * Falls back to the run timestamp rather than null, because observed_at is NOT
 * NULL and is part of the idempotency key — a null would break dedupe entirely.
 */
export function ipowatchObservedAtFrom(cell: string, runIso: string): string {
  const run = new Date(runIso);
  if (Number.isNaN(run.getTime())) return new Date().toISOString();

  const m = cell.trim().match(/^(\d{1,2})\s+([A-Za-z]{3,}),?\s*(\d{1,2}):(\d{2})$/);
  if (!m) return run.toISOString();

  const month = MONTHS.indexOf(m[2].toLowerCase().slice(0, 3));
  if (month < 0) return run.toISOString();

  let year = run.getUTCFullYear();
  const runMonth = run.getUTCMonth();
  if (month === 11 && runMonth === 0) year -= 1; // December reading, January run
  if (month === 0 && runMonth === 11) year += 1; // January reading, December run

  const ms = Date.UTC(year, month, Number(m[1]), Number(m[3]), Number(m[4])) - IST_OFFSET_MS;
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// row mapping
// ---------------------------------------------------------------------------

/**
 * ipowatch GMP-table row → IpoRecord. `listingByName` supplies listing_date
 * and exchange symbols from the separate listing-date table, joined by
 * normalizeName since the two pages share no other key; a company not yet on
 * that page just gets a null listing_date until it shows up there on a later
 * run.
 *
 * `priorSymbols` maps `${normalizeName}|${open_date}` to the symbol NSE or BSE
 * already used for that issue *in this same run*. Reusing it is what stops
 * this provider creating a second `ipos` row for a company an exchange just
 * wrote under its own symbol.
 */
export function ipowatchIpoRow(
  row: IpowatchGmpRow,
  listingByName: Map<string, IpowatchListingRow>,
  priorSymbols: Map<string, string> = new Map(),
  today = new Date().toISOString().slice(0, 10),
): IpoRecord | null {
  // SME issues are out of scope for this sync entirely — the app still lets a
  // user add one by hand, but the automated pipeline only tracks Mainboard.
  if (row.type_cell.toUpperCase().includes('SME')) return null;

  const company = decodeEntities(row.company_name).trim();
  if (!company) return null;

  const { open, close } = parseIpowatchDateRange(row.date_cell, today);
  // Mirrors fetchNse's `if (!symbol || !name) continue` — a row we cannot key
  // is worse than a missing row, because the upsert would duplicate it forever.
  if (!open) return null;

  const listing = listingByName.get(normalizeName(company));
  const nse = (listing?.nse_symbol ?? '').toUpperCase();
  const bse = (listing?.bse_symbol ?? '').toUpperCase();
  const slug = slugFromPath(row.url) ?? '';
  const prior = priorSymbols.get(`${normalizeName(company)}|${open}`);
  const symbol = nse || bse || prior || symbolFromSlug(slug);
  if (!symbol) return null;

  const type = row.type_cell.toUpperCase();
  const [min, max] = parsePriceBand(row.price_band_cell);

  return {
    symbol,
    company_name: company,
    exchange: type.includes('BSE') ? 'BSE' : 'NSE',
    segment: 'MAINBOARD',
    status: statusFor(open, close, today),
    open_date: open,
    close_date: close,
    listing_date: listing ? parseIpowatchFullDate(listing.listing_date_cell) : null,
    price_band_min: min,
    price_band_max: max,
    // The GMP table does not carry a lot size, issue size, or allotment date.
    // The per-IPO detail page does — see parseIpowatchIpoDetail below, merged
    // in by index.ts once SME exclusion has made that affordable to fetch.
    lot_size: null,
    issue_size_cr: null,
    allotment_date: null,
    source: 'IPOWATCH',
  };
}

/** ipowatch GMP-table row → GmpReading. */
export function ipowatchGmpRow(row: IpowatchGmpRow, runIso: string): GmpReading | null {
  // Same SME exclusion as ipowatchIpoRow — no point tracking a grey market
  // reading for an issue we no longer sync into `ipos`.
  if (row.type_cell.toUpperCase().includes('SME')) return null;

  const slug = slugFromPath(row.url);
  const company = decodeEntities(row.company_name).trim();
  if (!slug || !company) return null;

  const { open } = parseIpowatchDateRange(row.date_cell, runIso.slice(0, 10));
  const [, priceBandMax] = parsePriceBand(row.price_band_cell);

  return {
    provider: 'IPOWATCH',
    provider_slug: slug,
    company_name: company,
    open_date: open,
    observed_at: ipowatchObservedAtFrom(row.last_updated_cell, runIso),
    gmp: parseIpowatchAmount(row.gmp_cell),
    gmp_percent: parseIpowatchPercent(row.est_listing_cell),
    price: priceBandMax,
    // The GMP table carries no subscription figures.
    sub_times: null,
    // ipowatch's own anchors are already absolute (https://ipowatch.in/…-ipo/).
    source_url: row.url,
  };
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

export type IpoIndexes = {
  /** `SYMBOL|open_date` → ipos.id */
  bySymbolOpen: Map<string, string>;
  /** `normalizeName|open_date` → ipos.id */
  byNameOpen: Map<string, string>;
  /** normalizeName → every candidate, for the fuzzy date pass. */
  byName: Map<string, { id: string; open_date: string | null }[]>;
  /**
   * Every candidate with its words intact, for the fuzzy *name* pass.
   *
   * A flat list rather than a Map because there is no key to look up by — the
   * fuzzy pass has to score every candidate. That is affordable: the pool is
   * only the IPOs within the ±45 day match window, which is dozens of rows.
   */
  byTokens: { id: string; tokens: string[] }[];
};

export function buildIpoIndexes(
  rows: { id: string; symbol: string; company_name: string; open_date: string | null }[],
): IpoIndexes {
  const indexes: IpoIndexes = {
    bySymbolOpen: new Map(),
    byNameOpen: new Map(),
    byName: new Map(),
    byTokens: [],
  };

  for (const row of rows) {
    const tokens = nameTokens(row.company_name);
    const name = tokens.join('');
    indexes.bySymbolOpen.set(`${row.symbol.toUpperCase()}|${row.open_date}`, row.id);
    indexes.byNameOpen.set(`${name}|${row.open_date}`, row.id);
    const bucket = indexes.byName.get(name);
    if (bucket) bucket.push({ id: row.id, open_date: row.open_date });
    else indexes.byName.set(name, [{ id: row.id, open_date: row.open_date }]);
    indexes.byTokens.push({ id: row.id, tokens });
  }

  return indexes;
}

function daysApart(a: string | null, b: string | null): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / DAY_MS;
}

/**
 * Attach a GMP reading to an `ipos` row, or refuse.
 *
 * The rungs are ordered most-certain first, and the function returns null
 * rather than guessing. That is deliberate: an unattached reading is retained
 * and retried on the next run, whereas a wrongly attached one silently renders
 * one company's grey market on another company's page, and nothing will alert
 * anyone.
 *
 * Note on the slug rung: it only fires when the ipowatch *list* leg succeeded
 * in the same run, because that is what populates `slugIndex`. Name matching
 * is the safety net for every reading that misses it.
 */
export function resolveIpoId(
  reading: GmpReading,
  slugIndex: Map<string, { symbol: string; open_date: string | null }>,
  indexes: IpoIndexes,
): string | null {
  // 1. Slug → the symbol the ipowatch list leg just upserted → the row itself.
  const viaSlug = slugIndex.get(reading.provider_slug);
  if (viaSlug) {
    const id = indexes.bySymbolOpen.get(`${viaSlug.symbol.toUpperCase()}|${viaSlug.open_date}`);
    if (id) return id;
  }

  const name = normalizeName(reading.company_name);
  if (!name) return null;

  // 2. Same company, same open date.
  const exact = indexes.byNameOpen.get(`${name}|${reading.open_date}`);
  if (exact) return exact;

  // 3. Same company, open date within three days — issues get postponed and the
  //    two feeds do not always update in lockstep. Only accept an unambiguous
  //    match; two candidates means we do not actually know which, so refuse.
  const near = (indexes.byName.get(name) ?? []).filter(
    (candidate) => daysApart(candidate.open_date, reading.open_date) <= 3,
  );
  if (near.length === 1) return near[0].id;

  return null;
}

// ---------------------------------------------------------------------------
// KFintech allotment-status company list
// ---------------------------------------------------------------------------

/** One entry from KFintech's "Select IPO" dropdown. */
export type KfintechCompany = { clientId: string; name: string };

/**
 * KFintech's allotment-status site (ipostatus.kfintech.com) has no company-list
 * API — the dropdown is populated from a plain JSON array baked into their
 * React bundle at build time, e.g. `const rf=JSON.parse('[{"clientId":"...",
 * "name":"..."}, ...]')`.
 *
 * The anchor searched for is the JSON content itself (`[{"clientId"`), not the
 * `rf` variable name, because minifier-assigned identifiers are not stable
 * across their redeploys — the JSON shape is the only part of this we can rely
 * on holding still. If KFintech changes that shape too, this returns an empty
 * list rather than throwing, so one broken scrape degrades to "no matches this
 * run" instead of taking down the rest of the sync.
 */
export function parseKfintechCompanies(bundleSource: string): KfintechCompany[] {
  const jsonStart = bundleSource.indexOf('[{"clientId"');
  if (jsonStart === -1) return [];
  const jsonEnd = bundleSource.indexOf("')", jsonStart);
  if (jsonEnd === -1) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(bundleSource.slice(jsonStart, jsonEnd));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter(
      (row): row is { clientId: unknown; name: unknown } =>
        !!row && typeof row === 'object' && 'clientId' in row && 'name' in row,
    )
    .map((row) => ({ clientId: String(row.clientId), name: String(row.name) }))
    .filter((row) => row.clientId && row.name);
}

/**
 * Match one KFintech dropdown entry to an `ipos` row.
 *
 * KFintech's list carries no open date and no exchange symbol, and it mixes
 * equity IPOs with NCDs/bonds we never track — so name is the only signal
 * available. The ladder is exact-first, then fuzzy:
 *
 *   1. An unambiguous exact key match, exactly as before.
 *   2. The best `nameMatchScore` at or above the threshold.
 *
 * Rung 2 deliberately takes the highest scorer rather than refusing on a tie,
 * which is the opposite of what `resolveIpoId` and `pickMatch` do. That is a
 * considered trade-off, not an oversight: those two can afford to refuse
 * because an unattached GMP reading is retried on the next run, whereas an
 * unmatched company id is a dead "Check status" button with no path forward.
 * The threshold, the covered-character floor and the non-equity filter are what
 * keep the guess narrow.
 */
export function resolveKfintechCompanyMatch(
  company: KfintechCompany,
  indexes: IpoIndexes,
): string | null {
  const theirs = nameTokens(company.name);
  if (theirs.length === 0) return null;

  const candidates = indexes.byName.get(theirs.join(''));
  if (candidates && candidates.length === 1) return candidates[0].id;

  let best: { id: string; score: number; extra: number } | null = null;
  let tied = false;
  for (const candidate of indexes.byTokens) {
    if (skipNonEquity(candidate.tokens, theirs)) continue;
    const match = scoreTokens(candidate.tokens, theirs);
    if (match.score < NAME_MATCH_THRESHOLD) continue;
    if (best && isBetter(match, best)) {
      best = { id: candidate.id, score: match.score, extra: match.extra };
      tied = false;
    } else if (best) {
      if (match.score === best.score && match.extra === best.extra) tied = true;
    } else {
      best = { id: candidate.id, score: match.score, extra: match.extra };
    }
  }

  return best && !tied ? best.id : null;
}

/**
 * The same match run the other way round: one of our IPO names against a whole
 * registrar dropdown.
 *
 * `resolveKfintechCompanyMatch` is the bulk direction — walk their list, find
 * our row. This is the on-demand direction, for the "Check status" button,
 * which has exactly one IPO in hand and needs the `clientId` its allotment API
 * wants. Same ladder, same guards, same take-the-best tie-breaking.
 *
 * Generic over the entry type because MUFG Intime's dropdown has the same two
 * fields under the same names and nothing here is KFintech-specific — only the
 * scraping that produces the list is.
 */
export function matchCompanyByName<T extends { clientId: string; name: string }>(
  ipoName: string,
  companies: T[],
): T | null {
  const ours = nameTokens(ipoName);
  if (ours.length === 0) return null;
  const dense = ours.join('');

  let best: { company: T; score: number; extra: number } | null = null;
  let tied = false;
  for (const company of companies) {
    const theirs = nameTokens(company.name);
    if (theirs.length === 0) continue;
    if (theirs.join('') === dense) return company;
    if (skipNonEquity(ours, theirs)) continue;

    const match = scoreTokens(ours, theirs);
    if (match.score < NAME_MATCH_THRESHOLD) continue;
    if (best && isBetter(match, best)) {
      best = { company, score: match.score, extra: match.extra };
      tied = false;
    } else if (best) {
      if (match.score === best.score && match.extra === best.extra) tied = true;
    } else {
      best = { company, score: match.score, extra: match.extra };
    }
  }

  return best && !tied ? best.company : null;
}

/** @deprecated Use {@link matchCompanyByName} — kept so older imports resolve. */
export const matchKfintechCompanyByName = matchCompanyByName<KfintechCompany>;
