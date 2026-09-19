# Technical architecture — MVP

Status: Draft | Owner: Dan (Technical owner) | Last reviewed: 2026-09-19
Applicability: Applies | Evidence baseline: doc 03 (requirements), verdict mockup (this conversation)
Related requirements / ADRs: doc 03 REQ-001–012, RULE-001–008 | Next review: Before any pilot business's real data is stored

## System context and boundaries

One actor (doc 03): the pilot business owner, browser-based, no admin/member role split at MVP. Two uploaded inputs (pipeline CSV, P&L CSV) drive one computed output (the verdict, its explainers, and the trajectory chart). No external integrations at MVP — Xero is a named V1 dependency, not present here.

**The load-bearing boundary in this document is between the calc engine and everything else.** REQ-005 (explainability) is the whole trust thesis — a verdict that can't show its own working fails regardless of accuracy. That only holds if the calc engine is a deterministic, isolated unit whose inputs and outputs can be tested independently of whatever the UI builder generates around it. Treat this as non-negotiable, not a nice-to-have refactor for later.

| Component | Responsibility | Owns which data/rules | Interface | Runtime/location | Failure mode |
|---|---|---|---|---|---|
| Web client | Upload UI, verdict display, period tabs, trajectory chart, feedback capture (mirrors the mockup) | No business rules — pure presentation | Calls Supabase client SDK + calc-engine route | Browser, served by Next.js (local host in development; production target not yet decided) | Show explicit loading/empty/stale states (doc 03) — never a blank or silently wrong verdict |
| Auth | Verified identity per pilot user | Session/identity only | Supabase Auth | Supabase (EU/UK region) | Failed auth → login screen, no partial access |
| Data store | Canonical pipeline deals, P&L lines, targets, qualification tags, per business | RULE-001–008 data, RLS-scoped per user | Postgres via Supabase client / calc-engine route | Supabase (EU/UK region) | Query fails closed — never returns another user's rows |
| Raw upload storage | Original uploaded CSVs, for audit/reprocessing | The literal file the owner uploaded | Supabase Storage | Supabase (EU/UK region) | Retained even if parsing fails, so a bad upload can be diagnosed, not just rejected |
| Calc engine | RULE-001–008: coverage (raw + qualified), stale-deal flags, trajectory segments, target-vs-actual verdict | All business logic — the one place these rules are allowed to live | Pure function(s): `{deals[], pnlLines[], targets, tiers} → {verdict, coverage, staleDeals[], trajectory[]}` | TypeScript module, called from a Next.js server-side API route | Deterministic — same input always produces the same output, independently testable against the mockup's Kestrel dataset as a fixture |

## Stack and modular providers

| Capability | Selected option/status | Why it fits | Boundary/contract | Alternatives and exit cost | ADR |
|---|---|---|---|---|---|
| Source and collaboration | GitHub | Standard | Repo per project | N/A | — |
| Data platform | Supabase, **EU/UK region** (per standing preference) | Postgres + Auth + Storage in one place | Postgres tables, RLS policies | Portable — plain Postgres underneath | — |
| AI-assisted development | **Claude Code** (decided, 2026-09-19) | Full control over real code rather than a no-code generator — makes the calc-engine boundary a natural consequence of how the code is structured, not a fight against generated output | Claude Code writes and maintains both frontend and the calc-engine module directly | Lovable — faster for UI iteration, but generated code is harder to keep the calc-engine boundary clean against; rejected | — |
| Frontend / server runtime | Next.js (React) with the calc engine as an isolated, unit-tested TypeScript module invoked from a server-side API route | Matches the prior build's stack (some of which may be reusable — worth checking before rewriting from scratch); Claude Code has full control, so no platform-imposed backend shape | Calc-engine module is the only thing allowed to compute a verdict, called from a route handler, never inlined into a component | Supabase Edge Functions — viable alternative for the calc engine specifically, but unnecessary complexity once the backend is already a full Next.js server | **Proposed — confirm before doc 04 is finalised** |
| Authentication | Supabase Auth, single role at MVP (no admin/member split) | Doc 03 needs real per-user data isolation (RULE-006) even though doc 02 calls MVP "single-tenant" — that phrase means no account hierarchy, **not** no isolation | Every table scoped by `auth.uid()` via RLS, verified before any pilot's real data is stored | Deferring auth entirely — rejected outright; this is the framework's own non-negotiable (identity/tenancy trust resolved before real data) | — |
| Transactional email | Supabase Auth's built-in email (magic link) | Sufficient at pilot scale; no self-serve signup flow to support yet | — | Dedicated provider (e.g. an EU-hosted transactional service) once V1 self-serve onboarding needs it | — |
| Hosting / workers | **Local host for development; Vercel for production (decided, 2026-09-19)** | Local is right for build/test; Vercel is the natural fit for a Next.js app and gives pilots a real reachable URL | — | Self-hosting — available later if ever needed, no reason to take it on now | — |

For external identity: Supabase Auth issues its own verified JWT; RLS policies read `auth.uid()` directly. No external identity provider is in scope at MVP (no SSO), so there's no cross-provider claim mapping to resolve.

## Contracts and reliability

**CSV upload:** input is a file matched against the platform-supplied template (doc 03 — resolved, owners get a template, not asked to reshape their own export). Output is either a parsed, validated row set, or an explicit per-row error list — malformed or missing rows are never silently dropped (AC-002-02). **Calc-engine invocation:** pure function, no side effects, called from a Next.js server-side API route with the full current dataset (deals, P&L lines, targets, qualification tags) and returning the complete verdict object — the same fixture data used in the mockup (Kestrel Packaging Ltd) becomes the first regression test. **Idempotency:** re-uploading replaces the stored dataset rather than duplicating it (REQ-010). **Versioning, rate limits, pagination:** explicitly out of scope at MVP — no external API consumers, trivial data volumes. Revisit at V1 when self-serve onboarding is real.

## Environments and configuration

| Environment | Purpose | Data source | Isolation | Config/secret store | Access owner |
|---|---|---|---|---|---|
| Local | Development, via Claude Code | Synthetic — the mockup's Kestrel dataset | N/A | Local env vars, names only | Dan |
| Staging | Pre-pilot verification, especially RLS testing | Synthetic/sanitised | Separate Supabase project, not just a separate schema | Supabase project env store | Dan |
| Production | Real pilot businesses | Real pilot-uploaded data | Separate Supabase project (EU/UK); hosted on Vercel | Supabase project env store; Vercel env vars, names only | Dan |

Separate projects for staging vs. production is cheap insurance against a synthetic-data mistake ever touching a real pilot's account — worth doing even at this scale, not deferred as premature.

## Constraints and drift

Performance/cost targets: trivial at pilot scale (single-digit businesses, small datasets) — explicitly not optimised for now; revisit if V1 self-serve onboarding brings real volume. Repository layout: TBD once the Lovable project exists, but the calc-engine module must live in a directory clearly separate from generated UI components regardless of Lovable's default structure, so it survives being tested, reviewed, or ported later. Dependency policy: standard Lovable/Supabase managed updates, Dan owns them. Known debt: none — new build.

- [ ] Boundaries and rule ownership are explicit. — **Stated here; not yet implemented.**
- [x] Provider choices and exits are deliberate. — Claude Code/Next.js/Supabase/Vercel all decided, 2026-09-19.
- [ ] Identity/data trust chain and failure behaviour are verified. — **Not done. This is the actual gate before any pilot's real data goes in — per the app dev framework's own non-negotiable, this is never skipped for speed.**

## Open questions and change record

| Question/assumption | Impact if wrong | Validation/decision | Owner | Due/status |
|---|---|---|---|---|
| Lovable + Supabase, or hand-rolled Next.js (the prior build's stack)? | Wrong call either costs rebuild time later (Lovable lock-in at scale) or costs MVP speed now (hand-rolled) | Dan's call — recommendation given above, not decided | Dan | **Decided, 2026-09-19** — Claude Code, not Lovable; Next.js, not a no-code generator |
| Calc engine as a Supabase Edge Function, or computed client-side in the browser? | Client-side is simpler to ship but couples business logic to UI-generated code, undermining the auditability REQ-005 depends on | Recommendation: Edge Function, server-side, from the start | Dan | **Superseded** — with Claude Code writing a full Next.js backend, the calc engine is a server-side API-route module instead; the underlying principle (isolated, testable, never inlined into a component) is unchanged |
| Is any of the prior Next.js/Supabase build (167 committed financial_periods rows, £2.69M revenue verified) reusable now that the stack has converged back to it? | Rebuilding from scratch wastes real prior work if the schema or code is salvageable | Dan to check the old repo before writing new schema/migrations | Dan | **Decided, 2026-09-19** — starting fresh, deliberately. Untangling what's salvageable from a stalled build costs more time than it saves, and the thesis itself has moved on since that data was committed (qualification tiers, order book/WIP, the trajectory model — none of that existed in the old build) |
| Where does this actually run for pilots to reach it — local tunnel, self-hosted, or a managed host like Vercel? | Local host alone means only Dan can access it; pilots need a real URL before any pilot onboarding can start | Dan's call — flagging Vercel as the default-fit option for Next.js, not assuming it | Dan | **Decided, 2026-09-19** — Vercel for production |
| How is RLS isolation (RULE-006, "no shared query path across businesses") actually verified before real data goes in? | Skipping this test is exactly the kind of shortcut the app dev framework's guardrails exist to prevent — a data leak between two pilot businesses would be a severe failure, not a bug | Write and run a concrete test: user A's session cannot read user B's rows, checked in staging before any pilot onboarding | Dan | Open — blocks production use, not blocks doc 04 itself |
| Does the explainability requirement (REQ-005) still hold with a non-network owner? (carried from docs 01–03) | The calc engine can be built correctly and still fail the actual trust test it exists to pass | Cold test, still outstanding | Dan | Open |

Changes: 2026-09-19 · Initial draft, built off doc 03's requirements and the mockup's data shape · this conversation.
2026-09-19 · Stack decided: Claude Code (not Lovable), Next.js (not a no-code generator), Supabase unchanged, local host for development with production hosting target still open · this conversation.
2026-09-19 · Production hosting decided: Vercel · this conversation.
