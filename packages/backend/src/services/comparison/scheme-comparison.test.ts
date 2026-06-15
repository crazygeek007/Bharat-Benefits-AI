/**
 * Unit tests for the scheme comparison service (Requirement 24).
 *
 * Validates: Requirements 24.1, 24.3, 24.4, 24.5, 24.7.
 *
 * Covers:
 *   - id parsing & validation (count + uniqueness)
 *   - canonical-form determinism
 *   - differ detection across attributes
 *   - "Not specified" marker for missing data
 *   - top-level `buildSchemeComparison` shape
 */

import { describe, it, expect } from 'vitest';
import type { Scheme } from '@bharat-benefits/shared';
import {
  MIN_COMPARISON_SCHEMES,
  MAX_COMPARISON_SCHEMES,
  MISSING_VALUE_MARKER,
  COMPARISON_ATTRIBUTE_KEYS,
  TooFewSchemesError,
  TooManySchemesError,
  DuplicateSchemeError,
  parseComparisonIds,
  validateComparisonIds,
  canonicaliseAttribute,
  attributeDiffersAcross,
  buildSchemeComparison,
  buildComparisonWithEligibility,
} from './scheme-comparison';

let counter = 0;
function makeScheme(overrides: Partial<Scheme> = {}): Scheme {
  counter += 1;
  return {
    id: `scheme-${counter}`,
    name: `Scheme ${counter}`,
    description: 'Description',
    ministry: 'Ministry of Test',
    state: null,
    category: 'Education',
    sourceUrl: 'https://example.gov.in/scheme',
    benefitType: 'monetary',
    benefitAmount: 1000,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: null,
    eligibilityCriteria: [],
    benefits: [],
    applicationSteps: null,
    requiredDocuments: null,
    trustScore: 80,
    verified: true,
    discoveredAt: new Date('2024-01-01T00:00:00Z'),
    lastVerifiedAt: new Date('2024-01-02T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

// ─── parseComparisonIds & validateComparisonIds ──────────────────────────────

describe('parseComparisonIds', () => {
  it('parses a comma-separated string', () => {
    expect(parseComparisonIds('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('parses repeated parameter array values', () => {
    expect(parseComparisonIds(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('trims surrounding whitespace and ignores empty entries', () => {
    expect(parseComparisonIds('a, b ,, ')).toEqual(['a', 'b']);
  });

  it('throws TooFewSchemesError when fewer than 2 ids are supplied', () => {
    expect(() => parseComparisonIds('a')).toThrow(TooFewSchemesError);
    expect(() => parseComparisonIds(undefined)).toThrow(TooFewSchemesError);
    expect(() => parseComparisonIds([])).toThrow(TooFewSchemesError);
  });

  it('throws TooManySchemesError when more than 3 ids are supplied (Req 24.3)', () => {
    expect(() => parseComparisonIds('a,b,c,d')).toThrow(TooManySchemesError);
  });

  it('throws DuplicateSchemeError when an id is repeated', () => {
    expect(() => parseComparisonIds('a,b,a')).toThrow(DuplicateSchemeError);
  });
});

describe('validateComparisonIds', () => {
  it('returns the supplied ids unchanged when valid', () => {
    expect(validateComparisonIds(['a', 'b'])).toEqual(['a', 'b']);
    expect(validateComparisonIds(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('exposes minimum/maximum on the thrown errors', () => {
    try {
      validateComparisonIds(['only-one']);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TooFewSchemesError);
      expect((err as TooFewSchemesError).minimum).toBe(MIN_COMPARISON_SCHEMES);
    }
    try {
      validateComparisonIds(['a', 'b', 'c', 'd']);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TooManySchemesError);
      expect((err as TooManySchemesError).maximum).toBe(MAX_COMPARISON_SCHEMES);
    }
  });
});

// ─── canonicaliseAttribute ───────────────────────────────────────────────────

describe('canonicaliseAttribute', () => {
  it('returns "Not specified" for missing or empty values (Req 24.7)', () => {
    const scheme = makeScheme({
      eligibilityCriteria: [],
      benefits: [],
      deadline: null,
      requiredDocuments: null,
      applicationSteps: null,
    });
    for (const key of COMPARISON_ATTRIBUTE_KEYS) {
      expect(canonicaliseAttribute(key, scheme)).toBe(MISSING_VALUE_MARKER);
    }
  });

  it('formats deadlines to YYYY-MM-DD for day-precision comparison', () => {
    const a = makeScheme({ deadline: new Date('2025-04-01T08:00:00Z') });
    const b = makeScheme({ deadline: new Date('2025-04-01T20:00:00Z') });
    expect(canonicaliseAttribute('deadline', a)).toBe('2025-04-01');
    expect(canonicaliseAttribute('deadline', b)).toBe('2025-04-01');
  });

  it('canonical form is invariant to ordering for sets (criteria/benefits/docs)', () => {
    const a = makeScheme({
      eligibilityCriteria: [
        { field: 'age', operator: 'gte', value: 18, description: 'Age >= 18' },
        { field: 'state', operator: 'eq', value: 'KA', description: 'State = KA' },
      ],
    });
    const b = makeScheme({
      eligibilityCriteria: [
        { field: 'state', operator: 'eq', value: 'KA', description: 'State = KA' },
        { field: 'age', operator: 'gte', value: 18, description: 'Age >= 18' },
      ],
    });
    expect(canonicaliseAttribute('eligibilityCriteria', a)).toBe(
      canonicaliseAttribute('eligibilityCriteria', b),
    );
  });

  it('preserves order for application steps (intrinsically ordered)', () => {
    const a = makeScheme({
      applicationSteps: [
        { stepNumber: 1, action: 'Visit portal', expectedOutcome: 'Logged in' },
        { stepNumber: 2, action: 'Upload docs', expectedOutcome: 'Submitted' },
      ],
    });
    const b = makeScheme({
      applicationSteps: [
        { stepNumber: 1, action: 'Upload docs', expectedOutcome: 'Submitted' },
        { stepNumber: 2, action: 'Visit portal', expectedOutcome: 'Logged in' },
      ],
    });
    expect(canonicaliseAttribute('applicationProcess', a)).not.toBe(
      canonicaliseAttribute('applicationProcess', b),
    );
  });
});

// ─── attributeDiffersAcross ──────────────────────────────────────────────────

describe('attributeDiffersAcross', () => {
  it('returns false when all schemes share the same canonical value (Req 24.4)', () => {
    const a = makeScheme({ deadline: new Date('2025-05-01T00:00:00Z') });
    const b = makeScheme({ deadline: new Date('2025-05-01T12:00:00Z') });
    expect(attributeDiffersAcross('deadline', [a, b])).toBe(false);
  });

  it('returns true when one scheme differs from the others (Req 24.4)', () => {
    const a = makeScheme({ deadline: new Date('2025-05-01T00:00:00Z') });
    const b = makeScheme({ deadline: new Date('2025-06-01T00:00:00Z') });
    const c = makeScheme({ deadline: new Date('2025-05-01T00:00:00Z') });
    expect(attributeDiffersAcross('deadline', [a, b, c])).toBe(true);
  });

  it('returns false when every scheme is missing the attribute', () => {
    const a = makeScheme({ requiredDocuments: null });
    const b = makeScheme({ requiredDocuments: [] });
    expect(attributeDiffersAcross('requiredDocuments', [a, b])).toBe(false);
  });

  it('returns true when one scheme is missing while another has data', () => {
    const a = makeScheme({ requiredDocuments: null });
    const b = makeScheme({
      requiredDocuments: [
        {
          documentName: 'Aadhaar',
          description: 'National ID',
          format: 'PDF',
          required: true,
        },
      ],
    });
    expect(attributeDiffersAcross('requiredDocuments', [a, b])).toBe(true);
  });

  it('returns false for fewer than 2 schemes (degenerate case)', () => {
    expect(attributeDiffersAcross('deadline', [makeScheme()])).toBe(false);
    expect(attributeDiffersAcross('deadline', [])).toBe(false);
  });
});

// ─── buildSchemeComparison ───────────────────────────────────────────────────

describe('buildSchemeComparison', () => {
  it('produces one attribute row per supported attribute, in declared order', () => {
    const a = makeScheme({ id: 'a' });
    const b = makeScheme({ id: 'b' });
    const result = buildSchemeComparison([a, b]);
    expect(result.attributes).toHaveLength(COMPARISON_ATTRIBUTE_KEYS.length);
    expect(result.attributes.map((row) => row.attributeName)).toEqual([
      ...COMPARISON_ATTRIBUTE_KEYS,
    ]);
  });

  it('emits one cell per scheme per attribute, preserving input order (Req 24.4)', () => {
    const a = makeScheme({ id: 'a' });
    const b = makeScheme({ id: 'b' });
    const c = makeScheme({ id: 'c' });
    const result = buildSchemeComparison([a, b, c]);
    for (const row of result.attributes) {
      expect(row.values.map((v) => v.schemeId)).toEqual(['a', 'b', 'c']);
    }
  });

  it('flags rows whose canonical values differ across schemes (Req 24.4)', () => {
    const a = makeScheme({
      id: 'a',
      deadline: new Date('2025-05-01T00:00:00Z'),
      benefits: [{ type: 'monetary', amount: 5000, description: 'Cash' }],
    });
    const b = makeScheme({
      id: 'b',
      deadline: new Date('2025-06-01T00:00:00Z'),
      benefits: [{ type: 'monetary', amount: 5000, description: 'Cash' }],
    });
    const result = buildSchemeComparison([a, b]);
    const deadlineRow = result.attributes.find((r) => r.attributeName === 'deadline');
    const benefitsRow = result.attributes.find((r) => r.attributeName === 'benefits');
    expect(deadlineRow?.differs).toBe(true);
    expect(benefitsRow?.differs).toBe(false);
  });

  it('preserves the original Scheme records for the renderer', () => {
    const a = makeScheme({ id: 'a', name: 'Alpha' });
    const b = makeScheme({ id: 'b', name: 'Bravo' });
    const result = buildSchemeComparison([a, b]);
    expect(result.schemes.map((s) => s.id)).toEqual(['a', 'b']);
    expect(result.schemes[0].name).toBe('Alpha');
  });
});

// ─── buildComparisonWithEligibility ──────────────────────────────────────────

describe('buildComparisonWithEligibility', () => {
  it('runs the eligibility resolver once per scheme and returns a row per scheme (Req 24.6)', async () => {
    const a = makeScheme({ id: 'a' });
    const b = makeScheme({ id: 'b' });

    const resolved: string[] = [];
    const result = await buildComparisonWithEligibility([a, b], async (id) => {
      resolved.push(id);
      return {
        status: 'Eligible',
        metCriteria: [],
        unmetCriteria: [],
        unevaluatedCriteria: [],
        missingProfileFields: [],
      };
    });

    expect(resolved.sort()).toEqual(['a', 'b']);
    expect(result.eligibility).toHaveLength(2);
    expect(result.eligibility.map((r) => r.schemeId).sort()).toEqual(['a', 'b']);
    for (const row of result.eligibility) {
      expect(row.eligibility?.status).toBe('Eligible');
    }
  });

  it('passes through null eligibility for schemes without a profile match', async () => {
    const a = makeScheme({ id: 'a' });
    const b = makeScheme({ id: 'b' });
    const result = await buildComparisonWithEligibility([a, b], async () => null);
    expect(result.eligibility.every((row) => row.eligibility === null)).toBe(true);
  });
});
