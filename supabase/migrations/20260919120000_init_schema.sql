-- Initial schema for the Commercial Director MVP (doc 03/04/05).
-- Every table is created with RLS enabled and its policy in this same migration —
-- never added later. Ownership chains back to businesses.owner_user_id = auth.uid()
-- in every case (RULE-006, doc 05's access contract).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- businesses
-- ---------------------------------------------------------------------------
create table businesses (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table businesses enable row level security;

create policy "businesses_owner_all" on businesses
  for all
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

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

alter table deals enable row level security;

create policy "deals_owner_all" on deals
  for all
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

alter table pnl_lines enable row level security;

create policy "pnl_lines_owner_all" on pnl_lines
  for all
  using (business_id in (select id from businesses where owner_user_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_user_id = auth.uid()));

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

create policy "targets_owner_all" on targets
  for all
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

create policy "commercial_baseline_owner_all" on commercial_baseline
  for all
  using (business_id in (select id from businesses where owner_user_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- uploads — raw CSV audit trail (doc 04/05); Storage RLS mirrors this table
-- ---------------------------------------------------------------------------
create table uploads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses (id) on delete cascade,
  kind text not null check (kind in ('pipeline', 'pnl')),
  storage_path text not null,
  uploaded_at timestamptz not null default now()
);

alter table uploads enable row level security;

create policy "uploads_owner_all" on uploads
  for all
  using (business_id in (select id from businesses where owner_user_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_user_id = auth.uid()));

-- Storage bucket for raw uploaded CSVs, path convention: uploads/{business_id}/{upload_id}.csv
insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', false)
on conflict (id) do nothing;

create policy "uploads_bucket_owner_all" on storage.objects
  for all
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

create policy "feedback_events_owner_all" on feedback_events
  for all
  using (business_id in (select id from businesses where owner_user_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_user_id = auth.uid()));
