/**
 * Unit tests for scheme JSON serialization/deserialization.
 *
 * Validates: Requirements 22.3, 22.4
 */

import { describe, it, expect } from 'vitest';
import type { SchemeObject } from '@bharat-benefits/shared';
import {
  areSchemesSemanticallyEqual,
  canonicalize,
  deserializeScheme,
  SchemeDeserializationError,
  serializeScheme,
} from './serialization';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function fullScheme(): SchemeObject {
  return {
    name: 'PM Kisan Samman Nidhi',
    description: 'Income support to all landholding farmers families',
    eligibilityCriteria: [
      {
        field: 'occupation',
        operator: 'eq',
        value: 'Farmer',
        description: 'Must be a landholding farmer',
      },
      {
        field: 'income',
        operator: 'lte',
        value: 200000,
        description: 'Annual income must not exceed 2 lakh INR',
      },
    ],
    benefits: [
      {
        type: 'monetary',
        amount: 6000,
        description: 'Rs. 6000 per year in three equal installments',
      },
    ],
    sourceUrl: 'https://pmkisan.gov.in/',
    ministry: 'Ministry of Agriculture and Farmers Welfare',
    applicationProcess: [
      {
        stepNumber: 1,
        action: 'Visit pmkisan.gov.in and click "New Farmer Registration"',
        expectedOutcome: 'Registration form opens',
      },
      {
        stepNumber: 2,
        action: 'Submit Aadhaar and bank details',
        expectedOutcome: 'Acknowledgement number issued',
      },
    ],
    requiredDocuments: [
      {
        documentName: 'Aadhaar Card',
        description: 'Valid Aadhaar identity document',
        format: 'PDF/JPG',
        required: true,
      },
    ],
    deadline: new Date('2025-12-31T23:59:59.000Z'),
  };
}

function minimalScheme(): SchemeObject {
  return {
    name: 'Minimal Scheme',
    description: 'A minimal valid scheme',
    eligibilityCriteria: [
      { field: 'state', operator: 'eq', value: 'Karnataka', description: 'Must reside in Karnataka' },
    ],
    benefits: [{ type: 'non-monetary', amount: null, description: 'Free training' }],
    sourceUrl: 'https://state.gov.in/scheme',
    ministry: 'State Department',
    applicationProcess: null,
    requiredDocuments: null,
    deadline: null,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('serializeScheme', () => {
  it('produces JSON with keys in lexicographic order at every depth', () => {
    const json = serializeScheme(fullScheme());
    const parsed = JSON.parse(json);

    // Top-level keys
    const topKeys = Object.keys(parsed);
    expect(topKeys).toEqual([...topKeys].sort());

    // Nested object keys (eligibility criterion)
    const critKeys = Object.keys(parsed.eligibilityCriteria[0]);
    expect(critKeys).toEqual([...critKeys].sort());

    // Nested object keys (benefit)
    const benefitKeys = Object.keys(parsed.benefits[0]);
    expect(benefitKeys).toEqual([...benefitKeys].sort());

    // Nested object keys (application step)
    const stepKeys = Object.keys(parsed.applicationProcess[0]);
    expect(stepKeys).toEqual([...stepKeys].sort());

    // Nested object keys (document requirement)
    const docKeys = Object.keys(parsed.requiredDocuments[0]);
    expect(docKeys).toEqual([...docKeys].sort());
  });

  it('serializes Date deadline as an ISO 8601 string', () => {
    const json = serializeScheme(fullScheme());
    const parsed = JSON.parse(json);
    expect(parsed.deadline).toBe('2025-12-31T23:59:59.000Z');
  });

  it('preserves null optional fields', () => {
    const json = serializeScheme(minimalScheme());
    const parsed = JSON.parse(json);
    expect(parsed.applicationProcess).toBeNull();
    expect(parsed.requiredDocuments).toBeNull();
    expect(parsed.deadline).toBeNull();
  });

  it('produces identical output regardless of input key order', () => {
    const a = fullScheme();
    // Reorder top-level by reconstructing with different insertion order.
    const b: SchemeObject = {
      deadline: a.deadline,
      requiredDocuments: a.requiredDocuments,
      applicationProcess: a.applicationProcess,
      ministry: a.ministry,
      sourceUrl: a.sourceUrl,
      benefits: a.benefits,
      eligibilityCriteria: a.eligibilityCriteria,
      description: a.description,
      name: a.name,
    };
    expect(serializeScheme(a)).toBe(serializeScheme(b));
  });
});

describe('deserializeScheme', () => {
  it('round-trips a fully populated scheme', () => {
    const original = fullScheme();
    const json = serializeScheme(original);
    const parsed = deserializeScheme(json);
    expect(areSchemesSemanticallyEqual(original, parsed)).toBe(true);
  });

  it('round-trips a minimal scheme with null optional fields', () => {
    const original = minimalScheme();
    const json = serializeScheme(original);
    const parsed = deserializeScheme(json);
    expect(areSchemesSemanticallyEqual(original, parsed)).toBe(true);
    expect(parsed.applicationProcess).toBeNull();
    expect(parsed.requiredDocuments).toBeNull();
    expect(parsed.deadline).toBeNull();
  });

  it('converts ISO 8601 deadline back to a Date object', () => {
    const json = serializeScheme(fullScheme());
    const parsed = deserializeScheme(json);
    expect(parsed.deadline).toBeInstanceOf(Date);
    expect(parsed.deadline?.getTime()).toBe(new Date('2025-12-31T23:59:59.000Z').getTime());
  });

  it('throws SchemeDeserializationError on malformed JSON', () => {
    expect(() => deserializeScheme('{not json')).toThrow(SchemeDeserializationError);
  });

  it('throws when mandatory field "name" is missing', () => {
    const obj = { ...fullScheme() } as Partial<SchemeObject>;
    delete obj.name;
    const json = JSON.stringify({ ...obj, deadline: obj.deadline?.toISOString() ?? null });
    expect(() => deserializeScheme(json)).toThrow(/name/);
  });

  it('throws when mandatory field "eligibilityCriteria" is missing', () => {
    const obj = fullScheme();
    const broken = JSON.stringify({
      ...obj,
      eligibilityCriteria: undefined,
      deadline: obj.deadline?.toISOString() ?? null,
    });
    expect(() => deserializeScheme(broken)).toThrow(/eligibilityCriteria/);
  });

  it('throws when mandatory field "benefits" has a wrong-typed entry', () => {
    const obj = fullScheme();
    const broken = JSON.stringify({
      ...obj,
      benefits: [{ type: 'invalid', amount: 0, description: 'x' }],
      deadline: obj.deadline?.toISOString() ?? null,
    });
    expect(() => deserializeScheme(broken)).toThrow(/benefits\[0\]\.type/);
  });

  it('throws when deadline is a non-ISO string', () => {
    const obj = fullScheme();
    const broken = JSON.stringify({ ...obj, deadline: 'not-a-date' });
    expect(() => deserializeScheme(broken)).toThrow(/deadline/);
  });
});

describe('round-trip stability', () => {
  it('serialize → parse → serialize produces identical strings (full scheme)', () => {
    const original = fullScheme();
    const first = serializeScheme(original);
    const second = serializeScheme(deserializeScheme(first));
    expect(second).toBe(first);
  });

  it('serialize → parse → serialize produces identical strings (minimal scheme)', () => {
    const original = minimalScheme();
    const first = serializeScheme(original);
    const second = serializeScheme(deserializeScheme(first));
    expect(second).toBe(first);
  });
});

describe('areSchemesSemanticallyEqual', () => {
  it('returns true for a scheme compared with itself', () => {
    const scheme = fullScheme();
    expect(areSchemesSemanticallyEqual(scheme, scheme)).toBe(true);
  });

  it('returns true for round-tripped objects', () => {
    const original = fullScheme();
    const roundTripped = deserializeScheme(serializeScheme(original));
    expect(areSchemesSemanticallyEqual(original, roundTripped)).toBe(true);
  });

  it('returns false when a mandatory string field differs', () => {
    const a = fullScheme();
    const b = { ...fullScheme(), ministry: 'Different Ministry' };
    expect(areSchemesSemanticallyEqual(a, b)).toBe(false);
  });

  it('returns false when deadline differs by even one millisecond', () => {
    const a = fullScheme();
    const b = { ...fullScheme(), deadline: new Date(a.deadline!.getTime() + 1) };
    expect(areSchemesSemanticallyEqual(a, b)).toBe(false);
  });

  it('returns false when benefits array order differs', () => {
    const a: SchemeObject = {
      ...fullScheme(),
      benefits: [
        { type: 'monetary', amount: 100, description: 'A' },
        { type: 'non-monetary', amount: null, description: 'B' },
      ],
    };
    const b: SchemeObject = {
      ...fullScheme(),
      benefits: [
        { type: 'non-monetary', amount: null, description: 'B' },
        { type: 'monetary', amount: 100, description: 'A' },
      ],
    };
    expect(areSchemesSemanticallyEqual(a, b)).toBe(false);
  });

  it('returns true when only optional fields are null on both sides', () => {
    const a = minimalScheme();
    const b = minimalScheme();
    expect(areSchemesSemanticallyEqual(a, b)).toBe(true);
  });
});

describe('canonicalize', () => {
  it('sorts object keys lexicographically', () => {
    const result = canonicalize({ b: 1, a: 2, c: 3 }) as Record<string, number>;
    expect(Object.keys(result)).toEqual(['a', 'b', 'c']);
  });

  it('preserves array order', () => {
    const result = canonicalize([3, 1, 2]) as number[];
    expect(result).toEqual([3, 1, 2]);
  });

  it('recursively canonicalizes nested objects', () => {
    const result = canonicalize({ z: { y: 1, x: 2 }, a: 1 }) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['a', 'z']);
    expect(Object.keys(result.z as Record<string, unknown>)).toEqual(['x', 'y']);
  });

  it('passes primitives and null through unchanged', () => {
    expect(canonicalize(null)).toBeNull();
    expect(canonicalize(42)).toBe(42);
    expect(canonicalize('hello')).toBe('hello');
    expect(canonicalize(true)).toBe(true);
  });
});
