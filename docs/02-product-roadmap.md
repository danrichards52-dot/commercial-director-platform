# Product roadmap — Commercial Director Platform

Status: Draft | Owner: Dan (Product owner) | Last reviewed: 2026-09-19
Applicability: Applies | Evidence baseline: doc 01 (2 rounds owner interviews, 6+ business owners), Sep 2026
Related requirements / ADRs: doc 01 open questions; doc 03 not yet drafted — REQ IDs to be linked once it is | Next review: On MVP pilot completion

## Direction and prioritisation

**Vision:** A segment-2 SME leader — full pipeline, full financials, no target discipline connecting the two — gets a trustworthy, explained verdict on target-attainment without hiring anyone, and can act on it before the quarter is over instead of after.

Prioritised by: proving the trust-via-explainability requirement first (it's the thesis-killing risk), keeping segment 3 explicitly out until segment 2 is validated, and deferring every integration that isn't required to test the judgment engine.

| Phase | User outcome | Included capabilities | Excluded/deferred | Dependencies | Exit evidence | Owner / target |
|---|---|---|---|---|---|---|
| Discovery | Validated problem, segment and trust condition | 2 rounds of owner interviews (done); explainability mockup test (not yet done) | Any production build | Access to segment-2 owners | ≥3 pilot-willing segment-2 owners confirm the mocked-up verdict is trustworthy and actionable | Dan / before MVP build starts |
| MVP | One real (or realistic) business gets an explained on-target verdict from manually-supplied data | Manual/CSV upload of pipeline (deal list) + P&L; deterministic calc engine (target vs. actual, pipeline coverage, stale-deal/dwell-time flagging); narrative layer explaining the verdict with the underlying deals/line-items visible; single-tenant, single-user, no billing | Live Xero OAuth; multi-tenant auth/roles; segment 3 (win-driver attribution, capacity matching); marketing/procurement; self-serve signup; payments | Doc 01 decisions locked; explainability mockup validated | 3+ pilot users (segment 2 only) say the verdict changed a real decision, within 8 weeks of use (doc 01 success metric) | Dan / TBD |
| V1 | Reliable, repeatable use beyond one pilot business | Live Xero API integration (OAuth, downgraded to "buildable" per doc 01); lightweight built-in deal tracker for owners without a CRM (validated need — the co-packer/PT segment used spreadsheets, not CRMs); multi-tenant auth with proper RLS; stale-deal detection surfaced as a standing feature, not just a diagnostic; self-serve onboarding; billing; **evidence-based qualification engine — deal tier (Too early/Unlikely/Likely/Highly likely) derived from answered MEDDIC/SPIN/STAR-style questions rather than owner self-tagging, replacing the MVP's manual tier field** | Segment 3 capabilities; benchmarking/aggregate insights across customers | MVP pilot evidence; Gate B slice implemented and verified | Paying pilot cohort (target size TBD) retained past first billing cycle; forecast-vs-actual verdict accuracy tracked against a human's independent judgment (doc 01 success metric); qualification-engine tier assignments agree with the owner's own self-tagging on a sample of deals, or the discrepancy is explainable | Dan / TBD |
| V2 | Segment 3 (exit-adjacent, mature businesses) gets win-driver attribution and capacity-matched allocation | Won/lost reason capture and analysis; production/service-capacity data model; capacity-vs-pipeline-focus mismatch detection; "commercial narrative for a sale" framing — plays directly to Dan's own exit-prep expertise | Anything not built on the proven V1 calc-engine/narrative architecture | V1 retention evidence; explicit decision to build segment 3 (already logged in doc 01 as the named v2 wedge) | Segment-3 pilot users confirm attribution/capacity guidance changes real sales-effort allocation | Dan / TBD |
| Future | Directional only — not commitments | Additional accounting integrations (QuickBooks etc.); anonymised cross-customer benchmarking ("what's working for businesses like yours"); marketing/procurement modules | Full ERP scope — permanent non-goal, not just deferred | V2 evidence; real customer demand, not speculation | Named decision trigger, not a date | Dan |

## Backlog and sequencing

| Item | User/problem link | Value | Confidence | Effort range | Risk/dependency | Priority rationale | State |
|---|---|---|---|---|---|---|---|
| Explainability mockup (verdict + visible underlying deals/P&L lines) | doc 01 — trust is conditional on explainability | High — thesis-blocking if it fails | Medium — owners said "proof and understanding," mockup untested | Small | None | Must resolve before any calc-engine code is written | Proposed |
| Deterministic calc engine: target vs. actual + pipeline coverage | doc 01 — segment 2 core JTBD | High | High — pattern confirmed twice | Medium | Explainability mockup validated first | Core of MVP; no MVP without it | Proposed |
| Stale-deal / dwell-time flagging | doc 01 — co-packer finding: "full pipeline, behind target," deals sitting for ages | Medium-high — names a concrete, checkable symptom | Medium — one direct source | Small-medium | Calc engine exists | Cheap to add once the engine exists; directly answers "what's actually wrong" | Proposed |
| Lightweight built-in deal tracker (no-CRM path) | doc 01 — spreadsheet is the real incumbent, not a CRM | Medium — widens addressable segment-2 population | Low — inferred from incumbent behaviour, not directly asked | Medium | MVP validated first | V1, not MVP — adds scope before the core thesis is proven | Deferred |
| Live Xero OAuth integration | doc 01 — dominant financial source, confirmed buildable | High for scale, not for validation | High — precedent exists (ScaleWithCFO) | Medium | MVP validated with manual data first | V1, deliberately not MVP | Deferred |
| Evidence-based qualification engine (tier derived from MEDDIC/SPIN/STAR question completion, not self-tagged) | Dan's own methodology expertise; strengthens the core segment-2 verdict rather than opening a new segment | High — hardest tool to copy, since it's Dan's IP, not generic CRM data | Medium — real but based on Dan's domain call, not yet interview-tested | Large | MVP self-tagged version validated first | Placed in V1, not V2: it sharpens the *existing* segment-2 verdict rather than serving segment 3's different problem — segment 3 stays the clean, separate V2 wedge | Deferred |
| Stage-level bottleneck insight ("Proposal is becoming a bottleneck — your threshold is 30 days, but 23 closed deals historically average 41") | doc 03 REQ-006 correction — a natural extension of the per-deal stale explainer, aggregated to the stage level | Medium-high — a stronger commercial insight than the per-deal version alone | Medium — the underlying data (RULE-009's confidence-graded historical average) already exists once MVP ships | Small-medium — mostly presentation, the data's already computed | MVP's per-deal stale explainer validated first | New surface, not a correction — correctly kept out of MVP's REQ-006 scope | Deferred |
| Win-driver attribution + capacity matching (segment 3) | doc 01 — named v2 wedge | High long-term, unproven near-term | Low-medium — real but small evidence base (1 business) | Large | V1 retention evidence | Locked as V2, not before | Deferred |

## Scope control

Any new request gets checked against this roadmap before it's actioned: does it replace already-committed MVP scope, does it wait for V1/V2, or does it genuinely change the phase definition (which requires updating this doc, not just building it). Segment 3 requests in particular — given it's the most tempting scope-creep vector, being both evidenced and personally interesting — get logged in the backlog as Deferred and left there until V1 retention evidence exists. No security or RLS remediation work is ever deprioritised behind this.

## Review and readiness

Review cadence: at MVP pilot completion, and at any point new interview evidence contradicts a locked decision. Next review: after explainability mockup test.

- [ ] MVP delivers end-to-end value and has explicit non-goals. — **Non-goals explicit; end-to-end value not yet built or tested.**
- [ ] Each committed phase has measurable exit conditions. — **Set for Discovery/MVP/V1; V2/Future are directional, deliberately not yet measurable.**
- [x] Dependencies and capacity assumptions are visible.
- [x] Changes from the previous roadmap are explained and linked — this is the first roadmap draft, built directly from doc 01's locked decisions.

## Open questions and change record

| Question/assumption | Impact if wrong | Validation/decision | Owner | Due/status |
|---|---|---|---|---|
| Does the explainability mockup actually earn trust, or does "proof and understanding" turn out to mean something the mockup doesn't deliver? | MVP build starts on an unproven trust mechanism | Test the mockup with 2–3 segment-2 owners before writing calc-engine code | Dan | Open — blocks MVP start |
| Is the built-in deal tracker (no-CRM path) needed for MVP, or can pilot users tolerate a one-off CSV export from their spreadsheet? | If CSV export is too much friction, pilot recruitment stalls before the thesis gets tested | Ask directly when recruiting pilot users | Dan | Open |
| What's the realistic price point? (carried from doc 01, still unresolved) | Wrong pricing kills unit economics before scale | Direct willingness-to-pay question in next interview round | Dan | **Resolved** — ~£100–£200/month for manual-upload MVP, validated even before live Xero integration exists |
| Interview sourcing method not logged (carried from doc 01) | Confidence in evidence base may be inflated if sourcing is narrow/networked | Log how the 6 round-2 owners were found | Dan | **Resolved, unfavourably** — 100% Dan's personal/professional network; every respondent trusted Dan going in, which weakens the explainability/trust finding specifically, since that's the one most likely to differ with a stranger |
| What's the acquisition channel once Dan's personal network is exhausted? | £100–£200/month priced entirely off warm-network respondents may not convert through any channel that actually scales; a real pricing number with no real CAC is not yet a business model | Test outside the network — cold outreach, a landing page, or a referral ask to owners with no prior relationship to Dan | Dan | Open — new binding constraint, higher priority than any remaining feature work |

Changes: 2026-09-19 · Initial draft, built directly from doc 01's locked segment-2/segment-3 decision · this conversation.
2026-09-19 · Resolved pricing (~£100–£200/mo, manual-upload MVP validated as monetizable) and sourcing (100% personal network, flagged as a bias on the trust finding); added acquisition-channel outside that network as the new binding open question · this conversation.
2026-09-19 · Added evidence-based qualification engine as a named V1 feature (MVP stays self-tagged); segment 3 remains the separate, later V2 wedge · this conversation.
