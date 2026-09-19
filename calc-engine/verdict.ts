import { CalcEngineInput } from "./types";
import { resolvePeriodRange, isWithinPeriod } from "./periodRange";
import { derivePeriodTarget, PeriodTarget } from "./targets";
import { computeOrderBook } from "./orderBook";
import { computeCoverage, CoverageResult } from "./coverage";

export type VerdictDirection = "ahead" | "behind";

export interface Verdict {
  /** Null when no revenue target is configured at all — RULE-001's "no target set" state. */
  target: PeriodTarget | null;
  invoicedActual: number;
  orderBookValue: number;
  qualifiedPipelineValue: number;
  actualTotal: number;
  gap: number | null;
  direction: VerdictDirection | null;
  coverage: CoverageResult | null;
}

/** REQ-003/004, RULE-002/003/004/008. */
export function computeVerdict(input: CalcEngineInput): Verdict {
  const range = resolvePeriodRange(input.periodStart, input.period);

  const invoicedActual = input.pnlLines
    .filter((line) => isWithinPeriod(line.period, range))
    .reduce((sum, line) => sum + line.invoicedRevenue, 0);

  const { orderBookValue } = computeOrderBook(input.deals, input.pnlLines);

  const qualifiedPipelineValue = input.deals
    .filter(
      (deal) =>
        deal.status === "open" &&
        (deal.qualificationTier === "likely" || deal.qualificationTier === "highly_likely")
    )
    .reduce((sum, deal) => sum + deal.value, 0);

  const actualTotal = invoicedActual + orderBookValue + qualifiedPipelineValue;

  if (input.baseline.revenueTargetAnnual === null) {
    return {
      target: null,
      invoicedActual,
      orderBookValue,
      qualifiedPipelineValue,
      actualTotal,
      gap: null,
      direction: null,
      coverage: null,
    };
  }

  const target = derivePeriodTarget(input.baseline.revenueTargetAnnual, input.period, null);
  const gap = target.value - actualTotal;
  const direction: VerdictDirection = gap <= 0 ? "ahead" : "behind";
  const coverage = computeCoverage(input.deals, Math.max(gap, 0));

  return {
    target,
    invoicedActual,
    orderBookValue,
    qualifiedPipelineValue,
    actualTotal,
    gap,
    direction,
    coverage,
  };
}
