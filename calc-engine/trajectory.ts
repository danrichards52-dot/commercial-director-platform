import { CalcEngineInput } from "./types";
import { computeOrderBook } from "./orderBook";

export interface TrajectoryPoint {
  /** ISO date, first of month. */
  monthStart: string;
  cumulativeInvoiced: number;
  cumulativeOrderBook: number;
  cumulativeQualifiedPipeline: number;
  cumulativeTargetPace: number;
}

export interface TrajectoryResult {
  points: TrajectoryPoint[];
  todayMarker: string;
}

function monthKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthStartIso(year: number, monthIndexZeroBased: number): string {
  return new Date(Date.UTC(year, monthIndexZeroBased, 1)).toISOString().slice(0, 10);
}

/**
 * REQ-007: a 12-month cumulative trajectory for the calendar year containing `periodStart`,
 * plotting invoiced-actual, order-book and qualified-pipeline segments against an even
 * target pace line (RULE-002's even-distribution assumption, made visible as a line here
 * rather than asserted as fact).
 *
 * Order-book and qualified-pipeline deals are attributed to the month of their close/expected
 * close date; a qualified deal with no expected close date has nowhere to plot on this chart
 * and is excluded from it, though it still counts in RULE-008's point-in-time coverage figures.
 */
export function computeTrajectory(input: CalcEngineInput): TrajectoryResult {
  const year = new Date(input.periodStart).getUTCFullYear();
  const { wonUnmatchedDeals } = computeOrderBook(input.deals, input.pnlLines);

  const invoicedByMonth = new Map<string, number>();
  for (const line of input.pnlLines) {
    if (new Date(line.period).getUTCFullYear() !== year) continue;
    const key = monthKey(line.period);
    invoicedByMonth.set(key, (invoicedByMonth.get(key) ?? 0) + line.invoicedRevenue);
  }

  const orderBookByMonth = new Map<string, number>();
  for (const deal of wonUnmatchedDeals) {
    const dateForMonth = deal.closeDate ?? deal.expectedCloseDate;
    if (!dateForMonth || new Date(dateForMonth).getUTCFullYear() !== year) continue;
    const key = monthKey(dateForMonth);
    orderBookByMonth.set(key, (orderBookByMonth.get(key) ?? 0) + deal.value);
  }

  const qualifiedPipelineByMonth = new Map<string, number>();
  for (const deal of input.deals) {
    if (deal.status !== "open") continue;
    if (deal.qualificationTier !== "likely" && deal.qualificationTier !== "highly_likely") continue;
    if (!deal.expectedCloseDate || new Date(deal.expectedCloseDate).getUTCFullYear() !== year) continue;
    const key = monthKey(deal.expectedCloseDate);
    qualifiedPipelineByMonth.set(key, (qualifiedPipelineByMonth.get(key) ?? 0) + deal.value);
  }

  const annualTarget = input.baseline.revenueTargetAnnual;
  const monthlyTargetPace = annualTarget !== null ? annualTarget / 12 : 0;

  const points: TrajectoryPoint[] = [];
  let cumulativeInvoiced = 0;
  let cumulativeOrderBook = 0;
  let cumulativeQualifiedPipeline = 0;

  for (let month = 0; month < 12; month++) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}`;
    cumulativeInvoiced += invoicedByMonth.get(key) ?? 0;
    cumulativeOrderBook += orderBookByMonth.get(key) ?? 0;
    cumulativeQualifiedPipeline += qualifiedPipelineByMonth.get(key) ?? 0;

    points.push({
      monthStart: monthStartIso(year, month),
      cumulativeInvoiced,
      cumulativeOrderBook,
      cumulativeQualifiedPipeline,
      cumulativeTargetPace: monthlyTargetPace * (month + 1),
    });
  }

  return { points, todayMarker: input.now };
}
