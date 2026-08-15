/**
 * The sync scrapes undocumented sources whose columns are HTML fragments
 * written for a browser table. Almost every defect in that pipeline is a
 * parsing defect, and none of it can be exercised end-to-end without hitting
 * live third-party endpoints — so the pure layer carries the whole test burden.
 *
 * `resolveIpoId` is the one that matters most. Attaching a grey market chart to
 * the wrong company is worse than showing no chart at all, and nothing in
 * production would alert anyone that it happened.
 *
 * The ipowatch fixtures below are copied verbatim (cell text and hrefs) from
 * live pages on 2026-08-11, so the formatting quirks are real rather than
 * imagined.
 */
import {
  buildIpoIndexes,
  decodeEntities,
  type GmpReading,
  ipowatchGmpRow,
  ipowatchIpoRow,
  type IpowatchGmpRow,
  type IpowatchIpoDetail,
  ipowatchObservedAtFrom,
  type IpowatchListingRow,
  mergeIpowatchDetail,
  normalizeName,
  parseDate,
  parseIpowatchAmount,
  parseIpowatchDateRange,
  parseIpowatchFullDate,
  parseIpowatchGmpTable,
  parseIpowatchIpoDetail,
  parseIpowatchListingTable,
  parseIpowatchLongDate,
  parseIpowatchPercent,
  parseKfintechCompanies,
  parsePriceBand,
  resolveIpoId,
  resolveKfintechCompanyMatch,
  slugFromPath,
  statusFor,
  stripTags,
  symbolFromSlug,
  toNumber,
} from './syncIpos.parse.js';

// --- fixtures --------------------------------------------------------------

const GMP_TABLE_HTML = `
<figure class="wp-block-table"><table>
<tbody>
<tr><td>IPO Name</td><td class="has-text-align-center">IPO GMP*</td><td class="has-text-align-center">Trend</td><td class="has-text-align-center">Price Band</td><td class="has-text-align-center">Est. Listing</td><td class="has-text-align-center">Date</td><td class="has-text-align-center">Type</td><td class="has-text-align-center">Status</td><td class="has-text-align-center">Last Updated</td></tr>
<tr><td><a href="https://ipowatch.in/behari-lal-engineering-ipo/">Behari Lal Engineering</a></td><td>₹53</td><td>🟢</td><td>₹285</td><td>₹338 (18.60%)</td><td>12-14 August</td><td>Mainboard</td><td>Upcoming</td><td>11 Aug, 07:45</td></tr>
<tr><td><a href="https://ipowatch.in/shankesh-jewellers-ipo/">Shankesh Jewellers</a></td><td>₹0</td><td>🟡</td><td>₹-</td><td>₹- (0.00%)</td><td>18-20 August</td><td>Mainboard</td><td>Upcoming</td><td>11 Aug, 07:45</td></tr>
</tbody>
</table></figure>
<table><tbody><tr><td>Trend</td><td>Meaning</td></tr><tr><td>🟢</td><td>Rising</td></tr></tbody></table>
`;

const GMP_ROW: IpowatchGmpRow = {
  company_name: 'Behari Lal Engineering',
  url: 'https://ipowatch.in/behari-lal-engineering-ipo/',
  gmp_cell: '₹53',
  price_band_cell: '₹285',
  est_listing_cell: '₹338 (18.60%)',
  date_cell: '12-14 August',
  type_cell: 'Mainboard',
  last_updated_cell: '11 Aug, 07:45',
};

const LISTING_TABLE_HTML = `
<table id="tablepress-30" class="tablepress tablepress-id-30 dataTable">
<thead><tr><td>IPO</td><td>IPO Date</td><td>Listing Date</td><td>ISIN</td><td>BSE Symbol</td><td>NSE Symbol</td></tr></thead>
<tbody>
<tr><td><a href="https://ipowatch.in/behari-lal-engineering-ipo/">Behari Lal Engineering</a></td><td>12-14 August</td><td>19 August 2026</td><td></td><td></td><td></td></tr>
</tbody>
</table>
`;

const DETAIL_PAGE_HTML = `
<table><tbody>
<tr><td>IPO Open Date</td><td>August 12, 2026</td></tr>
<tr><td>IPO Close Date</td><td>August 14, 2026</td></tr>
<tr><td>Face Value</td><td>₹10 Per Equity Share</td></tr>
<tr><td>IPO Price Band</td><td>₹271 to ₹285 Per Share</td></tr>
<tr><td>Issue Size</td><td>Approx ₹301.62 Crores</td></tr>
<tr><td>Fresh Issue</td><td>Approx ₹93.00 Crores</td></tr>
<tr><td>Offer for Sale:</td><td>Approx 73,20,001 Equity Shares</td></tr>
<tr><td>Issue Type</td><td>Book built Issue</td></tr>
<tr><td>IPO Listing</td><td>BSE, NSE</td></tr>
</tbody></table>
<table><tbody>
<tr><td>Application</td><td>Lot Size</td><td>Shares</td><td>Amount</td></tr>
<tr><td>Retail Minimum</td><td>1</td><td>52</td><td>₹14,820</td></tr>
<tr><td>Retail Maximum</td><td>13</td><td>676</td><td>₹1,92,660</td></tr>
<tr><td>S-HNI Minimum</td><td>14</td><td>728</td><td>₹2,07,480</td></tr>
</tbody></table>
<table><tbody>
<tr><td>IPO Open Date:</td><td>August 12, 2026</td></tr>
<tr><td>IPO Close Date:</td><td>August 14, 2026</td></tr>
<tr><td>Basis of Allotment:</td><td>August 17, 2026</td></tr>
<tr><td>Refunds:</td><td>August 18, 2026</td></tr>
<tr><td>Credit to Demat Account:</td><td>August 18, 2026</td></tr>
<tr><td>IPO Listing Date:</td><td>August 19, 2026</td></tr>
</tbody></table>
`;

const RUN = '2026-08-11T02:15:00.000Z';

function reading(patch: Partial<GmpReading> = {}): GmpReading {
  return {
    provider: 'IPOWATCH',
    provider_slug: 'behari-lal-engineering-ipo',
    company_name: 'Behari Lal Engineering',
    open_date: '2026-08-12',
    observed_at: RUN,
    gmp: 53,
    gmp_percent: 18.6,
    price: 285,
    sub_times: null,
    source_url: null,
    ...patch,
  };
}

// --- the crux --------------------------------------------------------------

describe('resolveIpoId', () => {
  const indexes = buildIpoIndexes([
    { id: 'ipo-blal', symbol: 'BEHARILAL', company_name: 'Behari Lal Engineering Ltd.', open_date: '2026-08-12' },
    { id: 'ipo-ship', symbol: 'SHIPROCKET', company_name: 'Shiprocket Ltd.', open_date: '2026-08-12' },
  ]);
  const slugIndex = new Map([
    ['behari-lal-engineering-ipo', { symbol: 'BEHARILAL', open_date: '2026-08-12' }],
  ]);

  it('matches through the slug when the list leg ran in the same sync', () => {
    expect(resolveIpoId(reading(), slugIndex, indexes)).toBe('ipo-blal');
  });

  it('falls back to name plus open date when the slug is unknown', () => {
    expect(resolveIpoId(reading(), new Map(), indexes)).toBe('ipo-blal');
  });

  it('matches a company whose name is spelled differently by each feed', () => {
    const row = reading({ company_name: 'Behari Lal Engineering Private Limited' });
    expect(resolveIpoId(row, new Map(), indexes)).toBe('ipo-blal');
  });

  it('accepts an open date that moved by a couple of days', () => {
    const row = reading({ open_date: '2026-08-14' });
    expect(resolveIpoId(row, new Map(), indexes)).toBe('ipo-blal');
  });

  it('refuses to guess when two candidates are both within the date window', () => {
    const ambiguous = buildIpoIndexes([
      { id: 'a', symbol: 'BL1', company_name: 'Behari Lal Engineering', open_date: '2026-08-11' },
      { id: 'b', symbol: 'BL2', company_name: 'Behari Lal Engineering', open_date: '2026-08-13' },
    ]);
    expect(resolveIpoId(reading({ open_date: '2026-08-12' }), new Map(), ambiguous)).toBeNull();
  });

  it('returns null rather than attaching a reading to an unrelated company', () => {
    const row = reading({ provider_slug: 'nobody-ipo', company_name: 'Some Other Co' });
    expect(resolveIpoId(row, new Map(), indexes)).toBeNull();
  });

  it('returns null when the open date is too far from any candidate', () => {
    expect(resolveIpoId(reading({ open_date: '2026-09-30' }), new Map(), indexes)).toBeNull();
  });
});

// --- KFintech --------------------------------------------------------------

describe('parseKfintechCompanies', () => {
  it('extracts the company array from around the JSON.parse(\'...\') literal', () => {
    const bundle =
      'const nf=1;const rf=JSON.parse(\'[{"clientId":"44065980180","name":"MV ELECTROSYSTEMS LIMITED"},' +
      '{"clientId":"53707331280","name":"JUNIPER GREEN ENERGY LIMITED"}]\'),of={};';
    expect(parseKfintechCompanies(bundle)).toEqual([
      { clientId: '44065980180', name: 'MV ELECTROSYSTEMS LIMITED' },
      { clientId: '53707331280', name: 'JUNIPER GREEN ENERGY LIMITED' },
    ]);
  });

  it('finds the literal regardless of what the minifier named the variable', () => {
    // Same payload, different surrounding identifiers — the anchor is the JSON
    // shape, not a variable name, because that name is not stable across
    // KFintech's own redeploys.
    const bundle = 'const zz=JSON.parse(\'[{"clientId":"1","name":"ONLY CO LIMITED"}]\'),qq=2;';
    expect(parseKfintechCompanies(bundle)).toEqual([{ clientId: '1', name: 'ONLY CO LIMITED' }]);
  });

  it('returns an empty list rather than throwing when the shape is gone', () => {
    expect(parseKfintechCompanies('const rf=JSON.parse(\'{}\')')).toEqual([]);
    expect(parseKfintechCompanies('not even close to the expected bundle')).toEqual([]);
  });

  it('drops entries missing a clientId or name', () => {
    const bundle = 'JSON.parse(\'[{"clientId":"","name":"NO ID CO"},{"clientId":"1","name":""}]\')';
    expect(parseKfintechCompanies(bundle)).toEqual([]);
  });
});

describe('resolveKfintechCompanyMatch', () => {
  const indexes = buildIpoIndexes([
    { id: 'ipo-mv', symbol: 'MVELEC', company_name: 'MV Electrosystems Ltd.', open_date: '2026-08-01' },
    { id: 'ipo-ship', symbol: 'SHIPROCKET', company_name: 'Shiprocket Ltd.', open_date: '2026-08-12' },
  ]);

  it('matches an unambiguous company by name alone, with no open date available', () => {
    const company = { clientId: '44065980180', name: 'MV ELECTROSYSTEMS LIMITED' };
    expect(resolveKfintechCompanyMatch(company, indexes)).toBe('ipo-mv');
  });

  it('refuses to guess when two ipos rows share a normalised name', () => {
    const ambiguous = buildIpoIndexes([
      { id: 'a', symbol: 'X1', company_name: 'Repeat Co', open_date: '2026-08-01' },
      { id: 'b', symbol: 'X2', company_name: 'Repeat Co', open_date: '2026-09-01' },
    ]);
    expect(
      resolveKfintechCompanyMatch({ clientId: '1', name: 'REPEAT CO LIMITED' }, ambiguous),
    ).toBeNull();
  });

  it('returns null for an NCD/bond entry with no matching equity IPO', () => {
    const company = { clientId: '64562521850', name: 'POWER FINANCE CORPORATION LIMITED - NCDS' };
    expect(resolveKfintechCompanyMatch(company, indexes)).toBeNull();
  });
});

// --- timestamps ------------------------------------------------------------

describe('ipowatchObservedAtFrom', () => {
  it('reads the IST stamp and converts it to UTC', () => {
    // 11 Aug 07:45 IST is 11 Aug 02:15 UTC.
    expect(ipowatchObservedAtFrom(GMP_ROW.last_updated_cell, RUN)).toBe('2026-08-11T02:15:00.000Z');
  });

  it('infers the year from the run date', () => {
    expect(ipowatchObservedAtFrom('3 Feb, 10:00', '2027-02-04T04:00:00.000Z')).toBe(
      '2027-02-03T04:30:00.000Z',
    );
  });

  it('files a December reading under the previous year when run in January', () => {
    expect(ipowatchObservedAtFrom('31 Dec, 23:00', '2027-01-01T04:00:00.000Z')).toBe(
      '2026-12-31T17:30:00.000Z',
    );
  });

  it('falls back to the run timestamp rather than null, which would break dedupe', () => {
    expect(ipowatchObservedAtFrom('not a date', RUN)).toBe(RUN);
  });
});

// --- GMP cells ---------------------------------------------------------------

describe('parseIpowatchAmount', () => {
  it('reads a real quote', () => {
    expect(parseIpowatchAmount('₹53')).toBe(53);
  });

  it('treats "₹0" as an actual zero quote', () => {
    expect(parseIpowatchAmount('₹0')).toBe(0);
  });

  it('treats "₹-" as no quote, not as zero premium', () => {
    expect(parseIpowatchAmount('₹-')).toBeNull();
  });

  it('handles a discount', () => {
    expect(parseIpowatchAmount('₹-12')).toBe(-12);
  });
});

describe('parseIpowatchPercent', () => {
  it('pulls the percentage out of the estimated-listing cell', () => {
    expect(parseIpowatchPercent('₹338 (18.60%)')).toBe(18.6);
  });

  it('reads the reported 0.00% for a not-yet-priced issue', () => {
    expect(parseIpowatchPercent('₹- (0.00%)')).toBe(0);
  });

  it('is null when there is no parenthesised percentage at all', () => {
    expect(parseIpowatchPercent('₹-')).toBeNull();
  });
});

// --- identity --------------------------------------------------------------

describe('normalizeName', () => {
  it('collapses every spelling of one company to the same key', () => {
    const expected = normalizeName('Q&T Foods');
    expect(normalizeName('Q&amp;T Foods')).toBe(expected);
    expect(normalizeName('Q & T Foods Ltd. IPO')).toBe(expected);
    expect(normalizeName('Q and T Foods Private Limited')).toBe(expected);
    expect(normalizeName('  q&t   foods  ')).toBe(expected);
  });

  it('keeps genuinely different companies apart', () => {
    expect(normalizeName('Shiprocket Ltd.')).not.toBe(normalizeName('Q&T Foods'));
  });

  it('is empty for junk, so callers can refuse to match on it', () => {
    expect(normalizeName('Ltd.')).toBe('');
    expect(normalizeName(null)).toBe('');
  });
});

describe('slugFromPath', () => {
  it('extracts the slug from a GMP path', () => {
    expect(slugFromPath('/gmp/qt-foods-ipo/2299/')).toBe('qt-foods-ipo');
  });

  it('passes a bare slug through, which is how the IPO list supplies it', () => {
    expect(slugFromPath('shiprocket-ipo')).toBe('shiprocket-ipo');
  });

  it('is null for junk', () => {
    expect(slugFromPath('')).toBeNull();
    expect(slugFromPath('/gmp/')).toBeNull();
    expect(slugFromPath(42)).toBeNull();
  });
});

describe('symbolFromSlug', () => {
  it('builds a usable symbol and drops the -ipo suffix', () => {
    expect(symbolFromSlug('qt-foods-ipo')).toBe('QTFOODS');
    expect(symbolFromSlug('behari-lal-engineering-ipo')).toBe('BEHARILALENGINEERING');
  });

  it('stays within a sane length', () => {
    expect(symbolFromSlug('a-very-long-company-name-that-goes-on-ipo').length).toBeLessThanOrEqual(20);
  });
});

// --- HTML ------------------------------------------------------------------

describe('decodeEntities and stripTags', () => {
  it('decodes numeric and named entities', () => {
    expect(decodeEntities('&#8377;100')).toBe('₹100');
    expect(decodeEntities('Q&amp;T')).toBe('Q&T');
    expect(decodeEntities('a&nbsp;b')).toBe('a b');
  });

  it('does not turn an escaped entity into a real tag', () => {
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('strips nested markup down to text', () => {
    expect(stripTags('<small><b>9-Aug 23:34</b></small>')).toBe('9-Aug 23:34');
  });
});

// --- HTML tables (ipowatch.in) ----------------------------------------------

describe('parseIpowatchGmpTable', () => {
  it('reads every column, skips the header row, and ignores the unrelated legend table', () => {
    const rows = parseIpowatchGmpTable(GMP_TABLE_HTML);
    expect(rows).toEqual([
      GMP_ROW,
      {
        company_name: 'Shankesh Jewellers',
        url: 'https://ipowatch.in/shankesh-jewellers-ipo/',
        gmp_cell: '₹0',
        price_band_cell: '₹-',
        est_listing_cell: '₹- (0.00%)',
        date_cell: '18-20 August',
        type_cell: 'Mainboard',
        last_updated_cell: '11 Aug, 07:45',
      },
    ]);
  });

  it('returns an empty list rather than throwing when the table is gone', () => {
    expect(parseIpowatchGmpTable('<p>no tables here</p>')).toEqual([]);
  });
});

describe('parseIpowatchListingTable', () => {
  it('reads listing date and exchange symbols by table id', () => {
    expect(parseIpowatchListingTable(LISTING_TABLE_HTML, 'tablepress-30')).toEqual([
      {
        company_name: 'Behari Lal Engineering',
        url: 'https://ipowatch.in/behari-lal-engineering-ipo/',
        listing_date_cell: '19 August 2026',
        bse_symbol: '',
        nse_symbol: '',
      },
    ]);
  });

  it('returns an empty list for an id that is not on the page', () => {
    expect(parseIpowatchListingTable(LISTING_TABLE_HTML, 'tablepress-31')).toEqual([]);
  });
});

describe('parseIpowatchFullDate', () => {
  it('reads a full listing date', () => {
    expect(parseIpowatchFullDate('19 August 2026')).toBe('2026-08-19');
  });

  it('is null for junk', () => {
    expect(parseIpowatchFullDate('soon')).toBeNull();
  });
});

describe('parseIpowatchLongDate', () => {
  it('reads the detail page\'s month-first date format', () => {
    expect(parseIpowatchLongDate('August 17, 2026')).toBe('2026-08-17');
  });

  it('is null for junk, including the other date table\'s day-first format', () => {
    expect(parseIpowatchLongDate('soon')).toBeNull();
    expect(parseIpowatchLongDate('19 August 2026')).toBeNull();
  });
});

describe('parseIpowatchDateRange', () => {
  it('reads an open-close range within one month', () => {
    expect(parseIpowatchDateRange('12-14 August', '2026-08-10')).toEqual({
      open: '2026-08-12',
      close: '2026-08-14',
    });
  });

  it('assigns the start day to the previous month when it crosses a boundary', () => {
    expect(parseIpowatchDateRange('31-7 August', '2026-08-05')).toEqual({
      open: '2026-07-31',
      close: '2026-08-07',
    });
  });

  it('is null for junk', () => {
    expect(parseIpowatchDateRange('soon', '2026-08-10')).toEqual({ open: null, close: null });
  });
});

describe('parseIpowatchIpoDetail', () => {
  it('reads the precise price band, issue size, real lot size, and allotment date', () => {
    expect(parseIpowatchIpoDetail(DETAIL_PAGE_HTML)).toEqual({
      price_band_min: 271,
      price_band_max: 285,
      issue_size_cr: 301.62,
      // The "Lot Size" column in the Market Lot table is a lot *count* (1);
      // the real shares-per-lot value is the Retail Minimum row's Shares cell.
      lot_size: 52,
      allotment_date: '2026-08-17',
    });
  });

  it('degrades every field to null rather than throwing when the page has none of these tables', () => {
    expect(parseIpowatchIpoDetail('<p>withdrawn, no tables here</p>')).toEqual({
      price_band_min: null,
      price_band_max: null,
      issue_size_cr: null,
      lot_size: null,
      allotment_date: null,
    });
  });
});

describe('mergeIpowatchDetail', () => {
  const base = ipowatchIpoRow(GMP_ROW, new Map(), new Map(), '2026-08-11')!;
  const full: IpowatchIpoDetail = {
    price_band_min: 271,
    price_band_max: 285,
    issue_size_cr: 301.62,
    lot_size: 52,
    allotment_date: '2026-08-17',
  };

  it('fills in every detail field the list page could not supply', () => {
    expect(mergeIpowatchDetail(base, full)).toMatchObject(full);
  });

  it('keeps the list page value when the detail page could not produce one', () => {
    const empty: IpowatchIpoDetail = {
      price_band_min: null,
      price_band_max: null,
      issue_size_cr: null,
      lot_size: null,
      allotment_date: null,
    };
    // base already has price_band_min/max: 285 from the GMP table's coarser cell.
    expect(mergeIpowatchDetail(base, empty)).toMatchObject({
      price_band_min: base.price_band_min,
      price_band_max: base.price_band_max,
      lot_size: null,
      issue_size_cr: null,
      allotment_date: null,
    });
  });
});

// --- row mapping -----------------------------------------------------------

const LISTING_BY_NAME = new Map<string, IpowatchListingRow>([
  [
    normalizeName('Behari Lal Engineering'),
    {
      company_name: 'Behari Lal Engineering',
      url: 'https://ipowatch.in/behari-lal-engineering-ipo/',
      listing_date_cell: '19 August 2026',
      bse_symbol: '',
      nse_symbol: '',
    },
  ],
]);

describe('ipowatchIpoRow', () => {
  it('maps a live row, including the listing date the GMP table itself does not carry', () => {
    const record = ipowatchIpoRow(GMP_ROW, LISTING_BY_NAME, new Map(), '2026-08-11');
    expect(record).toMatchObject({
      symbol: 'BEHARILALENGINEERING',
      company_name: 'Behari Lal Engineering',
      exchange: 'NSE',
      segment: 'MAINBOARD',
      status: 'UPCOMING',
      open_date: '2026-08-12',
      close_date: '2026-08-14',
      listing_date: '2026-08-19',
      price_band_min: 285,
      price_band_max: 285,
      lot_size: null,
      issue_size_cr: null,
      allotment_date: null,
      source: 'IPOWATCH',
    });
  });

  it('reuses the symbol an exchange already used this run, instead of duplicating', () => {
    const prior = new Map([[`${normalizeName('Behari Lal Engineering')}|2026-08-12`, 'BLENG']]);
    expect(ipowatchIpoRow(GMP_ROW, LISTING_BY_NAME, prior, '2026-08-11')?.symbol).toBe('BLENG');
  });

  it('prefers a real exchange symbol over both', () => {
    const withSymbol = new Map(LISTING_BY_NAME).set(normalizeName('Behari Lal Engineering'), {
      ...LISTING_BY_NAME.get(normalizeName('Behari Lal Engineering'))!,
      nse_symbol: 'BEHARILAL',
    });
    const prior = new Map([[`${normalizeName('Behari Lal Engineering')}|2026-08-12`, 'BLENG']]);
    expect(ipowatchIpoRow(GMP_ROW, withSymbol, prior, '2026-08-11')?.symbol).toBe('BEHARILAL');
  });

  it('excludes SME issues entirely — this sync only tracks Mainboard', () => {
    expect(
      ipowatchIpoRow({ ...GMP_ROW, type_cell: 'NSE SME' }, new Map(), new Map(), '2026-08-11'),
    ).toBeNull();
    expect(
      ipowatchIpoRow({ ...GMP_ROW, type_cell: 'BSE SME' }, new Map(), new Map(), '2026-08-11'),
    ).toBeNull();
  });

  it('leaves listing_date null when the company has not appeared on the listing-date page yet', () => {
    expect(ipowatchIpoRow(GMP_ROW, new Map(), new Map(), '2026-08-11')?.listing_date).toBeNull();
  });

  it('skips rows with no parseable date range, which would duplicate on every run', () => {
    const undated = { ...GMP_ROW, date_cell: 'TBA' };
    expect(ipowatchIpoRow(undated, LISTING_BY_NAME)).toBeNull();
  });

  it('skips rows with no company name', () => {
    expect(ipowatchIpoRow({ ...GMP_ROW, company_name: '' }, LISTING_BY_NAME)).toBeNull();
  });
});

describe('ipowatchGmpRow', () => {
  it('maps a live GMP row', () => {
    expect(ipowatchGmpRow(GMP_ROW, RUN)).toEqual({
      provider: 'IPOWATCH',
      provider_slug: 'behari-lal-engineering-ipo',
      company_name: 'Behari Lal Engineering',
      open_date: '2026-08-12',
      observed_at: '2026-08-11T02:15:00.000Z',
      gmp: 53,
      gmp_percent: 18.6,
      price: 285,
      sub_times: null,
      source_url: 'https://ipowatch.in/behari-lal-engineering-ipo/',
    });
  });

  it('treats "₹-" as no quote, not as zero premium', () => {
    const noQuote = { ...GMP_ROW, gmp_cell: '₹-', est_listing_cell: '₹- (0.00%)' };
    expect(ipowatchGmpRow(noQuote, RUN)).toMatchObject({ gmp: null });
  });

  it('skips a row with no slug, since the slug is the only reliable join key', () => {
    expect(ipowatchGmpRow({ ...GMP_ROW, url: null }, RUN)).toBeNull();
  });

  it('excludes SME issues entirely — no GMP reading for an issue we no longer track', () => {
    expect(ipowatchGmpRow({ ...GMP_ROW, type_cell: 'NSE SME' }, RUN)).toBeNull();
    expect(ipowatchGmpRow({ ...GMP_ROW, type_cell: 'BSE SME' }, RUN)).toBeNull();
  });
});

// --- primitives retrofitted from index.ts ----------------------------------

describe('parseDate', () => {
  it('reads the exchange format', () => {
    expect(parseDate('12-Aug-2026')).toBe('2026-08-12');
    expect(parseDate('9-Aug-2026')).toBe('2026-08-09');
  });

  it('passes ISO through', () => {
    expect(parseDate('2026-08-12T00:00:00.000Z')).toBe('2026-08-12');
  });

  it('is null for junk', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate(null)).toBeNull();
  });
});

describe('parsePriceBand', () => {
  it('reads a band', () => {
    expect(parsePriceBand('92.00 to 97.00')).toEqual([92, 97]);
    expect(parsePriceBand('₹ 100 - 105')).toEqual([100, 105]);
  });

  it('repeats a single price as both ends', () => {
    expect(parsePriceBand('105')).toEqual([105, 105]);
  });

  it('is null for junk', () => {
    expect(parsePriceBand('')).toEqual([null, null]);
    expect(parsePriceBand(undefined)).toEqual([null, null]);
  });
});

describe('toNumber', () => {
  it('strips currency and separators', () => {
    expect(toNumber('₹1,617.48 Cr')).toBe(1617.48);
    expect(toNumber(42)).toBe(42);
  });

  it('is null for the feed placeholders', () => {
    expect(toNumber('-')).toBeNull();
    expect(toNumber('')).toBeNull();
    expect(toNumber(null)).toBeNull();
  });
});

describe('statusFor', () => {
  it('walks the lifecycle across the boundary days', () => {
    expect(statusFor('2026-08-12', '2026-08-14', '2026-08-11')).toBe('UPCOMING');
    expect(statusFor('2026-08-12', '2026-08-14', '2026-08-12')).toBe('OPEN');
    expect(statusFor('2026-08-12', '2026-08-14', '2026-08-14')).toBe('OPEN');
    expect(statusFor('2026-08-12', '2026-08-14', '2026-08-15')).toBe('CLOSED');
  });

  it('assumes upcoming when the window is incomplete', () => {
    expect(statusFor('2026-08-12', null, '2026-08-13')).toBe('UPCOMING');
    expect(statusFor(null, null, '2026-08-13')).toBe('UPCOMING');
  });
});
