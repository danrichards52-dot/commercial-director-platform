import { CalcEngineInput, CommercialBaseline, Deal, PnlLine } from "../../types";

// A synthetic fixture built to exercise each calc-engine rule explicitly — not a reverse-engineering
// of the verdict mockup's illustrative output, which never had raw input data behind it (deals,
// P&L lines) to begin with. Every deal below exists to prove one specific rule, named in its comment.

const YEAR = 2026;

function iso(month: number, day: number): string {
  return `${YEAR}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(dateIso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Generates `count` closed deals in `stage`, each with dwell time `dwellDays` — builds a chosen RULE-009 confidence band. */
function closedDealsForStage(
  stage: string,
  count: number,
  dwellDays: number,
  status: "won" | "lost"
): Deal[] {
  const deals: Deal[] = [];
  for (let i = 0; i < count; i++) {
    const stageEntryDate = iso(1, 1 + i);
    const closeDate = addDaysIso(stageEntryDate, dwellDays);
    deals.push({
      id: nextId(`closed-${stage}`),
      name: `${stage} closed deal ${i + 1}`,
      value: 5000,
      stage,
      stageEntryDate,
      expectedCloseDate: closeDate,
      status,
      qualificationTier: null,
      closeDate,
    });
  }
  return deals;
}

// --- RULE-009 confidence bands ---
// "Discovery": 0 closed deals -> "none"
// "Proposal": 2 closed deals, 18-day average dwell -> "early_indication" (1-4)
// "Negotiation": 10 closed deals, 25-day average dwell -> "developing_baseline" (5-19)
// "Qualified": 22 closed deals, 12-day average dwell -> "established_baseline" (20+)
// Marked "lost" rather than "won" deliberately — these exist only to seed RULE-009's
// per-stage dwell-time history and must not also inflate RULE-004's order-book total.
const closedDeals: Deal[] = [
  ...closedDealsForStage("Proposal", 2, 18, "lost"),
  ...closedDealsForStage("Negotiation", 10, 25, "lost"),
  ...closedDealsForStage("Qualified", 22, 12, "lost"),
];

// --- REQ-006 stale-deal flagging, via the historical-average comparator ---
// Sits in "Proposal" (historical average 18 days, from above) for 52 days -> stale.
// Matches AC-006-01's own example numbers exactly.
const staleDealViaHistory: Deal = {
  id: nextId("stale-history"),
  name: "Stale proposal deal (historical comparator)",
  value: 12000,
  stage: "Proposal",
  stageEntryDate: addDaysIso(iso(1, 1), -52),
  expectedCloseDate: iso(6, 1),
  status: "open",
  qualificationTier: "likely",
  closeDate: null,
};

// --- REQ-006 stale-deal flagging, via the RULE-010 benchmark fallback comparator ---
// "Discovery" has zero closed deals (no historical average exists), so staleness falls back
// to the resolved stale-opportunity threshold: baseline below has no explicit threshold set
// and a 40-day sales-cycle benchmark, so RULE-010 derives 20 days (50% of 40, rounded).
// 25 days in stage > 20-day threshold -> stale.
const staleDealViaThreshold: Deal = {
  id: nextId("stale-threshold"),
  name: "Stale discovery deal (threshold comparator, no stage history)",
  value: 8000,
  stage: "Discovery",
  stageEntryDate: addDaysIso(iso(1, 1), -25),
  expectedCloseDate: iso(7, 1),
  status: "open",
  qualificationTier: "too_early",
  closeDate: null,
};

// --- RULE-003: one open deal per qualification tier ---
const tooEarlyDeal: Deal = {
  id: nextId("tier"),
  name: "Too-early deal",
  value: 3000,
  stage: "Discovery",
  stageEntryDate: iso(3, 1),
  expectedCloseDate: iso(8, 1),
  status: "open",
  qualificationTier: "too_early",
  closeDate: null,
};

const unlikelyDeal: Deal = {
  id: nextId("tier"),
  name: "Unlikely deal",
  value: 4000,
  stage: "Negotiation",
  stageEntryDate: iso(3, 1),
  expectedCloseDate: iso(8, 1),
  status: "open",
  qualificationTier: "unlikely",
  closeDate: null,
};

const likelyDeal: Deal = {
  id: nextId("tier"),
  name: "Likely deal",
  value: 15000,
  stage: "Negotiation",
  stageEntryDate: iso(3, 1),
  expectedCloseDate: iso(5, 15),
  status: "open",
  qualificationTier: "likely",
  closeDate: null,
};

const highlyLikelyDeal: Deal = {
  id: nextId("tier"),
  name: "Highly-likely deal",
  value: 25000,
  stage: "Qualified",
  stageEntryDate: iso(3, 1),
  expectedCloseDate: iso(4, 20),
  status: "open",
  qualificationTier: "highly_likely",
  closeDate: null,
};

// --- RULE-004: order book ---
// Won, no matching invoice -> counts as order book.
const wonUnmatchedDeal: Deal = {
  id: nextId("won-unmatched"),
  name: "Won, not yet invoiced",
  value: 18000,
  stage: "Qualified",
  stageEntryDate: iso(2, 1),
  expectedCloseDate: iso(3, 10),
  status: "won",
  qualificationTier: null,
  closeDate: iso(3, 10),
};

// Won, WITH a matching invoice -> must not double-count as order book.
const wonMatchedDeal: Deal = {
  id: nextId("won-matched"),
  name: "Won and invoiced",
  value: 9000,
  stage: "Qualified",
  stageEntryDate: iso(2, 1),
  expectedCloseDate: iso(3, 5),
  status: "won",
  qualificationTier: null,
  closeDate: iso(3, 5),
};

export const syntheticDeals: Deal[] = [
  ...closedDeals,
  staleDealViaHistory,
  staleDealViaThreshold,
  tooEarlyDeal,
  unlikelyDeal,
  likelyDeal,
  highlyLikelyDeal,
  wonUnmatchedDeal,
  wonMatchedDeal,
];

export const syntheticPnlLines: PnlLine[] = [
  { period: iso(1, 1), invoicedRevenue: 20000 },
  { period: iso(2, 1), invoicedRevenue: 22000 },
  { period: iso(3, 1), invoicedRevenue: 9000, dealId: wonMatchedDeal.id },
];

export const syntheticBaseline: CommercialBaseline = {
  salesCycleDays: 40,
  // Unset -> exercises RULE-010's "derived from sales-cycle" path (20 days).
  staleOpportunityThresholdDays: null,
  revenueTargetAnnual: 300000,
  marginTargetPercent: 25,
  minimumAcceptableMarginPercent: 15,
};

/** RULE-001's "no target set" state — no sensible default exists for revenue/margin. */
export const syntheticBaselineNoTarget: CommercialBaseline = {
  ...syntheticBaseline,
  revenueTargetAnnual: null,
};

export const NOW = iso(1, 1);

export function buildInput(overrides: Partial<CalcEngineInput> = {}): CalcEngineInput {
  return {
    deals: syntheticDeals,
    pnlLines: syntheticPnlLines,
    baseline: syntheticBaseline,
    period: "year",
    periodStart: `${YEAR}-01-01`,
    now: NOW,
    lastUploadedAt: NOW,
    ...overrides,
  };
}

export const fixtureIds = {
  staleDealViaHistory: staleDealViaHistory.id,
  staleDealViaThreshold: staleDealViaThreshold.id,
  tooEarlyDeal: tooEarlyDeal.id,
  unlikelyDeal: unlikelyDeal.id,
  likelyDeal: likelyDeal.id,
  highlyLikelyDeal: highlyLikelyDeal.id,
  wonUnmatchedDeal: wonUnmatchedDeal.id,
  wonMatchedDeal: wonMatchedDeal.id,
};
