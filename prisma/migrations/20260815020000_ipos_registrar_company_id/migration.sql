-- One registrar company id, plus a discriminator saying whose it is.
--
-- kfintech_company_id and mufg_company_id were always mutually exclusive — an
-- issue has one registrar — so a third registrar (Bigshare) would have meant a
-- third column, a third branch in companyIdFor(), and a third wire field for no
-- gain. They collapse into registrar_company_id + registrar_key.
--
-- registrar_key is NOT the same thing as the existing `registrar` column.
-- `registrar` is display copy: a user can type it on the manual-add form, and
-- its column default is the literal 'KFintech', so most rows carry that string
-- without anyone having verified it. registrar_key is only ever written after a
-- match against that registrar's own company list, so it is evidence. The
-- allotment check used to approximate this distinction with a heuristic
-- (registrarIsEvidence); this column replaces it.

alter table public.ipos add column registrar_company_id text;
alter table public.ipos add column registrar_key text;

comment on column public.ipos.registrar_company_id is
  'The registrar''s own id for this issue''s allotment lookup; null when unmatched.';
comment on column public.ipos.registrar_key is
  'Which registrar registrar_company_id belongs to: KFINTECH, MUFG or BIGSHARE.';

-- Backfill. MUFG runs second so that a row which somehow carries both ids ends
-- up keyed to MUFG — matching companyIdFor()'s old precedence, which checked
-- mufg_company_id first.
update public.ipos
   set registrar_company_id = kfintech_company_id,
       registrar_key        = 'KFINTECH'
 where kfintech_company_id is not null;

update public.ipos
   set registrar_company_id = mufg_company_id,
       registrar_key        = 'MUFG'
 where mufg_company_id is not null;

-- Same partial-index reasoning as the columns it replaces: the overwhelming
-- majority of rows are null, and only the matched ones are looked up by id.
create index ipos_registrar_company_id_idx
  on public.ipos (registrar_company_id) where registrar_company_id is not null;

drop index if exists public.ipos_mufg_company_id_idx;

-- v_application_pnl selects i.kfintech_company_id, so the drop below would fail
-- on the dependency. Recreated without any registrar id at all rather than with
-- the new one: its only consumer was the app's pre-flight check for a KFintech
-- match, which is gone — the app now posts application ids and lets the server
-- resolve the registrar. Every other column is carried through unchanged.
drop view public.v_application_pnl;

alter table public.ipos drop column kfintech_company_id;
alter table public.ipos drop column mufg_company_id;

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

  a.allotment_checked_at

from public.ipo_applications a
join public.ipos i on i.id = a.ipo_id
join public.demat_accounts d on d.id = a.demat_account_id;
