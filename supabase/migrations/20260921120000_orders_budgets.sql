-- Orders, budgets, and the RULE-015/016 P&L representation/cutoff support they depend on.
-- Adds to the schema from 20260919120000_init_schema.sql — that file is untouched.
--
-- Three product decisions this migration deliberately does NOT make, per doc 03's own
-- open-questions table — flagged here again so they aren't silently baked into the schema:
--   (1) Order-allocation maintenance mechanism (periodic re-upload vs. in-app editing) —
--       still open. This migration's `order_book_as_of` tracking (see below) works
--       identically under either answer, so it doesn't presuppose one.
--   (2) Whether a customer name/reference is required on an order — still open.
--       orders.customer_name is nullable here; tightening it to NOT NULL later is a
--       compatible, non-breaking change once decided.
--   (3) Whether "unallocated new business" is strictly one line per business/year, or can
--       be split by sector/product/salesperson like customer lines — still open. The
--       budget_lines dedup index (below) supports either answer: it allows multiple
--       new_business_unallocated lines split by sector/product/salesperson, while still
--       rejecting an exact duplicate of the same combination.
--
-- Every new/altered table keeps this project's established pattern: RLS enabled, anon/PUBLIC
-- grants revoked, policy scoped `to authenticated`, same-business composite foreign keys
-- (never trusting a client to keep a child row's business_id honest on its own).

-- ---------------------------------------------------------------------------
-- uploads: RULE-015's declared-replacement-period metadata, needed before pnl_lines
-- can reference an upload via a same-business composite FK.
-- ---------------------------------------------------------------------------
alter table uploads add column declares_replacement_from date;
alter table uploads add column declares_replacement_through date;

alter table uploads add constraint uploads_pnl_declares_replacement_range
  check (
    kind <> 'pnl'
    or (
      declares_replacement_from is not null
      and declares_replacement_through is not null
      and declares_replacement_from <= declares_replacement_through
    )
  );

-- Lets pnl_lines (below) carry a composite FK to (id, business_id), so a P&L line can
-- never reference an upload belonging to a different business.
alter table uploads add constraint uploads_id_business_id_unique unique (id, business_id);

-- ---------------------------------------------------------------------------
-- pnl_lines: RULE-015's detail/summary exclusivity flag, and upload provenance.
-- The actual "an upload can't mix detail and summary rows" validation is an
-- application/parse-time concern (a property of the whole batch, not a single row) —
-- this column is the per-row structural fact that validation reads and enforces.
-- ---------------------------------------------------------------------------
alter table pnl_lines add column line_type text;
update pnl_lines set line_type = 'detail' where line_type is null; -- no-op: table is empty pre-pilot
alter table pnl_lines alter column line_type set not null;
alter table pnl_lines add constraint pnl_lines_line_type_check check (line_type in ('detail', 'summary'));

alter table pnl_lines add column upload_id uuid;
alter table pnl_lines alter column upload_id set not null;
alter table pnl_lines add constraint pnl_lines_upload_id_business_fk
  foreign key (upload_id, business_id) references uploads (id, business_id)
  on delete cascade;

-- ---------------------------------------------------------------------------
-- orders — REQ-016
-- ---------------------------------------------------------------------------
create table orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses (id) on delete cascade,
  customer_name text, -- nullable: customer-required-on-orders is an open PRD question (see header)
  deal_id uuid, -- context only, per RULE-004 — never required, never load-bearing
  total_value numeric not null check (total_value >= 0), -- reference context only (RULE-014); never a calc input for outstanding value
  status text not null default 'open' check (status in ('open', 'complete')),
  unscheduled_outstanding_value numeric not null default 0 check (unscheduled_outstanding_value >= 0), -- RULE-014: independent, owner-maintained, never derived by subtraction
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Composite FK, nullable-safe: MATCH SIMPLE (Postgres's default) means a NULL deal_id
-- satisfies the constraint automatically regardless of business_id — "no deal referenced"
-- needs no cross-business check. A non-null deal_id must belong to this same business.
alter table orders add constraint orders_deal_id_business_fk
  foreign key (deal_id, business_id) references deals (id, business_id)
  on delete set null (deal_id);

-- Lets order_allocations (below) carry a composite FK to (id, business_id).
alter table orders add constraint orders_id_business_id_unique unique (id, business_id);

alter table orders enable row level security;
revoke all on orders from anon, public;

create policy "orders_owner_all" on orders
  for all
  to authenticated
  using (business_id in (select id from businesses where owner_user_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- order_allocations — REQ-016. One row per (order, month) holding the CURRENT outstanding
-- value the owner has last stated for that month (RULE-013's worked example: the owner
-- *updates* March's allocation, not appends a second row for it).
-- ---------------------------------------------------------------------------
create table order_allocations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  business_id uuid not null references businesses (id) on delete cascade,
  period date not null, -- first-of-month, matching pnl_lines.period's convention
  outstanding_value numeric not null check (outstanding_value >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_allocations_order_period_unique unique (order_id, period)
);

alter table order_allocations add constraint order_allocations_order_id_business_fk
  foreign key (order_id, business_id) references orders (id, business_id)
  on delete cascade;

alter table order_allocations enable row level security;
revoke all on order_allocations from anon, public;

create policy "order_allocations_owner_all" on order_allocations
  for all
  to authenticated
  using (business_id in (select id from businesses where owner_user_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- RULE-016: the order-book's own reporting cutoff. Tracked on `businesses` (one scalar per
-- business) and bumped automatically by a trigger on any orders/order_allocations write —
-- this works identically whether allocations turn out to be maintained by periodic re-upload
-- or in-app editing (open question #1 above), since either path still writes these tables.
-- ---------------------------------------------------------------------------
alter table businesses add column order_book_as_of date;

create or replace function set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function bump_order_book_as_of() returns trigger
language plpgsql
as $$
declare
  v_business_id uuid;
begin
  v_business_id := coalesce(new.business_id, old.business_id);
  update businesses set order_book_as_of = current_date where id = v_business_id;
  return coalesce(new, old);
end;
$$;

create trigger orders_set_updated_at
  before update on orders
  for each row execute function set_updated_at();

create trigger order_allocations_set_updated_at
  before update on order_allocations
  for each row execute function set_updated_at();

create trigger orders_bump_order_book_as_of
  after insert or update or delete on orders
  for each row execute function bump_order_book_as_of();

create trigger order_allocations_bump_order_book_as_of
  after insert or update or delete on order_allocations
  for each row execute function bump_order_book_as_of();

-- RULE-013: marking an order complete zeroes all remaining outstanding — scheduled and
-- unscheduled — immediately, regardless of variance from the original total. Enforced here
-- as a database trigger rather than left to whichever API route happens to perform the
-- transition, so it holds true no matter which code path (or direct REST call) flips the
-- status.
create or replace function zero_out_order_on_complete() returns trigger
language plpgsql
as $$
begin
  if new.status = 'complete' and old.status is distinct from 'complete' then
    new.unscheduled_outstanding_value := 0;
    update order_allocations
      set outstanding_value = 0
      where order_id = new.id and outstanding_value <> 0;
  end if;
  return new;
end;
$$;

create trigger orders_zero_out_on_complete
  before update on orders
  for each row execute function zero_out_order_on_complete();

-- ---------------------------------------------------------------------------
-- budget_sets — REQ-017/RULE-017. Exactly one ACTIVE set per business/year; zero active
-- sets is valid (the annual-target fallback applies then). Activation/replacement must be
-- atomic — see activate_budget_set() below, which is the intended path for that transition.
-- ---------------------------------------------------------------------------
create table budget_sets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses (id) on delete cascade,
  year integer not null check (year between 2000 and 2100),
  status text not null default 'draft' check (status in ('draft', 'active', 'superseded')),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The core of RULE-017's atomicity requirement: the database itself, not application
-- discipline, guarantees at most one active set per business/year. A partial unique index
-- only constrains rows matching its predicate, so draft/superseded rows are unaffected and
-- multiple drafts for the same business/year can coexist freely.
create unique index budget_sets_one_active_per_business_year
  on budget_sets (business_id, year)
  where status = 'active';

-- Lets budget_lines (below) carry a composite FK to (id, business_id).
alter table budget_sets add constraint budget_sets_id_business_id_unique unique (id, business_id);

alter table budget_sets enable row level security;
revoke all on budget_sets from anon, public;

create policy "budget_sets_owner_all" on budget_sets
  for all
  to authenticated
  using (business_id in (select id from businesses where owner_user_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_user_id = auth.uid()));

create trigger budget_sets_set_updated_at
  before update on budget_sets
  for each row execute function set_updated_at();

-- Activates a draft budget_set, superseding whatever was previously active for the same
-- business/year, as a single atomic operation (doc 03: "failure must preserve the previous
-- active budget; concurrent activation attempts must not leave two active sets").
--
-- SECURITY INVOKER (the default, stated explicitly): runs as the calling role, so every
-- statement inside is still subject to budget_sets' own RLS policy above — no privilege
-- escalation, no bypass of the caller's own ownership boundary.
--
-- Concurrency: `select ... for update` locks the target draft row, serializing concurrent
-- attempts to activate the SAME draft. The subsequent `update ... where status = 'active'`
-- takes Postgres's normal row lock on whatever it touches, serializing against a concurrent
-- activation of a DIFFERENT draft for the same business/year. If the final activating UPDATE
-- fails for any reason (including the unique index above rejecting a duplicate active row
-- from a concurrent transaction that committed first), the whole function's effects —
-- including the supersede step just before it — roll back together, restoring the previous
-- active set exactly as it was.
create or replace function activate_budget_set(p_budget_set_id uuid)
returns budget_sets
language plpgsql
security invoker
as $$
declare
  v_business_id uuid;
  v_year integer;
  v_status text;
  v_result budget_sets;
begin
  select business_id, year, status
    into v_business_id, v_year, v_status
    from budget_sets
    where id = p_budget_set_id
    for update;

  if not found then
    raise exception 'budget_set % not found or not visible to the caller', p_budget_set_id
      using errcode = 'no_data_found';
  end if;

  if v_status <> 'draft' then
    raise exception 'budget_set % is not a draft (status = %) — only a draft can be activated', p_budget_set_id, v_status
      using errcode = 'invalid_parameter_value';
  end if;

  update budget_sets
    set status = 'superseded'
    where business_id = v_business_id
      and year = v_year
      and status = 'active';

  update budget_sets
    set status = 'active', confirmed_at = now()
    where id = p_budget_set_id
    returning * into v_result;

  return v_result;
end;
$$;

revoke all on function activate_budget_set(uuid) from public;
grant execute on function activate_budget_set(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- budget_lines — REQ-017
-- ---------------------------------------------------------------------------
create table budget_lines (
  id uuid primary key default gen_random_uuid(),
  budget_set_id uuid not null,
  business_id uuid not null references businesses (id) on delete cascade,
  line_type text not null check (line_type in ('customer', 'new_business_unallocated')),
  customer_name text,
  sector text,
  product_service text,
  salesperson text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_lines_customer_name_required
    check (
      (line_type = 'customer' and customer_name is not null)
      or (line_type = 'new_business_unallocated' and customer_name is null)
    )
);

alter table budget_lines add constraint budget_lines_budget_set_id_business_fk
  foreign key (budget_set_id, business_id) references budget_sets (id, business_id)
  on delete cascade;

-- RULE-018's blank-customer continuation is resolved to an explicit name by the upload
-- parser before storage — never stored as an ambiguous blank. This index is the duplicate
-- guard for the resolved, stored rows (REQ-017's dedup requirement), not the continuation
-- logic itself, which is parser-level, not schema-level.
--
-- A plain UNIQUE(...) on nullable columns would NOT catch two rows sharing a NULL
-- sector/product/salesperson as duplicates — NULL never equals NULL in Postgres, so two
-- otherwise-identical rows with NULL salesperson would both be silently accepted. Coalescing
-- each nullable dimension to '' first makes two NULLs compare as duplicates, while two
-- distinct real salespeople (or sectors, or products) for the same customer/product/month
-- remain distinct rows, exactly as required. '' is reserved as the sentinel: the upload
-- parser and any future editing API must normalize blank/whitespace input to NULL before
-- insert, never store a literal empty string, so '' unambiguously means "coalesced from NULL"
-- here.
create unique index budget_lines_dedup_idx on budget_lines (
  budget_set_id,
  line_type,
  coalesce(customer_name, ''),
  coalesce(sector, ''),
  coalesce(product_service, ''),
  coalesce(salesperson, '')
);

-- Lets budget_line_months (below) carry a composite FK to (id, business_id).
alter table budget_lines add constraint budget_lines_id_business_id_unique unique (id, business_id);

alter table budget_lines enable row level security;
revoke all on budget_lines from anon, public;

-- Always readable (including once active/superseded, for audit/history — RULE-011's
-- "historical behaviour is never silently redefined" spirit applied here as "never silently
-- deleted or hidden" either). Mutation is restricted to the owner's own DRAFT sets only —
-- once a set has been confirmed active, its lines are immutable outside forming a new draft.
-- This is what actually enforces RULE-017's "review then explicitly confirm" model at the
-- database level, not just in application flow.
create policy "budget_lines_select_own" on budget_lines
  for select
  to authenticated
  using (business_id in (select id from businesses where owner_user_id = auth.uid()));

create policy "budget_lines_insert_draft_own" on budget_lines
  for insert
  to authenticated
  with check (
    business_id in (select id from businesses where owner_user_id = auth.uid())
    and exists (select 1 from budget_sets bs where bs.id = budget_set_id and bs.status = 'draft')
  );

create policy "budget_lines_update_draft_own" on budget_lines
  for update
  to authenticated
  using (
    business_id in (select id from businesses where owner_user_id = auth.uid())
    and exists (select 1 from budget_sets bs where bs.id = budget_set_id and bs.status = 'draft')
  )
  with check (
    business_id in (select id from businesses where owner_user_id = auth.uid())
    and exists (select 1 from budget_sets bs where bs.id = budget_set_id and bs.status = 'draft')
  );

create policy "budget_lines_delete_draft_own" on budget_lines
  for delete
  to authenticated
  using (
    business_id in (select id from businesses where owner_user_id = auth.uid())
    and exists (select 1 from budget_sets bs where bs.id = budget_set_id and bs.status = 'draft')
  );

create trigger budget_lines_set_updated_at
  before update on budget_lines
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- budget_line_months — REQ-017. A row's mere existence is the "explicit amount" signal
-- (RULE-017: a blank monthly cell is missing data, never silently stored as £0 — so a
-- missing month simply has no row here; amount is NOT NULL precisely to make that the only
-- way to represent "no explicit figure").
-- ---------------------------------------------------------------------------
create table budget_line_months (
  id uuid primary key default gen_random_uuid(),
  budget_line_id uuid not null,
  business_id uuid not null references businesses (id) on delete cascade,
  month date not null,
  amount numeric not null check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_line_months_line_month_unique unique (budget_line_id, month)
);

alter table budget_line_months add constraint budget_line_months_budget_line_id_business_fk
  foreign key (budget_line_id, business_id) references budget_lines (id, business_id)
  on delete cascade;

alter table budget_line_months enable row level security;
revoke all on budget_line_months from anon, public;

create policy "budget_line_months_select_own" on budget_line_months
  for select
  to authenticated
  using (business_id in (select id from businesses where owner_user_id = auth.uid()));

create policy "budget_line_months_insert_draft_own" on budget_line_months
  for insert
  to authenticated
  with check (
    business_id in (select id from businesses where owner_user_id = auth.uid())
    and exists (
      select 1 from budget_lines bl
      join budget_sets bs on bs.id = bl.budget_set_id
      where bl.id = budget_line_id and bs.status = 'draft'
    )
  );

create policy "budget_line_months_update_draft_own" on budget_line_months
  for update
  to authenticated
  using (
    business_id in (select id from businesses where owner_user_id = auth.uid())
    and exists (
      select 1 from budget_lines bl
      join budget_sets bs on bs.id = bl.budget_set_id
      where bl.id = budget_line_id and bs.status = 'draft'
    )
  )
  with check (
    business_id in (select id from businesses where owner_user_id = auth.uid())
    and exists (
      select 1 from budget_lines bl
      join budget_sets bs on bs.id = bl.budget_set_id
      where bl.id = budget_line_id and bs.status = 'draft'
    )
  );

create policy "budget_line_months_delete_draft_own" on budget_line_months
  for delete
  to authenticated
  using (
    business_id in (select id from businesses where owner_user_id = auth.uid())
    and exists (
      select 1 from budget_lines bl
      join budget_sets bs on bs.id = bl.budget_set_id
      where bl.id = budget_line_id and bs.status = 'draft'
    )
  );

create trigger budget_line_months_set_updated_at
  before update on budget_line_months
  for each row execute function set_updated_at();
