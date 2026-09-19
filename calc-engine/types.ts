// Shared types for the calc engine (doc 03 RULE-001–011).
// This module has zero dependency on Next.js, React or Supabase — plain data in, plain data out.

export type QualificationTier = "too_early" | "unlikely" | "likely" | "highly_likely";
export type DealStatus = "open" | "won" | "lost";
export type Period = "month" | "quarter" | "year";

export interface Deal {
  id: string;
  name: string;
  value: number;
  stage: string;
  /** ISO date the deal entered its current stage. */
  stageEntryDate: string;
  /** ISO date the deal is expected to close, if known. */
  expectedCloseDate: string | null;
  status: DealStatus;
  /**
   * RULE-003: self-tagged by the owner, required while status === "open".
   * Closed (won/lost) deals carry no meaningful tier and should be null.
   */
  qualificationTier: QualificationTier | null;
  /** ISO date the deal actually closed (won or lost). Null while open. */
  closeDate: string | null;
}

export interface PnlLine {
  /** ISO date representing the start of the invoiced period (e.g. first of the month). */
  period: string;
  invoicedRevenue: number;
  /**
   * Links this invoice line back to the deal it settles, when known.
   * RULE-004's "no matching invoice" test depends on this — see calc-engine/orderBook.ts
   * for why this is modelled as an explicit link rather than inferred from period/amount.
   */
  dealId?: string | null;
}

export interface CommercialBaseline {
  /** RULE-001: benchmark set at onboarding. Null = unset, platform default (30 days) applies. */
  salesCycleDays: number | null;
  /** RULE-010: benchmark set at onboarding. Null = unset, fallback chain applies. */
  staleOpportunityThresholdDays: number | null;
  /** RULE-001: no sensible default exists. Null = "no target set", never fabricated. */
  revenueTargetAnnual: number | null;
  marginTargetPercent: number | null;
  minimumAcceptableMarginPercent: number | null;
}

export interface CalcEngineInput {
  deals: Deal[];
  pnlLines: PnlLine[];
  baseline: CommercialBaseline;
  period: Period;
  /** ISO date — the start of the selected month/quarter/year. */
  periodStart: string;
  /**
   * ISO date/time, injected rather than read from the system clock, so the engine
   * stays deterministic (doc 04: "same input always produces the same output").
   */
  now: string;
  /** ISO date/time of the most recent upload, or null if none exists yet (RULE-007). */
  lastUploadedAt: string | null;
}
