/**
 * Public surface of the scheme comparison service (Requirement 24).
 */

export {
  MIN_COMPARISON_SCHEMES,
  MAX_COMPARISON_SCHEMES,
  MISSING_VALUE_MARKER,
  COMPARISON_ATTRIBUTE_KEYS,
  COMPARISON_ATTRIBUTE_LABELS,
  ComparisonInputError,
  TooFewSchemesError,
  TooManySchemesError,
  DuplicateSchemeError,
  parseComparisonIds,
  validateComparisonIds,
  canonicaliseAttribute,
  attributeDiffersAcross,
  readAttributeValue,
  buildSchemeComparison,
  buildComparisonWithEligibility,
} from './scheme-comparison';
export type {
  ComparisonAttributeKey,
  SchemeEligibilityRow,
  SchemeComparisonWithEligibility,
} from './scheme-comparison';
