-- Initial schema for the Commercial Director MVP (doc 03/04/05).
-- Every table is created with RLS enabled and its policy in this same migration —
-- never added later. Ownership chains back to businesses.owner_user_id = auth.uid()
-- in every case (RULE-006, doc 05's access contract).
--
-- Defense in depth: every policy below is scoped `to authenticated` explicitly, and
-- anon/PUBLIC's default table-level grants are revoked on every application table
-- (not on storage.objects/storage.buckets, which Supabase's own Storage service
-- depends on and which RLS already governs). Belt and suspenders: even if a future
-- policy change were ever wrong, anon still has no grant to attempt the query at all.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- businesses
-- ---------------------------------------------------------------------------
create table businesses (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table businesses enable row level security;

revoke all on businesses from anon, public;

create policy "businesses_owner_select" on businesses
  for select
  to authenticated
  using (owner_user_id = auth.uid());

create policy "businesses_owner_insert" on businesses
  for insert
  to authenticated
  with check (owner_user_id = auth.uid());

create policy "businesses_owner_update" on businesses
  for update
  to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

-- Deletion additionally requires Storage to already be empty for this business — this makes
-- the "Storage cleanup happens before the business row is deleted" ordering (item 8's deletion
-- workflow, tracked separately) a database-enforced invariant rather than an API-route
-- convention a future bug could skip. storage.objects lives in this same Postgres database,
-- so the predicate can see it directly — no cross-service check needed.
create policy "businesses_owner_delete" on businesses
  for delete
  to authenticated
  using (
    owner_user_id = auth.uid()
    and not exists (
      select 1 from storage.objects
      where bucket_id = 'uploads'
      and (storage.foldername(name))[1] = businesses.id::text
    )
  );

-- ---------------------------------------------------------------------------
-- deals (pipeline) — REQ-001, RULE-003/004
-- ---------------------------------------------------------------------------
create table deals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses (id) on delete cascade,
  name text not null,
  value numeric not null check (value >= 0),
  stage text not null,
  stage_entry_date date not null,
  expected_close_date date,
  status text not null check (status in ('open', 'won', 'lost')),
  qualification_tier text check (qualification_tier in ('too_early', 'unlikely', 'likely', 'highly_likely')),
  close_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deals_open_requires_tier
    check (status <> 'open' or qualification_tier is not null),
  constraint deals_closed_requires_close_date
    check (status = 'open' or close_date is not null)
);

-- Lets pnl_lines carry a composite FK to (id, business_id) below, so a P&L line can
-- never reference a deal belonging to a different business — tenant isolation enforced
-- at the schema level, not just by RLS.
alter table deals add constraint deals_id_business_id_unique unique (id, business_id);

alter table deals enable row level security;

revoke all on deals from anon, public;

create policy "deals_owner_all" on deals
  for all
  to authenticated
  using (business_id in (select id from businesses where owner_user_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- pnl_lines (invoiced revenue) — REQ-002, RULE-004
-- ---------------------------------------------------------------------------
create table pnl_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses (id) on delete cascade,
  period date not null,
  invoiced_revenue numeric not null,
  deal_id uuid references deals (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Replace the simple deal_id FK with a composite FK against deals (id, business_id):
-- a pnl_line can only link to a deal in its own business, and deleting a deal still
-- only nulls this row's deal_id (Postgres 17's column-specific ON DELETE SET NULL) —
-- the P&L row itself, and its business_id, are untouched.
alter table pnl_lines drop constraint pnl_lines_deal_id_fkey;
alter table pnl_lines add constraint pnl_lines_deal_id_business_fk
  foreign key (deal_id, business_id) references deals (id, business_id)
  on delete set null (deal_id);

alter table pnl_lines enable row level security;

revoke all on pnl_lines from anon, public;

create policy "pnl_lines_owner_all" on pnl_lines
  for all
  to authenticated
  using (business_id in (select id from businesses where owner_user_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_user_id = auth.uid()));

-- Note: no uniqueness constraint on pnl_lines (e.g. per business_id/period/deal_id) —
-- row grain isn't defined yet and won't be until the upload flow is designed (REQ-002).

-- ---------------------------------------------------------------------------
-- targets — REQ-013, RULE-001 (no default for revenue/margin; null = "no target set")
-- ---------------------------------------------------------------------------
create table targets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null unique references businesses (id) on delete cascade,
  revenue_target_annual numeric,
  margin_target_percent numeric,
  minimum_acceptable_margin_percent numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table targets enable row level security;

revoke all on targets from anon, public;

create policy "targets_owner_all" on targets
  for all
  to authenticated
  using (business_id in (select id from businesses where owner_user_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- commercial_baseline — REQ-013/015, RULE-001/010 (sales-cycle, stale-opportunity threshold)
-- ---------------------------------------------------------------------------
create table commercial_baseline (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null unique references businesses (id) on delete cascade,
  sales_cycle_days integer,
  stale_opportunity_threshold_days integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table commercial_baseline enable row level security;

revoke all on commercial_baseline from anon, public;

create policy "commercial_baseline_owner_all" on commercial_baseline
  for all
  to authenticated
  using (business_id in (select id from businesses where owner_user_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- uploads — raw CSV audit trail (doc 04/05); Storage RLS mirrors this table.
-- (This is the application table recording upload metadata — distinct from the
-- Storage bucket of the same name, 'uploads', created below.)
-- ---------------------------------------------------------------------------
create table uploads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses (id) on delete cascade,
  kind text not null check (kind in ('pipeline', 'pnl')),
  storage_path text not null,
  uploaded_at timestamptz not null default now()
);

alter table uploads enable row level security;

revoke all on uploads from anon, public;

create policy "uploads_owner_all" on uploads
  for all
  to authenticated
  using (business_id in (select id from businesses where owner_user_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_user_id = auth.uid()));

-- Storage bucket for raw uploaded CSVs, object path convention: {business_id}/{upload_id}.csv
-- (no repeated 'uploads/' prefix inside the bucket — the bucket itself is already 'uploads').
-- Not revoking anon/PUBLIC grants on storage.objects/storage.buckets — those are Supabase's
-- own tables, RLS is the correct control surface for them, and a blanket REVOKE there risks
-- breaking the Storage service itself.
insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', false)
on conflict (id) do update set public = false;

create policy "uploads_bucket_owner_all" on storage.objects
  for all
  to authenticated
  using (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] in (
      select id::text from businesses where owner_user_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] in (
      select id::text from businesses where owner_user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- feedback_events — REQ-011
-- ---------------------------------------------------------------------------
create table feedback_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses (id) on delete cascade,
  verdict_period text not null,
  signal text not null check (signal in ('trust', 'no_trust')),
  created_at timestamptz not null default now()
);

alter table feedback_events enable row level security;

revoke all on feedback_events from anon, public;

-- Insert-only from the app's perspective (REQ-011): read your own feedback, submit your
-- own feedback, but never edit or delete it after the fact. No UPDATE/DELETE policy exists
-- at all — with RLS enabled, that silently denies both operations outright. Deleting the
-- parent business still removes these rows via ON DELETE CASCADE, which fires as an internal
-- referential action and isn't subject to this table's RLS policies.
create policy "feedback_events_select_own" on feedback_events
  for select
  to authenticated
  using (business_id in (select id from businesses where owner_user_id = auth.uid()));

create policy "feedback_events_insert_own" on feedback_events
  for insert
  to authenticated
  with check (business_id in (select id from businesses where owner_user_id = auth.uid()));
