/**
 * Eligibility Engine — calculates citizen eligibility for schemes from
 * profile data and a scheme's officially published criteria.
 *
 * Responsibilities:
 *   - Evaluate individual eligibility criteria against a UserProfile
 *     (`evaluateCriterion`, Req 4.1).
 *   - Bucket criteria into met / unmet / unevaluated and produce an
 *     `EligibilityResult` (`calculateEligibility`, Req 4.1, 4.2, 4.3, 4.6).
 *   - Recompute eligibility for every saved scheme of a citizen within 30
 *     seconds of a profile update (`recalculateAllSavedSchemes`, Req 3.3, 4.5).
 *   - Base every decision exclusively on `scheme.eligibilityCriteria` which is
 *     populated from the official source by the Crawler System (Req 4.4).
 *
 * The pure functions below are exported for use by property-based tests
 * (Property 7) so that no Prisma/database wiring is required for assertions.
 */

import type {
  CriterionEvaluation,
  CriterionResult,
  EligibilityCriterion,
  EligibilityResult,
  Scheme,
  UnevaluatedCriterion,
  UserProfile,
} from '@bharat-benefits/shared';
import prisma from '../../lib/prisma';

// ─── Profile field mapping ───────────────────────────────────────────────────

/**
 * Maps a criterion field name to the corresponding `UserProfile` attribute.
 *
 * Scheme authors author criteria using natural names (e.g. "age", "income",
 * "caste"). The platform's `UserProfile` uses canonical TypeScript names
 * (e.g. `incomeLevel`, `casteCategory`). This helper accepts both the
 * canonical name and a small set of common aliases.
 *
 * Returns `undefined` when the field name is unrecognised or when the profile
 * does not provide a value for the field — callers MUST treat `undefined` as
 * "missing profile data" rather than as a falsy value.
 */
export function getProfileFieldValue(
  profile: UserProfile,
  field: string,
): unknown {
  if (!field) return undefined;
  const key = field.trim();
  const lower = key.toLowerCase();

  // Direct property match wins (handles `incomeLevel`, `casteCategory`, …).
  if (Object.prototype.hasOwnProperty.call(profile, key)) {
    return (profile as unknown as Record<string, unknown>)[key];
  }

  // Common aliases used by official scheme criteria.
  switch (lower) {
    case 'age':
      return profile.age;
    case 'gender':
      return profile.gender;
    case 'state':
    case 'state_of_residence':
    case 'stateofresidence':
      return profile.state;
    case 'district':
      return profile.district;
    case 'income':
    case 'incomelevel':
    case 'income_level':
    case 'annualincome':
    case 'annual_income':
    case 'household_income':
    case 'householdincome':
      return profile.incomeLevel;
    case 'occupation':
      return profile.occupation;
    case 'education':
    case 'educationlevel':
    case 'education_level':
      return profile.educationLevel;
    case 'caste':
    case 'castecategory':
    case 'caste_category':
      return profile.casteCategory;
    case 'disability':
    case 'disabilitystatus':
    case 'disability_status':
      return profile.disabilityStatus;
    case 'marital':
    case 'maritalstatus':
    case 'marital_status':
      return profile.maritalStatus;
    case 'dependents':
    case 'numberofdependents':
    case 'number_of_dependents':
      return profile.dependents;
    case 'language':
    case 'languagepreference':
    case 'language_preference':
      return profile.languagePreference;
    default:
      return undefined;
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Coerces a value into a finite number for numeric comparisons. Accepts
 * native numbers, numeric strings, and Decimal-like wrappers exposing a
 * `toNumber()` method (e.g. Prisma `Decimal`).
 *
 * Returns `null` when the value cannot be interpreted numerically. Numeric
 * comparators treat a `null` coercion as "comparison not applicable" — they
 * mark the criterion as unmet rather than throwing, which matches Req 4.6's
 * direction to surface unevaluable criteria gracefully.
 */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object' && value !== null) {
    const maybe = value as { toNumber?: () => unknown; valueOf?: () => unknown };
    if (typeof maybe.toNumber === 'function') {
      const n = maybe.toNumber();
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    }
    if (typeof maybe.valueOf === 'function') {
      const v = maybe.valueOf();
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return null;
}

/** Loose equality that treats Decimal-like wrappers and primitives uniformly. */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Numeric comparison when both sides are coercible to numbers.
  const an = toNumber(a);
  const bn = toNumber(b);
  if (an !== null && bn !== null) return an === bn;
  return false;
}

// ─── Pure eligibility helpers ────────────────────────────────────────────────

/**
 * Evaluates a single eligibility criterion against a (possibly missing)
 * profile value. Pure — no I/O, no exceptions for normal inputs.
 *
 * Conventions:
 *   - When `profileValue` is `null` or `undefined`, the criterion is reported
 *     as unmet with `missingField` set to `criterion.field`. Callers use this
 *     marker to bucket the criterion into `unevaluatedCriteria` and to
 *     surface the field name in `missingProfileFields` (Req 4.3, 4.5).
 *   - The `requirement` returned mirrors the citizen-facing description so
 *     that Not Eligible explanations cite the official rule text (Req 4.2).
 */
export function evaluateCriterion(
  criterion: EligibilityCriterion,
  profileValue: unknown,
): CriterionResult {
  const requirement = criterion.description ?? '';
  const criterionName = criterion.field;

  // Missing profile data — criterion cannot be evaluated.
  if (profileValue === null || profileValue === undefined) {
    return {
      met: false,
      criterionName,
      requirement,
      profileValue,
      missingField: criterion.field,
    };
  }

  const op = criterion.operator;
  const expected = criterion.value;
  let met = false;

  switch (op) {
    case 'eq':
      met = looseEquals(profileValue, expected);
      break;

    case 'neq':
      met = !looseEquals(profileValue, expected);
      break;

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumber(profileValue);
      const b = toNumber(expected);
      if (a === null || b === null) {
        met = false;
        break;
      }
      met =
        op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
      break;
    }

    case 'in': {
      if (!Array.isArray(expected)) {
        met = false;
      } else {
        met = expected.some((candidate) => looseEquals(profileValue, candidate));
      }
      break;
    }

    case 'between': {
      if (!Array.isArray(expected) || expected.length !== 2) {
        met = false;
        break;
      }
      const a = toNumber(profileValue);
      const min = toNumber(expected[0]);
      const max = toNumber(expected[1]);
      if (a === null || min === null || max === null) {
        met = false;
        break;
      }
      met = a >= min && a <= max;
      break;
    }

    default:
      // Unsupported operator — treat as unmet but do not throw, matching
      // Req 4.6's direction to gracefully surface unevaluable criteria.
      met = false;
  }

  return {
    met,
    criterionName,
    requirement,
    profileValue,
    missingField: null,
  };
}

/**
 * Calculates a full `EligibilityResult` for a profile against a scheme using
 * only the scheme's officially published `eligibilityCriteria` (Req 4.4).
 *
 * Status determination follows the simple bucketing direction from the task
 * spec:
 *   - any definitively unmet criterion → `Not Eligible`
 *   - else any criterion that could not be evaluated (regardless of met
 *     count) → `Partially Eligible` (the citizen-facing UI uses
 *     `missingProfileFields` to prompt the user to fill in profile data,
 *     Req 4.5).
 *   - else → `Eligible` (covers the vacuously-true empty-criteria case and
 *     the all-criteria-met case).
 */
export function calculateEligibility(
  userProfile: UserProfile,
  scheme: Scheme,
): EligibilityResult {
  const metCriteria: CriterionEvaluation[] = [];
  const unmetCriteria: CriterionEvaluation[] = [];
  const unevaluatedCriteria: UnevaluatedCriterion[] = [];

  const criteria = Array.isArray(scheme.eligibilityCriteria)
    ? scheme.eligibilityCriteria
    : [];

  for (const criterion of criteria) {
    const profileValue = getProfileFieldValue(userProfile, criterion.field);
    const result = evaluateCriterion(criterion, profileValue);

    if (result.missingField !== null) {
      unevaluatedCriteria.push({
        criterionName: result.criterionName,
        requirement: result.requirement,
        missingField: result.missingField,
      });
    } else if (result.met) {
      metCriteria.push({
        criterionName: result.criterionName,
        requirement: result.requirement,
        profileValue: result.profileValue,
        met: true,
      });
    } else {
      unmetCriteria.push({
        criterionName: result.criterionName,
        requirement: result.requirement,
        profileValue: result.profileValue,
        met: false,
      });
    }
  }

  let status: EligibilityResult['status'];
  if (unmetCriteria.length > 0) {
    status = 'Not Eligible';
  } else if (unevaluatedCriteria.length > 0) {
    status = 'Partially Eligible';
  } else {
    status = 'Eligible';
  }

  // Deduplicate missing field names while preserving first-seen ordering so
  // the prompt to the citizen is stable and readable (Req 4.5).
  const seen = new Set<string>();
  const missingProfileFields: string[] = [];
  for (const u of unevaluatedCriteria) {
    if (!seen.has(u.missingField)) {
      seen.add(u.missingField);
      missingProfileFields.push(u.missingField);
    }
  }

  return {
    status,
    metCriteria,
    unmetCriteria,
    unevaluatedCriteria,
    missingProfileFields,
  };
}

// ─── Prisma-aware orchestration ──────────────────────────────────────────────

/**
 * Minimal shape of the Prisma client surface the engine relies on. Declared
 * locally so unit tests can supply an in-memory fake without depending on the
 * generated Prisma types.
 */
export interface EligibilityEnginePrisma {
  userProfile: {
    findUnique(args: { where: { userId: string } }): Promise<UserProfile | null>;
  };
  savedScheme: {
    findMany(args: {
      where: { userId: string };
      include?: { scheme: true };
    }): Promise<Array<{ scheme: Scheme }>>;
  };
}

/** Result returned per saved scheme by `recalculateAllSavedSchemes`. */
export interface SavedSchemeEligibility {
  schemeId: string;
  result: EligibilityResult;
}

/**
 * `EligibilityEngine` couples the pure helpers above to a database client so
 * that callers can recompute eligibility across all of a citizen's saved
 * schemes after a profile update.
 *
 * The class exposes the same `evaluateCriterion` / `calculateEligibility`
 * surface area as the pure module functions so that downstream services can
 * inject the engine and rely on a stable interface.
 */
export class EligibilityEngine {
  constructor(private readonly db: EligibilityEnginePrisma = prisma as unknown as EligibilityEnginePrisma) {}

  /** Pure pass-through to `evaluateCriterion`. */
  evaluateCriterion(
    criterion: EligibilityCriterion,
    profileValue: unknown,
  ): CriterionResult {
    return evaluateCriterion(criterion, profileValue);
  }

  /** Pure pass-through to `calculateEligibility`. */
  calculateEligibility(userProfile: UserProfile, scheme: Scheme): EligibilityResult {
    return calculateEligibility(userProfile, scheme);
  }

  /**
   * Recalculates eligibility for every scheme the citizen has saved.
   *
   * Per Req 3.3 / 4.5 this must complete within 30 seconds for a typical
   * citizen (the platform caps saved schemes at `MAX_SAVED_SCHEMES = 100`).
   * The implementation runs evaluations in-process — each evaluation is a
   * pure, allocation-light function that finishes in microseconds, so the
   * 30-second budget is comfortable headroom.
   *
   * Throws if the citizen does not have a profile yet (Req 4.5 expects the
   * engine to demand profile data before producing a result).
   */
  async recalculateAllSavedSchemes(userId: string): Promise<SavedSchemeEligibility[]> {
    if (!userId) {
      throw new TypeError('userId is required to recalculate saved schemes');
    }

    const [profile, savedSchemes] = await Promise.all([
      this.db.userProfile.findUnique({ where: { userId } }),
      this.db.savedScheme.findMany({
        where: { userId },
        include: { scheme: true },
      }),
    ]);

    if (!profile) {
      throw new Error(`No user profile found for userId=${userId}`);
    }

    return savedSchemes.map((row) => ({
      schemeId: row.scheme.id,
      result: calculateEligibility(profile, row.scheme),
    }));
  }
}

/** Default singleton suitable for HTTP handlers and downstream services. */
export const eligibilityEngine = new EligibilityEngine();
