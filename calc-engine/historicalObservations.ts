import { Deal } from "./types";

export type ConfidenceBand =
  | "none"
  | "early_indication"
  | "developing_baseline"
  | "established_baseline";

export interface StageHistoricalObservation {
  stage: string;
  averageDwellDays: number;
  qualifyingRecordCount: number;
  confidence: ConfidenceBand;
}

/** RULE-009: illustrative thresholds — tune once real data exists. */
function confidenceBandFor(count: number): ConfidenceBand {
  if (count === 0) return "none";
  if (count <= 4) return "early_indication";
  if (count <= 19) return "developing_baseline";
  return "established_baseline";
}

function daysBetween(startIso: string, endIso: string): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / msPerDay);
}

/**
 * RULE-009 / doc 05's resolved open question: there is no longitudinal history at MVP
 * (a single-snapshot CSV upload), so the per-stage average dwell time is derived from
 * closed (won/lost) deals present in the same upload — the only available source.
 * Stages with zero closed deals are simply absent from the returned map (confidence "none").
 */
export function computeHistoricalStageObservations(
  deals: Deal[]
): Map<string, StageHistoricalObservation> {
  const byStage = new Map<string, number[]>();

  for (const deal of deals) {
    if (deal.status === "open" || deal.closeDate === null) continue;
    const dwellDays = daysBetween(deal.stageEntryDate, deal.closeDate);
    const existing = byStage.get(deal.stage) ?? [];
    existing.push(dwellDays);
    byStage.set(deal.stage, existing);
  }

  const result = new Map<string, StageHistoricalObservation>();
  for (const [stage, dwellDaysList] of byStage.entries()) {
    const count = dwellDaysList.length;
    const average = dwellDaysList.reduce((sum, d) => sum + d, 0) / count;
    result.set(stage, {
      stage,
      averageDwellDays: Math.round(average),
      qualifyingRecordCount: count,
      confidence: confidenceBandFor(count),
    });
  }
  return result;
}
