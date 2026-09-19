# Data, security and permissions — MVP

Status: Draft | Owner: Dan (Security and technical owner) | Last reviewed: 2026-09-19
Applicability: Applies | Evidence baseline: doc 03 (requirements), doc 04 (architecture)
Related requirements / ADRs: doc 03 RULE-001–008; doc 04's RLS gate (identity/tenancy trust chain verified before real data) | Next review: Before any pilot business's real data is stored

> MVP has no organisation/membership model — one authenticated user owns one business, full stop. That collapses most of the Access contract table below to two real states (anonymous vs. owner), but the table is kept in full so V1's multi-tenant work (doc 02) has something concrete to extend rather than a blank page.

## Data inventory and ownership

| Entity/resource | Classification | Tenant/global/user scope | Owner/key | Retention/deletion | Backup/export | Source |
|---|---|---|---|---|---|---|
| `businesses` | Internal | User-scoped | `owner_user_id` FK to `auth.users` | **Decided** — permanently deleted from the live platform on departure/deletion request; backups purge within a defined window (e.g. 30 days); no archiving | Supabase automated backups (subject to the same purge window) | New table |
| `deals` (pipeline) | Sensitive (real commercial data) | Scoped via `business_id` → owner | `business_id` FK | Deleted when parent business is deleted (per policy above); superseded rows overwritten on re-upload (REQ-010) | Supabase automated backups (purge window applies) | New table |
| `pnl_lines` (P&L/invoiced) | Sensitive (real financial data) | Scoped via `business_id` → owner | `business_id` FK | Same as deals | Supabase automated backups (purge window applies) | New table |
| `targets` | Internal | Scoped via `business_id` → owner | `business_id` FK | Same as deals | Supabase automated backups (purge window applies) | New table |
| `commercial_baseline` (REQ-013 — sales-cycle benchmark, stale-opportunity threshold; revenue target and margin target + minimum live in `targets`) | Internal | Scoped via `business_id` → owner, one row per business | `business_id` FK | Same as deals — this is business configuration, not exempt from the deletion policy | Supabase automated backups (purge window applies) | New table |
| `uploads` (raw CSV, audit trail) | Sensitive | Scoped via `business_id` → owner | `business_id` FK | Same as deals — the raw file is commercial data too, not exempt from the deletion policy | Supabase Storage (purge window applies) | New bucket |
| `feedback_events` (REQ-011) | Internal | Scoped via `business_id` → owner | `business_id` FK | Same as deals, unless Dan separately decides pilot research feedback should survive deletion in anonymised form — not yet decided, treat as deleted by default | Supabase automated backups (purge window applies) | New table |

No global/public records exist in this schema — every row belongs to exactly one business, and every business belongs to exactly one user. `businesses.owner_user_id` is the single source of truth for ownership; there is no separate roles table at MVP because there is only one role.

## Access contract

| Resource/action | Anonymous | Non-member | Member | Admin | Owner | Removed member | Service/job |
|---|---|---|---|---|---|---|---|
| `deals` / `pnl_lines` / `targets` / `commercial_baseline`: read, create (via upload/form), update, delete | Deny | N/A — no membership model at MVP | N/A | N/A | Allow, own business only | N/A | Calc-engine route reads under the caller's own session — never a privileged bypass |
| `uploads`: create, read, delete | Deny | N/A | N/A | N/A | Allow, own business only | N/A | N/A |
| `feedback_events`: create, read own | Deny | N/A | N/A | N/A | Allow, own business only | N/A | N/A |
| Computed verdict (calc-engine output) | Deny | N/A | N/A | N/A | Read-only, derived live from the caller's own data — never stored as an independently editable resource | N/A | N/A |

Session: Supabase Auth default JWT + refresh token, no custom expiry logic at MVP. Authoritative ownership is `businesses.owner_user_id` — never trust any client-supplied business ID without checking it against the authenticated session server-side, even though the UI itself has no multi-business switcher to exploit yet.

## RLS and database exposure contract

| Object | Exposed? / grants | RLS state | SELECT/DELETE predicate | INSERT check | UPDATE old/new checks | Tests / migration |
|---|---|---|---|---|---|---|
| `businesses` | `authenticated` role only, never `anon` | Enabled, must be verified before pilot data | `owner_user_id = auth.uid()` | `owner_user_id = auth.uid()` | Same predicate on both old and new row | Required isolation evidence below |
| `deals` | `authenticated` only | Enabled, must be verified | `business_id IN (SELECT id FROM businesses WHERE owner_user_id = auth.uid())` | Same subquery against the target `business_id` | Same predicate, old and new | Same |
| `pnl_lines` | `authenticated` only | Enabled, must be verified | Same pattern as `deals` | Same | Same | Same |
| `targets` | `authenticated` only | Enabled, must be verified | Same pattern | Same | Same | Same |
| `commercial_baseline` | `authenticated` only | Enabled, must be verified | Same pattern | Same | Same | Same |
| `uploads` (table + Storage bucket) | `authenticated` only | Enabled, must be verified | Same pattern; Storage policy mirrors it on the object path (`uploads/{business_id}/...`) | Same | Same | Same |
| `feedback_events` | `authenticated` only | Enabled, must be verified | Same pattern | Same | N/A — insert-only at MVP | Same |

**The calc-engine API route (doc 04) must execute using the caller's own authenticated Supabase client, not the service-role key.** The service-role key is server-only, used solely for migrations/admin scripts, and must never appear in a user-facing request path — if it did, every RLS policy above becomes decorative rather than enforced. This is the single most important line in this document; verify it explicitly during implementation, not by assumption.

## Isolation beyond tables

Object storage: uploaded CSVs live at `uploads/{business_id}/{upload_id}.csv`, with Storage RLS mirroring the table policies — a user can only read/write objects under their own `business_id` prefix. No public buckets. No signed URLs needed at MVP (files are only ever fetched by their owning user through the app, not shared externally). No realtime channels, search indexes, or background jobs exist at MVP — everything is synchronous request/response. Logs and error messages must never include uploaded file contents, deal names, or monetary figures in plaintext — a stack trace or generic error log is not the place for a pilot business's real revenue numbers.

## Threats and controls

| Threat / abuse case | Entry point | Control/enforcement | Verification | Residual risk / owner |
|---|---|---|---|---|
| Cross-tenant ID substitution (User A requests User B's `business_id`) | API routes, direct DB query | RLS predicate on every table, keyed off `auth.uid()` | Negative test: authenticated User A attempts to read/write User B's rows via API and direct query | Low once verified — this is doc 04's blocking gate before real data / Dan |
| Service-role key used in a user-facing route by mistake | Server code | Service-role key restricted to migration/admin scripts only, never imported into request-handling code | Code review + grep for service-role usage outside admin scripts | Medium until explicitly checked — easy mistake to make, easy to miss / Dan |
| Malicious or malformed CSV upload | Upload endpoint | Strict validation against the platform-supplied template; reject non-conforming rows explicitly (AC-002-02); size limits; file stored inert, never executed or parsed as anything but data | Test with malformed, oversized and adversarial files | Low / Dan |
| Secret exposure in client bundle, repo or logs | Build output, git history, logs | Env vars only; only the Supabase anon key is client-exposed (by design, relies on RLS not secrecy); service-role key and DB connection strings never committed | Scan repo and built client bundle for secret patterns before each deploy | Low if disciplined / Dan |
| Enumeration / IDOR via guessable IDs | API routes using resource IDs | UUID primary keys throughout; RLS is the actual authorisation control, not ID obscurity | Attempt fetch of an adjacent/guessed UUID under a different authenticated session | Low / Dan |

## Required isolation evidence

- [ ] Two distinct businesses (two authenticated users), each with their own uploaded dataset; each user's own reads/writes behave correctly.
- [ ] User A's session cannot read, write, or delete User B's `businesses`, `deals`, `pnl_lines`, `targets`, `uploads`, or `feedback_events` rows — tested via direct API/DB calls, not just by not seeing it in the UI.
- [ ] Anonymous (unauthenticated) requests are denied on every table and the Storage bucket.
- [ ] User A cannot fetch User B's uploaded CSV via a guessed or adjacent Storage path.
- [ ] The calc-engine route is confirmed to run under the caller's own session, not the service-role key.
- [ ] Secrets are absent from the Next.js client bundle, the repository, and logs.
- [ ] RLS policies are applied via migration, not a manual console step — a fresh environment reproduces the same isolation automatically.

No membership/invitation/role-escalation evidence is required at MVP — there is no membership model yet. This whole document gets revisited properly once doc 02's V1 multi-tenant work begins.

## Open questions and change record

| Question/assumption | Impact if wrong | Validation/decision | Owner | Due/status |
|---|---|---|---|---|
| RULE-001 (doc 03) assumes a "historical average" dwell time per stage exists — but a single-snapshot CSV upload has no longitudinal history on day one. Where does that average actually come from? | Without a real source, "average" becomes either a fabrication (exactly what REQ-005's explainability promise forbids) or silently breaks on a pilot's first upload | Recommend: derive it from closed (won/lost) deals present in the same upload, if the template captures their stage-entry and close dates; fall back to a stated, visibly-labelled default only if a business has no closed deals yet | Dan | **Decided, 2026-09-19, corrected from an earlier phrasing that wrongly implied historical data could substitute for a benchmark.** It never does — RULE-001 and RULE-009 (doc 03) are now separate: the onboarding-set benchmark (sales-cycle, revenue/margin targets, stale threshold) is permanent and never silently overwritten; the historical observation is a separate, always-shown figure with its own confidence indicator (0/1–4/5–19/20+ closed deals). The fallback chain — platform default, 30 days for sales-cycle — fires only when *no benchmark has been configured at all*, never when a benchmark simply disagrees with observed reality. |
| What's the actual retention/deletion policy if a pilot business leaves or asks to be deleted? | Real financial and commercial data, EU/UK-hosted — this isn't a hypothetical GDPR question, it's a live one the moment the first pilot's real data goes in | Decide and document before any pilot onboarding, not as an afterthought | Dan | **Decided, 2026-09-19** — on departure/deletion request, all operational, financial and commercial data is permanently deleted from the live platform; backups purge automatically within a defined window (e.g. 30 days). Only the minimum Dan is legally required to keep (billing, contractual, audit records) survives — never the underlying commercial dataset "just in case." Principle: customer leaves = data deleted, not archived. |
| Does the calc-engine route ever need elevated access for anything (e.g. a future notification)? | If "no" isn't stated explicitly, it's easy for a later feature to quietly reach for the service-role key as a shortcut | State explicitly: no service-role usage in any user-facing route at MVP, full stop | Dan | **Decided, 2026-09-19** — no browser-triggered or user-facing path may access the service-role key, ever, at MVP. It's reserved exclusively for trusted server-side/background processes (scheduled jobs, migrations, future backend-only notification processing). Any future exception must be explicitly documented, security-reviewed and justified — never introduced as a shortcut around RLS. Litmus test for every new route: "can this be reached from a browser?" → if yes, it must run under the caller's session, no exceptions. |

Changes: 2026-09-19 · Initial draft, built directly off doc 03's data rules and doc 04's architecture · this conversation.
2026-09-19 · Resolved all three open questions: historical-average source (closed deals in same upload, stated default otherwise), retention/deletion policy (delete on departure, 30-day backup purge, minimum legal retention only), and service-role key rule (never in a user-facing route, full stop) · this conversation.
2026-09-19 · Added `commercial_baseline` table (REQ-013) following Dan's onboarding proposal; enriched the historical-average decision with the full precedence model (stated benchmark → historical actual → labelled 30-day default) · this conversation.
2026-09-19 · Corrected the precedence wording: benchmark and historical observation are separate, permanently co-displayed values, not a fallback chain — matches doc 03's RULE-001/RULE-009 split · this conversation.
