/**
 * Prisma rows -> the JSON the app already knows how to read.
 *
 * The wire format is deliberately unchanged from PostgREST: snake_case keys,
 * `numeric` as a JSON number, `timestamptz` as an ISO string, `date` as
 * YYYY-MM-DD. That is what lib/types.ts declares and what every screen parses,
 * so keeping it means the migration does not ripple into the UI.
 *
 * Two conversions have to happen explicitly, because JSON.stringify gets both
 * wrong on its own: Prisma's Decimal serialises to a string, and Prisma's
 * `@db.Date` values arrive as a Date at UTC midnight which toISOString() would
 * render with a time component.
 */
import type { Prisma } from '@prisma/client';
import type {
  Broker,
  CredentialHistory,
  DematAccount,
  Ipo,
  IpoApplication,
  IpoGmp,
  Profile,
  PushToken,
  SyncLog,
} from '@prisma/client';

type Decimal = Prisma.Decimal;

const num = (d: Decimal | null): number | null => (d === null ? null : d.toNumber());
const ts = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * A `date` column has no time and no zone. Prisma hands it back as a Date at
 * UTC midnight, so slicing the UTC ISO string is exact — going through local
 * time here would shift the day for anyone east or west of UTC.
 */
export const day = (d: Date | null): string | null =>
  d === null ? null : d.toISOString().slice(0, 10);

export function profileRow(p: Profile) {
  return {
    id: p.id,
    display_name: p.displayName,
    vault_salt: p.vaultSalt,
    vault_verifier: p.vaultVerifier,
    vault_recovery_blob: p.vaultRecoveryBlob,
    auto_lock_minutes: p.autoLockMinutes,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

export function brokerRow(b: Broker) {
  return {
    id: b.id,
    name: b.name,
    slug: b.slug,
    website: b.website,
    created_at: b.createdAt.toISOString(),
  };
}

export function dematAccountRow(a: DematAccount) {
  return {
    id: a.id,
    user_id: a.userId,
    broker_id: a.brokerId,
    nickname: a.nickname,
    client_id_enc: a.clientIdEnc,
    dp_id_enc: a.dpIdEnc,
    bo_id_enc: a.boIdEnc,
    email_enc: a.emailEnc,
    phone_enc: a.phoneEnc,
    password_enc: a.passwordEnc,
    mpin_enc: a.mpinEnc,
    upi_id_enc: a.upiIdEnc,
    linked_bank_enc: a.linkedBankEnc,
    pan: a.pan,
    pan_enc: a.panEnc,
    notes_enc: a.notesEnc,
    is_active: a.isActive,
    opened_on: day(a.openedOn),
    password_changed_at: ts(a.passwordChangedAt),
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
  };
}

export function ipoRow(i: Ipo) {
  return {
    id: i.id,
    symbol: i.symbol,
    company_name: i.companyName,
    exchange: i.exchange,
    segment: i.segment,
    status: i.status,
    open_date: day(i.openDate),
    close_date: day(i.closeDate),
    allotment_date: day(i.allotmentDate),
    listing_date: day(i.listingDate),
    price_band_min: num(i.priceBandMin),
    price_band_max: num(i.priceBandMax),
    lot_size: i.lotSize,
    issue_size_cr: num(i.issueSizeCr),
    listing_price: num(i.listingPrice),
    current_price: num(i.currentPrice),
    registrar: i.registrar,
    registrar_url: i.registrarUrl,
    registrar_company_id: i.registrarCompanyId,
    source: i.source,
    created_by: i.createdBy,
    last_synced_at: ts(i.lastSyncedAt),
    created_at: i.createdAt.toISOString(),
    updated_at: i.updatedAt.toISOString(),
  };
}

export function applicationRow(a: IpoApplication) {
  return {
    id: a.id,
    user_id: a.userId,
    ipo_id: a.ipoId,
    demat_account_id: a.dematAccountId,
    category: a.category,
    lots: a.lots,
    bid_price: a.bidPrice.toNumber(),
    shares_applied: a.sharesApplied,
    amount_blocked: a.amountBlocked.toNumber(),
    application_no: a.applicationNo,
    upi_ref: a.upiRef,
    applied_at: a.appliedAt.toISOString(),
    status: a.status,
    shares_allotted: a.sharesAllotted,
    allotment_checked_at: ts(a.allotmentCheckedAt),
    sell_price: num(a.sellPrice),
    sold_at: ts(a.soldAt),
    notes: a.notes,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
  };
}

export function credentialHistoryRow(c: CredentialHistory) {
  return {
    id: c.id,
    user_id: c.userId,
    demat_account_id: c.dematAccountId,
    field: c.field,
    old_value_enc: c.oldValueEnc,
    changed_at: c.changedAt.toISOString(),
  };
}

export function syncLogRow(s: SyncLog) {
  return {
    id: s.id,
    provider: s.provider,
    ok: s.ok,
    rows_upserted: s.rowsUpserted,
    message: s.message,
    ran_at: s.ranAt.toISOString(),
  };
}

export function pushTokenRow(p: PushToken) {
  return {
    id: p.id,
    user_id: p.userId,
    token: p.token,
    created_at: p.createdAt.toISOString(),
  };
}

export function gmpRow(g: IpoGmp) {
  return {
    id: g.id,
    ipo_id: g.ipoId,
    provider: g.provider,
    provider_slug: g.providerSlug,
    company_name: g.companyName,
    open_date: day(g.openDate),
    observed_at: g.observedAt.toISOString(),
    gmp: num(g.gmp),
    gmp_percent: num(g.gmpPercent),
    price: num(g.price),
    sub_times: num(g.subTimes),
    source_url: g.sourceUrl,
    synced_at: g.syncedAt.toISOString(),
    created_at: g.createdAt.toISOString(),
  };
}

/**
 * v_application_pnl is read with $queryRaw, so its rows arrive already
 * snake_cased from Postgres — only the numeric and date columns need coercing.
 * The pg driver hands `numeric` back as a string to avoid float64 precision
 * loss; every value here is rupees or a share count, well inside safe integer
 * range once scaled, so Number() is exact for our data.
 */
export type RawPnlRow = Record<string, unknown>;

const PNL_NUMERIC = [
  'bid_price',
  'amount_blocked',
  'listing_price',
  'current_price',
  'amount_invested',
  'amount_currently_blocked',
  'realised_pnl',
  'unrealised_pnl',
] as const;

const PNL_DATE = ['open_date', 'close_date', 'allotment_date', 'listing_date'] as const;

const PNL_TIMESTAMP = ['applied_at', 'sold_at', 'allotment_checked_at'] as const;

export function pnlRow(row: RawPnlRow) {
  const out: Record<string, unknown> = { ...row };

  for (const key of PNL_NUMERIC) {
    const v = out[key];
    out[key] = v === null || v === undefined ? null : Number(v);
  }
  for (const key of PNL_DATE) {
    const v = out[key];
    out[key] = v instanceof Date ? day(v) : (v ?? null);
  }
  for (const key of PNL_TIMESTAMP) {
    const v = out[key];
    out[key] = v instanceof Date ? v.toISOString() : (v ?? null);
  }
  return out;
}
