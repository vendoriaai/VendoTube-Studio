-- VendoTube Studio · migration 001 — profiles table (vendoria.ai Supabase project)
--
-- ⚠️ DO NOT RUN against project ercipwxeirrwzpbvlgkn ("vendoriaai's Project"):
-- that project ALREADY has an equivalent (and compatible) setup created by
-- another app sharing the project — public.profiles (id, display_name,
-- preferred_model, settings jsonb, push_* columns), the on_auth_user_created
-- trigger (handle_new_user inserts id + display_name from the email local
-- part), and an RLS policy `profiles_own` (ALL, id = auth.uid()). VendoTube's
-- auth flow needs nothing more; this file is kept as the reference migration
-- for a FRESH/empty Supabase project.
--
-- Run ONCE: Supabase Dashboard → SQL Editor → paste → Run.
-- Idempotent (safe to re-run): drops/recreates its own policies + trigger.
--
-- What it does:
--   1. public.profiles — one row per auth user (id, email, display name).
--   2. Row Level Security — each user can read/insert/update ONLY their own row.
--   3. Auto-create trigger — every new auth.users row gets a profile instantly,
--      even before they confirm their email (the trigger runs as the table
--      owner, not as the unauthenticated new user).

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: select own" on public.profiles;
create policy "profiles: select own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles: insert own" on public.profiles;
create policy "profiles: insert own" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
