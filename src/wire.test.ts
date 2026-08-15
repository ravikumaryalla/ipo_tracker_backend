/**
 * The wire format is a contract with the shipped app: lib/types.ts declares
 * these exact shapes and every screen parses them. A Decimal that serialises as
 * a string, or a date that gains a time component, breaks the client silently —
 * the fields are still there, just the wrong type.
 */
import { Prisma } from '@prisma/client';

import { day, gmpRow, ipoRow, pnlRow } from './wire.js';

const D = (v: string) => new Prisma.Decimal(v);

describe('day', () => {
  it('renders a date column as YYYY-MM-DD', () => {
    expect(day(new Date('2026-08-14T00:00:00.000Z'))).toBe('2026-08-14');
  });

  it('uses UTC, so the day does not shift for a non-UTC reader', () => {
    // Prisma hands back `date` columns at UTC midnight. Going through local time
    // would render this as the 13th anywhere west of Greenwich.
    expect(day(new Date(Date.UTC(2026, 7, 14)))).toBe('2026-08-14');
  });

  it('passes null through', () => {
    expect(day(null)).toBeNull();
  });
});

describe('ipoRow', () => {
  const base = {
    id: 'i1',
    symbol: 'TESTCO',
    companyName: 'Test Co',
    exchange: 'NSE',
    segment: 'MAINBOARD' as const,
    status: 'OPEN' as const,
    openDate: new Date('2026-08-01T00:00:00.000Z'),
    closeDate: new Date('2026-08-03T00:00:00.000Z'),
    allotmentDate: null,
    listingDate: null,
    priceBandMin: D('100.00'),
    priceBandMax: D('105.50'),
    lotSize: 15,
    issueSizeCr: D('1200.00'),
    listingPrice: null,
    currentPrice: null,
    registrar: 'KFintech',
    registrarUrl: 'https://ipostatus.kfintech.com/',
    kfintechCompanyId: null,
    source: 'NSE',
    createdBy: null,
    lastSyncedAt: new Date('2026-08-14T09:30:00.000Z'),
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-14T09:30:00.000Z'),
  };

  it('emits numerics as JSON numbers, not Decimal strings', () => {
    const row = ipoRow(base);
    expect(row.price_band_min).toBe(100);
    expect(row.price_band_max).toBe(105.5);
    expect(row.issue_size_cr).toBe(1200);
    // The failure this guards against: JSON.stringify(Decimal) yields "100",
    // and `Number(null)` yields 0, so both mistakes survive a shallow check.
    expect(typeof row.price_band_min).toBe('number');
  });

  it('keeps dates day-only and timestamps full ISO', () => {
    const row = ipoRow(base);
    expect(row.open_date).toBe('2026-08-01');
    expect(row.last_synced_at).toBe('2026-08-14T09:30:00.000Z');
  });

  it('preserves nulls rather than coercing them to zero', () => {
    const row = ipoRow(base);
    expect(row.listing_price).toBeNull();
    expect(row.allotment_date).toBeNull();
  });

  it('uses the snake_case keys the app declares', () => {
    const row = ipoRow(base);
    expect(row).toHaveProperty('company_name', 'Test Co');
    expect(row).toHaveProperty('kfintech_company_id', null);
    expect(row).not.toHaveProperty('companyName');
  });
});

describe('gmpRow', () => {
  it('converts every numeric column and leaves an unquoted reading null', () => {
    const row = gmpRow({
      id: 'g1',
      ipoId: 'i1',
      provider: 'IPOGYANI',
      providerSlug: 'test-co-ipo',
      companyName: 'Test Co',
      openDate: new Date('2026-08-01T00:00:00.000Z'),
      observedAt: new Date('2026-08-02T12:00:00.000Z'),
      gmp: D('42.00'),
      gmpPercent: D('40.00'),
      price: D('105.00'),
      subTimes: null,
      sourceUrl: null,
      syncedAt: new Date('2026-08-02T12:05:00.000Z'),
      createdAt: new Date('2026-08-02T12:05:00.000Z'),
    });

    expect(row.gmp).toBe(42);
    expect(row.gmp_percent).toBe(40);
    expect(row.price).toBe(105);
    // null means "no quote", which is different from a quote of zero — the
    // chart draws a gap for one and a point at the axis for the other.
    expect(row.sub_times).toBeNull();
    expect(row.open_date).toBe('2026-08-01');
  });
});

describe('pnlRow', () => {
  it('coerces the numerics the pg driver hands back as strings', () => {
    const row = pnlRow({
      id: 'a1',
      user_id: 'u1',
      status: 'ALLOTTED',
      bid_price: '100.00',
      amount_blocked: '1500.00',
      listing_price: '120.00',
      current_price: null,
      amount_invested: '1500.00',
      amount_currently_blocked: '0.00',
      realised_pnl: '0.00',
      unrealised_pnl: '300.00',
      applied_at: new Date('2026-08-01T00:00:00.000Z'),
      sold_at: null,
      allotment_checked_at: null,
      open_date: new Date('2026-08-01T00:00:00.000Z'),
      close_date: null,
      allotment_date: null,
      listing_date: null,
    });

    expect(row.bid_price).toBe(100);
    expect(row.unrealised_pnl).toBe(300);
    expect(row.current_price).toBeNull();
    expect(row.applied_at).toBe('2026-08-01T00:00:00.000Z');
    expect(row.open_date).toBe('2026-08-01');
    // Columns it does not touch pass through untouched.
    expect(row.status).toBe('ALLOTTED');
  });
});
