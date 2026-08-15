-- IPO Tracker — initial schema for the standalone Postgres.
--
-- This is the Supabase schema (supabase/migrations/*.sql, squashed) with three
-- differences:
--   1. `auth.users` is replaced by `public.users`, plus refresh/reset token
--      tables, so identity is ours.
--   2. No Row Level Security. Ownership is enforced in the Express handlers.
--   3. No pg_cron / pg_net / vault. The scrapers are POST /jobs/* endpoints
--      driven by an external scheduler.
--
-- SECURITY CONTRACT: every column holding a demat credential ends in `_enc` and
-- is TEXT holding base64(nonce || ciphertext) produced on-device. There is
-- deliberately no plaintext credential column except `demat_accounts.pan`,
-- which the allotment job requires. Adding another is a bug.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- enums
-- ---------------------------------------------------------------------------
create type public.ipo_segment as enum ('MAINBOARD', 'SME');
create type public.ipo_status  as enum ('UPCOMING', 'OPEN', 'CLOSED', 'LISTED', 'WITHDRAWN');
create type public.application_category as enum
  ('RETAIL', 'SHNI', 'BHNI', 'SHAREHOLDER', 'EMPLOYEE', 'POLICYHOLDER');
create type public.application_status as enum
  ('APPLIED', 'ALLOTTED', 'PARTIAL', 'NOT_ALLOTTED', 'WITHDRAWN', 'REFUNDED');

-- ---------------------------------------------------------------------------
-- identity — replaces Supabase auth.users
-- ---------------------------------------------------------------------------
create table public.users (
  id                uuid primary key default gen_random_uuid(),
  -- Stored lowercased by the application, so a plain unique index is a
  -- case-insensitive one without depending on the citext extension.
  email             text not null unique,
  password_hash     text not null,
  email_verified_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Opaque and rotating. Hashed so a database read does not yield a live session.
create table public.refresh_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index refresh_tokens_user_id_idx on public.refresh_tokens(user_id);

create table public.password_reset_tokens (
  token_hash text primary key,
  user_id    uuid not null references public.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index password_reset_tokens_user_id_idx on public.password_reset_tokens(user_id);

-- ---------------------------------------------------------------------------
-- profiles: the public half of the vault crypto
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                  uuid primary key references public.users(id) on delete cascade,
  display_name        text,
  -- A salt is not a secret; storing it lets a reinstall re-derive the vault key
  -- from the master passphrase alone.
  vault_salt          text,
  -- Known plaintext encrypted under the vault key, so a wrong passphrase is
  -- detected up front instead of silently producing garbage.
  vault_verifier      text,
  -- Vault key wrapped under a key derived from the printable recovery code.
  vault_recovery_blob text,
  auto_lock_minutes   integer not null default 5 check (auto_lock_minutes between 0 and 1440),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on column public.profiles.vault_salt is
  'Argon2id salt (base64). Public by design; the passphrase never leaves the device.';

-- ---------------------------------------------------------------------------
-- brokers: shared reference data
-- ---------------------------------------------------------------------------
create table public.brokers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  website    text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- demat_accounts: the vault
-- ---------------------------------------------------------------------------
create table public.demat_accounts (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.users(id) on delete cascade,
  broker_id           uuid references public.brokers(id) on delete set null,
  -- Non-secret label so the list can render without unlocking the vault.
  nickname            text not null,
  client_id_enc       text,
  dp_id_enc           text,
  bo_id_enc           text,
  email_enc           text,
  phone_enc           text,
  password_enc        text,
  mpin_enc            text,
  upi_id_enc          text,
  linked_bank_enc     text,
  -- Legacy encrypted PAN, kept only as the source for the one-time client-side
  -- backfill into `pan` (lib/db/accounts.ts#migratePanIfNeeded).
  pan_enc             text,
  -- Deliberate plaintext exception: the allotment job must query KFintech with
  -- a readable PAN, and the server has never held the vault key.
  pan                 text,
  notes_enc           text,
  is_active           boolean not null default true,
  opened_on           date,
  password_changed_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index demat_accounts_user_idx on public.demat_accounts(user_id) where is_active;

comment on column public.demat_accounts.email_enc is 'Login email for the broker/DP portal.';
comment on column public.demat_accounts.phone_enc is 'Login phone number for the broker/DP portal.';
comment on column public.demat_accounts.mpin_enc  is 'MPIN, the short numeric password brokers ask for at login or order placement.';

-- ---------------------------------------------------------------------------
-- ipos: public market data. created_by null = synced/shared row.
-- ---------------------------------------------------------------------------
create table public.ipos (
  id                  uuid primary key default gen_random_uuid(),
  symbol              text not null,
  company_name        text not null,
  exchange            text not null default 'NSE',
  segment             public.ipo_segment not null default 'MAINBOARD',
  status              public.ipo_status  not null default 'UPCOMING',
  open_date           date,
  close_date          date,
  allotment_date      date,
  listing_date        date,
  price_band_min      numeric(12,2),
  price_band_max      numeric(12,2),
  lot_size            integer check (lot_size > 0),
  issue_size_cr       numeric(14,2),
  listing_price       numeric(12,2),
  current_price       numeric(12,2),
  -- A display name, not a code — it is rendered into "Check allotment at <x>".
  registrar           text default 'KFintech',
  registrar_url       text default 'https://ipostatus.kfintech.com/',
  kfintech_company_id text,
  -- 'NSE' | 'BSE' | 'MANUAL'
  source              text not null default 'MANUAL',
  created_by          uuid references public.users(id) on delete cascade,
  last_synced_at      timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on column public.ipos.kfintech_company_id is
  'KFintech''s internal clientId for this issue''s allotment-status lookup, when the issue is KFintech-registered and the sync job has matched it. Null otherwise.';

-- Upsert key for the sync job. Two IPOs never share symbol + open date.
create unique index ipos_symbol_open_idx on public.ipos(symbol, open_date);
create index ipos_dates_idx on public.ipos(open_date desc nulls last);
-- Sparse: doubles as the "does this IPO support automatic allotment check" test.
create index ipos_kfintech_company_id_idx
  on public.ipos (kfintech_company_id) where kfintech_company_id is not null;

-- ---------------------------------------------------------------------------
-- ipo_applications
-- ---------------------------------------------------------------------------
create table public.ipo_applications (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.users(id) on delete cascade,
  ipo_id               uuid not null references public.ipos(id) on delete cascade,
  demat_account_id     uuid not null references public.demat_accounts(id) on delete cascade,
  category             public.application_category not null default 'RETAIL',
  lots                 integer not null check (lots > 0),
  bid_price            numeric(12,2) not null check (bid_price > 0),
  -- Denormalised so history stays correct even if the IPO's lot size is edited.
  shares_applied       integer not null check (shares_applied > 0),
  amount_blocked       numeric(14,2) not null check (amount_blocked >= 0),
  application_no       text,
  upi_ref              text,
  applied_at           timestamptz not null default now(),
  status               public.application_status not null default 'APPLIED',
  shares_allotted      integer not null default 0 check (shares_allotted >= 0),
  allotment_checked_at timestamptz,
  sell_price           numeric(12,2),
  sold_at              timestamptz,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- One application per account per category per IPO — matches SEBI rules. The
  -- client turns the resulting 23505 into specific copy, so this name is API.
  constraint ipo_applications_unique_bid unique (ipo_id, demat_account_id, category),
  constraint shares_allotted_within_applied check (shares_allotted <= shares_applied)
);

create index ipo_applications_user_idx on public.ipo_applications(user_id);
create index ipo_applications_ipo_idx  on public.ipo_applications(ipo_id);

-- ---------------------------------------------------------------------------
-- credential_history: append-only prior ciphertext, so a bad edit is recoverable
-- ---------------------------------------------------------------------------
create table public.credential_history (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  demat_account_id uuid not null references public.demat_accounts(id) on delete cascade,
  field            text not null,
  old_value_enc    text not null,
  changed_at       timestamptz not null default now()
);

create index credential_history_account_idx
  on public.credential_history(demat_account_id, changed_at desc);

-- ---------------------------------------------------------------------------
-- ipo_gmp: append-only grey market premium time series.
--
-- GMP is unregulated, unofficial, and manipulable on thinly-traded SME issues.
-- Anything rendering it must say so. Stored as a series, never as a column on
-- `ipos`: a single reading is close to meaningless, and overwriting would
-- destroy the only record of what the market thought at the time.
-- ---------------------------------------------------------------------------
create table public.ipo_gmp (
  id            uuid primary key default gen_random_uuid(),
  -- Nullable on purpose: providers often quote a grey market before NSE or BSE
  -- publish the issue. The backfill pass re-tries these every run.
  ipo_id        uuid references public.ipos(id) on delete cascade,
  provider      text not null default 'IPOWATCH',
  provider_slug text not null,
  company_name  text not null,
  open_date     date,
  -- The provider's own "last updated" stamp, NOT our fetch time.
  observed_at   timestamptz not null,
  gmp           numeric(12,2),
  gmp_percent   numeric(6,2),
  price         numeric(12,2),
  sub_times     numeric(10,2),
  source_url    text,
  synced_at     timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

comment on table public.ipo_gmp is
  'Append-only grey market premium readings. Unofficial data — display with a disclaimer.';

-- Idempotency: re-running a sync inside one provider update window is a no-op.
create unique index ipo_gmp_reading_idx on public.ipo_gmp (provider, provider_slug, observed_at);
-- The charting query: newest N readings for one IPO.
create index ipo_gmp_ipo_idx on public.ipo_gmp (ipo_id, observed_at desc);
-- The backfill query: readings still waiting for an `ipos` row.
create index ipo_gmp_unmatched_idx on public.ipo_gmp (open_date, provider_slug) where ipo_id is null;

-- ---------------------------------------------------------------------------
-- sync_log: why the IPO list is stale, surfaced in-app instead of failing quietly
-- ---------------------------------------------------------------------------
create table public.sync_log (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  ok            boolean not null,
  rows_upserted integer not null default 0,
  message       text,
  ran_at        timestamptz not null default now()
);

create index sync_log_ran_at_idx on public.sync_log(ran_at desc);

-- ---------------------------------------------------------------------------
-- push_tokens: one row per device, since an account can have the app on more
-- than one phone.
-- ---------------------------------------------------------------------------
create table public.push_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  token      text not null,
  created_at timestamptz not null default now(),
  unique (user_id, token)
);

-- ---------------------------------------------------------------------------
-- keep updated_at honest
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger users_touch             before update on public.users
  for each row execute function public.touch_updated_at();
create trigger profiles_touch          before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger demat_accounts_touch    before update on public.demat_accounts
  for each row execute function public.touch_updated_at();
create trigger ipos_touch              before update on public.ipos
  for each row execute function public.touch_updated_at();
create trigger ipo_applications_touch  before update on public.ipo_applications
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- v_application_pnl: per-application economics, computed in Postgres so the
-- dashboard is one query instead of client-side math over every row.
--
-- The Supabase version carried `with (security_invoker = on)` so the view
-- respected the querying user's RLS policies. RLS is gone; the API filters on
-- user_id in the handler instead, so that flag is deliberately dropped here.
-- ---------------------------------------------------------------------------
create view public.v_application_pnl as
select
  a.id,
  a.user_id,
  a.ipo_id,
  a.demat_account_id,
  a.category,
  a.status,
  a.lots,
  a.bid_price,
  a.shares_applied,
  a.amount_blocked,
  a.shares_allotted,
  a.applied_at,
  a.sell_price,
  a.sold_at,
  i.symbol,
  i.company_name,
  i.segment,
  i.open_date,
  i.close_date,
  i.allotment_date,
  i.listing_date,
  i.listing_price,
  i.current_price,
  d.nickname as account_nickname,

  -- What the allotment actually cost.
  (a.shares_allotted * a.bid_price)::numeric(14,2) as amount_invested,

  -- Money still with the registrar: blocked while the bid is live, released
  -- once the outcome is known.
  case when a.status = 'APPLIED' then a.amount_blocked else 0 end::numeric(14,2)
    as amount_currently_blocked,

  -- Realised P&L once sold; otherwise unrealised against the best price we know
  -- (live price if we have it, else the listing price).
  case
    when a.sell_price is not null
      then (a.shares_allotted * (a.sell_price - a.bid_price))
    else 0
  end::numeric(14,2) as realised_pnl,

  case
    when a.sell_price is null and a.shares_allotted > 0
      then (a.shares_allotted * (coalesce(i.current_price, i.listing_price, a.bid_price) - a.bid_price))
    else 0
  end::numeric(14,2) as unrealised_pnl,

  i.kfintech_company_id,
  a.allotment_checked_at

from public.ipo_applications a
join public.ipos i on i.id = a.ipo_id
join public.demat_accounts d on d.id = a.demat_account_id;

-- ---------------------------------------------------------------------------
-- Indian brokers, seeded once. Idempotent so re-running is safe.
-- ---------------------------------------------------------------------------
insert into public.brokers (name, slug, website) values
  ('Zerodha',            'zerodha',      'https://zerodha.com'),
  ('Groww',              'groww',        'https://groww.in'),
  ('Upstox',             'upstox',       'https://upstox.com'),
  ('Angel One',          'angel-one',    'https://angelone.in'),
  ('ICICI Direct',       'icici-direct', 'https://icicidirect.com'),
  ('HDFC Securities',    'hdfc-sec',     'https://hdfcsec.com'),
  ('Kotak Securities',   'kotak-sec',    'https://kotaksecurities.com'),
  ('5paisa',             '5paisa',       'https://5paisa.com'),
  ('Motilal Oswal',      'motilal',      'https://motilaloswal.com'),
  ('Sharekhan',          'sharekhan',    'https://sharekhan.com'),
  ('SBI Securities',     'sbi-sec',      'https://sbisecurities.in'),
  ('Axis Direct',        'axis-direct',  'https://axisdirect.in'),
  ('Dhan',               'dhan',         'https://dhan.co'),
  ('Fyers',              'fyers',        'https://fyers.in'),
  ('Paytm Money',        'paytm-money',  'https://paytmmoney.com'),
  ('IIFL Securities',    'iifl',         'https://iiflcapital.com'),
  ('Other',              'other',        null)
on conflict (slug) do nothing;
