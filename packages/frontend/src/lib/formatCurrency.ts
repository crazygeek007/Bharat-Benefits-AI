/**
 * Currency formatting helpers shared across pages and components.
 *
 * Why a dedicated module: dashboard, profile, scheme detail, and
 * comparison table each had their own inline `Intl.NumberFormat` call —
 * usually with subtly different options (some had `maximumFractionDigits`,
 * some didn't). Centralising avoids drift and keeps the rupee glyph
 * rendering consistent.
 */

const INR_FORMATTER = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/**
 * Formats an amount as Indian Rupees with no decimal digits — the form
 * almost every scheme benefit amount needs. Returns `'—'` for `null` or
 * `undefined` so callers can pass profile/scheme values through without
 * a null-check at every callsite.
 */
export function formatINR(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  return INR_FORMATTER.format(amount);
}
