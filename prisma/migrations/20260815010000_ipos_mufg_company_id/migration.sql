-- MUFG Intime's company id, the twin of kfintech_company_id.
--
-- The allotment check now routes by registrar rather than sending every
-- application to KFintech, and MUFG's search wants their own dropdown id. Same
-- shape as the KFintech column: nullable text, resolved once per issue by a
-- fuzzy name match, plus a partial index because the overwhelming majority of
-- rows are null and only the matched ones are ever looked up by it.

alter table public.ipos add column mufg_company_id text;

comment on column public.ipos.mufg_company_id is
  'MUFG Intime dropdown company_id for the allotment lookup; null when unmatched.';

create index ipos_mufg_company_id_idx
  on public.ipos (mufg_company_id) where mufg_company_id is not null;
