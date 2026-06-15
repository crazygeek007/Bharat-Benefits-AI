/**
 * Unit tests for heading hierarchy validation (Requirement 20.5).
 *
 * Validates that the heading hierarchy utility correctly identifies:
 *   - Valid sequential heading structures
 *   - Skipped heading levels
 *   - Missing initial h1
 *   - Multiple h1 elements
 *   - Correct child heading level computation
 */

import { describe, expect, test } from 'vitest';
import {
  validateHeadingHierarchy,
  getChildHeadingLevel,
  type HeadingLevel,
} from './headingHierarchy';

describe('validateHeadingHierarchy', () => {
  test('valid: simple sequential hierarchy h1 → h2 → h3', () => {
    const result = validateHeadingHierarchy([1, 2, 3]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('valid: h1 → h2 → h2 (siblings at same level)', () => {
    const result = validateHeadingHierarchy([1, 2, 2, 2]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('valid: h1 → h2 → h3 → h2 (going back up is allowed)', () => {
    const result = validateHeadingHierarchy([1, 2, 3, 2]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('valid: h1 → h2 → h3 → h4 → h2 (deep then back to section level)', () => {
    const result = validateHeadingHierarchy([1, 2, 3, 4, 2]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('valid: empty array', () => {
    const result = validateHeadingHierarchy([]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('valid: single h1', () => {
    const result = validateHeadingHierarchy([1]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('invalid: first heading is not h1', () => {
    const result = validateHeadingHierarchy([2, 3]);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].message).toContain('First heading should be h1');
    expect(result.issues[0].level).toBe(2);
  });

  test('invalid: skipped level h1 → h3 (missing h2)', () => {
    const result = validateHeadingHierarchy([1, 3]);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain('Heading level skipped');
    expect(result.issues[0].level).toBe(3);
    expect(result.issues[0].previousLevel).toBe(1);
  });

  test('invalid: skipped level h2 → h4 (missing h3)', () => {
    const result = validateHeadingHierarchy([1, 2, 4]);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].index).toBe(2);
    expect(result.issues[0].message).toContain('h2 → h4');
  });

  test('invalid: multiple h1 elements', () => {
    const result = validateHeadingHierarchy([1, 2, 1, 2]);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes('Multiple h1'))).toBe(true);
  });

  test('reports multiple issues', () => {
    // First heading is h2 (not h1), then h2 → h4 (skip)
    const result = validateHeadingHierarchy([2, 4]);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  test('valid: typical page structure h1 → h2 → h3 → h3 → h2 → h3', () => {
    const result = validateHeadingHierarchy([1, 2, 3, 3, 2, 3]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('invalid: h1 → h2 → h3 → h5 (skips h4)', () => {
    const result = validateHeadingHierarchy([1, 2, 3, 5]);
    expect(result.valid).toBe(false);
    expect(result.issues[0].message).toContain('h3 → h5');
  });
});

describe('getChildHeadingLevel', () => {
  test('returns level + 1 for levels 1-5', () => {
    expect(getChildHeadingLevel(1)).toBe(2);
    expect(getChildHeadingLevel(2)).toBe(3);
    expect(getChildHeadingLevel(3)).toBe(4);
    expect(getChildHeadingLevel(4)).toBe(5);
    expect(getChildHeadingLevel(5)).toBe(6);
  });

  test('caps at level 6', () => {
    expect(getChildHeadingLevel(6)).toBe(6);
  });

  test('return type is HeadingLevel', () => {
    const result: HeadingLevel = getChildHeadingLevel(3);
    expect(result).toBe(4);
  });
});
