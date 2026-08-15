/**
 * ipogyani is a JSON feed rather than an HTML one, so the failure mode is
 * different from parse.test.ts's: nothing here can fail to *parse*, but plenty
 * can be mapped wrong. The rules worth guarding are the ones where the feed's
 * literal value is not the value we want — zeros that mean "unknown", a
 * gmpPercent that contradicts its own gmp, and the symbol/exchange that this
 * provider simply does not publish.
 *
 * The fixtures are trimmed verbatim from https://ipogyani.com/api/ipos on
 * 2026-08-13, so the quirks below are real rather than imagined.
 */
import {
  fillGapsFrom,
  ipogyaniGmpRow,
  type IpogyaniIpo,
  ipogyaniIpoRow,
  priorIndex,
  registrarAssignments,
  resolveRegistrar,
} from './ipogyani.js';
import type { IpoRecord } from './syncIpos.parse.js';

// --- fixtures --------------------------------------------------------------

/** A live Mainboard issue: real GMP, real subscription, and a wrong gmpPercent. */
const BEHARI_LAL: IpogyaniIpo = {
  name: 'Behari Lal Engineering',
  slug: 'behari-lal-ipo',
  exchange: 'Mainboard',
  openDate: '2026-08-12',
  closeDate: '2026-08-14',
  allotmentDate: '2026-08-17',
  listDate: '2026-08-19',
  priceMin: 271,
  priceMax: 285,
  lotSize: 52,
  issueSizeCr: 302,
  gmp: 74,
  gmpLastUpdated: '2026-08-13T02:40:48.16+00:00',
  subscription: { total: 2.03 },
  registrar: 'MUFG Intime India Pvt. Ltd.',
};

/** Announced but not yet open: GMP and subscription both sit at a literal 0. */
const HORIZON: IpogyaniIpo = {
  name: 'Horizon Industrial Parks',
  slug: 'horizon-parks-ipo',
  exchange: 'Mainboard',
  openDate: '2026-08-17',
  closeDate: '2026-08-19',
  allotmentDate: '2026-08-20',
  listDate: '2026-08-24',
  priceMin: 57,
  priceMax: 60,
  lotSize: 250,
  issueSizeCr: 2600,
  gmp: 0,
  gmpLastUpdated: '2026-08-13T02:41:13.546+00:00',
  subscription: { total: 0 },
  registrar: 'Kfin Technologies Ltd.',
};

const SME: IpogyaniIpo = {
  name: 'Sham Foam',
  slug: 'sham-foam-ipo',
  exchange: 'NSE SME',
  openDate: '2026-08-12',
  closeDate: '2026-08-14',
  allotmentDate: '2026-08-17',
  listDate: '2026-08-19',
  priceMin: 90,
  priceMax: 95,
  lotSize: 1200,
  issueSizeCr: 24,
  gmp: 12,
  gmpLastUpdated: '2026-08-13T02:41:03.863+00:00',
  subscription: { total: 4.1 },
  registrar: 'Maashitla Securities Pvt. Ltd.',
};

/** What NSE wrote for the same issue earlier in the run. */
const NSE_BEHARI_LAL: IpoRecord = {
  symbol: 'BEHARILAL',
  company_name: 'Behari Lal Engineering Limited',
  exchange: 'BSE',
  segment: 'MAINBOARD',
  status: 'OPEN',
  open_date: '2026-08-12',
  close_date: '2026-08-14',
  listing_date: null,
  price_band_min: 271,
  price_band_max: 285,
  lot_size: 52,
  issue_size_cr: 302,
  allotment_date: null,
  source: 'BSE',
};

const TODAY = '2026-08-13';

// --- ipogyaniIpoRow --------------------------------------------------------

describe('ipogyaniIpoRow', () => {
  it('maps a Mainboard row, deriving the symbol from the slug when nothing prior exists', () => {
    expect(ipogyaniIpoRow(BEHARI_LAL, new Map(), TODAY)).toEqual({
      symbol: 'BEHARILAL',
      company_name: 'Behari Lal Engineering',
      exchange: 'NSE',
      segment: 'MAINBOARD',
      status: 'OPEN',
      open_date: '2026-08-12',
      close_date: '2026-08-14',
      listing_date: '2026-08-19',
      price_band_min: 271,
      price_band_max: 285,
      lot_size: 52,
      issue_size_cr: 302,
      allotment_date: '2026-08-17',
      source: 'IPOGYANI',
    });
  });

  it('reuses the symbol and exchange an earlier provider chose for the same issue', () => {
    // Names differ ("Behari Lal Engineering" vs "…Limited") — normalizeName is
    // what bridges them. Without this the row would key on BEHARILAL from the
    // slug and, on a company whose slug does not happen to agree, duplicate.
    const record = ipogyaniIpoRow(BEHARI_LAL, priorIndex([NSE_BEHARI_LAL]), TODAY);
    expect(record?.symbol).toBe('BEHARILAL');
    expect(record?.exchange).toBe('BSE');
  });

  it('recomputes status from the dates rather than trusting the feed', () => {
    expect(ipogyaniIpoRow(HORIZON, new Map(), TODAY)?.status).toBe('UPCOMING');
    expect(ipogyaniIpoRow(BEHARI_LAL, new Map(), '2026-08-20')?.status).toBe('CLOSED');
  });

  it('drops SME rows', () => {
    expect(ipogyaniIpoRow(SME, new Map(), TODAY)).toBeNull();
  });

  it('drops a row with no open date, which could not be keyed', () => {
    expect(ipogyaniIpoRow({ ...BEHARI_LAL, openDate: null }, new Map(), TODAY)).toBeNull();
  });

  it('reads a zero price band, lot size or issue size as unknown', () => {
    const record = ipogyaniIpoRow(
      { ...BEHARI_LAL, priceMin: 0, priceMax: 0, lotSize: 0, issueSizeCr: 0 },
      new Map(),
      TODAY,
    );
    expect(record).toMatchObject({
      price_band_min: null,
      price_band_max: null,
      lot_size: null,
      issue_size_cr: null,
    });
  });

  it('never blanks a field an earlier provider populated', () => {
    // This is the whole reason ipogyani can safely run last.
    const record = ipogyaniIpoRow(
      { ...BEHARI_LAL, priceMin: 0, priceMax: 0, lotSize: 0, issueSizeCr: 0 },
      priorIndex([NSE_BEHARI_LAL]),
      TODAY,
    );
    expect(record).toMatchObject({
      price_band_min: 271,
      price_band_max: 285,
      lot_size: 52,
      issue_size_cr: 302,
      // …while still contributing the two fields no exchange supplies.
      listing_date: '2026-08-19',
      allotment_date: '2026-08-17',
    });
  });
});

describe('fillGapsFrom', () => {
  it('prefers the new record wherever it has a value', () => {
    const merged = fillGapsFrom(
      { ...NSE_BEHARI_LAL, price_band_max: 999, listing_date: '2026-08-19' },
      NSE_BEHARI_LAL,
    );
    expect(merged.price_band_max).toBe(999);
    expect(merged.listing_date).toBe('2026-08-19');
  });
});

describe('priorIndex', () => {
  it('skips records with no open date, which cannot be keyed', () => {
    expect(priorIndex([{ ...NSE_BEHARI_LAL, open_date: null }]).size).toBe(0);
  });
});

// --- registrar -------------------------------------------------------------

const KFINTECH = { name: 'KFintech', url: 'https://ipostatus.kfintech.com/' };
const MUFG = {
  name: 'MUFG Intime',
  url: 'https://in.mpms.mufg.com/Initial_Offer/public-issues.html',
};

/**
 * Every string below is a real spelling from the 2026-08-13 payload. The
 * feed's own inconsistency is the whole reason this function exists: on that
 * book the same three registrars arrived under six different names.
 */
describe('resolveRegistrar', () => {
  it('collapses both KFintech spellings onto one registrar', () => {
    expect(resolveRegistrar('Kfin Technologies Ltd.')).toEqual(KFINTECH);
    expect(resolveRegistrar('KFin Technologies Limited')).toEqual(KFINTECH);
  });

  it('collapses both MUFG spellings, including the one with no suffix', () => {
    expect(resolveRegistrar('MUFG Intime India Pvt. Ltd.')).toEqual(MUFG);
    expect(resolveRegistrar('MUFG Intime India')).toEqual(MUFG);
  });

  it('collapses both Bigshare spellings, including "Pvt.Ltd." with no space', () => {
    const bigshare = { name: 'Bigshare', url: 'https://ipo.bigshareonline.com/ipo_status.html' };
    expect(resolveRegistrar('Bigshare Services Pvt. Ltd.')).toEqual(bigshare);
    expect(resolveRegistrar('Bigshare Services Pvt.Ltd.')).toEqual(bigshare);
  });

  it('sends the retired Link Intime name to MUFG Intime', () => {
    // linkintime.co.in no longer resolves; rows written before the rebrand
    // still say this and must land somewhere that exists.
    expect(resolveRegistrar('Link Intime India Pvt Ltd')).toEqual(MUFG);
  });

  it('keeps an unknown registrar by name, with no URL to guess at', () => {
    expect(resolveRegistrar('Some New RTA Services Ltd.')).toEqual({
      name: 'Some New RTA Services Ltd.',
      url: null,
    });
  });

  it('gives a known registrar with a dead allotment page a name but no link', () => {
    expect(resolveRegistrar('Alankit Assignments Limited')).toEqual({
      name: 'Alankit',
      url: null,
    });
  });

  it('is null for nothing at all', () => {
    expect(resolveRegistrar(null)).toBeNull();
    expect(resolveRegistrar(undefined)).toBeNull();
    expect(resolveRegistrar('   ')).toBeNull();
  });
});

describe('registrarAssignments', () => {
  const record = ipogyaniIpoRow(BEHARI_LAL, new Map(), TODAY)!;

  it('addresses the assignment by the same upsert key the ipos row uses', () => {
    expect(registrarAssignments([BEHARI_LAL], [record])).toEqual([
      { ...MUFG, symbol: 'BEHARILAL', open_date: '2026-08-12' },
    ]);
  });

  it('skips rows that never became an ipos row, like SME', () => {
    // SME is dropped by ipogyaniIpoRow, so there is nothing to update.
    expect(registrarAssignments([SME], [record])).toEqual([]);
  });

  it('skips a row with no registrar rather than writing a null over one', () => {
    expect(registrarAssignments([{ ...BEHARI_LAL, registrar: null }], [record])).toEqual([]);
  });
});

// --- ipogyaniGmpRow --------------------------------------------------------

describe('ipogyaniGmpRow', () => {
  it('maps a quoted reading', () => {
    expect(ipogyaniGmpRow(BEHARI_LAL)).toEqual({
      provider: 'IPOGYANI',
      provider_slug: 'behari-lal-ipo',
      company_name: 'Behari Lal Engineering',
      open_date: '2026-08-12',
      observed_at: '2026-08-13T02:40:48.16+00:00',
      gmp: 74,
      gmp_percent: 25.96,
      price: 285,
      sub_times: 2.03,
      source_url: 'https://ipogyani.com/ipo/behari-lal-ipo',
    });
  });

  it('computes gmp_percent rather than believing the payload', () => {
    // The live payload said gmpPercent 15.8 for this row. 74/285 is 25.96%,
    // and ipogyani's own GMP history for the issue says 26.
    expect(ipogyaniGmpRow(BEHARI_LAL)?.gmp_percent).toBe(25.96);
  });

  it('reads a zero GMP and a zero subscription as "not quoted yet"', () => {
    expect(ipogyaniGmpRow(HORIZON)).toMatchObject({
      gmp: null,
      gmp_percent: null,
      sub_times: null,
      // The price band is out even though nothing is quoted against it.
      price: 60,
    });
  });

  it('drops SME rows', () => {
    expect(ipogyaniGmpRow(SME)).toBeNull();
  });

  it('drops a reading with no observed_at, which could not be deduplicated', () => {
    expect(ipogyaniGmpRow({ ...BEHARI_LAL, gmpLastUpdated: null })).toBeNull();
  });
});
