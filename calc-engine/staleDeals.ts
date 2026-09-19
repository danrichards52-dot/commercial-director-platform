import { CommercialBaseline, Deal } from "./types";
import {
  computeHistoricalStageObservations,
  StageHistoricalObservation,
} from "./historicalObservations";
import { resolveStaleOpportunityThresholdDays, ResolvedBenchmark } from "./benchmarks";

export interface StaleDealFlag {
  deal: Deal;
  daysInCurrentStage: number;
  /**
   * RULE-012: the organisation's configured stale-opportunity threshold (RULE-010) is the
   * *only* comparator for whether a deal is flagged — full stop, no exceptions. A per-stage
   * historical average, however confident, never overrides it; that would let a business's
   * own bad historical performance silently redefine what "stale" means for it (the same
   * drift RULE-001/009 forbid elsewhere).
   */
  threshold: ResolvedBenchmark<number>;
  /** Positive once the deal has exceeded the threshold; negative/zero otherwise. */
  daysBeyondThreshold: number;
  /** RULE-009: always shown alongside, purely as confidence-graded context — never a factor in `isStale`. */
  historicalObservation: StageHistoricalObservation | null;
  isStale: boolean;
}

function daysBetween(startIso: string, endIso: string): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / msPerDay);
}

/** REQ-006 / RULE-012. */
export function flagStaleDeals(
  deals: Deal[],
  baseline: CommercialBaseline,
  now: string
): StaleDealFlag[] {
  const openDeals = deals.filter((d) => d.status === "open");
  const historicalByStage = computeHistoricalStageObservations(deals);
  const threshold = resolveStaleOpportunityThresholdDays(baseline);

  return openDeals.map((deal) => {
    const daysInCurrentStage = daysBetween(deal.stageEntryDate, now);
    const historicalObservation = historicalByStage.get(deal.stage) ?? null;
    const daysBeyondThreshold = daysInCurrentStage - threshold.value;

    return {
      deal,
      daysInCurrentStage,
      threshold,
      daysBeyondThreshold,
      historicalObservation,
      isStale: daysInCurrentStage > threshold.value,
    };
  });
}
