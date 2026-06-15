/**
 * Zod schemas for credential-based auth routes.
 *
 * The schemas live in a dedicated module so route handlers stay short and
 * the same shape can be reused by tests. Server-side validation is
 * intentionally stricter than the frontend form validation — clients are
 * untrusted, so policy checks (length, character classes) live here.
 */

import { z } from 'zod';

/** Maximum email length per RFC 5321 §4.5.3.1. */
const MAX_EMAIL_LENGTH = 254;

/** Minimum / maximum password length. The full policy lives in the shared
 * `validatePassword` helper which the auth service still calls — this
 * schema only enforces the easy cases. */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

const EmailField = z
  .string()
  .trim()
  .min(1, 'email is required')
  .max(MAX_EMAIL_LENGTH, `email must be ≤ ${MAX_EMAIL_LENGTH} characters`)
  .email('email must be a valid address');

const PasswordField = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, `password must be at most ${MAX_PASSWORD_LENGTH} characters`);

/** `POST /auth/register` and `POST /auth/login` share an identical body. */
export const CredentialsSchema = z.object({
  email: EmailField,
  password: PasswordField,
});

export type CredentialsInput = z.infer<typeof CredentialsSchema>;
