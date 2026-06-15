/**
 * Unit tests for the Scheme Browser filter helpers.
 *
 * Validates: Requirements 2.2, 2.3, 2.4.
 *
 * Covers:
 *   - `applySchemeFilters` returns the empty array for empty input.
 *   - Each individual filter dimension narrows results correctly.
 *   - Combining filters applies AND semantics (Requirement 2.3).
 *   - `getGovernmentLevel` derives Central vs State (Requirement 2.4).
 */

import { describe, it, expect } from 'vitest';
import type { EligibilityCriterion, Scheme, SchemeCategory } from '@bharat-benefits/shared';
import {
  applySchemeFilters,
  countActiveFilters,
  criterionAllowsValue,
  getGovernmentLevel,
} from './scheme-filter';

// ─── Test fixtures ───────────────────────────────────────────────────────────

function criterion(
  field: string,
  operator: EligibilityCriterion['operator'],
  value: unknown,
  description = `${field} ${operator} ${JSON.stringify(value)}`,
): EligibilityCriterion {
  return { field, operator, value, description };
}

let schemeCounter = 0;
function makeScheme(overrides: Partial<Scheme> = {}): Scheme {
  schemeCounter += 1;
  return {
    id: `scheme-${schemeCounter}`,
    name: `Scheme ${schemeCounter}`,
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

// ─── getGovernmentLevel ──────────────────────────────────────────────────────

describe('getGovernmentLevel', () => {
  it('returns "Central" when scheme.state is null', () => {
    const scheme = makeScheme({ state: null });
    expect(getGovernmentLevel(scheme)).toBe('Central');
  });

  it('returns "State" when scheme.state is a non-empty string', () => {
    const scheme = makeScheme({ state: 'Karnataka' });
    expect(getGovernmentLevel(scheme)).toBe('State');
  });

  it('treats an empty-string state as Central (defensive parsing)', () => {
    const scheme = makeScheme({ state: '' });
    expect(getGovernmentLevel(scheme)).toBe('Central');
  });
});

// ─── applySchemeFilters: degenerate inputs ───────────────────────────────────

describe('applySchemeFilters — degenerate inputs', () => {
  it('returns an empty array when given an empty scheme list', () => {
    expect(applySchemeFilters([], {})).toEqual([]);
    expect(applySchemeFilters([], { category: 'Education' })).toEqual([]);
  });

  it('returns the full list when no filters are active', () => {
    const a = makeScheme({ category: 'Education' });
    const b = makeScheme({ category: 'Healthcare' });
    expect(applySchemeFilters([a, b], {})).toEqual([a, b]);
  });
});

// ─── applySchemeFilters: individual dimensions ───────────────────────────────

describe('applySchemeFilters — single filter dimensions', () => {
  it('filters by category', () => {
    const edu = makeScheme({ category: 'Education' });
    const ag = makeScheme({ category: 'Agriculture' });
    const result = applySchemeFilters([edu, ag], { category: 'Education' });
    expect(result).toEqual([edu]);
  });

  it('filters by benefitType', () => {
    const monetary = makeScheme({ benefitType: 'monetary' });
    const nonMonetary = makeScheme({ benefitType: 'non-monetary' });
    const result = applySchemeFilters([monetary, nonMonetary], {
      benefitType: 'non-monetary',
    });
    expect(result).toEqual([nonMonetary]);
  });

  it('filters by state — Central schemes are always included alongside the state', () => {
    const central = makeScheme({ state: null });
    const karnataka = makeScheme({ state: 'Karnataka' });
    const tamilNadu = makeScheme({ state: 'Tamil Nadu' });
    const result = applySchemeFilters([central, karnataka, tamilNadu], {
      state: 'Karnataka',
    });
    expect(result).toEqual([central, karnataka]);
  });

  it('filters by income level using lte criterion', () => {
    // Eligible up to 200k income.
    const lowIncomeOnly = makeScheme({
      eligibilityCriteria: [criterion('income', 'lte', 200_000)],
    });
    // No income restriction at all → always passes.
    const unrestricted = makeScheme({ eligibilityCriteria: [] });
    // Eligible only above 500k.
    const highIncomeOnly = makeScheme({
      eligibilityCriteria: [criterion('income', 'gte', 500_000)],
    });

    const result = applySchemeFilters([lowIncomeOnly, unrestricted, highIncomeOnly], {
      incomeLevel: 250_000,
    });
    expect(result).toEqual([unrestricted]);
  });

  it('filters by age using between criterion', () => {
    const youth = makeScheme({
      eligibilityCriteria: [criterion('age', 'between', [18, 35])],
    });
    const senior = makeScheme({
      eligibilityCriteria: [criterion('age', 'gte', 60)],
    });
    const open = makeScheme({ eligibilityCriteria: [] });

    expect(applySchemeFilters([youth, senior, open], { age: 25 })).toEqual([
      youth,
      open,
    ]);
    expect(applySchemeFilters([youth, senior, open], { age: 65 })).toEqual([
      senior,
      open,
    ]);
  });

  it('filters by gender using eq criterion', () => {
    const womenOnly = makeScheme({
      eligibilityCriteria: [criterion('gender', 'eq', 'Female')],
    });
    const open = makeScheme({ eligibilityCriteria: [] });

    expect(applySchemeFilters([womenOnly, open], { gender: 'Female' })).toEqual([
      womenOnly,
      open,
    ]);
    expect(applySchemeFilters([womenOnly, open], { gender: 'Male' })).toEqual([open]);
  });

  it('filters by occupation using in criterion', () => {
    const farmersAndUnemployed = makeScheme({
      eligibilityCriteria: [criterion('occupation', 'in', ['Farmer', 'Unemployed'])],
    });
    const open = makeScheme({ eligibilityCriteria: [] });

    expect(
      applySchemeFilters([farmersAndUnemployed, open], { occupation: 'Farmer' }),
    ).toEqual([farmersAndUnemployed, open]);
    expect(
      applySchemeFilters([farmersAndUnemployed, open], { occupation: 'Salaried' }),
    ).toEqual([open]);
  });
});

// ─── applySchemeFilters: AND logic (Requirement 2.3) ─────────────────────────

describe('applySchemeFilters — AND logic across multiple filters', () => {
  it('requires every active filter to pass', () => {
    const target = makeScheme({
      state: 'Karnataka',
      category: 'Agriculture',
      benefitType: 'monetary',
      eligibilityCriteria: [
        criterion('age', 'gte', 18),
        criterion('income', 'lte', 500_000),
        criterion('occupation', 'eq', 'Farmer'),
      ],
    });
    const wrongCategory = makeScheme({
      state: 'Karnataka',
      category: 'Education',
      benefitType: 'monetary',
    });
    const wrongState = makeScheme({
      state: 'Tamil Nadu',
      category: 'Agriculture',
      benefitType: 'monetary',
    });
    const ageRestricted = makeScheme({
      state: 'Karnataka',
      category: 'Agriculture',
      benefitType: 'monetary',
      eligibilityCriteria: [criterion('age', 'gte', 65)],
    });

    const result = applySchemeFilters(
      [target, wrongCategory, wrongState, ageRestricted],
      {
        state: 'Karnataka',
        category: 'Agriculture',
        benefitType: 'monetary',
        age: 25,
        incomeLevel: 200_000,
        occupation: 'Farmer',
      },
    );
    expect(result).toEqual([target]);
  });

  it('returns no schemes when AND logic excludes everything', () => {
    const a = makeScheme({ category: 'Education', benefitType: 'monetary' });
    const b = makeScheme({ category: 'Healthcare', benefitType: 'non-monetary' });
    // No scheme is both Education AND non-monetary.
    expect(
      applySchemeFilters([a, b], { category: 'Education', benefitType: 'non-monetary' }),
    ).toEqual([]);
  });

  it('AND logic is commutative — filter ordering does not affect outcome', () => {
    const a = makeScheme({
      state: 'Karnataka',
      category: 'Education',
      benefitType: 'monetary',
    });
    const b = makeScheme({
      state: 'Tamil Nadu',
      category: 'Education',
      benefitType: 'monetary',
    });
    const c = makeScheme({
      state: 'Karnataka',
      category: 'Healthcare',
      benefitType: 'non-monetary',
    });

    const f1 = { state: 'Karnataka', category: 'Education' as SchemeCategory };
    const f2 = { category: 'Education' as SchemeCategory, state: 'Karnataka' };
    expect(applySchemeFilters([a, b, c], f1)).toEqual(
      applySchemeFilters([a, b, c], f2),
    );
  });
});

// ─── criterionAllowsValue ────────────────────────────────────────────────────

describe('criterionAllowsValue', () => {
  it('handles all defined operators', () => {
    expect(criterionAllowsValue(criterion('x', 'eq', 5), 5)).toBe(true);
    expect(criterionAllowsValue(criterion('x', 'eq', 5), 4)).toBe(false);

    expect(criterionAllowsValue(criterion('x', 'neq', 5), 4)).toBe(true);
    expect(criterionAllowsValue(criterion('x', 'neq', 5), 5)).toBe(false);

    expect(criterionAllowsValue(criterion('x', 'gt', 5), 6)).toBe(true);
    expect(criterionAllowsValue(criterion('x', 'gt', 5), 5)).toBe(false);

    expect(criterionAllowsValue(criterion('x', 'gte', 5), 5)).toBe(true);
    expect(criterionAllowsValue(criterion('x', 'lt', 5), 4)).toBe(true);
    expect(criterionAllowsValue(criterion('x', 'lte', 5), 5)).toBe(true);

    expect(criterionAllowsValue(criterion('x', 'in', [1, 2, 3]), 2)).toBe(true);
    expect(criterionAllowsValue(criterion('x', 'in', [1, 2, 3]), 4)).toBe(false);

    expect(criterionAllowsValue(criterion('x', 'between', [1, 10]), 5)).toBe(true);
    expect(criterionAllowsValue(criterion('x', 'between', [1, 10]), 11)).toBe(false);
  });

  it('does case-insensitive string equality for eq/neq/in', () => {
    expect(criterionAllowsValue(criterion('g', 'eq', 'Female'), 'female')).toBe(true);
    expect(
      criterionAllowsValue(criterion('o', 'in', ['Farmer', 'Student']), 'student'),
    ).toBe(true);
  });
});

// ─── countActiveFilters ──────────────────────────────────────────────────────

describe('countActiveFilters', () => {
  it('counts only defined filter keys', () => {
    expect(countActiveFilters({})).toBe(0);
    expect(countActiveFilters({ category: 'Education' })).toBe(1);
    expect(
      countActiveFilters({ state: 'Karnataka', category: 'Education', age: 25 }),
    ).toBe(3);
  });
});
