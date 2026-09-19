import { Deal } from "./types";

export interface CoverageResult {
  remainingTarget: number;
  /** RULE-008: raw open-pipeline value, all tiers, no discounting. */
  rawPipelineValue: number;
  /** RULE-008: Likely + Highly likely only, at full value (RULE-003). */
  qualifiedPipelineValue: number;
  /** Null when there's no remaining gap to cover (already ahead) — a ratio would be meaningless. */
  rawCoverageRatio: number | null;
  qualifiedCoverageRatio: number | null;
}

/**
 * RULE-008: reported as two distinct numbers, never collapsed into one — the gap between
 * a full-looking raw pipeline and a thin qualified one is precisely the failure mode this
 * tool exists to surface (doc 01's "full pipeline, behind target").
 */
export function computeCoverage(deals: Deal[], remainingTarget: number): CoverageResult {
  const openDeals = deals.filter((deal) => deal.status === "open");
  const rawPipelineValue = openDeals.reduce((sum, deal) => sum + deal.value, 0);
  const qualifiedPipelineValue = openDeals
    .filter((deal) => deal.qualificationTier === "likely" || deal.qualificationTier === "highly_likely")
    .reduce((sum, deal) => sum + deal.value, 0);

  const canComputeRatio = remainingTarget > 0;
  return {
    remainingTarget,
    rawPipelineValue,
    qualifiedPipelineValue,
    rawCoverageRatio: canComputeRatio ? rawPipelineValue / remainingTarget : null,
    qualifiedCoverageRatio: canComputeRatio ? qualifiedPipelineValue / remainingTarget : null,
  };
}
