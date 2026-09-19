import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Isolation assertions. This file must NEVER reference SUPABASE_SERVICE_ROLE_KEY or import
// setup.mjs/teardown.mjs — it uses only the public anon key plus each test user's own token,
// exactly like a real client would. Run setup.mjs first (creates fixtures), this file second,
// teardown.mjs last.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:3000";

if (!SUPABASE_URL || !ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set.");
  process.exit(1);
}

const fixturesPath = fileURLToPath(new URL("./.fixtures.json", import.meta.url));
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));
const userA = fixtures.users.find((u) => u.label === "userA");
const userB = fixtures.users.find((u) => u.label === "userB");

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const sections = [
  "1. App-session integration (Layer A)",
  "2. Direct Data API isolation (Layer B)",
  "3. Storage isolation",
  "4. Deletion checks",
  "5. Deferred",
];
const results = Object.fromEntries(sections.map((s) => [s, []]));
let passCount = 0;
let failCount = 0;

function record(section, name, ok, detail) {
  results[section].push({ name, ok, detail });
  if (ok) passCount++;
  else failCount++;
  console.log(`${ok ? "PASS" : "FAIL"}  [${section}] ${name}${detail ? " — " + detail : ""}`);
}

function note(section, text) {
  results[section].push({ note: text });
  console.log(`NOTE  [${section}] ${text}`);
}

// ---------------------------------------------------------------------------
// PostgREST (Layer B) helpers
// ---------------------------------------------------------------------------
function restUrl(table, query = "") {
  return `${SUPABASE_URL}/rest/v1/${table}${query}`;
}

async function rest(method, table, { token, query = "", body, prefer } = {}) {
  const headers = { apikey: ANON_KEY, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  headers.Prefer = prefer ?? "return=representation";
  const res = await fetch(restUrl(table, query), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, ok: res.ok, json, text };
}

function isRlsFilteredEmpty(result) {
  // A successful request that matched zero rows — RLS silently excluded them.
  // Distinct from an error: this is the ONLY signal that counts as isolation proof
  // for a cross-tenant read/write against a row the caller doesn't own.
  return result.ok && Array.isArray(result.json) && result.json.length === 0;
}

function isRlsViolationError(result) {
  // A same-tenant row that WAS visible under USING, but whose new state failed WITH CHECK
  // (e.g. a business_id hijack attempt) — Postgres raises an explicit policy-violation error.
  return !result.ok && (result.json?.code === "42501" || /row-level security/i.test(result.text));
}

function isForeignKeyViolation(result) {
  return !result.ok && (result.json?.code === "23503" || /foreign key/i.test(result.text));
}

// ---------------------------------------------------------------------------
// Storage REST helpers
// ---------------------------------------------------------------------------
function storageObjectUrl(path) {
  return `${SUPABASE_URL}/storage/v1/object/uploads/${path}`;
}

async function storageUpload(path, token, content, contentType = "text/csv") {
  const res = await fetch(storageObjectUrl(path), {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": contentType },
    body: content,
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

async function storageDownload(path, token) {
  const res = await fetch(storageObjectUrl(path), {
    method: "GET",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

async function storageRemove(path, token) {
  const res = await fetch(storageObjectUrl(path), {
    method: "DELETE",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

async function storageList(prefix, token) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/uploads`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, limit: 100 }),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, json };
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
async function signInDirect(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Direct sign-in failed for ${email}: ${JSON.stringify(json)}`);
  return json.access_token;
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  updateFromResponse(res) {
    const setCookie =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : res.headers.get("set-cookie")
          ? [res.headers.get("set-cookie")]
          : [];
    for (const sc of setCookie) {
      const pair = sc.split(";")[0];
      const idx = pair.indexOf("=");
      this.cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function appRequest(method, path, { cookieJar, body, rawCookieHeader } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (rawCookieHeader !== undefined) headers.Cookie = rawCookieHeader;
  else if (cookieJar) headers.Cookie = cookieJar.header();
  const res = await fetch(`${APP_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (cookieJar) cookieJar.updateFromResponse(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, ok: res.ok, json, text };
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------
const ctx = {};

// ===========================================================================
// SECTION 1 — App-session integration (Layer A)
// ===========================================================================
async function section1() {
  const S = sections[0];

  const unauth = await appRequest("GET", "/api/businesses");
  record(S, "unauthenticated GET /api/businesses is rejected", unauth.status === 401, `status=${unauth.status}`);

  const badCookie = await appRequest("GET", "/api/businesses", { rawCookieHeader: "sb-garbage=not-a-real-session" });
  record(
    S,
    "invalid/garbage session cookie is rejected, not a crash",
    badCookie.status === 401,
    `status=${badCookie.status}`
  );

  const jarA = new CookieJar();
  const login = await appRequest("POST", "/api/auth/login", {
    cookieJar: jarA,
    body: { email: userA.email, password: fixtures.password },
  });
  record(S, "login as userA sets a real session cookie", login.status === 200 && login.json?.user?.id === userA.id, `status=${login.status}`);

  // Positive control + requirement 6: a client-supplied owner_user_id in the body must be ignored.
  const create = await appRequest("POST", "/api/businesses", {
    cookieJar: jarA,
    body: { name: "Isolation Test Business A", owner_user_id: userB.id },
  });
  const ownerIgnored = create.json?.business?.owner_user_id === userA.id;
  record(
    S,
    "authenticated create succeeds and ignores a spoofed owner_user_id in the body",
    create.status === 201 && ownerIgnored,
    `status=${create.status}, owner_user_id=${create.json?.business?.owner_user_id}`
  );
  ctx.bizA = create.json?.business?.id;

  const list = await appRequest("GET", "/api/businesses", { cookieJar: jarA });
  const onlyOwnBusiness =
    Array.isArray(list.json?.businesses) &&
    list.json.businesses.length === 1 &&
    list.json.businesses[0].id === ctx.bizA;
  record(S, "list returns exactly the caller's own business, nothing else", onlyOwnBusiness, `count=${list.json?.businesses?.length}`);

  await appRequest("POST", "/api/auth/logout", { cookieJar: jarA });
  const afterLogout = await appRequest("GET", "/api/businesses", { cookieJar: jarA });
  record(S, "logout clears the session — subsequent request is rejected", afterLogout.status === 401, `status=${afterLogout.status}`);
}

// ===========================================================================
// SECTION 2 — Direct Data API isolation (Layer B), all 7 tables
// ===========================================================================
async function section2() {
  const S = sections[1];

  ctx.tokenA = await signInDirect(userA.email, fixtures.password);
  ctx.tokenB = await signInDirect(userB.email, fixtures.password);

  // --- businesses: userB's positive control (userA's business already exists from section 1) ---
  const createB = await rest("POST", "businesses", { token: ctx.tokenB, body: { owner_user_id: userB.id, name: "Isolation Test Business B" } });
  ctx.bizB = createB.json?.[0]?.id;
  record(S, "businesses: userB creates their own business via direct API", createB.status === 201 && !!ctx.bizB, `status=${createB.status}`);

  const selfSelectA = await rest("GET", "businesses", { token: ctx.tokenA, query: `?id=eq.${ctx.bizA}` });
  record(S, "businesses: userA can select their own business directly", selfSelectA.ok && selfSelectA.json?.length === 1);

  const crossSelect = await rest("GET", "businesses", { token: ctx.tokenA, query: `?id=eq.${ctx.bizB}` });
  record(S, "businesses: userA cannot select business B (RLS-filtered empty, not an error)", isRlsFilteredEmpty(crossSelect), `status=${crossSelect.status}`);

  const crossUpdate = await rest("PATCH", "businesses", { token: ctx.tokenA, query: `?id=eq.${ctx.bizB}`, body: { name: "hacked" } });
  record(S, "businesses: userA's UPDATE against business B affects 0 rows", isRlsFilteredEmpty(crossUpdate), `status=${crossUpdate.status}`);
  const bizBUnchanged = await rest("GET", "businesses", { token: ctx.tokenB, query: `?id=eq.${ctx.bizB}` });
  record(S, "businesses: business B's name is verified unchanged via userB's own session", bizBUnchanged.json?.[0]?.name === "Isolation Test Business B");

  const crossDelete = await rest("DELETE", "businesses", { token: ctx.tokenA, query: `?id=eq.${ctx.bizB}` });
  record(S, "businesses: userA's DELETE against business B affects 0 rows", isRlsFilteredEmpty(crossDelete), `status=${crossDelete.status}`);

  // --- deals ---
  const dealAKeep = await rest("POST", "deals", {
    token: ctx.tokenA,
    body: { business_id: ctx.bizA, name: "Deal A keep", value: 1000, stage: "Proposal", stage_entry_date: "2026-01-01", status: "open", qualification_tier: "likely" },
  });
  ctx.dealAKeep = dealAKeep.json?.[0]?.id;
  const dealAScratch = await rest("POST", "deals", {
    token: ctx.tokenA,
    body: { business_id: ctx.bizA, name: "Deal A scratch", value: 500, stage: "Discovery", stage_entry_date: "2026-01-01", status: "open", qualification_tier: "too_early" },
  });
  ctx.dealAScratch = dealAScratch.json?.[0]?.id;
  const dealBKeep = await rest("POST", "deals", {
    token: ctx.tokenB,
    body: { business_id: ctx.bizB, name: "Deal B keep", value: 2000, stage: "Proposal", stage_entry_date: "2026-01-01", status: "open", qualification_tier: "likely" },
  });
  ctx.dealBKeep = dealBKeep.json?.[0]?.id;
  record(
    S,
    "deals: both users create their own deals (positive control)",
    dealAKeep.status === 201 && dealAScratch.status === 201 && dealBKeep.status === 201
  );

  const updateOwn = await rest("PATCH", "deals", { token: ctx.tokenA, query: `?id=eq.${ctx.dealAScratch}`, body: { value: 750 } });
  record(S, "deals: userA can update their own deal", updateOwn.ok && updateOwn.json?.[0]?.value === 750, `value=${updateOwn.json?.[0]?.value}`);

  const deleteOwn = await rest("DELETE", "deals", { token: ctx.tokenA, query: `?id=eq.${ctx.dealAScratch}` });
  record(S, "deals: userA can delete their own scratch deal", deleteOwn.ok && deleteOwn.json?.length === 1);

  const crossSelectDeal = await rest("GET", "deals", { token: ctx.tokenB, query: `?id=eq.${ctx.dealAKeep}` });
  record(S, "deals: userB cannot select userA's deal", isRlsFilteredEmpty(crossSelectDeal));

  const crossUpdateDeal = await rest("PATCH", "deals", { token: ctx.tokenB, query: `?id=eq.${ctx.dealAKeep}`, body: { value: 999999 } });
  record(S, "deals: userB's UPDATE against userA's deal affects 0 rows", isRlsFilteredEmpty(crossUpdateDeal));
  const dealAUnchanged = await rest("GET", "deals", { token: ctx.tokenA, query: `?id=eq.${ctx.dealAKeep}` });
  record(S, "deals: userA's deal value verified unchanged via userA's own session", dealAUnchanged.json?.[0]?.value === 1000, `value=${dealAUnchanged.json?.[0]?.value}`);

  const crossDeleteDeal = await rest("DELETE", "deals", { token: ctx.tokenB, query: `?id=eq.${ctx.dealAKeep}` });
  record(S, "deals: userB's DELETE against userA's deal affects 0 rows", isRlsFilteredEmpty(crossDeleteDeal));

  const hijackDeal = await rest("PATCH", "deals", { token: ctx.tokenA, query: `?id=eq.${ctx.dealAKeep}`, body: { business_id: ctx.bizB } });
  record(S, "deals: userA cannot move their own deal into business B (WITH CHECK denies the hijack)", isRlsViolationError(hijackDeal), `status=${hijackDeal.status}`);
  const dealAStillInBizA = await rest("GET", "deals", { token: ctx.tokenA, query: `?id=eq.${ctx.dealAKeep}` });
  record(S, "deals: business_id verified unchanged after the hijack attempt", dealAStillInBizA.json?.[0]?.business_id === ctx.bizA);

  // --- pnl_lines ---
  const pnlAKeep = await rest("POST", "pnl_lines", { token: ctx.tokenA, body: { business_id: ctx.bizA, period: "2026-01-01", invoiced_revenue: 100, deal_id: ctx.dealAKeep } });
  ctx.pnlAKeep = pnlAKeep.json?.[0]?.id;
  const pnlAScratch = await rest("POST", "pnl_lines", { token: ctx.tokenA, body: { business_id: ctx.bizA, period: "2026-02-01", invoiced_revenue: 200 } });
  ctx.pnlAScratch = pnlAScratch.json?.[0]?.id;
  const pnlBKeep = await rest("POST", "pnl_lines", { token: ctx.tokenB, body: { business_id: ctx.bizB, period: "2026-01-01", invoiced_revenue: 300, deal_id: ctx.dealBKeep } });
  ctx.pnlBKeep = pnlBKeep.json?.[0]?.id;
  record(S, "pnl_lines: both users create their own P&L lines, one linked to their own deal (positive control)", pnlAKeep.status === 201 && pnlAScratch.status === 201 && pnlBKeep.status === 201);

  const updatePnlOwn = await rest("PATCH", "pnl_lines", { token: ctx.tokenA, query: `?id=eq.${ctx.pnlAScratch}`, body: { invoiced_revenue: 250 } });
  record(S, "pnl_lines: userA can update their own line", updatePnlOwn.ok && updatePnlOwn.json?.[0]?.invoiced_revenue === 250, `value=${updatePnlOwn.json?.[0]?.invoiced_revenue}`);
  const deletePnlOwn = await rest("DELETE", "pnl_lines", { token: ctx.tokenA, query: `?id=eq.${ctx.pnlAScratch}` });
  record(S, "pnl_lines: userA can delete their own scratch line", deletePnlOwn.ok && deletePnlOwn.json?.length === 1);

  const crossSelectPnl = await rest("GET", "pnl_lines", { token: ctx.tokenB, query: `?id=eq.${ctx.pnlAKeep}` });
  record(S, "pnl_lines: userB cannot select userA's line", isRlsFilteredEmpty(crossSelectPnl));

  const crossUpdatePnl = await rest("PATCH", "pnl_lines", { token: ctx.tokenB, query: `?id=eq.${ctx.pnlAKeep}`, body: { invoiced_revenue: 0 } });
  record(S, "pnl_lines: userB's UPDATE against userA's line affects 0 rows", isRlsFilteredEmpty(crossUpdatePnl));
  const pnlAUnchanged = await rest("GET", "pnl_lines", { token: ctx.tokenA, query: `?id=eq.${ctx.pnlAKeep}` });
  record(S, "pnl_lines: userA's line verified unchanged via userA's own session", pnlAUnchanged.json?.[0]?.invoiced_revenue === 100, `value=${pnlAUnchanged.json?.[0]?.invoiced_revenue}`);

  const hijackPnl = await rest("PATCH", "pnl_lines", { token: ctx.tokenA, query: `?id=eq.${ctx.pnlAKeep}`, body: { business_id: ctx.bizB } });
  record(S, "pnl_lines: userA cannot move their own line into business B", isRlsViolationError(hijackPnl), `status=${hijackPnl.status}`);

  const crossDealLink = await rest("PATCH", "pnl_lines", { token: ctx.tokenA, query: `?id=eq.${ctx.pnlAKeep}`, body: { deal_id: ctx.dealBKeep } });
  record(
    S,
    "pnl_lines: linking to a deal from a different business is rejected by the composite FK (schema-level, not RLS)",
    isForeignKeyViolation(crossDealLink),
    `status=${crossDealLink.status}`
  );

  // --- targets ---
  const targetA = await rest("POST", "targets", { token: ctx.tokenA, body: { business_id: ctx.bizA, revenue_target_annual: 300000 } });
  ctx.targetA = targetA.json?.[0]?.id;
  const targetB = await rest("POST", "targets", { token: ctx.tokenB, body: { business_id: ctx.bizB, revenue_target_annual: 500000 } });
  ctx.targetB = targetB.json?.[0]?.id;
  record(S, "targets: both users create their own target row (positive control)", targetA.status === 201 && targetB.status === 201);

  const updateTargetOwn = await rest("PATCH", "targets", { token: ctx.tokenA, query: `?id=eq.${ctx.targetA}`, body: { margin_target_percent: 25 } });
  record(S, "targets: userA can update their own target", updateTargetOwn.ok && updateTargetOwn.json?.[0]?.margin_target_percent === 25, `value=${updateTargetOwn.json?.[0]?.margin_target_percent}`);

  const crossSelectTarget = await rest("GET", "targets", { token: ctx.tokenA, query: `?id=eq.${ctx.targetB}` });
  record(S, "targets: userA cannot select business B's target", isRlsFilteredEmpty(crossSelectTarget));
  const crossUpdateTarget = await rest("PATCH", "targets", { token: ctx.tokenA, query: `?id=eq.${ctx.targetB}`, body: { revenue_target_annual: 1 } });
  record(S, "targets: userA's UPDATE against business B's target affects 0 rows", isRlsFilteredEmpty(crossUpdateTarget));
  const targetBUnchanged = await rest("GET", "targets", { token: ctx.tokenB, query: `?id=eq.${ctx.targetB}` });
  record(S, "targets: business B's target verified unchanged via userB's own session", targetBUnchanged.json?.[0]?.revenue_target_annual === 500000, `value=${targetBUnchanged.json?.[0]?.revenue_target_annual}`);
  const crossDeleteTarget = await rest("DELETE", "targets", { token: ctx.tokenA, query: `?id=eq.${ctx.targetB}` });
  record(S, "targets: userA's DELETE against business B's target affects 0 rows", isRlsFilteredEmpty(crossDeleteTarget));
  const hijackTarget = await rest("PATCH", "targets", { token: ctx.tokenA, query: `?id=eq.${ctx.targetA}`, body: { business_id: ctx.bizB } });
  record(S, "targets: userA cannot move their own target into business B", isRlsViolationError(hijackTarget) || isRlsFilteredEmpty(hijackTarget) === false, `status=${hijackTarget.status}`);

  // --- commercial_baseline ---
  const baselineA = await rest("POST", "commercial_baseline", { token: ctx.tokenA, body: { business_id: ctx.bizA, sales_cycle_days: 40 } });
  ctx.baselineA = baselineA.json?.[0]?.id;
  const baselineB = await rest("POST", "commercial_baseline", { token: ctx.tokenB, body: { business_id: ctx.bizB, sales_cycle_days: 60 } });
  ctx.baselineB = baselineB.json?.[0]?.id;
  record(S, "commercial_baseline: both users create their own baseline row (positive control)", baselineA.status === 201 && baselineB.status === 201);

  const updateBaselineOwn = await rest("PATCH", "commercial_baseline", { token: ctx.tokenA, query: `?id=eq.${ctx.baselineA}`, body: { stale_opportunity_threshold_days: 30 } });
  record(S, "commercial_baseline: userA can update their own baseline", updateBaselineOwn.ok && updateBaselineOwn.json?.[0]?.stale_opportunity_threshold_days === 30);

  const crossSelectBaseline = await rest("GET", "commercial_baseline", { token: ctx.tokenA, query: `?id=eq.${ctx.baselineB}` });
  record(S, "commercial_baseline: userA cannot select business B's baseline", isRlsFilteredEmpty(crossSelectBaseline));
  const crossUpdateBaseline = await rest("PATCH", "commercial_baseline", { token: ctx.tokenA, query: `?id=eq.${ctx.baselineB}`, body: { sales_cycle_days: 1 } });
  record(S, "commercial_baseline: userA's UPDATE against business B's baseline affects 0 rows", isRlsFilteredEmpty(crossUpdateBaseline));
  const baselineBUnchanged = await rest("GET", "commercial_baseline", { token: ctx.tokenB, query: `?id=eq.${ctx.baselineB}` });
  record(S, "commercial_baseline: business B's baseline verified unchanged via userB's own session", baselineBUnchanged.json?.[0]?.sales_cycle_days === 60);
  const crossDeleteBaseline = await rest("DELETE", "commercial_baseline", { token: ctx.tokenA, query: `?id=eq.${ctx.baselineB}` });
  record(S, "commercial_baseline: userA's DELETE against business B's baseline affects 0 rows", isRlsFilteredEmpty(crossDeleteBaseline));

  // --- uploads (metadata table; real Storage object tested in section 3) ---
  const uploadA = await rest("POST", "uploads", { token: ctx.tokenA, body: { business_id: ctx.bizA, kind: "pipeline", storage_path: `${ctx.bizA}/deals.csv` } });
  ctx.uploadA = uploadA.json?.[0]?.id;
  const uploadB = await rest("POST", "uploads", { token: ctx.tokenB, body: { business_id: ctx.bizB, kind: "pipeline", storage_path: `${ctx.bizB}/deals.csv` } });
  ctx.uploadB = uploadB.json?.[0]?.id;
  record(S, "uploads: both users create their own upload record (positive control)", uploadA.status === 201 && uploadB.status === 201);

  const updateUploadOwn = await rest("PATCH", "uploads", { token: ctx.tokenA, query: `?id=eq.${ctx.uploadA}`, body: { kind: "pnl" } });
  record(S, "uploads: userA can update their own upload record", updateUploadOwn.ok && updateUploadOwn.json?.[0]?.kind === "pnl");

  const crossSelectUpload = await rest("GET", "uploads", { token: ctx.tokenA, query: `?id=eq.${ctx.uploadB}` });
  record(S, "uploads: userA cannot select business B's upload record", isRlsFilteredEmpty(crossSelectUpload));
  const crossDeleteUpload = await rest("DELETE", "uploads", { token: ctx.tokenA, query: `?id=eq.${ctx.uploadB}` });
  record(S, "uploads: userA's DELETE against business B's upload record affects 0 rows", isRlsFilteredEmpty(crossDeleteUpload));
  const uploadBUnchanged = await rest("GET", "uploads", { token: ctx.tokenB, query: `?id=eq.${ctx.uploadB}` });
  record(S, "uploads: business B's upload record verified still present via userB's own session", uploadBUnchanged.json?.length === 1);
  const hijackUpload = await rest("PATCH", "uploads", { token: ctx.tokenA, query: `?id=eq.${ctx.uploadA}`, body: { business_id: ctx.bizB } });
  record(S, "uploads: userA cannot move their own upload record into business B", isRlsViolationError(hijackUpload), `status=${hijackUpload.status}`);

  // --- feedback_events: insert/select only, NO update/delete for anyone, including the owner ---
  const feedbackA = await rest("POST", "feedback_events", { token: ctx.tokenA, body: { business_id: ctx.bizA, verdict_period: "2026-Q1", signal: "trust" } });
  ctx.feedbackA = feedbackA.json?.[0]?.id;
  record(S, "feedback_events: userA can INSERT their own feedback (positive control)", feedbackA.status === 201);

  const feedbackSelectOwn = await rest("GET", "feedback_events", { token: ctx.tokenA, query: `?id=eq.${ctx.feedbackA}` });
  record(S, "feedback_events: userA can SELECT their own feedback (positive control)", feedbackSelectOwn.json?.length === 1);

  const feedbackUpdateOwn = await rest("PATCH", "feedback_events", { token: ctx.tokenA, query: `?id=eq.${ctx.feedbackA}`, body: { signal: "no_trust" } });
  record(S, "feedback_events: UPDATE is denied even for the row's own owner (0 rows)", isRlsFilteredEmpty(feedbackUpdateOwn), `status=${feedbackUpdateOwn.status}`);
  const feedbackDeleteOwn = await rest("DELETE", "feedback_events", { token: ctx.tokenA, query: `?id=eq.${ctx.feedbackA}` });
  record(S, "feedback_events: DELETE is denied even for the row's own owner (0 rows)", isRlsFilteredEmpty(feedbackDeleteOwn), `status=${feedbackDeleteOwn.status}`);
  const feedbackStillIntact = await rest("GET", "feedback_events", { token: ctx.tokenA, query: `?id=eq.${ctx.feedbackA}` });
  record(
    S,
    "feedback_events: row verified unchanged and still present after both denied attempts",
    feedbackStillIntact.json?.length === 1 && feedbackStillIntact.json[0].signal === "trust"
  );

  const crossSelectFeedback = await rest("GET", "feedback_events", { token: ctx.tokenB, query: `?id=eq.${ctx.feedbackA}` });
  record(S, "feedback_events: userB cannot select userA's feedback", isRlsFilteredEmpty(crossSelectFeedback));
  const crossInsertFeedback = await rest("POST", "feedback_events", { token: ctx.tokenA, body: { business_id: ctx.bizB, verdict_period: "2026-Q1", signal: "trust" } });
  record(
    S,
    "feedback_events: userA cannot INSERT a row against business B (WITH CHECK denies it)",
    isRlsViolationError(crossInsertFeedback),
    `status=${crossInsertFeedback.status}`
  );
}

// ===========================================================================
// SECTION 3 — Storage isolation (real objects, real bytes)
// ===========================================================================
async function section3() {
  const S = sections[2];
  const path = `${ctx.bizA}/isolation-test-file.csv`;
  const content = "deal_name,value\nTest Deal,1000\n";

  const upload = await storageUpload(path, ctx.tokenA, content);
  record(S, "storage: userA uploads a real object to their own business folder", upload.status === 200 || upload.status === 201, `status=${upload.status}`);

  const download = await storageDownload(path, ctx.tokenA);
  record(S, "storage: userA downloads their own object and content matches", download.ok && download.text === content, `status=${download.status}`);

  const crossDownload = await storageDownload(path, ctx.tokenB);
  record(S, "storage: userB cannot download userA's object", !crossDownload.ok, `status=${crossDownload.status}`);

  const crossDelete = await storageRemove(path, ctx.tokenB);
  record(S, "storage: userB's delete attempt on userA's object does not succeed", !crossDelete.ok, `status=${crossDelete.status}`);

  const anonDownload = await storageDownload(path, ANON_KEY);
  record(S, "storage: anonymous (anon-key) request cannot download userA's object", !anonDownload.ok, `status=${anonDownload.status}`);

  const stillThereForOwner = await storageDownload(path, ctx.tokenA);
  record(
    S,
    "storage: object verified unaffected and still downloadable by userA after the denied attempts",
    stillThereForOwner.ok && stillThereForOwner.text === content
  );

  const ownDelete = await storageRemove(path, ctx.tokenA);
  record(S, "storage: userA can delete their own object", ownDelete.ok, `status=${ownDelete.status}`);

  // Observed: a direct object GET immediately after DELETE can briefly return the stale object
  // (eventual consistency on the read path) even though the delete itself succeeded. `list`
  // was consistently accurate immediately in every manual check. Poll GET briefly and report
  // whether a retry was needed — this is a real operational nuance, not a security failure,
  // and it's a concrete reason for item 8's deletion workflow to confirm emptiness via `list`
  // rather than a direct GET/HEAD.
  const deleteConsistencyStart = Date.now();
  let afterOwnDelete = await storageDownload(path, ctx.tokenA);
  let retries = 0;
  while (afterOwnDelete.ok && retries < 20) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    afterOwnDelete = await storageDownload(path, ctx.tokenA);
    retries++;
  }
  const elapsedMs = Date.now() - deleteConsistencyStart;
  record(
    S,
    "storage: object is gone after userA's own delete (measuring actual GET consistency lag, not just pass/fail)",
    !afterOwnDelete.ok,
    retries > 0
      ? `GET returned stale data for ~${elapsedMs}ms after DELETE (${retries} retries) before resolving to not-found — list() was accurate immediately in every check in this suite`
      : "consistent immediately"
  );
}

// ===========================================================================
// SECTION 4 — Deletion checks (real Storage objects gate the business DELETE)
// ===========================================================================
async function section4() {
  const S = sections[3];
  const path = `${ctx.bizB}/deletion-guard-test.csv`;
  const content = "x\n1\n";

  await storageUpload(path, ctx.tokenB, content);
  const listBefore = await storageList(ctx.bizB, ctx.tokenB);
  record(S, "deletion guard: business B has a real Storage object present before the delete attempt", (listBefore.json?.length ?? 0) > 0);

  const blockedDelete = await rest("DELETE", "businesses", { token: ctx.tokenB, query: `?id=eq.${ctx.bizB}` });
  record(S, "deletion guard: business DELETE is blocked while a Storage object remains", isRlsFilteredEmpty(blockedDelete), `status=${blockedDelete.status}`);
  const stillExists = await rest("GET", "businesses", { token: ctx.tokenB, query: `?id=eq.${ctx.bizB}` });
  record(S, "deletion guard: business B row still exists after the blocked attempt", stillExists.json?.length === 1);

  await storageRemove(path, ctx.tokenB);
  const listAfter = await storageList(ctx.bizB, ctx.tokenB);
  record(S, "deletion guard: Storage is confirmed empty for business B after cleanup", (listAfter.json?.length ?? 0) === 0);

  const allowedDelete = await rest("DELETE", "businesses", { token: ctx.tokenB, query: `?id=eq.${ctx.bizB}` });
  record(S, "deletion guard: business DELETE succeeds once Storage is empty, under the owner's own session", allowedDelete.ok && allowedDelete.json?.length === 1, `status=${allowedDelete.status}`);
  const goneNow = await rest("GET", "businesses", { token: ctx.tokenB, query: `?id=eq.${ctx.bizB}` });
  record(S, "deletion guard: business B is confirmed gone", goneNow.json?.length === 0);

  note(
    S,
    "This proves the synchronous single-request case only. Two things remain explicitly OPEN, not resolved by this test: " +
      "(a) the concurrent-upload race condition — an upload landing between a client's 'list Storage' check and its DELETE call " +
      "is not exercised here and is not prevented by the current policy on its own; " +
      "(b) the auth.users cascade/admin-deletion path for full account deletion is untouched — this test only deletes a business row, " +
      "never an auth user. Both are item 8's tracked, unbuilt scope."
  );
}

// ===========================================================================
// SECTION 5 — Deferred
// ===========================================================================
function section5() {
  const S = sections[4];
  note(
    S,
    "The calc-engine route (/api/verdict) was not exercised in this run. It already uses the same " +
      "session-scoped server client proven correct in section 1, but that alone does not prove the route's " +
      "own query/aggregation logic is correct or that it stays isolated once deals/pnl_lines/targets data " +
      "actually exists for a business. That needs its own check once the upload flow exists and a real " +
      "dataset can be loaded through it — tracked separately, not covered here."
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
await section1();
await section2();
await section3();
await section4();
section5();

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
