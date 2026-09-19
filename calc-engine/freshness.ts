/**
 * RULE-007: the exact staleness threshold isn't specified in doc 03/09 yet — this default
 * is a placeholder pending Dan's number, not a modelled business decision.
 */
export const FRESHNESS_THRESHOLD_DAYS = 35;

export interface FreshnessResult {
  isStale: boolean;
  daysSinceUpload: number | null;
}

export function computeFreshness(lastUploadedAt: string | null, now: string): FreshnessResult {
  if (lastUploadedAt === null) {
    return { isStale: true, daysSinceUpload: null };
  }
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysSinceUpload = Math.round(
    (new Date(now).getTime() - new Date(lastUploadedAt).getTime()) / msPerDay
  );
  return { isStale: daysSinceUpload > FRESHNESS_THRESHOLD_DAYS, daysSinceUpload };
}
