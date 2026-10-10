export const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
export function isDecimalString(value, { allowNegative = true } = {}) { return typeof value === 'string' && DECIMAL_PATTERN.test(value) && (allowNegative || !value.startsWith('-')); }
export function isUnsignedId(value) { return typeof value === 'string' && /^[1-9]\d*$/.test(value); }
export function validateDateRange(from, to, maxDays = 366) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) return 'Choose a valid from and to date.';
  const start = Date.parse(`${from}T00:00:00Z`); const end = Date.parse(`${to}T00:00:00Z`);
  if (start > end) return 'From date must not be after to date.';
  if ((end - start) / 86400000 + 1 > maxDays) return `Date range must not exceed ${maxDays} days.`;
  return null;
}
