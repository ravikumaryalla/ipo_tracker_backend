-- One row per IPO, on two keys: the company (name + open date) and the symbol.
--
-- The old key was (symbol, open_date), which caught neither duplicate the table
-- actually accumulated:
--
--   - Postgres treats NULLs as distinct, so a row with a null open_date could
--     duplicate without limit.
--   - The scrapers synthesise a symbol from the company name, and that
--     synthesis has changed across releases. One company therefore sits in the
--     table under several symbols with an identical open date — BEHARILALENGINEERING
--     / BEHARILAL / BLEL are all Behari Lal Engineering opening 2026-08-12. A
--     unique index on symbol alone does not touch those; the company itself has
--     to be the key.
--
-- Collapsing keeps the NEWEST row of each group and moves its children across
-- first, so no user application or GMP reading is lost to the cascade.

-- ---------------------------------------------------------------------------
-- the company key
-- ---------------------------------------------------------------------------

-- Mirrors normalizeName() in src/jobs/syncIpos.parse.ts: lowercase, "&" spelled
-- out, punctuation dropped, the legal-form noise words removed, then welded into
-- one string. "Behari Lal Engineering Ltd. IPO" and "Behari Lal Engineering"
-- both become "beharilalengineering".
--
-- IMMUTABLE because an index depends on it. Changing this body silently
-- invalidates ipos_company_idx — REINDEX it if you ever do.
create or replace function public.ipo_name_key(name text)
returns text
language sql
immutable
strict
parallel safe
as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(lower(name), '&', ' and ', 'g'),
               '[^a-z0-9]+', ' ', 'g'),
             '\y(ipo|ltd|limited|pvt|private|india|indian|the|inc|corp|corporation|company|co)\y',
             ' ', 'g'),
           '\s', '', 'g')
$$;

-- ---------------------------------------------------------------------------
-- pass 1 — collapse by company name + open date
-- ---------------------------------------------------------------------------

create temporary table ipo_dupes on commit drop as
with ranked as (
  select id,
         first_value(id) over (
           -- A window partition treats NULLs as equal, so dateless rows of the
           -- same company group together here as well.
           partition by public.ipo_name_key(company_name), open_date
           order by created_at desc, id desc
         ) as keeper_id
  from public.ipos
)
select id as dup_id, keeper_id from ranked where id <> keeper_id;

-- ipo_applications is unique on (ipo_id, demat_account_id, category), so a
-- repoint can collide. Drop the loser's application when the keeper already
-- holds the same bid; everything else moves across below.
delete from public.ipo_applications a
using ipo_dupes d
where a.ipo_id = d.dup_id
  and exists (
    select 1 from public.ipo_applications k
    where k.ipo_id = d.keeper_id
      and k.demat_account_id = a.demat_account_id
      and k.category = a.category
  );

update public.ipo_applications a
set ipo_id = d.keeper_id
from ipo_dupes d
where a.ipo_id = d.dup_id;

-- ipo_gmp keys on (provider, provider_slug, observed_at), independent of
-- ipo_id, so this repoint cannot conflict.
update public.ipo_gmp g
set ipo_id = d.keeper_id
from ipo_dupes d
where g.ipo_id = d.dup_id;

delete from public.ipos i using ipo_dupes d where i.id = d.dup_id;

drop table ipo_dupes;

-- ---------------------------------------------------------------------------
-- pass 2 — collapse by symbol
--
-- Same block against the rows pass 1 left behind, so a losing row can never
-- itself be some other row's keeper.
-- ---------------------------------------------------------------------------

create temporary table ipo_dupes on commit drop as
with ranked as (
  select id,
         first_value(id) over (
           partition by symbol order by created_at desc, id desc
         ) as keeper_id
  from public.ipos
)
select id as dup_id, keeper_id from ranked where id <> keeper_id;

delete from public.ipo_applications a
using ipo_dupes d
where a.ipo_id = d.dup_id
  and exists (
    select 1 from public.ipo_applications k
    where k.ipo_id = d.keeper_id
      and k.demat_account_id = a.demat_account_id
      and k.category = a.category
  );

update public.ipo_applications a
set ipo_id = d.keeper_id
from ipo_dupes d
where a.ipo_id = d.dup_id;

update public.ipo_gmp g
set ipo_id = d.keeper_id
from ipo_dupes d
where g.ipo_id = d.dup_id;

delete from public.ipos i using ipo_dupes d where i.id = d.dup_id;

drop table ipo_dupes;

-- ---------------------------------------------------------------------------
-- pass 3 — collapse a company whose name one feed published shorter
--
-- The keys above fold punctuation and legal suffixes, not a feed dropping a
-- whole word: "Lalithaa Jewellery" and "Lalithaa Jewellery Mart" open on the
-- same day and are one company under two different name keys. The sync's own
-- alignToExistingNames() stops new ones arriving; this clears the ones already
-- here.
--
-- Guarded hard, because a false merge destroys a real IPO: identical open date,
-- one key a strict prefix of the other, at least 10 characters of prefix, and a
-- single candidate on each side.
-- ---------------------------------------------------------------------------

create temporary table ipo_dupes on commit drop as
with keys as (
  select id, open_date, public.ipo_name_key(company_name) as k from public.ipos
), pairs as (
  select shorter.id as dup_id, longer.id as keeper_id
  from keys shorter
  join keys longer
    on shorter.id <> longer.id
   and shorter.open_date is not distinct from longer.open_date
   and length(shorter.k) >= 10
   and length(longer.k) > length(shorter.k)
   and longer.k like shorter.k || '%'
), unambiguous as (
  -- array_agg[1] rather than min(): Postgres has no min() for uuid, and the
  -- HAVING clause means there is exactly one element anyway.
  select dup_id, (array_agg(keeper_id))[1] as keeper_id
  from pairs group by dup_id having count(*) = 1
)
-- Never point at a row that is itself being deleted.
select dup_id, keeper_id from unambiguous
where keeper_id not in (select dup_id from unambiguous);

delete from public.ipo_applications a
using ipo_dupes d
where a.ipo_id = d.dup_id
  and exists (
    select 1 from public.ipo_applications k
    where k.ipo_id = d.keeper_id
      and k.demat_account_id = a.demat_account_id
      and k.category = a.category
  );

update public.ipo_applications a
set ipo_id = d.keeper_id
from ipo_dupes d
where a.ipo_id = d.dup_id;

update public.ipo_gmp g
set ipo_id = d.keeper_id
from ipo_dupes d
where g.ipo_id = d.dup_id;

delete from public.ipos i using ipo_dupes d where i.id = d.dup_id;

drop table ipo_dupes;

-- ---------------------------------------------------------------------------
-- the keys themselves
-- ---------------------------------------------------------------------------

drop index if exists public.ipos_symbol_open_idx;

-- NULLS NOT DISTINCT: two undated rows of one company are the same IPO, and the
-- default would let them coexist forever. Needs Postgres 15+.
create unique index ipos_company_idx
  on public.ipos (public.ipo_name_key(company_name), open_date)
  nulls not distinct;

create unique index ipos_symbol_idx on public.ipos (symbol);
