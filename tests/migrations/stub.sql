-- Minimal stand-ins for the parts of the Supabase platform our migration depends on,
-- just enough to exercise the real RLS/constraint/cascade behavior of the migration
-- SQL itself under a real Postgres engine. Not a mock of our logic — a stub of the
-- surrounding platform pieces (auth.uid(), storage schema) that Supabase provides.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid
);
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

create or replace function storage.foldername(name text) returns text[]
language sql stable
as $$
  select string_to_array(name, '/')
$$;
