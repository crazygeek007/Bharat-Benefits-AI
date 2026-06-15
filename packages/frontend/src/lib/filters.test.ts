/**
 * Unit tests for the frontend filter parsers.
 *
 * Validates: Requirements 2.2, 2.3.
 *
 * Covers: parsing valid filters, rejecting invalid filter values,
 * pagination defaults.
 */

import { describe, it, expect } from 'vitest';
import {
  parseFiltersFromSearchParams,
  parsePageFromSearchParams,
} from './filters';
import { buildSchemeQueryString } from './api';

describe('parseFiltersFromSearchParams', () => {
  it('returns an empty object for an empty input', () => {
    expect(parseFiltersFromSearchParams({})).toEqual({});
  });

  it('parses string filters', () => {
    expect(
      parseFiltersFromSearchParams({
        state: 'Karnataka',
        gender: 'Female',
        occupation: 'Farmer',
      }),
    ).toEqual({ state: 'Karnataka', gender: 'Female', occupation: 'Farmer' });
  });

  it('parses numeric filters', () => {
    expect(
      parseFiltersFromSearchParams({ age: '25', incomeLevel: '200000' }),
    ).toEqual({ age: 25, incomeLevel: 200_000 });
  });

  it('rejects unknown categories and benefit types', () => {
    expect(parseFiltersFromSearchParams({ category: 'NotARealCategory' })).toEqual({});
    expect(parseFiltersFromSearchParams({ benefitType: 'cash' })).toEqual({});
  });

  it('accepts canonical categories', () => {
    expect(parseFiltersFromSearchParams({ category: 'Education' })).toEqual({
      category: 'Education',
    });
  });

  it('handles array-valued search params by taking the first entry', () => {
    expect(parseFiltersFromSearchParams({ state: ['Karnataka', 'Tamil Nadu'] })).toEqual({
      state: 'Karnataka',
    });
  });
});

describe('parsePageFromSearchParams', () => {
  it('defaults to 1 when not supplied or invalid', () => {
    expect(parsePageFromSearchParams({})).toBe(1);
    expect(parsePageFromSearchParams({ page: 'abc' })).toBe(1);
    expect(parsePageFromSearchParams({ page: '0' })).toBe(1);
  });

  it('parses valid positive integers', () => {
    expect(parsePageFromSearchParams({ page: '3' })).toBe(3);
    expect(parsePageFromSearchParams({ page: '12' })).toBe(12);
  });
});

describe('buildSchemeQueryString', () => {
  it('returns an empty string when no filters are active', () => {
    expect(buildSchemeQueryString({})).toBe('');
  });

  it('serialises filters in the expected order', () => {
    const qs = buildSchemeQueryString({
      state: 'Karnataka',
      category: 'Education',
      age: 25,
      incomeLevel: 250_000,
    });
    expect(qs).toContain('state=Karnataka');
    expect(qs).toContain('category=Education');
    expect(qs).toContain('age=25');
    expect(qs).toContain('incomeLevel=250000');
  });

  it('omits page=1 and pageSize=20 (the defaults)', () => {
    const qs = buildSchemeQueryString({ category: 'Education' }, { page: 1, pageSize: 20 });
    expect(qs).toBe('category=Education');
  });

  it('includes page when greater than 1', () => {
    const qs = buildSchemeQueryString({}, { page: 3 });
    expect(qs).toBe('page=3');
  });
});
