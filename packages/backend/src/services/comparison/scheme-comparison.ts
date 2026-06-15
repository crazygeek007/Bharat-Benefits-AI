/**
 * Scheme Comparison — pure logic for the side-by-side comparison tool
 * (Requirement 24).
 *
 * Given 2 or 3 schemes, this module produces a `SchemeComparison` record
 * that the citizen-facing comparison page renders as a table:
 *   - one row per attribute (eligibility criteria, benefits, deadline,
 *     required documents, application process),
 *   - one cell per scheme,
 *   - a `differs` flag so the UI can highlight rows where the values
 *     differ across the selected schemes (Property 22 / Req 24.4).
 *
 * Every helper is pure: same input → same output, no I/O. That keeps the
 * module trivially unit-testable and lets the route handler call it from
 * a request without touching the database.
 *
 * The module also exports validation helpers and typed errors so the route
 * can return precise 400-level responses for the edge cases listed in
 * Requirement 24:
 *   - 24.1 — accept exactly 2 or 3 scheme ids,
 *   - 24.3 — reject more than 3 ids with a "max reached" error,
 *   - 24.5 — reject duplicate ids in the selection.
 *
 * Validates: Requirements 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7.
 */

import type {
  ApplicationStep,
  Benefit,
  ComparisonAttribute,
  DocumentRequirement,
  EligibilityCriterion,
  EligibilityResult,
  Scheme,
  SchemeComparison,
} from '@bharat-benefits/shared';
import { MAX_COMPARISON_SCHEMES } from '@bharat-benefits/shared';

/** Minimum number of schemes the comparison tool will operate on (Req 24.1). */
export const MIN_COMPARISON_SCHEMES = 2;

/** Re-export the maximum so callers can import both bounds from one place. */
export { MAX_COMPARISON_SCHEMES };

/**
 * Sentinel string rendered in the cell when a scheme does not publish a
 * value for the attribute (Req 24.7). Surfacing the marker — rather than
 * leaving the cell blank — keeps the table readable and makes the
 * "Information not available" expectation explicit.
 */
export const MISSING_VALUE_MARKER = 'Not specified';

/**
 * Stable list of attributes that must appear in every comparison result,
 * in the order the table renders them (Req 24.4).
 */
export const COMPARISON_ATTRIBUTE_KEYS = [
  'eligibilityCriteria',
  'benefits',
  'deadline',
  'requiredDocuments',
  'applicationProcess',
] as const;

export type ComparisonAttributeKey = (typeof COMPARISON_ATTRIBUTE_KEYS)[number];

/** Human-readable column labels keyed by attribute. */
export const COMPARISON_ATTRIBUTE_LABELS: Record<ComparisonAttributeKey, string> = {
  eligibilityCriteria: 'Eligibility criteria',
  benefits: 'Benefits',
  deadline: 'Application deadline',
  requiredDocuments: 'Required documents',
  applicationProcess: 'Application process',
};

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Base error class for comparison input errors. */
export class ComparisonInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComparisonInputError';
  }
}

/** Raised when the caller supplies fewer than `MIN_COMPARISON_SCHEMES`. */
export class TooFewSchemesError extends ComparisonInputError {
  readonly minimum = MIN_COMPARISON_SCHEMES;
  constructor() {
    super(
      `At least ${MIN_COMPARISON_SCHEMES} schemes are required for comparison.`,
    );
    this.name = 'TooFewSchemesError';
  }
}

/** Raised when the caller supplies more than `MAX_COMPARISON_SCHEMES`. */
export class TooManySchemesError extends ComparisonInputError {
  readonly maximum = MAX_COMPARISON_SCHEMES;
  constructor() {
    super(
      `A maximum of ${MAX_COMPARISON_SCHEMES} schemes can be compared at once. Please remove a scheme before adding another.`,
    );
    this.name = 'TooManySchemesError';
  }
}

/** Raised when the same scheme id appears more than once in the selection. */
export class DuplicateSchemeError extends ComparisonInputError {
  constructor(public readonly schemeId: string) {
    super(`Duplicate scheme id in comparison selection: ${schemeId}.`);
    this.name = 'DuplicateSchemeError';
  }
}

// ─── Public input parsing & validation ───────────────────────────────────────

/**
 * Parses a raw `?ids=` query parameter into a deduplicated list of scheme
 * ids and validates the count against the `[2, 3]` range.
 *
 * Accepts either:
 *   - a single comma-separated string (e.g. `ids=a,b,c`), or
 *   - a repeated parameter array (e.g. `ids=a&ids=b&ids=c`).
 *
 * Throws `TooFewSchemesError` / `TooManySchemesError` / `DuplicateSchemeError`
 * for the corresponding validation failures so the route handler can map
 * each to a precise HTTP status.
 */
export function parseComparisonIds(raw: unknown): string[] {
  const ids: string[] = [];
  const source = Array.isArray(raw) ? raw : [raw];
  for (const entry of source) {
    if (typeof entry !== 'string') continue;
    for (const part of entry.split(',')) {
      const trimmed = part.trim();
      if (trimmed.length > 0) ids.push(trimmed);
    }
  }
  return validateComparisonIds(ids);
}

/**
 * Validates the count + uniqueness of an already-parsed id list. Exposed
 * separately so callers that source ids from elsewhere (e.g. POST body) can
 * reuse the same rules.
 */
export function validateComparisonIds(ids: ReadonlyArray<string>): string[] {
  if (ids.length < MIN_COMPARISON_SCHEMES) {
    throw new TooFewSchemesError();
  }
  if (ids.length > MAX_COMPARISON_SCHEMES) {
    throw new TooManySchemesError();
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new DuplicateSchemeError(id);
    }
    seen.add(id);
  }
  return [...ids];
}

// ─── Canonicalisation ────────────────────────────────────────────────────────
//
// To compute the `differs` flag we need a deterministic canonical form per
// attribute. Two schemes "differ" on an attribute when their canonical
// strings are not equal. The canonical form is built from the structured
// value (criteria array, benefits array, deadline date, etc.) so cosmetic
// differences in object key order or whitespace don't trigger a false
// "differs" verdict.

function normaliseString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '');
}

function canonicaliseCriterion(c: EligibilityCriterion): string {
  return JSON.stringify({
    f: normaliseString(c.field).toLowerCase(),
    o: normaliseString(c.operator).toLowerCase(),
    v: c.value ?? null,
    d: normaliseString(c.description),
  });
}

function canonicaliseBenefit(b: Benefit): string {
  return JSON.stringify({
    t: normaliseString(b.type).toLowerCase(),
    a: typeof b.amount === 'number' && Number.isFinite(b.amount) ? b.amount : null,
    d: normaliseString(b.description),
  });
}

function canonicaliseDocument(d: DocumentRequirement): string {
  return JSON.stringify({
    n: normaliseString(d.documentName).toLowerCase(),
    de: normaliseString(d.description),
    f: normaliseString(d.format).toLowerCase(),
    r: Boolean(d.required),
  });
}

function canonicaliseStep(s: ApplicationStep): string {
  return JSON.stringify({
    n: Number.isFinite(s.stepNumber) ? Number(s.stepNumber) : 0,
    a: normaliseString(s.action),
    e: normaliseString(s.expectedOutcome),
  });
}

/**
 * Produces a canonical string for an attribute value. Empty / null arrays
 * collapse to `MISSING_VALUE_MARKER` so two schemes that both lack the
 * attribute compare equal (no spurious "differs") — this also drives the
 * UI rendering: the same canonical value powers both the differ flag and
 * the displayed "Not specified" cell.
 */
export function canonicaliseAttribute(
  key: ComparisonAttributeKey,
  scheme: Scheme,
): string {
  switch (key) {
    case 'eligibilityCriteria': {
      const arr = scheme.eligibilityCriteria ?? [];
      if (arr.length === 0) return MISSING_VALUE_MARKER;
      return arr.map(canonicaliseCriterion).sort().join('|');
    }
    case 'benefits': {
      const arr = scheme.benefits ?? [];
      if (arr.length === 0) return MISSING_VALUE_MARKER;
      return arr.map(canonicaliseBenefit).sort().join('|');
    }
    case 'deadline': {
      const d = scheme.deadline;
      if (d === null || d === undefined) return MISSING_VALUE_MARKER;
      const date = d instanceof Date ? d : new Date(d as string);
      if (Number.isNaN(date.getTime())) return MISSING_VALUE_MARKER;
      return date.toISOString().slice(0, 10); // YYYY-MM-DD — comparison is day-precision.
    }
    case 'requiredDocuments': {
      const arr = scheme.requiredDocuments ?? [];
      if (arr.length === 0) return MISSING_VALUE_MARKER;
      return arr.map(canonicaliseDocument).sort().join('|');
    }
    case 'applicationProcess': {
      const arr = scheme.applicationSteps ?? [];
      if (arr.length === 0) return MISSING_VALUE_MARKER;
      // Application steps are intrinsically ordered — preserve order rather
      // than sorting so a 3-step → 5-step reorder counts as a difference.
      return arr.map(canonicaliseStep).join('|');
    }
    default: {
      // Exhaustiveness guard — TypeScript flags any missed key here.
      const _exhaustive: never = key;
      void _exhaustive;
      return '';
    }
  }
}

// ─── Differ detection ────────────────────────────────────────────────────────

/**
 * Computes whether the canonical values across the supplied schemes differ
 * for the given attribute.
 *
 * Differ semantics (Req 24.4 / Property 22): the cell is highlighted **iff**
 * the canonical values are not all equal. A row where every scheme reports
 * `MISSING_VALUE_MARKER` does not differ — they all share the "not
 * specified" state.
 */
export function attributeDiffersAcross(
  key: ComparisonAttributeKey,
  schemes: ReadonlyArray<Scheme>,
): boolean {
  if (schemes.length < 2) return false;
  const first = canonicaliseAttribute(key, schemes[0]);
  for (let i = 1; i < schemes.length; i++) {
    if (canonicaliseAttribute(key, schemes[i]) !== first) return true;
  }
  return false;
}

// ─── Public attribute extraction ─────────────────────────────────────────────

/**
 * Produces the raw attribute value the UI renders. Arrays / nullable
 * fields preserve their structure so the table can format each cell with
 * domain-specific knowledge (criteria → bullet list, deadline → formatted
 * date, etc.). Missing values are surfaced as `null` rather than the
 * sentinel string — the render layer decides how to display them.
 */
export function readAttributeValue(
  key: ComparisonAttributeKey,
  scheme: Scheme,
): unknown {
  switch (key) {
    case 'eligibilityCriteria':
      return scheme.eligibilityCriteria ?? [];
    case 'benefits':
      return scheme.benefits ?? [];
    case 'deadline':
      return scheme.deadline ? toIsoString(scheme.deadline) : null;
    case 'requiredDocuments':
      return scheme.requiredDocuments ?? [];
    case 'applicationProcess':
      return scheme.applicationSteps ?? [];
    default: {
      const _exhaustive: never = key;
      void _exhaustive;
      return null;
    }
  }
}

function toIsoString(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toISOString();
}

// ─── Top-level builder ───────────────────────────────────────────────────────

/**
 * Builds the full `SchemeComparison` record from a set of pre-loaded
 * schemes. Pure: no DB access, no clock reads.
 *
 * Caller is responsible for:
 *   - ensuring `schemes.length` is in `[MIN, MAX]` (use
 *     `validateComparisonIds` upstream),
 *   - ordering `schemes` to match the order the citizen selected them
 *     (the comparison preserves the supplied order so the table columns
 *     line up with the user's selection).
 */
export function buildSchemeComparison(
  schemes: ReadonlyArray<Scheme>,
): SchemeComparison {
  const attributes: ComparisonAttribute[] = COMPARISON_ATTRIBUTE_KEYS.map(
    (key) => ({
      attributeName: key,
      values: schemes.map((scheme) => ({
        schemeId: scheme.id,
        value: readAttributeValue(key, scheme),
      })),
      differs: attributeDiffersAcross(key, schemes),
    }),
  );
  return { schemes: [...schemes], attributes };
}

// ─── Eligibility decoration (Req 24.6) ───────────────────────────────────────

/**
 * Per-scheme eligibility row that the route returns alongside the bare
 * `SchemeComparison`. The map key is the scheme id; `null` means the
 * citizen has no profile yet (or is unauthenticated) — the UI surfaces
 * "Sign in to see eligibility" in that case.
 */
export interface SchemeEligibilityRow {
  schemeId: string;
  eligibility: EligibilityResult | null;
}

/**
 * Combines `buildSchemeComparison` with a per-scheme eligibility lookup so
 * the route can return a single payload that drives the entire comparison
 * page.
 */
export interface SchemeComparisonWithEligibility {
  comparison: SchemeComparison;
  eligibility: SchemeEligibilityRow[];
}

/**
 * Convenience builder that produces both halves of the response in one
 * call. The eligibility lookup is pluggable so the route can substitute a
 * mock during tests.
 */
export async function buildComparisonWithEligibility(
  schemes: ReadonlyArray<Scheme>,
  resolveEligibility: (
    schemeId: string,
  ) => Promise<EligibilityResult | null>,
): Promise<SchemeComparisonWithEligibility> {
  const comparison = buildSchemeComparison(schemes);
  const eligibility = await Promise.all(
    schemes.map(async (s) => ({
      schemeId: s.id,
      eligibility: await resolveEligibility(s.id),
    })),
  );
  return { comparison, eligibility };
}
