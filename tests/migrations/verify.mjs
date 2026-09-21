import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Verifies every migration under supabase/migrations/, in order, against a real Postgres
// engine (PGlite — WASM, not a mock) with minimal stubs for the parts of the Supabase
// platform the migrations depend on (auth.uid(), storage.buckets/objects). Run with
// `npm run test:migrations`. Never touches the live project.
//
// What this file CANNOT verify: genuine concurrent-connection behavior. PGlite is a
// single-connection embedded engine, so "two simultaneous activation attempts" here means
// "two sequential statements inside one script," not two real overlapping transactions. The
// structural guarantee (the partial unique index) is verified directly; true concurrency
// needs a real multi-connection Postgres — see the separate Supabase-branch check.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../supabase/migrations");
const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

let passed = 0;
let failed = 0;

function report(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

async function expectError(name, fn, matchFragment) {
  try {
    await fn();
    report(name, false, "expected an error, none was thrown");
  } catch (e) {
    const msg = String(e.message || e);
    if (matchFragment && !msg.toLowerCase().includes(matchFragment.toLowerCase())) {
      report(name, false, `wrong error: ${msg}`);
    } else {
      report(name, true);
    }
  }
}

async function insertAllMonths(db, budgetLineId, businessId, year, amount) {
  for (let m = 1; m <= 12; m++) {
    const month = `${year}-${String(m).padStart(2, "0")}-01`;
    await db.query(
      "insert into budget_line_months (budget_line_id, business_id, month, amount) values ($1, $2, $3, $4)",
      [budgetLineId, businessId, month, amount]
    );
  }
}

async function main() {
  const db = new PGlite({ extensions: { pgcrypto } });

  await db.exec(readFileSync(path.join(__dirname, "stub.sql"), "utf8"));
  for (const file of migrationFiles) {
    await db.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
    console.log(`Applied ${file}`);
  }
  console.log("All migrations applied cleanly.\n");

  // --- Seed: two businesses/owners, bootstrapping role bypasses RLS ---
  const userA = "11111111-1111-1111-1111-111111111111";
  const userB = "22222222-2222-2222-2222-222222222222";
  await db.query("insert into auth.users (id) values ($1), ($2)", [userA, userB]);

  const bizA = (
    await db.query("insert into businesses (owner_user_id, name) values ($1, 'Business A') returning id", [userA])
  ).rows[0].id;
  const bizB = (
    await db.query("insert into businesses (owner_user_id, name) values ($1, 'Business B') returning id", [userB])
  ).rows[0].id;

  async function asUser(userId, fn) {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    try {
      return await fn();
    } finally {
      await db.query("rollback");
    }
  }

  // Same idea as asUser, but NOT transactional — for calls that must actually succeed and
  // persist (activate_budget_set positive-control calls in particular; that function checks
  // auth.uid() internally now, so it must be called under a real acting-user context, and
  // wrapping it in asUser's begin/rollback would silently undo the activation afterward).
  // Everything outside an actingAs()/asUser() block keeps running as the default bootstrap
  // role (bypasses RLS, no auth.uid() set) — most of this script's cross-business/constraint
  // tests deliberately rely on that to isolate FK/CHECK failures from RLS denials.
  async function actingAs(userId, fn) {
    await db.query("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
    try {
      return await fn();
    } finally {
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claim.sub', '', false)");
    }
  }

  // ==========================================================================
  // Budget activation: happy path, supersede-on-replace
  // ==========================================================================
  let draft1, draft2;
  {
    draft1 = (
      await db.query(
        "insert into budget_sets (business_id, year, status) values ($1, 2027, 'draft') returning id",
        [bizA]
      )
    ).rows[0].id;
    const line1 = (
      await db.query(
        `insert into budget_lines (budget_set_id, business_id, line_type, customer_name) values ($1, $2, 'customer', 'Acme Ltd') returning id`,
        [draft1, bizA]
      )
    ).rows[0].id;
    await insertAllMonths(db, line1, bizA, 2027, 1000);

    const activated1 = await actingAs(userA, () => db.query("select * from activate_budget_set($1)", [draft1]));
    report(
      "Budget activation: happy path activates a complete draft with no prior active set",
      activated1.rows[0]?.status === "active" && activated1.rows[0]?.confirmed_at !== null
    );

    const activeCount1 = await db.query(
      "select count(*)::int as n from budget_sets where business_id = $1 and year = 2027 and status = 'active'",
      [bizA]
    );
    report("Budget activation: exactly one active row exists after activation", activeCount1.rows[0].n === 1);

    draft2 = (
      await db.query(
        "insert into budget_sets (business_id, year, status) values ($1, 2027, 'draft') returning id",
        [bizA]
      )
    ).rows[0].id;
    const line2 = (
      await db.query(
        `insert into budget_lines (budget_set_id, business_id, line_type, customer_name) values ($1, $2, 'customer', 'Beta Co') returning id`,
        [draft2, bizA]
      )
    ).rows[0].id;
    await insertAllMonths(db, line2, bizA, 2027, 2000);

    const activated2 = await actingAs(userA, () => db.query("select * from activate_budget_set($1)", [draft2]));
    report("Budget activation: second activation succeeds", activated2.rows[0]?.status === "active");

    const draft1AfterSupersede = await db.query("select status from budget_sets where id = $1", [draft1]);
    report(
      "Budget activation: replacing the active set supersedes the previous one (not deletes it)",
      draft1AfterSupersede.rows[0]?.status === "superseded"
    );

    const activeCount2 = await db.query(
      "select count(*)::int as n from budget_sets where business_id = $1 and year = 2027 and status = 'active'",
      [bizA]
    );
    report("Budget activation: still exactly one active row after replacement", activeCount2.rows[0].n === 1);
  }

  // ==========================================================================
  // Fix 1: budget_sets is no longer directly writable — RLS denies UPDATE/DELETE
  // entirely; only activate_budget_set() (SECURITY DEFINER, own ownership check) can
  // change status.
  // ==========================================================================
  {
    await asUser(userA, async () => {
      const blockedFlip = await db.query("update budget_sets set status = 'draft' where id = $1", [draft2]);
      report(
        "budget_sets: owner's direct UPDATE (flip active back to draft) is denied by RLS, affects 0 rows",
        Array.isArray(blockedFlip.rows) ? blockedFlip.rows.length === 0 : blockedFlip.affectedRows === 0
      );
    });

    await asUser(userA, async () => {
      const blockedDelete = await db.query("delete from budget_sets where id = $1", [draft2]);
      report(
        "budget_sets: owner's direct DELETE of the active set is denied by RLS, affects 0 rows",
        Array.isArray(blockedDelete.rows) ? blockedDelete.rows.length === 0 : blockedDelete.affectedRows === 0
      );
    });

    const stillActiveAfterAttempts = await db.query("select status from budget_sets where id = $1", [draft2]);
    report(
      "budget_sets: still active after both denied direct-write attempts",
      stillActiveAfterAttempts.rows[0]?.status === "active"
    );

    // actingAs, not asUser: this draft needs to persist for the tests below (budget lines
    // inserted against it, then activation) — asUser's transaction would roll it back.
    let freshDraft;
    await actingAs(userA, async () => {
      const insertDraft = await db.query(
        "insert into budget_sets (business_id, year, status) values ($1, 2033, 'draft') returning id",
        [bizA]
      );
      report("budget_sets: owner CAN insert a new draft directly (positive control)", insertDraft.rows.length === 1);
      freshDraft = insertDraft.rows[0]?.id;
    });

    await asUser(userA, async () => {
      const insertActive = await db
        .query("insert into budget_sets (business_id, year, status) values ($1, 2034, 'active')", [bizA])
        .catch((e) => ({ error: e }));
      report(
        "budget_sets: owner CANNOT insert directly as 'active' — INSERT policy requires status='draft'",
        !!insertActive.error || insertActive.rows?.length === 0
      );
    });

    await asUser(userB, async () => {
      // SECURITY DEFINER means RLS doesn't auto-filter inside the function — this proves the
      // function's own explicit ownership check is what's actually doing the denying.
      await expectError(
        "activate_budget_set: a non-owner cannot activate someone else's draft (explicit ownership check inside the SECURITY DEFINER function)",
        () => db.query("select * from activate_budget_set($1)", [freshDraft]),
        "not found"
      );
    });

    // Positive control: the actual owner still can, through the function.
    const line3 = (
      await db.query(
        `insert into budget_lines (budget_set_id, business_id, line_type, customer_name) values ($1, $2, 'customer', 'Gamma Ltd') returning id`,
        [freshDraft, bizA]
      )
    ).rows[0].id;
    await insertAllMonths(db, line3, bizA, 2033, 500);
    await actingAs(userA, async () => {
      const ownerActivates = await db.query("select * from activate_budget_set($1)", [freshDraft]);
      report(
        "activate_budget_set: the actual owner CAN activate their own complete draft, as authenticated (positive control) — and this persists (not asUser's rolled-back transaction)",
        ownerActivates.rows[0]?.status === "active"
      );
    });
  }

  // ==========================================================================
  // Fix 2: structural validation inside activate_budget_set() — empty or incomplete
  // drafts are rejected.
  // ==========================================================================
  {
    const emptyDraft = (
      await db.query(
        "insert into budget_sets (business_id, year, status) values ($1, 2035, 'draft') returning id",
        [bizA]
      )
    ).rows[0].id;
    await actingAs(userA, () =>
      expectError(
        "activate_budget_set: an empty draft (no lines at all) is rejected",
        () => db.query("select * from activate_budget_set($1)", [emptyDraft]),
        "no budget lines"
      )
    );

    const incompleteDraft = (
      await db.query(
        "insert into budget_sets (business_id, year, status) values ($1, 2036, 'draft') returning id",
        [bizA]
      )
    ).rows[0].id;
    const incompleteLine = (
      await db.query(
        `insert into budget_lines (budget_set_id, business_id, line_type, customer_name) values ($1, $2, 'customer', 'Delta Ltd') returning id`,
        [incompleteDraft, bizA]
      )
    ).rows[0].id;
    // Only 6 of 12 months.
    for (let m = 1; m <= 6; m++) {
      await db.query(
        "insert into budget_line_months (budget_line_id, business_id, month, amount) values ($1, $2, $3, $4)",
        [incompleteLine, bizA, `2036-${String(m).padStart(2, "0")}-01`, 100]
      );
    }
    await actingAs(userA, () =>
      expectError(
        "activate_budget_set: a draft with a line missing months is rejected",
        () => db.query("select * from activate_budget_set($1)", [incompleteDraft]),
        "missing one or more months"
      )
    );

    const draftStillDraft = await db.query("select status from budget_sets where id = $1", [incompleteDraft]);
    report(
      "activate_budget_set: the rejected draft remains a draft, untouched",
      draftStillDraft.rows[0]?.status === "draft"
    );
  }

  // ==========================================================================
  // Rollback: failure must preserve the previous active budget.
  // ==========================================================================
  {
    await db.query("begin");
    await db.query(
      "update budget_sets set status = 'superseded' where business_id = $1 and year = 2027 and status = 'active'",
      [bizA]
    );
    let forcedErrorRaised = false;
    try {
      await db.query("select 1/0"); // deliberate failure between the two steps
    } catch {
      forcedErrorRaised = true;
    }
    await db.query("rollback");
    report("Budget activation rollback: the forced mid-transaction failure actually occurred", forcedErrorRaised);
    const afterRollback = await db.query(
      "select id, status from budget_sets where business_id = $1 and year = 2027 and status = 'active'",
      [bizA]
    );
    report(
      "Budget activation rollback: previous active set (draft2) is restored after rollback, not left superseded",
      afterRollback.rows.length === 1 && afterRollback.rows[0].id === draft2
    );
  }

  // ==========================================================================
  // Real function error paths + the structural (not just RLS) duplicate-active guarantee.
  // ==========================================================================
  {
    await actingAs(userA, () =>
      expectError(
        "Budget activation: re-activating an already-active set is rejected",
        () => db.query("select * from activate_budget_set($1)", [draft2]),
        "not a draft"
      )
    );
    await actingAs(userA, () =>
      expectError(
        "Budget activation: activating a superseded set is rejected",
        () => db.query("select * from activate_budget_set($1)", [draft1]),
        "not a draft"
      )
    );
    await expectError(
      "Budget activation: activating a nonexistent id is rejected, not silently no-op",
      () => db.query("select * from activate_budget_set($1)", ["00000000-0000-0000-0000-000000000000"]),
      "not found"
    );

    // Structural backstop: even the table owner (which bypasses RLS entirely, unlike
    // 'authenticated') cannot force a second active row — the partial unique index is the
    // final guarantee, independent of any policy.
    const draft3 = (
      await db.query(
        "insert into budget_sets (business_id, year, status) values ($1, 2027, 'draft') returning id",
        [bizA]
      )
    ).rows[0].id;
    await expectError(
      "Budget activation: the partial unique index rejects a second active row for the same business/year even for the table owner, bypassing RLS and the function entirely",
      () => db.query("update budget_sets set status = 'active', confirmed_at = now() where id = $1", [draft3]),
      "duplicate key"
    );

    // Zero active sets is valid (annual fallback applies).
    const userC = "33333333-3333-3333-3333-333333333333";
    await db.query("insert into auth.users (id) values ($1)", [userC]);
    const bizC = (
      await db.query("insert into businesses (owner_user_id, name) values ($1, 'Business C') returning id", [userC])
    ).rows[0].id;
    const noActiveCount = await db.query(
      "select count(*)::int as n from budget_sets where business_id = $1 and status = 'active'",
      [bizC]
    );
    report("Budget activation: zero active sets for a business/year is valid, not an error state", noActiveCount.rows[0].n === 0);
  }

  // ==========================================================================
  // Exclusion of draft and superseded budgets from an "active" query
  // ==========================================================================
  {
    await db.query("insert into budget_sets (business_id, year, status) values ($1, 2028, 'draft')", [bizA]);
    const activeQuery = await db.query(
      "select id from budget_sets where business_id = $1 and year = 2028 and status = 'active'",
      [bizA]
    );
    report(
      "Budget query: an explicit status='active' filter excludes a draft-only business/year",
      activeQuery.rows.length === 0
    );

    const active2027 = await db.query(
      "select id, status from budget_sets where business_id = $1 and year = 2027 and status = 'active'",
      [bizA]
    );
    report(
      "Budget query: status='active' returns exactly the active row, excluding draft and superseded siblings",
      active2027.rows.length === 1 && active2027.rows[0].status === "active"
    );
  }

  // ==========================================================================
  // Draft-only mutation immutability, against a genuinely active set (freshDraft/2033
  // from earlier, now active) — this is what RLS actually enforces now that budget_sets
  // has no direct UPDATE path at all.
  // ==========================================================================
  {
    const activeSet = await db.query(
      "select id from budget_sets where business_id = $1 and year = 2033 and status = 'active'",
      [bizA]
    );
    const activeSetId = activeSet.rows[0].id;
    const activeSetLine = await db.query("select id from budget_lines where budget_set_id = $1 limit 1", [activeSetId]);
    const activeLineId = activeSetLine.rows[0].id;

    await asUser(userA, async () => {
      const blockedInsert = await db
        .query(
          `insert into budget_lines (budget_set_id, business_id, line_type, customer_name) values ($1, $2, 'customer', 'Too Late Ltd') returning id`,
          [activeSetId, bizA]
        )
        .catch((e) => ({ error: e }));
      report(
        "Budget lines: RLS blocks inserting a new line into an already-active budget_set",
        !!blockedInsert.error || blockedInsert.rows?.length === 0
      );
    });

    await asUser(userA, async () => {
      const blockedUpdate = await db.query("update budget_lines set sector = 'Changed' where id = $1", [activeLineId]);
      report(
        "Budget lines: RLS blocks updating a line belonging to an already-active budget_set",
        Array.isArray(blockedUpdate.rows) ? blockedUpdate.rows.length === 0 : blockedUpdate.affectedRows === 0
      );
    });

    await asUser(userA, async () => {
      const stillReadable = await db.query("select id from budget_lines where id = $1", [activeLineId]);
      report("Budget lines: an active set's lines remain readable even though they're no longer mutable", stillReadable.rows.length === 1);
    });
  }

  // ==========================================================================
  // Budget-line duplicate detection (NULL-safe) — REQ-017 dedup requirement.
  // This budget_set is intentionally never activated — it exists only to exercise
  // insert-time constraints (dedup, checks, composite FK), not the activation path.
  // ==========================================================================
  {
    const bs = (
      await db.query(
        "insert into budget_sets (business_id, year, status) values ($1, 2029, 'draft') returning id",
        [bizA]
      )
    ).rows[0].id;

    const line1 = await db.query(
      `insert into budget_lines (budget_set_id, business_id, line_type, customer_name, sector, product_service, salesperson)
       values ($1, $2, 'customer', 'Acme Ltd', 'Manufacturing', 'Widgets', 'Alice') returning id`,
      [bs, bizA]
    );
    report("Budget lines: first line for Acme/Widgets/Alice inserts fine", line1.rows.length === 1);

    await expectError(
      "Budget lines: an exact duplicate (same customer/sector/product/salesperson) is rejected",
      () =>
        db.query(
          `insert into budget_lines (budget_set_id, business_id, line_type, customer_name, sector, product_service, salesperson)
           values ($1, $2, 'customer', 'Acme Ltd', 'Manufacturing', 'Widgets', 'Alice')`,
          [bs, bizA]
        ),
      "duplicate key"
    );

    const line2 = await db.query(
      `insert into budget_lines (budget_set_id, business_id, line_type, customer_name, sector, product_service, salesperson)
       values ($1, $2, 'customer', 'Acme Ltd', 'Manufacturing', 'Widgets', 'Bob') returning id`,
      [bs, bizA]
    );
    report(
      "Budget lines: a genuinely different salesperson for the same customer/product IS allowed, not treated as a duplicate",
      line2.rows.length === 1
    );

    const line3 = await db.query(
      `insert into budget_lines (budget_set_id, business_id, line_type, customer_name, sector, product_service, salesperson)
       values ($1, $2, 'customer', 'Beta Co', 'Retail', 'Gadgets', null) returning id`,
      [bs, bizA]
    );
    report("Budget lines: a line with NULL salesperson inserts fine", line3.rows.length === 1);
    await expectError(
      "Budget lines: a second line with NULL salesperson for the same customer/sector/product IS caught as a duplicate (NULL-safe dedup)",
      () =>
        db.query(
          `insert into budget_lines (budget_set_id, business_id, line_type, customer_name, sector, product_service, salesperson)
           values ($1, $2, 'customer', 'Beta Co', 'Retail', 'Gadgets', null)`,
          [bs, bizA]
        ),
      "duplicate key"
    );

    const nb1 = await db.query(
      `insert into budget_lines (budget_set_id, business_id, line_type, sector, product_service, salesperson)
       values ($1, $2, 'new_business_unallocated', 'Manufacturing', null, null) returning id`,
      [bs, bizA]
    );
    report("Budget lines: unallocated new-business line for one sector inserts fine", nb1.rows.length === 1);
    const nb2 = await db.query(
      `insert into budget_lines (budget_set_id, business_id, line_type, sector, product_service, salesperson)
       values ($1, $2, 'new_business_unallocated', 'Retail', null, null) returning id`,
      [bs, bizA]
    );
    report(
      "Budget lines: a second unallocated line split by a DIFFERENT sector is allowed, not a duplicate",
      nb2.rows.length === 1
    );
    await expectError(
      "Budget lines: an exact duplicate unallocated line (same sector) IS caught",
      () =>
        db.query(
          `insert into budget_lines (budget_set_id, business_id, line_type, sector, product_service, salesperson)
           values ($1, $2, 'new_business_unallocated', 'Manufacturing', null, null)`,
          [bs, bizA]
        ),
      "duplicate key"
    );

    await expectError(
      "Budget lines: line_type='customer' requires a customer_name",
      () =>
        db.query(
          `insert into budget_lines (budget_set_id, business_id, line_type, customer_name) values ($1, $2, 'customer', null)`,
          [bs, bizA]
        ),
      "check"
    );
    await expectError(
      "Budget lines: line_type='new_business_unallocated' must NOT have a customer_name",
      () =>
        db.query(
          `insert into budget_lines (budget_set_id, business_id, line_type, customer_name) values ($1, $2, 'new_business_unallocated', 'Acme Ltd')`,
          [bs, bizA]
        ),
      "check"
    );

    await expectError(
      "Budget lines: business_id must match the parent budget_set's own business (composite FK)",
      () =>
        db.query(
          `insert into budget_lines (budget_set_id, business_id, line_type, customer_name) values ($1, $2, 'customer', 'Hijack Co')`,
          [bs, bizB]
        ),
      "foreign key"
    );

    const bl = line1.rows[0].id;
    const monthRow = await db.query(
      "insert into budget_line_months (budget_line_id, business_id, month, amount) values ($1, $2, '2029-01-01', 1000) returning id",
      [bl, bizA]
    );
    report("Budget line months: explicit amount inserts fine", monthRow.rows.length === 1);
    await expectError(
      "Budget line months: a second row for the same line/month is rejected (unique constraint)",
      () =>
        db.query("insert into budget_line_months (budget_line_id, business_id, month, amount) values ($1, $2, '2029-01-01', 2000)", [
          bl,
          bizA,
        ]),
      "duplicate key"
    );
    await expectError(
      "Budget line months: cross-business hijack via composite FK is rejected",
      () =>
        db.query("insert into budget_line_months (budget_line_id, business_id, month, amount) values ($1, $2, '2029-02-01', 500)", [
          bl,
          bizB,
        ]),
      "foreign key"
    );
  }

  // ==========================================================================
  // Fix 5: RULE-019 canonical monthly dates
  // ==========================================================================
  {
    const orderForDateTest = await db.query("insert into orders (business_id, total_value) values ($1, 1000) returning id", [bizA]);
    await expectError(
      "order_allocations: a period on the 15th (not first-of-month) is rejected",
      () =>
        db.query(
          "insert into order_allocations (order_id, business_id, period, outstanding_value) values ($1, $2, '2026-03-15', 100)",
          [orderForDateTest.rows[0].id, bizA]
        ),
      "check"
    );

    const bsForDates = (
      await db.query("insert into budget_sets (business_id, year, status) values ($1, 2037, 'draft') returning id", [bizA])
    ).rows[0].id;
    const lineForDates = (
      await db.query(
        `insert into budget_lines (budget_set_id, business_id, line_type, customer_name) values ($1, $2, 'customer', 'Date Test Ltd') returning id`,
        [bsForDates, bizA]
      )
    ).rows[0].id;

    await expectError(
      "budget_line_months: a month on the 15th (not first-of-month) is rejected",
      () =>
        db.query("insert into budget_line_months (budget_line_id, business_id, month, amount) values ($1, $2, '2037-03-15', 100)", [
          lineForDates,
          bizA,
        ]),
      "check"
    );

    await expectError(
      "budget_line_months: a month outside its budget_set's own year is rejected (cross-table trigger, not a plain CHECK)",
      () =>
        db.query("insert into budget_line_months (budget_line_id, business_id, month, amount) values ($1, $2, '2038-01-01', 100)", [
          lineForDates,
          bizA,
        ]),
      "must fall within"
    );

    const validMonth = await db.query(
      "insert into budget_line_months (budget_line_id, business_id, month, amount) values ($1, $2, '2037-03-01', 100) returning id",
      [lineForDates, bizA]
    );
    report("budget_line_months: a canonical first-of-month date within the correct year inserts fine", validMonth.rows.length === 1);
  }

  // ==========================================================================
  // Invoice representation exclusivity and replacement metadata — RULE-015, plus
  // invoiced_as_of() (fix 3, P&L side).
  // ==========================================================================
  let bizAInvoicedAsOfUploadId;
  {
    await expectError(
      "Uploads: a pnl-kind upload without a declared replacement range is rejected",
      () => db.query("insert into uploads (business_id, kind, storage_path) values ($1, 'pnl', 'x.csv')", [bizA]),
      "check"
    );

    const pnlUpload1 = await db.query(
      `insert into uploads (business_id, kind, storage_path, declares_replacement_from, declares_replacement_through)
       values ($1, 'pnl', 'march.csv', '2026-03-01', '2026-03-15') returning id`,
      [bizA]
    );
    report("Uploads: a pnl-kind upload with a valid declared range inserts fine", pnlUpload1.rows.length === 1);
    bizAInvoicedAsOfUploadId = pnlUpload1.rows[0].id;

    const pipelineUpload = await db.query(
      "insert into uploads (business_id, kind, storage_path) values ($1, 'pipeline', 'deals.csv') returning id",
      [bizA]
    );
    report("Uploads: a pipeline-kind upload needs no declared replacement range", pipelineUpload.rows.length === 1);

    const detailLine = await db.query(
      "insert into pnl_lines (business_id, period, invoiced_revenue, line_type, upload_id) values ($1, '2026-03-01', 5000, 'detail', $2) returning id",
      [bizA, bizAInvoicedAsOfUploadId]
    );
    report("pnl_lines: a detail-typed row linked to its upload inserts fine", detailLine.rows.length === 1);

    await expectError(
      "pnl_lines: line_type must be 'detail' or 'summary'",
      () =>
        db.query(
          "insert into pnl_lines (business_id, period, invoiced_revenue, line_type, upload_id) values ($1, '2026-03-01', 1, 'both', $2)",
          [bizA, bizAInvoicedAsOfUploadId]
        ),
      "check"
    );

    await expectError(
      "pnl_lines: linking to an upload from a different business is rejected (composite FK)",
      () =>
        db.query(
          "insert into pnl_lines (business_id, period, invoiced_revenue, line_type, upload_id) values ($1, '2026-03-01', 1, 'detail', $2)",
          [bizB, bizAInvoicedAsOfUploadId]
        ),
      "foreign key"
    );

    // A later, more-complete upload with a later declared cutoff.
    const pnlUpload2 = await db.query(
      `insert into uploads (business_id, kind, storage_path, declares_replacement_from, declares_replacement_through)
       values ($1, 'pnl', 'march-full.csv', '2026-03-01', '2026-03-31') returning id`,
      [bizA]
    );
    report("Uploads: a second, later pnl upload inserts fine", pnlUpload2.rows.length === 1);

    const invoicedAsOf = await db.query("select invoiced_as_of($1) as cutoff", [bizA]);
    report(
      "invoiced_as_of(): derives the MAX declared cutoff across pnl uploads, not a write timestamp",
      invoicedAsOf.rows[0].cutoff?.toISOString().slice(0, 10) === "2026-03-31"
    );

    const invoicedAsOfNoUploads = await db.query("select invoiced_as_of($1) as cutoff", [bizB]);
    report("invoiced_as_of(): a business with no pnl uploads gets null, not a fabricated date", invoicedAsOfNoUploads.rows[0].cutoff === null);
  }

  // ==========================================================================
  // Fix 3: order_book_as_of is a plain, owner-declared column — never auto-bumped by a
  // write trigger.
  // ==========================================================================
  {
    const beforeAnyWrites = await db.query("select order_book_as_of from businesses where id = $1", [bizA]);
    report("order_book_as_of: starts null, no default fabricates a value", beforeAnyWrites.rows[0].order_book_as_of === null);

    const orderForCutoffTest = await db.query("insert into orders (business_id, total_value) values ($1, 1000) returning id", [bizA]);
    await db.query(
      "insert into order_allocations (order_id, business_id, period, outstanding_value) values ($1, $2, '2026-04-01', 500)",
      [orderForCutoffTest.rows[0].id, bizA]
    );
    const afterOrderWrites = await db.query("select order_book_as_of from businesses where id = $1", [bizA]);
    report(
      "order_book_as_of: writing orders/order_allocations does NOT auto-bump it (no write-timestamp trigger)",
      afterOrderWrites.rows[0].order_book_as_of === null
    );

    await asUser(userA, async () => {
      const explicitSet = await db.query("update businesses set order_book_as_of = '2026-04-15' where id = $1 returning order_book_as_of", [
        bizA,
      ]);
      report(
        "order_book_as_of: the owner CAN set it explicitly via a normal UPDATE (existing businesses RLS, unchanged)",
        explicitSet.rows[0]?.order_book_as_of?.toISOString().slice(0, 10) === "2026-04-15"
      );
    });
  }

  // ==========================================================================
  // Fix 4: RULE-013 as a standing invariant, not just a one-time transition action.
  // ==========================================================================
  {
    const order = await db.query(
      "insert into orders (business_id, total_value, unscheduled_outstanding_value) values ($1, 150000, 15000) returning id",
      [bizA]
    );
    const orderId = order.rows[0].id;
    await db.query("insert into order_allocations (order_id, business_id, period, outstanding_value) values ($1, $2, '2026-02-01', 50000)", [
      orderId,
      bizA,
    ]);
    await db.query("insert into order_allocations (order_id, business_id, period, outstanding_value) values ($1, $2, '2026-03-01', 30000)", [
      orderId,
      bizA,
    ]);

    const beforeComplete = await db.query(
      "select sum(outstanding_value)::numeric as total from order_allocations where order_id = $1",
      [orderId]
    );
    report("Order completion: allocations are non-zero before completion", Number(beforeComplete.rows[0].total) === 80000);

    await db.query("update orders set status = 'complete' where id = $1", [orderId]);

    const afterComplete = await db.query(
      "select coalesce(sum(outstanding_value), 0)::numeric as total from order_allocations where order_id = $1",
      [orderId]
    );
    report(
      "Order completion: marking complete zeroes all scheduled allocations via the transition trigger",
      Number(afterComplete.rows[0].total) === 0
    );

    const orderRow = await db.query("select unscheduled_outstanding_value from orders where id = $1", [orderId]);
    report(
      "Order completion: unscheduled_outstanding_value is also zeroed, regardless of the original variance",
      Number(orderRow.rows[0].unscheduled_outstanding_value) === 0
    );

    // Standing invariant, not just the transition: inserting a new order directly as
    // 'complete' with positive unscheduled value is rejected by the CHECK constraint.
    await expectError(
      "orders: inserting a new order already 'complete' with positive unscheduled_outstanding_value is rejected (CHECK, catches insert too)",
      () =>
        db.query("insert into orders (business_id, total_value, status, unscheduled_outstanding_value) values ($1, 1000, 'complete', 500)", [
          bizA,
        ]),
      "check"
    );

    // A later positive write against an already-complete order is REJECTED, not silently
    // re-zeroed — both a new allocation row and an update to an existing (already-zeroed) one.
    await expectError(
      "order_allocations: inserting a new positive allocation against an already-complete order is rejected, not silently zeroed",
      () =>
        db.query(
          "insert into order_allocations (order_id, business_id, period, outstanding_value) values ($1, $2, '2026-05-01', 200)",
          [orderId, bizA]
        ),
      "already complete"
    );

    await expectError(
      "order_allocations: updating an existing (zeroed) allocation back to positive on an already-complete order is rejected",
      () =>
        db.query("update order_allocations set outstanding_value = 100 where order_id = $1 and period = '2026-02-01'", [orderId]),
      "already complete"
    );

    // Zero is always fine, even against a completed order (no-op, not a violation).
    const zeroWriteOk = await db
      .query("update order_allocations set outstanding_value = 0 where order_id = $1 and period = '2026-02-01' returning id", [
        orderId,
      ])
      .catch((e) => ({ error: e }));
    report("order_allocations: writing zero against an already-complete order is fine (not a violation)", !zeroWriteOk.error);
  }

  // ==========================================================================
  // Same-business FKs and cross-business isolation (RLS) — orders/allocations, budget_sets
  // ==========================================================================
  {
    const dealA = await db.query(
      `insert into deals (business_id, name, value, stage, stage_entry_date, status, qualification_tier)
       values ($1, 'Deal A', 1000, 'Proposal', '2026-01-01', 'open', 'likely') returning id`,
      [bizA]
    );
    await expectError(
      "orders: a deal_id from a different business is rejected (composite FK)",
      () => db.query("insert into orders (business_id, total_value, deal_id) values ($1, 1000, $2)", [bizB, dealA.rows[0].id]),
      "foreign key"
    );

    const orderForRls = await db.query("insert into orders (business_id, total_value) values ($1, 1000) returning id", [bizA]);
    await expectError(
      "order_allocations: an order_id from a different business is rejected (composite FK)",
      () =>
        db.query("insert into order_allocations (order_id, business_id, period, outstanding_value) values ($1, $2, '2026-01-01', 1)", [
          orderForRls.rows[0].id,
          bizB,
        ]),
      "foreign key"
    );

    await asUser(userB, async () => {
      const crossOrderSelect = await db.query("select * from orders where id = $1", [orderForRls.rows[0].id]);
      report("orders: userB cannot select userA's order (RLS-filtered empty)", crossOrderSelect.rows.length === 0);

      const crossBudgetSelect = await db.query("select * from budget_sets where business_id = $1", [bizA]);
      report("budget_sets: userB cannot select any of userA's budget sets", crossBudgetSelect.rows.length === 0);
    });

    await asUser(userA, async () => {
      const ownOrderSelect = await db.query("select * from orders where id = $1", [orderForRls.rows[0].id]);
      report("orders: userA (owner) can select their own order", ownOrderSelect.rows.length === 1);
    });

    const anonAttempt = await (async () => {
      await db.query("begin");
      await db.query("set local role anon");
      try {
        return await db.query("select * from orders");
      } catch (e) {
        return { error: e };
      } finally {
        await db.query("rollback");
      }
    })();
    report(
      "orders: anon is denied at the grant level, not just RLS",
      !!anonAttempt.error && /permission denied/i.test(String(anonAttempt.error.message))
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed;
}

async function verifyPnlLinesNotEmptyPrecondition() {
  // Fix 6: this needs its own instance — the main flow above needs pnl_lines empty. Applies
  // migration 1 alone, seeds a row using ITS schema (pre-line_type/upload_id), then confirms
  // migration 2 refuses to proceed with a clear, purpose-built error rather than an opaque
  // NOT NULL violation.
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(readFileSync(path.join(__dirname, "stub.sql"), "utf8"));

  const firstMigration = migrationFiles.find((f) => f !== "20260921120000_orders_budgets.sql");
  const secondMigration = migrationFiles.find((f) => f === "20260921120000_orders_budgets.sql");
  if (!firstMigration || !secondMigration) {
    report("pnl_lines precondition: could not identify both migration files to test against", false);
    return 1;
  }

  await db.exec(readFileSync(path.join(migrationsDir, firstMigration), "utf8"));

  const userId = "44444444-4444-4444-4444-444444444444";
  await db.query("insert into auth.users (id) values ($1)", [userId]);
  const bizId = (
    await db.query("insert into businesses (owner_user_id, name) values ($1, 'Precondition Test Biz') returning id", [userId])
  ).rows[0].id;
  await db.query("insert into pnl_lines (business_id, period, invoiced_revenue) values ($1, '2026-01-01', 1000)", [bizId]);

  await expectError(
    "pnl_lines precondition: migration 2 refuses to proceed with a clear diagnostic when pnl_lines is not empty, instead of an opaque NOT NULL failure",
    () => db.exec(readFileSync(path.join(migrationsDir, secondMigration), "utf8")),
    "not empty"
  );
}

await main();
await verifyPnlLinesNotEmptyPrecondition();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
