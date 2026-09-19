# Design system, art direction and UI library — MVP

Status: Draft | Owner: Dan (Design/product owner) | Last reviewed: 2026-09-19
Applicability: Applies | Evidence baseline: the verdict mockup (this conversation) — the only UI actually built so far
Related requirements / ADRs: doc 03 REQ-005/007/008/013/014/015; doc 03's undefined loading/empty/partial-success states | Next review: Before the mockup's tokens are ported into the real Next.js build

> This document doesn't invent a new visual direction — it writes down what the mockup already established, so Claude Code has a real spec to build against instead of guessing at "trustworthy dashboard" from scratch. Where the mockup didn't cover something (onboarding, mobile, error states), that's flagged as a genuine gap, not filled in speculatively.

## Experience principles

1. **Every number earns trust by showing its working.** Nothing renders a figure without a path to its source one click away — the explainer cards, not a corrected number, are the primary trust mechanism (REQ-005).
2. **Never collapse benchmark and observed into one figure.** This is a UI rule as much as a calc rule (RULE-001/RULE-009) — the two are always shown together, never one silently replacing the other.
3. **Read like a sentence, not a dashboard.** The verdict headline is plain English first ("£38,400 short of target"), with structured data behind it, not the reverse.
4. **Quiet until asked.** Deal lists and P&L line detail stay collapsed by default; progressive disclosure, not a wall of data on first load.
5. **Short enough to actually finish.** Onboarding (REQ-013) has to complete in one sitting — this constrains every future form in the product, not just that one.

## Tokens and layout

| Token/category | Value/source | Usage | Accessibility/responsive rule |
|---|---|---|---|
| Colour — background | `#F7F5F0` (warm off-white) | Page background | — |
| Colour — text | `#1C1B18` | Primary text | High contrast against background by design |
| Colour — verdict (behind target) | `#C2410C` | Verdict badge/headline when behind | — |
| Colour — verdict (on target) | `#2F6B3E` | Verdict badge/headline when ahead | — |
| Colour — muted text | `#8A8377` | Secondary labels, confidence lines, mono captions | **Flagged risk: likely fails WCAG AA contrast on the off-white background at small sizes — needs a real contrast check and probable darkening, not just a note carried forward** |
| Colour — border/divider | `#E4DFD5` | Card borders, dividers | — |
| Typography — display/headline | Source Serif 4 (400/600/700) | Verdict headline only | Serif reserved for the one number that matters most on screen |
| Typography — body | IBM Plex Sans (400/500/600) | All body text, labels, buttons | — |
| Typography — data/mono | IBM Plex Mono (400/500) | Figures, confidence lines, table data, tab labels | Mono signals "this is a precise, computed number," distinct from prose |
| Spacing/radius | 8–10px card radius; 16–24px internal padding; 20–48px section gaps | Cards, page rhythm | — |
| Layout — Narrative mode | Single centred column, 720–800px max-width | Verdict, onboarding, insight explanation, setup | This is the mockup's current 760px — correct for reading-flow screens, wrong as a universal constraint |
| Layout — Working mode | 1100–1280px, allows genuine multi-column/table layouts | Deal tables, opportunity lists, Company Settings (multiple related fields), any screen with real operational density | **New — not yet built.** Same tokens and typography as Narrative mode; different canvas. Prevents forcing data-dense screens into an editorial column that becomes awkward to actually use |

Single source in code: currently the mockup artifact's inline styles (`Main.dc.html`). **This is not yet the real app** — porting these values into an actual token file (CSS custom properties or Tailwind config) inside the Next.js/Claude Code build is outstanding work, not done. Doc 04 already established Claude Code writes the real frontend; this document is what it should be told to match.

## Component library

| Component | Canonical implementation | Variants | States | Keyboard/screen-reader behaviour | Examples/tests |
|---|---|---|---|---|---|
| Verdict badge + headline | Mockup verdict block | Behind / on-target (colour + label swap) | Static — no loading/error state defined yet | Not yet reviewed | Mockup |
| Period tabs (Month/Quarter/Year) | Mockup tab row | Three fixed options | Active/inactive | Real `<button>` elements — keyboard-operable by default; not yet confirmed with a screen reader | Mockup |
| Explainer card | Mockup "why" cards | Coverage / stale-deals / financial pace | Collapsed/expanded | **Gap: expand state has no `aria-expanded` attribute — chevron symbol alone isn't sufficient for screen readers** | Mockup |
| Deal table (inside a card) | Mockup stale-deals table | — | Static rows | Not yet reviewed for small-screen behaviour — 4 fixed columns will not fit a phone width | Mockup |
| Annual trajectory chart | Mockup inline SVG | Behind/on-target scenario; period-highlight band | Static | **Gap: SVG chart has no text-alternative/summary for screen readers — a purely visual trajectory conveys nothing without sight** | Mockup |
| Feedback buttons | Mockup footer buttons | Primary (dark) / secondary (outline) | Default → recorded (buttons replaced by a note) | Real `<button>` elements | Mockup |
| **Onboarding form (REQ-013)** | Not built | — | — | — | **Gap — no design exists yet for the four-field Commercial Baseline capture** |
| **Company Settings page (REQ-015)** | Not built | — | — | — | **Gap — no design exists yet for editing the baseline post-onboarding** |
| **Upload flow (REQ-001/002)** | Not built | — | — | — | **Gap — the mockup starts from data already loaded; the actual upload/parse/error experience has no design yet** |

Loading, empty and partial-success states — flagged as undefined in doc 03's own workflow section — are still undefined here too. That's the single biggest hole in this document relative to what REQ-001–010 actually require.

## Accessibility

Target: WCAG 2.1 AA. Verification so far: **none** — the mockup has not been run through a contrast checker, keyboard walkthrough, or screen reader. Known issues already visible on inspection, not waiting for a formal audit to flag:
- Muted text colour (`#8A8377` on `#F7F5F0`) is likely below AA contrast for small text.
- Explainer cards lack `aria-expanded` on their toggle buttons.
- The trajectory chart (pure SVG) has no accessible text alternative — a screen-reader user gets nothing from it as built.

None of these are disqualifying for a pilot test with sighted users clicking through with Dan in the room, but they are real debt before this goes anywhere near a wider release, and cheaper to fix now than after more screens are built on the same pattern.

## Art direction

- **Tone and visual character:** calm, editorial, closer to a financial report than a SaaS dashboard — deliberately not flashy. Fits an owner who wants to be told the truth, not sold a feeling.
- **Illustration/photography/icon style:** none used. Purely typographic and data-driven — no icons, no illustration, no stock imagery. This was a deliberate choice to avoid generic AI-dashboard tropes, not an oversight to fill in later.
- **Imagery purpose and exclusions:** exclude decorative imagery entirely for this product; a number that needs a picture next to it to feel credible is the wrong signal for this audience.
- **Asset provenance:** N/A — no external assets used; Google Fonts (Source Serif 4, IBM Plex Sans, IBM Plex Mono) only.
- **Motion:** minimal — card expand/collapse only, no page transitions or decorative animation. **Reduced-motion behaviour not yet specified — see open questions.**
- **Reference board:** none formally assembled; the mockup itself is the reference until this document says otherwise.

## Anti-pattern register

This list is deliberately **product-specific, not generic** — generic AI-frontend tells (purple gradients, glassmorphism, bounce easing, Inter font, KPI-card grids, dense sidebars) are already caught automatically by Impeccable's detector rules once it's running against real code (see Tooling below); duplicating that list here would just drift out of sync with the tool. What belongs here is judgment the generic tool has no way to know:

- Never present the verdict screen as a dashboard — no grid of metric tiles as the primary structure. It reads like a briefing, not an app.
- Never let a benchmark and its observed figure share one number or one visual treatment — they must always be distinguishable at a glance (RULE-001/009).
- Never use a pill/badge as decoration — the verdict badge and qualification-tier tags are the only sanctioned uses, and only because they carry real status meaning.
- Never add an icon, illustration, or "AI assistant" visual cue (sparkles, glow, magic-wand language) anywhere in the product — this was a deliberate choice in the Art direction section, not an oversight.
- Never let a chart exist for decoration — the trajectory chart earns its place because it answers a specific question (doc 03 REQ-007); a chart with no explainer function doesn't belong.

## Tooling: Impeccable

[Impeccable](https://impeccable.style) is a third-party, open-source design-guidance skill for Claude Code and similar AI coding tools — deterministic detector rules plus commands to critique, audit and polish real rendered UI against known AI-generated-frontend anti-patterns. Adopting it for this build, with doc 06 as the authoritative brief it works from, not the other way round.

**Sequencing, corrected from the version Dan brought in:** Impeccable audits real code, and the verdict screen currently exists only as a standalone artifact-tool mockup — a different format entirely from what Claude Code will write. The order has to be: port the mockup's tokens/components into the real Next.js codebase first (already flagged as open work above), *then* run Impeccable's critique against that real implementation. Running a critique command against a prototype that isn't the real frontend would produce feedback that doesn't transfer.

Once that's true, the workflow Dan proposed holds: init Impeccable with this document as the constrained brief → critique the ported verdict screen → formalise into whatever persistent config file Impeccable uses so later commands don't rediscover the direction each time → design onboarding → design upload flow → define empty/loading/error states → responsive pass across both layout modes → audit → only then build the remaining frontend.

## Readiness

- [ ] Core workflow uses defined components and all relevant states. — **Verdict/why/trajectory yes; onboarding, settings and upload flow have no design yet; loading/empty/error states undefined everywhere.**
- [ ] Responsive/accessibility acceptance criteria link to 09. — Doc 09 not yet drafted; accessibility issues are named above but not yet turned into acceptance criteria.
- [x] Art direction and terminology support the product's users. — Deliberate, evidence-informed choice (calm/editorial fits a "tell me the truth" audience); not yet tested with a real owner.
- [ ] Code and documented tokens/components agree, or drift is owned. — **Not applicable yet — no real app code exists. This document is the target Claude Code should be built against, not a description of something already true.**

## Open questions and change record

| Question/assumption | Impact if wrong | Validation/decision | Owner | Due/status |
|---|---|---|---|---|
| How does this layout behave below ~900px width? | Pilot owners may well open this on a phone or tablet, not a desktop browser — the deal table and trajectory chart in particular have no defined small-screen behaviour | Design a responsive pass before or during Claude Code build, not after | Dan | **Resolved in direction, not in build** — two layout modes defined (Narrative 720–800px, Working 1100–1280px); actual sub-900px responsive behaviour within each mode still needs a real pass, per the Impeccable sequencing above |
| Does the muted text colour actually fail WCAG AA? | If it does, it's currently used for confidence lines and secondary labels throughout — a real accessibility defect, not cosmetic | Run an actual contrast check; darken the token if it fails | Dan | Open |
| What do the onboarding form and Company Settings page (REQ-013/015) actually look like? | These are now Must-have MVP requirements with zero design behind them | Next mockup candidate, alongside the upload flow | Dan | Open |
| What do loading, empty, and error states look like across the product? | Doc 03 names these as required for every workflow; without a design, they'll be improvised ad hoc during the Claude Code build, which tends to produce inconsistent results | Design them explicitly, at least for the upload and verdict screens, before implementation starts | Dan | Open |
| Can Impeccable meaningfully critique the verdict screen before it's ported into real Next.js code? | Running its audit against the artifact-tool mockup instead of real code would produce feedback that doesn't transfer to the actual build | No — port first, critique second (see Tooling section) | Dan | Resolved as a sequencing rule, not yet executed |

Changes: 2026-09-19 · Initial draft, written directly from the mockup's actual implementation rather than a new design pass · this conversation.
2026-09-19 · Adopted Dan's refined workflow: two layout modes (Narrative/Working) replacing the single 760px constraint; a product-specific anti-pattern register (not duplicating Impeccable's generic detector rules); Impeccable adopted as the design-critique tool for the real Claude Code build, with doc 06 as its authoritative brief. Corrected sequencing: mockup must be ported into real code before Impeccable's critique commands are meaningful · this conversation.
