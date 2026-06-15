/**
 * Unit tests for password policy validation.
 *
 * Validates: Requirement 16.2
 *
 * Note: a dedicated property-based test for password validation is implemented
 * in task 2.2. This file contains representative example tests.
 */

import { describe, it, expect } from 'vitest';
import { validatePassword, isPasswordValid, PASSWORD_REJECTION_MESSAGES } from './password';

describe('validatePassword', () => {
  it('accepts a strong password meeting all rules', () => {
    const result = validatePassword('Str0ng!Pass');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects passwords shorter than 8 characters', () => {
    const result = validatePassword('Aa1!');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('too_short');
  });

  it('rejects passwords longer than 128 characters', () => {
    const long = 'A1a!' + 'a'.repeat(130);
    const result = validatePassword(long);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('too_long');
  });

  it('rejects passwords missing an uppercase letter', () => {
    const result = validatePassword('weakpass1!');
    expect(result.errors).toContain('missing_uppercase');
  });

  it('rejects passwords missing a lowercase letter', () => {
    const result = validatePassword('WEAKPASS1!');
    expect(result.errors).toContain('missing_lowercase');
  });

  it('rejects passwords missing a digit', () => {
    const result = validatePassword('WeakPass!!');
    expect(result.errors).toContain('missing_digit');
  });

  it('rejects passwords missing a special character', () => {
    const result = validatePassword('WeakPass11');
    expect(result.errors).toContain('missing_special_char');
  });

  it('rejects non-string inputs', () => {
    expect(validatePassword(undefined).valid).toBe(false);
    expect(validatePassword(null).valid).toBe(false);
    expect(validatePassword(12345).valid).toBe(false);
    expect(validatePassword({} as unknown).valid).toBe(false);
  });

  it('accepts a password exactly 8 characters long', () => {
    expect(isPasswordValid('Aa1!aaaa')).toBe(true);
  });

  it('accepts a password exactly 128 characters long', () => {
    const pwd = 'A1a!' + 'a'.repeat(124);
    expect(pwd.length).toBe(128);
    expect(isPasswordValid(pwd)).toBe(true);
  });

  it('treats whitespace as not a special character', () => {
    const result = validatePassword('Weak Pass 1');
    expect(result.errors).toContain('missing_special_char');
  });

  it('exposes human-readable rejection messages', () => {
    expect(PASSWORD_REJECTION_MESSAGES.too_short).toContain('8');
    expect(PASSWORD_REJECTION_MESSAGES.too_long).toContain('128');
  });
});
