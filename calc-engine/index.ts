import { CalcEngineInput } from "./types";
import { computeVerdict, Verdict } from "./verdict";
import { flagStaleDeals, StaleDealFlag } from "./staleDeals";
import { computeTrajectory, TrajectoryResult } from "./trajectory";
import { computeFreshness, FreshnessResult } from "./freshness";
import {
  resolveSalesCycleDays,
  resolveStaleOpportunityThresholdDays,
  ResolvedBenchmark,
} from "./benchmarks";

export interface CalcEngineResult {
  verdict: Verdict;
  staleDeals: StaleDealFlag[];
  trajectory: TrajectoryResult;
  freshness: FreshnessResult;
  resolvedBenchmarks: {
    salesCycleDays: ResolvedBenchmark<number>;
    staleOpportunityThresholdDays: ResolvedBenchmark<number>;
  };
}

/**
 * The single entry point (doc 04): a pure function, deterministic, no I/O, no side effects.
 * Called from a Next.js server-side API route with the caller's own authenticated session —
 * never inlined into a UI component, never given the service-role key.
 */
export function computeCalcEngineResult(input: CalcEngineInput): CalcEngineResult {
  return {
    verdict: computeVerdict(input),
    staleDeals: flagStaleDeals(input.deals, input.baseline, input.now),
    trajectory: computeTrajectory(input),
    freshness: computeFreshness(input.lastUploadedAt, input.now),
    resolvedBenchmarks: {
      salesCycleDays: resolveSalesCycleDays(input.baseline),
      staleOpportunityThresholdDays: resolveStaleOpportunityThresholdDays(input.baseline),
    },
  };
}

export * from "./types";
export * from "./verdict";
export * from "./staleDeals";
export * from "./trajectory";
export * from "./coverage";
export * from "./orderBook";
export * from "./historicalObservations";
export * from "./benchmarks";
export * from "./targets";
export * from "./freshness";
export * from "./rounding";
