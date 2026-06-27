/**
 * Mandatory Field Enforcer for Scheme Parsing
 *
 * Per the discovery-feature refinement (June 2026), the mandatory-field
 * gate is intentionally narrow:
 *
 *   - REQUIRED: `name`, `description`, `sourceUrl`. Without these we
 *     can't render a useful scheme card or link a citizen to the
 *     official source, so the ingest pipeline rejects the row.
 *
 *   - OPTIONAL: `ministry`, `eligibilityCriteria`, `benefits`,
 *     `applicationProcess`, `requiredDocuments`, `deadline`. Missing
 *     values are normalised to a fallback (ministry -> "Unknown
 *     Ministry") or `[]` / `null`. The catalogue now stores partial
 *     schemes; future crawls / admin edits enrich them.
 *
 *   We deliberately relaxed the original strict gate because the prod
 *   crawler was rejecting >95% of pages over missing `eligibilityCriteria`
 *   / `benefits` even though the page WAS a valid scheme — the
 *   information was just structured differently from our parser's
 *   expectations. A partial scheme is more useful than no scheme.
 *
 * The enforcer is intentionally pure (no logging, no I/O) so it remains
 * trivially testable and reusable across HTML / PDF / JSON / XML parsers.
 */

import type {
  Benefit,
  EligibilityCriterion,
  SchemeObject,
} from '@bharat-benefits/shared';

/**
 * Fallback ministry name used when a parsed scheme doesn't surface the
 * issuing ministry. Set to "Unknown Ministry" so admin reviewers can
 * filter for these rows and fill in the correct ministry by hand.
 */
export const FALLBACK_MINISTRY = 'Unknown Ministry';

/** Names of the mandatory fields, in the order they should be reported. */
export const MANDATORY_SCHEME_FIELDS = [
  'name',
  'description',
  'sourceUrl',
] as const;

/** Single mandatory-field name. */
export type MandatorySchemeField = (typeof MANDATORY_SCHEME_FIELDS)[number];

/** Result returned when the partial scheme is missing one or more mandatory fields. */
export interface MandatoryFieldRejection {
  rejected: true;
  missingFields: MandatorySchemeField[];
}

/** Outcome of running the enforcer: either a complete SchemeObject or a rejection. */
export type EnforcementResult = SchemeObject | MandatoryFieldRejection;

/**
 * Type guard for the rejection branch of {@link EnforcementResult}.
 */
export function isRejected(
  result: EnforcementResult,
): result is MandatoryFieldRejection {
  return (result as MandatoryFieldRejection).rejected === true;
}

/**
 * Validates that the three core mandatory fields are present on the
 * partial SchemeObject and produces a fully-shaped SchemeObject (with
 * optional fields defaulted to sensible empty values) on success, or a
 * rejection listing the missing field names.
 *
 * `sourceUrl` is taken from the partial first; if absent, the fallback
 * URL passed by the caller (typically the URL the scheme was discovered
 * at) is used.
 *
 * Rules:
 *   - `name`, `description`, `sourceUrl`: must be non-empty strings
 *     after trimming. Whitespace-only strings are treated as missing.
 *   - `ministry`: optional — falls back to `FALLBACK_MINISTRY` when
 *     the parser couldn't surface it.
 *   - `eligibilityCriteria`, `benefits`: optional — default to `[]`.
 *     A scheme with no parsed eligibility / benefits still surfaces
 *     to citizens; admin reviewers fill in the structured details
 *     later through the admin UI.
 *   - `applicationProcess`, `requiredDocuments`, `deadline`: optional.
 */
export function enforceMandatoryFields(
  partial: Partial<SchemeObject>,
  sourceUrl: string,
): EnforcementResult {
  const missingFields: MandatorySchemeField[] = [];

  const name = sanitizeString(partial.name);
  if (name === null) missingFields.push('name');

  const description = sanitizeString(partial.description);
  if (description === null) missingFields.push('description');

  const resolvedSourceUrl =
    sanitizeString(partial.sourceUrl) ?? sanitizeString(sourceUrl);
  if (resolvedSourceUrl === null) missingFields.push('sourceUrl');

  if (missingFields.length > 0) {
    return { rejected: true, missingFields };
  }

  // ── Now-optional fields: normalise rather than reject. ──────────────
  // Ministry was previously required; preserve a stable downstream
  // shape with a fallback string so PrismaSchemePersistence (which
  // expects a non-null `ministry`) keeps working.
  const ministry = sanitizeString(partial.ministry) ?? FALLBACK_MINISTRY;

  // Eligibility / benefits default to empty arrays. The shared
  // SchemeObject type requires arrays, not null — we honour that, just
  // allow them to be empty.
  const eligibilityCriteria = Array.isArray(partial.eligibilityCriteria)
    ? (partial.eligibilityCriteria as EligibilityCriterion[])
    : [];
  const benefits = Array.isArray(partial.benefits)
    ? (partial.benefits as Benefit[])
    : [];

  const applicationProcess = Array.isArray(partial.applicationProcess)
    ? partial.applicationProcess
    : null;

  const requiredDocuments = Array.isArray(partial.requiredDocuments)
    ? partial.requiredDocuments
    : null;

  const deadline =
    partial.deadline instanceof Date && !Number.isNaN(partial.deadline.getTime())
      ? partial.deadline
      : null;

  return {
    name: name as string,
    description: description as string,
    eligibilityCriteria,
    benefits,
    sourceUrl: resolvedSourceUrl as string,
    ministry,
    applicationProcess,
    requiredDocuments,
    deadline,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
