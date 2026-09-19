import { CommercialBaseline, Deal } from "./types";
import {
  computeHistoricalStageObservations,
  StageHistoricalObservation,
} from "./historicalObservations";
import { resolveStaleOpportunityThresholdDays } from "./benchmarks";

export interface StaleDealFlag {
  deal: Deal;
  daysInCurrentStage: number;
  /**
   * Which figure actually decided staleness for this deal. REQ-006 compares against the
   * stage's historical average when one exists; RULE-010's organisation threshold is the
   * fallback for a stage with no closed-deal history yet.
   */
  comparator: { type: "historical_average" | "stale_threshold_benchmark"; days: number };
  /** RULE-009: always surfaced alongside, even when the benchmark (not history) decided staleness. */
  historicalObservation: StageHistoricalObservation | null;
  isStale: boolean;
}

function daysBetween(startIso: string, endIso: string): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / msPerDay);
}

export function flagStaleDeals(
  deals: Deal[],
  baseline: CommercialBaseline,
  now: string
): StaleDealFlag[] {
  const openDeals = deals.filter((d) => d.status === "open");
  const historicalByStage = computeHistoricalStageObservations(deals);
  const resolvedThreshold = resolveStaleOpportunityThresholdDays(baseline);

  return openDeals.map((deal) => {
    const daysInCurrentStage = daysBetween(deal.stageEntryDate, now);
    const historicalObservation = historicalByStage.get(deal.stage) ?? null;

    const comparator =
      historicalObservation !== null
        ? ({ type: "historical_average", days: historicalObservation.averageDwellDays } as const)
        : ({ type: "stale_threshold_benchmark", days: resolvedThreshold.value } as const);

    return {
      deal,
      daysInCurrentStage,
      comparator,
      historicalObservation,
      isStale: daysInCurrentStage > comparator.days,
    };
  });
}
