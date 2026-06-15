/**
 * Scheme Browser — pure filtering logic for the scheme discovery experience.
 *
 * These helpers power the public scheme browsing pages (Requirement 2). They
 * are intentionally pure, dependency-free, and synchronous so they can be:
 *   - exercised by property-based tests for AND-logic invariants (Property 4),
 *   - reused on either side of the network boundary (server route handler
 *     and, if needed, client-side previews),
 *   - reasoned about without database fixtures.
 *
 * Responsibilities:
 *   - `applySchemeFilters` combines every active filter using AND semantics
 *     (Requirement 2.3).
 *   - `getGovernmentLevel` derives the Central/State Government label that
 *     the platform must display on each Scheme (Requirement 2.4): a Scheme
 *     with a non-null `state` field is a State Government Scheme; otherwise
 *     it is a Central Government Scheme.
 *
 * Filter semantics:
 *   The filter input describes a Citizen's profile slice. A Scheme passes a
 *   filter if it is reachable by a Citizen with that attribute — i.e. the
 *   Scheme either places no restriction on the field or places a restriction
 *   that the supplied value satisfies. This matches user expectation: "show
 *   me schemes available to a 25-year-old farmer in Karnataka".
 */

import type {
  EligibilityCriterion,
  Scheme,
  SchemeCategory,
} from '@bharat-benefits/shared';

/** Government level label displayed on each scheme (Requirement 2.4). */
export type GovernmentLevel = 'Central' | 'State';

/** Filter dimensions surfaced in the browse UI (Requirement 2.2). */
export interface SchemeFilters {
  /** Indian state or union territory name (matches `Scheme.state`). */
  state?: string;
  /** Annual household income in INR. */
  incomeLevel?: number;
  /** Scheme category. */
  category?: SchemeCategory;
  /** Citizen age in years. */
  age?: number;
  /** Citizen gender. */
  gender?: string;
  /** Citizen occupation. */
  occupation?: string;
  /** Scheme benefit type. */
  benefitType?: 'monetary' | 'non-monetary';
}

// ─── Government level derivation (Requirement 2.4) ───────────────────────────

/**
 * Derives the visible Central/State Government label for a scheme.
 *
 * Per the data model, a Scheme that originates from a State Government has
 * its `state` field populated with the state name. A Scheme administered by
 * the Central Government applies nationwide and leaves `state` as `null`.
 */
export function getGovernmentLevel(scheme: Pick<Scheme, 'state'>): GovernmentLevel {
  return scheme.state !== null && scheme.state !== undefined && scheme.state !== ''
    ? 'State'
    : 'Central';
}

// ─── Criterion evaluation helpers ────────────────────────────────────────────

/**
 * Map of common criterion field aliases used by official scheme data to the
 * canonical filter keys we expose. Matching is case-insensitive.
 */
const FIELD_ALIASES: Record<string, keyof SchemeFilters> = {
  age: 'age',
  gender: 'gender',
  occupation: 'occupation',
  income: 'incomeLevel',
  incomelevel: 'incomeLevel',
  income_level: 'incomeLevel',
  annualincome: 'incomeLevel',
  annual_income: 'incomeLevel',
  state: 'state',
};

function canonicalFilterKey(field: string): keyof SchemeFilters | null {
  if (!field) return null;
  const normalised = field.trim().toLowerCase().replace(/\s+/g, '');
  return FIELD_ALIASES[normalised] ?? null;
}

/**
 * Evaluates a single criterion against a candidate value.
 *
 * Returns:
 *   - `true`  — the value satisfies the criterion (or the operator is unknown
 *               and we conservatively allow it through),
 *   - `false` — the value violates the criterion.
 *
 * Coercion: numeric criteria accept numeric strings to remain forgiving with
 * crawler-extracted values; string equality is case-insensitive to absorb
 * casing differences across official portals.
 */
export function criterionAllowsValue(
  criterion: EligibilityCriterion,
  value: unknown,
): boolean {
  const expected = criterion.value;

  switch (criterion.operator) {
    case 'eq':
      return looseEquals(value, expected);
    case 'neq':
      return !looseEquals(value, expected);
    case 'gt':
      return compareNumbers(value, expected, (a, b) => a > b);
    case 'gte':
      return compareNumbers(value, expected, (a, b) => a >= b);
    case 'lt':
      return compareNumbers(value, expected, (a, b) => a < b);
    case 'lte':
      return compareNumbers(value, expected, (a, b) => a <= b);
    case 'in':
      if (!Array.isArray(expected)) return false;
      return expected.some((entry) => looseEquals(value, entry));
    case 'between': {
      if (!Array.isArray(expected) || expected.length !== 2) return false;
      const [low, high] = expected;
      return (
        compareNumbers(value, low, (a, b) => a >= b) &&
        compareNumbers(value, high, (a, b) => a <= b)
      );
    }
    default:
      // Unknown operator — do not exclude the scheme on this dimension.
      return true;
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function compareNumbers(
  a: unknown,
  b: unknown,
  cmp: (x: number, y: number) => boolean,
): boolean {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na === null || nb === null) return false;
  return cmp(na, nb);
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na === nb;
  return false;
}

// ─── Per-filter predicates ───────────────────────────────────────────────────

/**
 * Checks whether the scheme's eligibility criteria allow a given value for
 * the requested filter key. Schemes that place no restriction on the field
 * automatically pass (they're available to anyone on that dimension).
 */
function criteriaAllowFilterValue(
  scheme: Pick<Scheme, 'eligibilityCriteria'>,
  filterKey: keyof SchemeFilters,
  value: unknown,
): boolean {
  const criteria = scheme.eligibilityCriteria ?? [];
  for (const criterion of criteria) {
    if (canonicalFilterKey(criterion.field) === filterKey) {
      if (!criterionAllowsValue(criterion, value)) return false;
    }
  }
  return true;
}

function passesStateFilter(scheme: Pick<Scheme, 'state'>, filterState: string): boolean {
  // Central schemes (state === null) apply nationwide and are always
  // surfaced when filtering by a specific state. State schemes match only
  // when their state matches the filter (case-insensitive trim).
  if (scheme.state === null || scheme.state === undefined || scheme.state === '') {
    return true;
  }
  return scheme.state.trim().toLowerCase() === filterState.trim().toLowerCase();
}

function passesCategoryFilter(
  scheme: Pick<Scheme, 'category'>,
  filterCategory: SchemeCategory,
): boolean {
  return scheme.category === filterCategory;
}

function passesBenefitTypeFilter(
  scheme: Pick<Scheme, 'benefitType'>,
  filterBenefitType: 'monetary' | 'non-monetary',
): boolean {
  return scheme.benefitType === filterBenefitType;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the subset of `schemes` that satisfy every active filter.
 *
 * AND semantics: a scheme is included only if it passes every supplied
 * filter (Requirement 2.3). Filters left as `undefined` are inactive and
 * contribute nothing to the predicate.
 *
 * Pure: same input → same output, no side effects, no I/O. Empty input
 * returns an empty array.
 */
export function applySchemeFilters(
  schemes: ReadonlyArray<Scheme>,
  filters: SchemeFilters,
): Scheme[] {
  if (schemes.length === 0) return [];

  return schemes.filter((scheme) => {
    if (filters.state !== undefined) {
      if (!passesStateFilter(scheme, filters.state)) return false;
    }
    if (filters.category !== undefined) {
      if (!passesCategoryFilter(scheme, filters.category)) return false;
    }
    if (filters.benefitType !== undefined) {
      if (!passesBenefitTypeFilter(scheme, filters.benefitType)) return false;
    }
    if (filters.incomeLevel !== undefined) {
      if (!criteriaAllowFilterValue(scheme, 'incomeLevel', filters.incomeLevel)) {
        return false;
      }
    }
    if (filters.age !== undefined) {
      if (!criteriaAllowFilterValue(scheme, 'age', filters.age)) return false;
    }
    if (filters.gender !== undefined) {
      if (!criteriaAllowFilterValue(scheme, 'gender', filters.gender)) return false;
    }
    if (filters.occupation !== undefined) {
      if (!criteriaAllowFilterValue(scheme, 'occupation', filters.occupation)) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Returns a count of how many filters are active on the supplied input.
 * Useful for the zero-results UI that suggests broadening filters.
 */
export function countActiveFilters(filters: SchemeFilters): number {
  return (Object.keys(filters) as (keyof SchemeFilters)[]).reduce(
    (acc, key) => (filters[key] !== undefined ? acc + 1 : acc),
    0,
  );
}
