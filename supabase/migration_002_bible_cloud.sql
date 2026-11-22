-- VendoTube Studio · migration 002 — Bible cloud-save (vendoria.ai Supabase project)
--
-- ⚠️ ALREADY APPLIED to project ercipwxeirrwzpbvlgkn ("vendoriaai's Project")
-- on 2026-11-22 via the Management API query endpoint — do NOT re-run there.
-- Kept as the reference migration for a FRESH/empty Supabase project.
--
-- Co-tenant-safe: all tables are `vendotube_`-prefixed (the project is shared
-- with a sibling chat/RAG app) and every table is RLS-scoped to the owning
-- auth user. Only LINKS are stored — the downloaded media files never leave
-- the user's machine.
--
-- Layout:
--   vendotube_bibles        one row per (user_id, project_slug); payload jsonb
--                           holds the Bible-section result (bible, beats,
--                           script sections, scene notes, stage)
--   vendotube_bible_sources website/article links from the research ledger
--   vendotube_bible_assets  image/video links from the research ledger

create table if not exists public.vendotube_bibles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_slug text not null,
  title text,
  stage text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, project_slug)
);

create table if not exists public.vendotube_bible_sources (
  id uuid primary key default gen_random_uuid(),
  bible_id uuid not null references public.vendotube_bibles (id) on delete cascade,
  url text not null,
  title text,
  publisher text,
  published_date text,
  source_type text,
  license text,
  created_at timestamptz not null default now(),
  unique (bible_id, url)
);

create table if not exists public.vendotube_bible_assets (
  id uuid primary key default gen_random_uuid(),
  bible_id uuid not null references public.vendotube_bibles (id) on delete cascade,
  url text not null,
  title text,
  media_type text,
  provider text,
  license text,
  license_url text,
  creator text,
  created_at timestamptz not null default now(),
  unique (bible_id, url)
);

alter table public.vendotube_bibles enable row level security;
alter table public.vendotube_bible_sources enable row level security;
alter table public.vendotube_bible_assets enable row level security;

drop policy if exists "vendotube_bibles: own all" on public.vendotube_bibles;
create policy "vendotube_bibles: own all" on public.vendotube_bibles
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Child tables resolve ownership through their bible row.
drop policy if exists "vendotube_bible_sources: own via bible" on public.vendotube_bible_sources;
create policy "vendotube_bible_sources: own via bible" on public.vendotube_bible_sources
  for all
  using (exists (select 1 from public.vendotube_bibles b where b.id = bible_id and b.user_id = auth.uid()))
  with check (exists (select 1 from public.vendotube_bibles b where b.id = bible_id and b.user_id = auth.uid()));

drop policy if exists "vendotube_bible_assets: own via bible" on public.vendotube_bible_assets;
create policy "vendotube_bible_assets: own via bible" on public.vendotube_bible_assets
  for all
  using (exists (select 1 from public.vendotube_bibles b where b.id = bible_id and b.user_id = auth.uid()))
  with check (exists (select 1 from public.vendotube_bibles b where b.id = bible_id and b.user_id = auth.uid()));
