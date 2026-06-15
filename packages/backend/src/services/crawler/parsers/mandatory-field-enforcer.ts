/**
 * Mandatory Field Enforcer for Scheme Parsing
 *
 * Per Requirements 22.1, 22.6, and 22.7:
 *
 *   - A standardized {@link SchemeObject} contains six MANDATORY fields:
 *       name, description, eligibilityCriteria, benefits, sourceUrl, ministry
 *     and three OPTIONAL fields:
 *       applicationProcess, requiredDocuments, deadline
 *
 *   - If one or more mandatory fields cannot be parsed, the scheme MUST be
 *     rejected; the rejection result lists the missing fields so the caller
 *     can log them with the source URL and flag the source for admin review.
 *
 *   - If all mandatory fields are present but some optional fields are
 *     unparseable, the scheme is created with the optional fields set to
 *     null.
 *
 * The enforcer is intentionally pure (no logging, no I/O) so it remains
 * trivially testable and reusable across HTML / PDF / JSON / XML parsers.
 */

import type {
  Benefit,
  EligibilityCriterion,
  SchemeObject,
} from '@bharat-benefits/shared';

/** Names of the mandatory fields, in the order they should be reported. */
export const MANDATORY_SCHEME_FIELDS = [
  'name',
  'description',
  'eligibilityCriteria',
  'benefits',
  'sourceUrl',
  'ministry',
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
 * Validates that all mandatory fields are present on the partial SchemeObject
 * and produces a fully-shaped SchemeObject (with optional fields defaulted to
 * null) on success, or a rejection listing the missing field names.
 *
 * `sourceUrl` is taken from the partial first; if absent, the fallback URL
 * passed by the caller (typically the URL the scheme was discovered at) is
 * used. This allows individual parsers to omit `sourceUrl` from their output
 * and have it filled in centrally.
 *
 * Rules:
 *   - `name`, `description`, `ministry`, `sourceUrl`: must be non-empty strings
 *     after trimming. Whitespace-only strings are treated as missing.
 *   - `eligibilityCriteria`, `benefits`: must be arrays with at least one
 *     element. Empty arrays count as missing data.
 *   - All other fields are optional. Anything that isn't a recognisable
 *     value (undefined, null, malformed) is normalised to null.
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

  const eligibilityCriteria = sanitizeCriteria(partial.eligibilityCriteria);
  if (eligibilityCriteria === null) missingFields.push('eligibilityCriteria');

  const benefits = sanitizeBenefits(partial.benefits);
  if (benefits === null) missingFields.push('benefits');

  const resolvedSourceUrl =
    sanitizeString(partial.sourceUrl) ?? sanitizeString(sourceUrl);
  if (resolvedSourceUrl === null) missingFields.push('sourceUrl');

  const ministry = sanitizeString(partial.ministry);
  if (ministry === null) missingFields.push('ministry');

  if (missingFields.length > 0) {
    return { rejected: true, missingFields };
  }

  // Optional fields — keep type safety while normalising "missing" to null.
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
    eligibilityCriteria: eligibilityCriteria as EligibilityCriterion[],
    benefits: benefits as Benefit[],
    sourceUrl: resolvedSourceUrl as string,
    ministry: ministry as string,
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

function sanitizeCriteria(
  value: unknown,
): EligibilityCriterion[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value as EligibilityCriterion[];
}

function sanitizeBenefits(value: unknown): Benefit[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value as Benefit[];
}
