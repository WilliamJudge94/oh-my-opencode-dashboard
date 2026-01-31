const TOKEN_COUNT_FORMATTER = new Intl.NumberFormat("en-US");

export function formatTokenCount(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return TOKEN_COUNT_FORMATTER.format(Math.max(0, Math.round(value)));
}
