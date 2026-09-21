-- Orders, budgets, and the RULE-015/016/019 P&L representation/cutoff support they depend on.
-- Adds to the schema from 20260919120000_init_schema.sql — that file is untouched.
--
-- Three product decisions this migration deliberately does NOT make, per doc 03's own
-- open-questions table — flagged here again so they aren't silently baked into the schema:
--   (1) Order-allocation maintenance mechanism (periodic re-upload vs. in-app editing) —
--       still open. order_book_as_of (below) is an explicitly owner-declared cutoff, not
--       inferred from writes, so it works identically under either answer.
--   (2) Whether a customer name/reference is required on an order — still open.
--       orders.customer_name is nullable here; tightening it to NOT NULL later is a
--       compatible, non-breaking change once decided.
--   (3) Whether "unallocated new business" is strictly one line per business/year, or can
--       be split by sector/product/salesperson like customer lines — still open. The
--       budget_lines dedup index (below) supports either answer.
--
-- Every new/altered table keeps this project's established pattern: RLS enabled, anon/PUBLIC
-- grants revoked, policy scoped `to authenticated`, same-business composite foreign keys.

-- Explicit precondition, not just a comment: several ALTERs below add NOT NULL columns to
-- pnl_lines with no default, which only works if the table is currently empty. Postgres
-- would fail the migration anyway if that's wrong, but with a raw constraint-violation error
-- that doesn't say why — this gives a clear diagnostic instead.
do $$
begin
  if exists (select 1 from pnl_lines limit 1) then
    raise exception 'pnl_lines is not empty — this migration adds line_type/upload_id as NOT NULL with no default, which requires an empty table. Revise with a backfill before proceeding.'
      using errcode = 'invalid_table_definition';
  end if;
end $$;

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
-- ---------------------------------------------------------------------------
alter table pnl_lines add column line_type text;
alter table pnl_lines alter column line_type set not null;
alter table pnl_lines add constraint pnl_lines_line_type_check check (line_type in ('detail', 'summary'));

alter table pnl_lines add column upload_id uuid;
alter table pnl_lines alter column upload_id set not null;
alter table pnl_lines add constraint pnl_lines_upload_id_business_fk
  foreign key (upload_id, business_id) references uploads (id, business_id)
  on delete cascade;

-- RULE-016 (corrected): invoiced_as_of is DERIVED from uploads' own declared cutoffs, never
-- stored or inferred from a write timestamp. The most recent complete-P&L position for a
-- business is the latest declares_replacement_through among its 'pnl' uploads.
create or replace function invoiced_as_of(p_business_id uuid) returns date
language sql
stable
as $$
  select max(declares_replacement_through)
  from uploads
  where business_id = p_business_id and kind = 'pnl';
$$;

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
  updated_at timestamptz not null default now(), -- audit only — never read as a reporting cutoff (RULE-016)
  -- RULE-013's standing invariant, not just a one-time action: a completed order can never
  -- carry a nonzero unscheduled balance, on insert or on any later update. Catches
  -- insert-already-complete-with-nonzero directly; the transition trigger below (which
  -- zeroes this field automatically when status flips to 'complete') keeps this constraint
  -- satisfied for the normal "mark complete" path so it never fires there.
  constraint orders_complete_implies_zero_unscheduled
    check (status <> 'complete' or unscheduled_outstanding_value = 0)
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
-- value the owner has last stated for that month.
-- ---------------------------------------------------------------------------
create table order_allocations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  business_id uuid not null references businesses (id) on delete cascade,
  period date not null, -- first-of-month, matching pnl_lines.period's convention
  outstanding_value numeric not null check (outstanding_value >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), -- audit only — never read as a reporting cutoff (RULE-016)
  constraint order_allocations_order_period_unique unique (order_id, period),
  -- RULE-019: "one row per month" is meaningless unless the date itself is always the 1st —
  -- the 1st and the 15th of the same month must never both be able to satisfy the unique
  -- constraint above as if they were different periods.
  constraint order_allocations_period_is_month_start check (period = date_trunc('month', period)::date)
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
-- RULE-016 (corrected): the order-book's reporting cutoff must be an explicitly declared
-- position ("this is accurate as of [date]"), never inferred from a write timestamp — true
-- regardless of which maintenance mechanism (re-upload or in-app editing) gets chosen, since
-- editing one row never proves the whole position is current. So this is a plain,
-- owner-settable column on businesses — set only by explicit application action, never
-- bumped automatically by a trigger on every orders/order_allocations write. (An earlier
-- draft of this migration had exactly that trigger — removed.)
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

create trigger orders_set_updated_at
  before update on orders
  for each row execute function set_updated_at();

create trigger order_allocations_set_updated_at
  before update on order_allocations
  for each row execute function set_updated_at();

-- RULE-013 (corrected): the "completed order has zero outstanding" invariant must hold as a
-- standing fact, not just at the moment of transition. This trigger handles the transition
-- itself (auto-zeroing is the correct UX when an owner marks an order complete); the CHECK
-- constraint on orders above catches insert-already-complete; the order_allocations trigger
-- below catches any later write that would reintroduce a positive value against an
-- already-complete order — rejecting it outright rather than silently re-zeroing it, so a
-- write against a completed order is visibly an error, not a silent no-op.
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

create or replace function reject_allocation_write_on_completed_order() returns trigger
language plpgsql
as $$
declare
  v_order_status text;
begin
  if new.outstanding_value > 0 then
    select status into v_order_status from orders where id = new.order_id;
    if v_order_status = 'complete' then
      raise exception 'order % is already complete — cannot write a positive outstanding_value (%) to its allocations', new.order_id, new.outstanding_value
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger order_allocations_reject_positive_on_completed_order
  before insert or update on order_allocations
  for each row execute function reject_allocation_write_on_completed_order();

-- ---------------------------------------------------------------------------
-- budget_sets — REQ-017/RULE-017. Exactly one ACTIVE set per business/year; zero active
-- sets is valid (the annual-target fallback applies then).
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
-- discipline, guarantees at most one active set per business/year.
create unique index budget_sets_one_active_per_business_year
  on budget_sets (business_id, year)
  where status = 'active';

-- Lets budget_lines (below) carry a composite FK to (id, business_id).
alter table budget_sets add constraint budget_sets_id_business_id_unique unique (id, business_id);

alter table budget_sets enable row level security;
revoke all on budget_sets from anon, public;

-- Corrected: NO direct UPDATE or DELETE policy for authenticated at all. Without one, both
-- are unconditionally denied by RLS — an owner cannot flip 'active' back to 'draft' to edit
-- "immutable" lines, cannot delete an active set outright, and cannot directly activate a
-- draft by writing status='active' themselves. Only SELECT and INSERT-of-new-drafts remain
-- as direct client operations; every state transition (activation, supersession) must go
-- through activate_budget_set() below, which is SECURITY DEFINER precisely because RLS no
-- longer grants any client-side path to perform those UPDATEs at all.
create policy "budget_sets_owner_select" on budget_sets
  for select
  to authenticated
  using (business_id in (select id from businesses where owner_user_id = auth.uid()));

create policy "budget_sets_owner_insert_draft" on budget_sets
  for insert
  to authenticated
  with check (
    business_id in (select id from businesses where owner_user_id = auth.uid())
    and status = 'draft'
  );

create trigger budget_sets_set_updated_at
  before update on budget_sets
  for each row execute function set_updated_at();

-- Activates a draft budget_set, superseding whatever was previously active for the same
-- business/year, as a single atomic operation.
--
-- SECURITY DEFINER: necessary, not just a style choice — budget_sets has no UPDATE policy
-- for authenticated at all now, so a SECURITY INVOKER function couldn't perform these writes
-- regardless of caller. Running as the function owner (which owns budget_sets, so bypasses
-- RLS the same way any table owner does) means this function is now the *only* path capable
-- of changing a budget_set's status — which is exactly the point: a controlled, validated
-- gate instead of an open UPDATE surface. Because RLS no longer applies automatically, the
-- function performs its own explicit ownership check before touching anything, and
-- `set search_path = public` is set explicitly (standard hardening for SECURITY DEFINER
-- functions, closing the search-path-injection class of attack).
--
-- Validation order: not found -> not owned (same error as not found, deliberately, so the
-- caller can't distinguish "doesn't exist" from "exists but isn't yours") -> not draft ->
-- structural completeness -> supersede -> activate. Structural validation runs as the LAST
-- step before the final UPDATE, inside the same transaction, to keep the window where a
-- concurrent insert into budget_lines could race past validation as narrow as possible.
-- That race is not fully closed — locking the budget_sets row doesn't block writes to the
-- child tables — and is accepted as open for MVP given single-user-per-business; closing it
-- fully would need locking budget_lines/budget_line_months too, which isn't done here.
--
-- Concurrency: a concurrent transaction activating a DIFFERENT draft for the same
-- business/year does not silently "win" or get silently skipped — it fails outright on the
-- partial unique index (or, if it reaches its own supersede step first, this transaction's
-- own activating UPDATE fails instead). Either way the losing call must be caught and
-- retried by the caller (e.g. "someone already activated a different budget, refresh and
-- retry") — this function does not hide or paper over that failure.
create or replace function activate_budget_set(p_budget_set_id uuid)
returns budget_sets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_year integer;
  v_status text;
  v_owns boolean;
  v_result budget_sets;
  v_incomplete_line_count integer;
begin
  select business_id, year, status
    into v_business_id, v_year, v_status
    from budget_sets
    where id = p_budget_set_id
    for update;

  if not found then
    raise exception 'budget_set % not found' , p_budget_set_id using errcode = 'no_data_found';
  end if;

  select exists (
    select 1 from businesses where id = v_business_id and owner_user_id = auth.uid()
  ) into v_owns;

  if not v_owns then
    raise exception 'budget_set % not found' , p_budget_set_id using errcode = 'no_data_found';
  end if;

  if v_status <> 'draft' then
    raise exception 'budget_set % is not a draft (status = %) — only a draft can be activated', p_budget_set_id, v_status
      using errcode = 'invalid_parameter_value';
  end if;

  -- Structural completeness (RULE-017/AC-017-06): this is "every row parses and every line
  -- has an amount for every month" — the system's own job to verify. It is deliberately NOT
  -- "every real customer the owner meant to include is present," which RULE-017 explicitly
  -- reserves for the owner's own judgment via the reviewed preview, not something the system
  -- can check.
  if not exists (select 1 from budget_lines where budget_set_id = p_budget_set_id) then
    raise exception 'budget_set % has no budget lines — an empty draft cannot be activated', p_budget_set_id
      using errcode = 'integrity_constraint_violation';
  end if;

  select count(*) into v_incomplete_line_count
  from (
    select bl.id
    from budget_lines bl
    left join budget_line_months blm on blm.budget_line_id = bl.id
    where bl.budget_set_id = p_budget_set_id
    group by bl.id
    having count(blm.id) < 12
  ) incomplete;

  if v_incomplete_line_count > 0 then
    raise exception 'budget_set % has % line(s) missing one or more months — every line must have all 12 months resolved before activation', p_budget_set_id, v_incomplete_line_count
      using errcode = 'integrity_constraint_violation';
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

-- NULL-safe duplicate detection (REQ-017): a plain UNIQUE(...) on nullable columns would NOT
-- catch two rows sharing a NULL sector/product/salesperson as duplicates — NULL never equals
-- NULL in Postgres. Coalescing each nullable dimension to '' first makes two NULLs compare as
-- duplicates, while two distinct real salespeople (or sectors, or products) for the same
-- customer/product/month remain distinct rows. '' is reserved as the sentinel: the upload
-- parser and any future editing API must normalize blank/whitespace input to NULL before
-- insert, never store a literal empty string.
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

-- Always readable (including once active/superseded, for audit/history). Mutation is
-- restricted to the owner's own DRAFT sets only — once a set has been confirmed active, its
-- lines are immutable outside forming a new draft. Note this is a real, enforced restriction
-- now that budget_sets itself has no direct UPDATE path: an owner cannot flip a set back to
-- 'draft' to reopen these policies, so "draft-only mutation" actually holds, not just by
-- convention.
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
-- (RULE-017: a blank monthly cell is missing data, never silently stored as £0).
-- ---------------------------------------------------------------------------
create table budget_line_months (
  id uuid primary key default gen_random_uuid(),
  budget_line_id uuid not null,
  business_id uuid not null references businesses (id) on delete cascade,
  month date not null,
  amount numeric not null check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_line_months_line_month_unique unique (budget_line_id, month),
  -- RULE-019: canonical first-of-month dates only — same reasoning as order_allocations.period.
  constraint budget_line_months_month_is_month_start check (month = date_trunc('month', month)::date)
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

-- RULE-019: a budget_line_months row must fall within its own budget_set's stated year — a
-- cross-table check, so it needs a trigger, not a plain CHECK.
create or replace function check_budget_line_month_year() returns trigger
language plpgsql
as $$
declare
  v_budget_year integer;
begin
  select bs.year into v_budget_year
  from budget_lines bl
  join budget_sets bs on bs.id = bl.budget_set_id
  where bl.id = new.budget_line_id;

  if v_budget_year is null then
    raise exception 'budget_line % not found', new.budget_line_id using errcode = 'no_data_found';
  end if;

  if extract(year from new.month)::integer <> v_budget_year then
    raise exception 'budget_line_months.month (%) must fall within its budget_set''s year (%)', new.month, v_budget_year
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger budget_line_months_check_year
  before insert or update on budget_line_months
  for each row execute function check_budget_line_month_year();
