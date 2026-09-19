/** RULE-005: display rounded to nearest £1; underlying calculation stays precise — never round before this point. */
export function roundToWholePound(value: number): number {
  return Math.round(value);
}
