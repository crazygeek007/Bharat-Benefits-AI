/**
 * Password hashing utilities using bcrypt.
 *
 * Hashes are produced with a configurable cost factor (default 12). Salts are
 * managed by bcrypt internally and embedded in the produced hash.
 *
 * Re-exports `validatePassword` from the shared package so backend consumers
 * have a single import surface for password operations.
 */

import bcrypt from 'bcryptjs';

export {
  validatePassword,
  isPasswordValid,
  PASSWORD_REJECTION_MESSAGES,
  type PasswordValidationResult,
  type PasswordRejectionReason,
} from '@bharat-benefits/shared';

/** Default bcrypt cost factor. 12 is a sensible default for production. */
export const DEFAULT_BCRYPT_ROUNDS = 12;

/**
 * Hashes a plaintext password using bcrypt.
 */
export async function hashPassword(
  plaintext: string,
  rounds: number = DEFAULT_BCRYPT_ROUNDS,
): Promise<string> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TypeError('hashPassword requires a non-empty string');
  }
  return bcrypt.hash(plaintext, rounds);
}

/**
 * Verifies a plaintext password against a previously stored bcrypt hash.
 *
 * Returns `false` for any non-string input or malformed hash; never throws
 * for ordinary mismatches.
 */
export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  if (typeof plaintext !== 'string' || typeof hash !== 'string' || hash.length === 0) {
    return false;
  }
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}
