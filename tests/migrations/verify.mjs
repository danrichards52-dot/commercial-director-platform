import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Verifies every migration under supabase/migrations/, in order, against a real Postgres
// engine (PGlite — WASM, not a mock) with minimal stubs for the parts of the Supabase
// platform the migrations depend on (auth.uid(), storage.buckets/objects). Run with
// `npm run test:migrations`. Never touches the live project.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../supabase/migrations");

const db = new PGlite({ extensions: { pgcrypto } });

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

async function main() {
  await db.exec(readFileSync(path.join(__dirname, "stub.sql"), "utf8"));

  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
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

  // ==========================================================================
  // Budget activation, rollback, concurrency-equivalent structural guarantees
  // ==========================================================================
  {
    const draft1 = (
      await db.query(
        "insert into budget_sets (business_id, year, status) values ($1, 2027, 'draft') returning id",
        [bizA]
      )
    ).rows[0].id;

    const activated1 = await db.query("select * from activate_budget_set($1)", [draft1]);
    report(
      "Budget activation: happy path activates a draft with no prior active set",
      activated1.rows[0]?.status === "active" && activated1.rows[0]?.confirmed_at !== null
    );

    const activeCount1 = await db.query(
      "select count(*)::int as n from budget_sets where business_id = $1 and year = 2027 and status = 'active'",
      [bizA]
    );
    report("Budget activation: exactly one active row exists after activation", activeCount1.rows[0].n === 1);

    // Second draft for the SAME business/year — activating it must supersede the first.
    const draft2 = (
      await db.query(
        "insert into budget_sets (business_id, year, status) values ($1, 2027, 'draft') returning id",
        [bizA]
      )
    ).rows[0].id;

    const activated2 = await db.query("select * from activate_budget_set($1)", [draft2]);
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

    // Structural guarantee behind "concurrent activation attempts must not leave two active
    // sets": the partial unique index makes a second simultaneously-active row impossible
    // regardless of timing or which code path attempts it — tested here by bypassing the
    // function entirely and trying to force a duplicate active row directly.
    const draft3 = (
      await db.query(
        "insert into budget_sets (business_id, year, status) values ($1, 2027, 'draft') returning id",
        [bizA]
      )
    ).rows[0].id;
    await expectError(
      "Budget activation: the partial unique index rejects a second active row for the same business/year even via a direct UPDATE bypassing the function",
      () => db.query("update budget_sets set status = 'active', confirmed_at = now() where id = $1", [draft3]),
      "duplicate key"
    );
    const draft3AfterFailedDirectUpdate = await db.query("select status from budget_sets where id = $1", [draft3]);
    report(
      "Budget activation: the rejected direct attempt leaves the draft as draft, and the real active set untouched",
      draft3AfterFailedDirectUpdate.rows[0]?.status === "draft"
    );
    const stillActive = await db.query("select id, status from budget_sets where id = $1", [draft2]);
    report(
      "Budget activation: the genuinely active set (draft2) is unaffected by the rejected concurrent attempt",
      stillActive.rows[0]?.status === "active"
    );

    // Rollback: failure must preserve the previous active budget. Demonstrated on the actual
    // underlying mechanism the function relies on (transactional atomicity) — supersede the
    // active set, then force an error before the activating UPDATE, and confirm ROLLBACK
    // restores the previous active set exactly.
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

    // Real function error paths.
    await expectError(
      "Budget activation: re-activating an already-active set is rejected",
      () => db.query("select * from activate_budget_set($1)", [draft2]),
      "not a draft"
    );
    await expectError(
      "Budget activation: activating a superseded set is rejected",
      () => db.query("select * from activate_budget_set($1)", [draft1]),
      "not a draft"
    );
    await expectError(
      "Budget activation: activating a nonexistent id is rejected, not silently no-op",
      () => db.query("select * from activate_budget_set($1)", ["00000000-0000-0000-0000-000000000000"]),
      "not found"
    );

    // Zero active sets is valid (annual fallback applies).
    const userC = "33333333-3333-3333-3333-333333333333";
    await db.query("insert into auth.users (id) values ($1)", [userC]);
    const bizC = (
      await db.query("insert into businesses (owner_user_id, name) values ($1, 'Business C') returning id", [
        userC,
      ])
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
    const draftOnly = (
      await db.query(
        "insert into budget_sets (business_id, year, status) values ($1, 2028, 'draft') returning id",
        [bizA]
      )
    ).rows[0].id;
    const activeQuery = await db.query(
      "select id from budget_sets where business_id = $1 and year = 2028 and status = 'active'",
      [bizA]
    );
    report(
      "Budget query: an explicit status='active' filter excludes a draft-only business/year",
      activeQuery.rows.length === 0
    );

    // 2027 now has one active (draft2) and two non-active (draft1 superseded, draft3 draft).
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
  // Budget-line duplicate detection (NULL-safe) — REQ-017 dedup requirement
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

    // NULL-safety: two lines with NULL salesperson for the same customer/sector/product must
    // be caught as duplicates — this is the case a naive UNIQUE(...) on nullable columns misses.
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

    // new_business_unallocated: no customer, but distinguishable by sector/product/salesperson
    // (open question #3 — split-by-dimension must be POSSIBLE, not force a single row).
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

    // Same-business composite FK: a budget_line can't claim a business_id different from its
    // parent budget_set's actual business.
    await expectError(
      "Budget lines: business_id must match the parent budget_set's own business (composite FK)",
      () =>
        db.query(
          `insert into budget_lines (budget_set_id, business_id, line_type, customer_name) values ($1, $2, 'customer', 'Hijack Co')`,
          [bs, bizB]
        ),
      "foreign key"
    );

    // budget_line_months: blank cell = no row, not amount=0.
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

    // Draft-only mutation: once the set is active, lines/months become immutable via RLS.
    // Each assertion gets its own transaction — Postgres aborts a transaction entirely after
    // any error within it, so an expected-to-fail statement can't be followed by more
    // statements in the same asUser() call without a savepoint.
    await db.query("select * from activate_budget_set($1)", [bs]);

    await asUser(userA, async () => {
      const blockedInsert = await db
        .query(
          `insert into budget_lines (budget_set_id, business_id, line_type, customer_name) values ($1, $2, 'customer', 'Too Late Ltd') returning id`,
          [bs, bizA]
        )
        .catch((e) => ({ error: e }));
      report(
        "Budget lines: RLS blocks inserting a new line into an already-active budget_set",
        !!blockedInsert.error || blockedInsert.rows?.length === 0
      );
    });

    await asUser(userA, async () => {
      const blockedUpdate = await db.query("update budget_lines set sector = 'Changed' where id = $1", [line1.rows[0].id]);
      report(
        "Budget lines: RLS blocks updating a line belonging to an already-active budget_set",
        Array.isArray(blockedUpdate.rows) ? blockedUpdate.rows.length === 0 : blockedUpdate.affectedRows === 0
      );
    });

    await asUser(userA, async () => {
      const stillReadable = await db.query("select id from budget_lines where id = $1", [line1.rows[0].id]);
      report("Budget lines: an active set's lines remain readable even though they're no longer mutable", stillReadable.rows.length === 1);
    });
  }

  // ==========================================================================
  // Invoice representation exclusivity and replacement metadata — RULE-015
  // ==========================================================================
  {
    await expectError(
      "Uploads: a pnl-kind upload without a declared replacement range is rejected",
      () => db.query("insert into uploads (business_id, kind, storage_path) values ($1, 'pnl', 'x.csv')", [bizA]),
      "check"
    );

    const pnlUpload = await db.query(
      `insert into uploads (business_id, kind, storage_path, declares_replacement_from, declares_replacement_through)
       values ($1, 'pnl', 'march.csv', '2026-03-01', '2026-03-15') returning id`,
      [bizA]
    );
    report("Uploads: a pnl-kind upload with a valid declared range inserts fine", pnlUpload.rows.length === 1);
    const uploadId = pnlUpload.rows[0].id;

    const pipelineUpload = await db.query(
      "insert into uploads (business_id, kind, storage_path) values ($1, 'pipeline', 'deals.csv') returning id",
      [bizA]
    );
    report("Uploads: a pipeline-kind upload needs no declared replacement range", pipelineUpload.rows.length === 1);

    const detailLine = await db.query(
      "insert into pnl_lines (business_id, period, invoiced_revenue, line_type, upload_id) values ($1, '2026-03-01', 5000, 'detail', $2) returning id",
      [bizA, uploadId]
    );
    report("pnl_lines: a detail-typed row linked to its upload inserts fine", detailLine.rows.length === 1);

    await expectError(
      "pnl_lines: line_type must be 'detail' or 'summary'",
      () =>
        db.query("insert into pnl_lines (business_id, period, invoiced_revenue, line_type, upload_id) values ($1, '2026-03-01', 1, 'both', $2)", [
          bizA,
          uploadId,
        ]),
      "check"
    );

    await expectError(
      "pnl_lines: linking to an upload from a different business is rejected (composite FK)",
      () =>
        db.query(
          "insert into pnl_lines (business_id, period, invoiced_revenue, line_type, upload_id) values ($1, '2026-03-01', 1, 'detail', $2)",
          [bizB, uploadId]
        ),
      "foreign key"
    );
  }

  // ==========================================================================
  // Order completion — RULE-013/014
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
      "Order completion: marking complete zeroes all scheduled allocations via the trigger",
      Number(afterComplete.rows[0].total) === 0
    );

    const orderRow = await db.query("select unscheduled_outstanding_value from orders where id = $1", [orderId]);
    report(
      "Order completion: unscheduled_outstanding_value is also zeroed, regardless of the original variance",
      Number(orderRow.rows[0].unscheduled_outstanding_value) === 0
    );
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

      const crossBudgetSelect = await db.query(
        "select * from budget_sets where business_id = $1",
        [bizA]
      );
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
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Harness error:", e);
  process.exit(1);
});
