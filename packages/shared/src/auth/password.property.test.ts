/**
 * Property-based tests for password policy validation.
 *
 * **Property 23: Password Policy Validation**
 * **Validates: Requirements 16.2**
 *
 * For any password string, the validation function SHALL accept the password
 * if and only if:
 *   (a) length is between 8 and 128 characters inclusive,
 *   (b) it contains at least one uppercase letter,
 *   (c) it contains at least one lowercase letter,
 *   (d) it contains at least one digit, and
 *   (e) it contains at least one special character.
 * All other passwords SHALL be rejected.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { validatePassword, isPasswordValid } from './password';
import { PASSWORD_POLICY } from '../types';

// ─── Helpers mirroring the validator's character-class semantics ─────────────
//
// The validator uses `ch >= 'A' && ch <= 'Z'`, `ch >= 'a' && ch <= 'z'`, and
// `ch >= '0' && ch <= '9'` for upper/lower/digit, and treats any non-whitespace
// character that is not a Latin letter or digit as "special".

const hasUpper = (s: string): boolean => /[A-Z]/.test(s);
const hasLower = (s: string): boolean => /[a-z]/.test(s);
const hasDigit = (s: string): boolean => /[0-9]/.test(s);

const hasSpecial = (s: string): boolean => {
  for (const ch of s) {
    if (/\s/.test(ch)) continue;
    if (/[A-Za-z0-9]/.test(ch)) continue;
    return true;
  }
  return false;
};

const meetsAllRules = (s: string): boolean =>
  s.length >= PASSWORD_POLICY.minLength &&
  s.length <= PASSWORD_POLICY.maxLength &&
  hasUpper(s) &&
  hasLower(s) &&
  hasDigit(s) &&
  hasSpecial(s);

// ─── Generators ──────────────────────────────────────────────────────────────

/** Single character generators for each character class. */
const upperChar = fc.constantFrom(
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
);
const lowerChar = fc.constantFrom(
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),
);
const digitChar = fc.constantFrom(
  ...Array.from({ length: 10 }, (_, i) => String.fromCharCode(48 + i)),
);
// A representative set of ASCII special characters that the validator accepts.
const specialChar = fc.constantFrom(
  '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '-', '_', '=', '+',
  '[', ']', '{', '}', '|', '\\', ':', ';', "'", '"', ',', '.', '<', '>',
  '/', '?', '`', '~',
);

/** Filler characters drawn from any of the four classes. */
const fillerChar = fc.oneof(upperChar, lowerChar, digitChar, specialChar);

/**
 * Generates a password guaranteed to satisfy ALL five conditions:
 *   - length in [8, 128]
 *   - at least one upper, lower, digit, and special character
 *
 * Strategy: pick one mandatory char from each class, fill remaining length
 * with arbitrary class chars, then shuffle the resulting array.
 */
const validPassword = fc
  .tuple(
    upperChar,
    lowerChar,
    digitChar,
    specialChar,
    fc.array(fillerChar, {
      minLength: PASSWORD_POLICY.minLength - 4,
      maxLength: PASSWORD_POLICY.maxLength - 4,
    }),
  )
  .chain(([u, l, d, s, filler]) => {
    const chars = [u, l, d, s, ...filler];
    return fc.shuffledSubarray(chars, { minLength: chars.length, maxLength: chars.length });
  })
  .map((chars) => chars.join(''));

/** Generates a password whose length is below the minimum (0 to 7). */
const tooShortPassword = fc
  .array(fillerChar, { minLength: 0, maxLength: PASSWORD_POLICY.minLength - 1 })
  .map((chars) => chars.join(''));

/** Generates a password whose length is above the maximum (129 to ~256). */
const tooLongPassword = fc
  .array(fillerChar, {
    minLength: PASSWORD_POLICY.maxLength + 1,
    maxLength: PASSWORD_POLICY.maxLength + 128,
  })
  .map((chars) => chars.join(''));

/**
 * Builds a generator that produces a password missing one specific character
 * class, while satisfying all other rules (length and the remaining classes).
 */
const passwordMissing = (excludedClass: 'upper' | 'lower' | 'digit' | 'special') => {
  const required: Array<typeof upperChar> = [];
  const filler: Array<typeof upperChar> = [];

  if (excludedClass !== 'upper') {
    required.push(upperChar);
    filler.push(upperChar);
  }
  if (excludedClass !== 'lower') {
    required.push(lowerChar);
    filler.push(lowerChar);
  }
  if (excludedClass !== 'digit') {
    required.push(digitChar);
    filler.push(digitChar);
  }
  if (excludedClass !== 'special') {
    required.push(specialChar);
    filler.push(specialChar);
  }

  // We need at least 3 required chars (one from each remaining class) plus
  // filler to reach the minimum length.
  const fillerGen = fc.oneof(...filler);
  return fc
    .tuple(
      ...required,
      fc.array(fillerGen, {
        minLength: PASSWORD_POLICY.minLength - required.length,
        // Cap at a reasonable size to keep tests fast.
        maxLength: 64 - required.length,
      }),
    )
    .chain((parts) => {
      const requiredChars = parts.slice(0, required.length) as string[];
      const fillerChars = parts[parts.length - 1] as string[];
      const all = [...requiredChars, ...fillerChars];
      return fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length });
    })
    .map((chars) => chars.join(''));
};

const noUpperPassword = passwordMissing('upper');
const noLowerPassword = passwordMissing('lower');
const noDigitPassword = passwordMissing('digit');
const noSpecialPassword = passwordMissing('special');

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Property 23: Password Policy Validation', () => {
  // 1. Bidirectional property — the heart of the "if and only if".
  it('isPasswordValid is equivalent to the conjunction of all five rules', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (s) => {
        expect(isPasswordValid(s)).toBe(meetsAllRules(s));
      }),
      { numRuns: 200 },
    );
  });

  // 2. Acceptance property — any password satisfying all five rules is valid.
  it('accepts every password that satisfies all five rules', () => {
    fc.assert(
      fc.property(validPassword, (pwd) => {
        // Sanity check the generator itself.
        expect(meetsAllRules(pwd)).toBe(true);

        const result = validatePassword(pwd);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  // 3a. Rejection — too short.
  it('rejects every password shorter than minLength with a too_short error', () => {
    fc.assert(
      fc.property(tooShortPassword, (pwd) => {
        expect(pwd.length).toBeLessThan(PASSWORD_POLICY.minLength);
        const result = validatePassword(pwd);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('too_short');
      }),
      { numRuns: 200 },
    );
  });

  // 3b. Rejection — too long.
  it('rejects every password longer than maxLength with a too_long error', () => {
    fc.assert(
      fc.property(tooLongPassword, (pwd) => {
        expect(pwd.length).toBeGreaterThan(PASSWORD_POLICY.maxLength);
        const result = validatePassword(pwd);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('too_long');
      }),
      { numRuns: 100 },
    );
  });

  // 3c. Rejection — missing uppercase.
  it('rejects every password missing an uppercase letter with missing_uppercase', () => {
    fc.assert(
      fc.property(noUpperPassword, (pwd) => {
        expect(hasUpper(pwd)).toBe(false);
        const result = validatePassword(pwd);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('missing_uppercase');
      }),
      { numRuns: 200 },
    );
  });

  // 3d. Rejection — missing lowercase.
  it('rejects every password missing a lowercase letter with missing_lowercase', () => {
    fc.assert(
      fc.property(noLowerPassword, (pwd) => {
        expect(hasLower(pwd)).toBe(false);
        const result = validatePassword(pwd);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('missing_lowercase');
      }),
      { numRuns: 200 },
    );
  });

  // 3e. Rejection — missing digit.
  it('rejects every password missing a digit with missing_digit', () => {
    fc.assert(
      fc.property(noDigitPassword, (pwd) => {
        expect(hasDigit(pwd)).toBe(false);
        const result = validatePassword(pwd);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('missing_digit');
      }),
      { numRuns: 200 },
    );
  });

  // 3f. Rejection — missing special character.
  it('rejects every password missing a special character with missing_special_char', () => {
    fc.assert(
      fc.property(noSpecialPassword, (pwd) => {
        expect(hasSpecial(pwd)).toBe(false);
        const result = validatePassword(pwd);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('missing_special_char');
      }),
      { numRuns: 200 },
    );
  });

  // 4. Boundary check — exactly at minLength and maxLength are accepted.
  it('accepts boundary lengths exactly at minLength and maxLength', () => {
    fc.assert(
      fc.property(
        fc.tuple(upperChar, lowerChar, digitChar, specialChar),
        ([u, l, d, s]) => {
          const baseChars = [u, l, d, s];
          const minPad = 'a'.repeat(PASSWORD_POLICY.minLength - 4);
          const maxPad = 'a'.repeat(PASSWORD_POLICY.maxLength - 4);

          const minPwd = baseChars.join('') + minPad;
          const maxPwd = baseChars.join('') + maxPad;

          expect(minPwd.length).toBe(PASSWORD_POLICY.minLength);
          expect(maxPwd.length).toBe(PASSWORD_POLICY.maxLength);

          expect(isPasswordValid(minPwd)).toBe(true);
          expect(isPasswordValid(maxPwd)).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});
