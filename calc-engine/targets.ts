import { Period } from "./types";

export interface PeriodTarget {
  value: number;
  /** RULE-002: must be visibly labelled when the figure is derived, not user-supplied. */
  derived: boolean;
}

/**
 * RULE-002: if only an annual target exists, monthly/quarterly targets are derived by
 * even distribution unless overridden. An override (a per-period target the user has
 * explicitly set) always wins and is never treated as derived.
 */
export function derivePeriodTarget(
  annualTarget: number,
  period: Period,
  overrideValue: number | null
): PeriodTarget {
  if (overrideValue !== null) {
    return { value: overrideValue, derived: false };
  }
  if (period === "year") {
    return { value: annualTarget, derived: false };
  }
  const divisor = period === "quarter" ? 4 : 12;
  return { value: annualTarget / divisor, derived: true };
}
