/**
 * Password Policy Validation
 *
 * Validates passwords against the platform's password policy:
 *   - 8 to 128 characters in length (inclusive)
 *   - At least one uppercase letter
 *   - At least one lowercase letter
 *   - At least one digit
 *   - At least one special character
 *
 * Validates: Requirement 16.2
 */

import { PASSWORD_POLICY, type PasswordPolicy } from '../types';

/** Reasons why a password may be rejected. */
export type PasswordRejectionReason =
  | 'too_short'
  | 'too_long'
  | 'missing_uppercase'
  | 'missing_lowercase'
  | 'missing_digit'
  | 'missing_special_char'
  | 'not_a_string';

/** Result of validating a password against the policy. */
export interface PasswordValidationResult {
  valid: boolean;
  errors: PasswordRejectionReason[];
}

/**
 * Character is considered "special" if it is not a letter, digit, or whitespace.
 *
 * This intentionally accepts any printable non-alphanumeric character (e.g.
 * `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, `(`, `)`, `-`, `_`, `=`, `+`, `[`,
 * `]`, `{`, `}`, `|`, `\`, `:`, `;`, `'`, `"`, `,`, `.`, `<`, `>`, `/`, `?`,
 * `` ` ``, `~`, etc.) and unicode punctuation.
 */
function isSpecialChar(ch: string): boolean {
  if (ch.length === 0) return false;
  // Disallow whitespace as a "special" char.
  if (/\s/.test(ch)) return false;
  // Accept any single character that is not a Latin letter or digit.
  return !/[A-Za-z0-9]/.test(ch);
}

/**
 * Validates a password against the configured PasswordPolicy.
 *
 * Returns a result object listing all failing rules. A password is accepted
 * if and only if no rules are violated.
 */
export function validatePassword(
  password: unknown,
  policy: PasswordPolicy = PASSWORD_POLICY,
): PasswordValidationResult {
  const errors: PasswordRejectionReason[] = [];

  if (typeof password !== 'string') {
    return { valid: false, errors: ['not_a_string'] };
  }

  if (password.length < policy.minLength) errors.push('too_short');
  if (password.length > policy.maxLength) errors.push('too_long');

  let hasUpper = false;
  let hasLower = false;
  let hasDigit = false;
  let hasSpecial = false;

  for (const ch of password) {
    if (!hasUpper && ch >= 'A' && ch <= 'Z') hasUpper = true;
    else if (!hasLower && ch >= 'a' && ch <= 'z') hasLower = true;
    else if (!hasDigit && ch >= '0' && ch <= '9') hasDigit = true;
    if (!hasSpecial && isSpecialChar(ch)) hasSpecial = true;
    if (hasUpper && hasLower && hasDigit && hasSpecial) break;
  }

  if (policy.requireUppercase && !hasUpper) errors.push('missing_uppercase');
  if (policy.requireLowercase && !hasLower) errors.push('missing_lowercase');
  if (policy.requireDigit && !hasDigit) errors.push('missing_digit');
  if (policy.requireSpecialChar && !hasSpecial) errors.push('missing_special_char');

  return { valid: errors.length === 0, errors };
}

/**
 * Convenience boolean check for password validity. Useful in form validators
 * and conditional UI logic where the rejection reason is not needed.
 */
export function isPasswordValid(
  password: unknown,
  policy: PasswordPolicy = PASSWORD_POLICY,
): boolean {
  return validatePassword(password, policy).valid;
}

/**
 * Human-readable explanations of each rejection reason. Useful for displaying
 * validation errors to end users.
 */
export const PASSWORD_REJECTION_MESSAGES: Record<PasswordRejectionReason, string> = {
  not_a_string: 'Password must be a string.',
  too_short: `Password must be at least ${PASSWORD_POLICY.minLength} characters long.`,
  too_long: `Password must be at most ${PASSWORD_POLICY.maxLength} characters long.`,
  missing_uppercase: 'Password must contain at least one uppercase letter.',
  missing_lowercase: 'Password must contain at least one lowercase letter.',
  missing_digit: 'Password must contain at least one digit.',
  missing_special_char: 'Password must contain at least one special character.',
};
