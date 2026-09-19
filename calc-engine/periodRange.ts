import { Period } from "./types";

export interface PeriodRange {
  start: Date;
  /** Exclusive. */
  end: Date;
}

export function resolvePeriodRange(periodStart: string, period: Period): PeriodRange {
  const start = new Date(periodStart);
  const end = new Date(start);
  if (period === "month") end.setUTCMonth(end.getUTCMonth() + 1);
  else if (period === "quarter") end.setUTCMonth(end.getUTCMonth() + 3);
  else end.setUTCFullYear(end.getUTCFullYear() + 1);
  return { start, end };
}

export function isWithinPeriod(dateIso: string, range: PeriodRange): boolean {
  const time = new Date(dateIso).getTime();
  return time >= range.start.getTime() && time < range.end.getTime();
}
