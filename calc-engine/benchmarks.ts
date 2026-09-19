import { CommercialBaseline } from "./types";

/** RULE-001: platform default when no sales-cycle benchmark has been configured. */
export const DEFAULT_SALES_CYCLE_DAYS = 30;

/** RULE-010 fallback tier 3: derived from the 30-day sales-cycle default when nothing is configured at all. */
export const DEFAULT_DERIVED_STALE_THRESHOLD_DAYS = 15;

export interface ResolvedBenchmark<T> {
  value: T;
  source: "configured" | "platform_default" | "derived";
}

/** RULE-001. */
export function resolveSalesCycleDays(baseline: CommercialBaseline): ResolvedBenchmark<number> {
  if (baseline.salesCycleDays !== null) {
    return { value: baseline.salesCycleDays, source: "configured" };
  }
  return { value: DEFAULT_SALES_CYCLE_DAYS, source: "platform_default" };
}

/**
 * RULE-010: no universal default — stale is industry-contextual. Deterministic chain:
 * (1) explicit threshold → (2) 50% of the sales-cycle benchmark, rounded → (3) 15 days,
 * derived from the 30-day MVP sales-cycle default.
 */
export function resolveStaleOpportunityThresholdDays(
  baseline: CommercialBaseline
): ResolvedBenchmark<number> {
  if (baseline.staleOpportunityThresholdDays !== null) {
    return { value: baseline.staleOpportunityThresholdDays, source: "configured" };
  }
  if (baseline.salesCycleDays !== null) {
    return { value: Math.round(baseline.salesCycleDays * 0.5), source: "derived" };
  }
  return { value: DEFAULT_DERIVED_STALE_THRESHOLD_DAYS, source: "derived" };
}
