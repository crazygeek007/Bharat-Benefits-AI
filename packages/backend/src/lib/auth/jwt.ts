/**
 * JWT signing and verification helpers.
 *
 * Tokens are HMAC-SHA256 signed using the secret configured via the
 * `JWT_SECRET` (or `NEXTAUTH_SECRET`) environment variable. Sessions enforce a
 * 30-minute inactivity timeout aligned with the platform's session policy
 * (Requirement 16.5, see `SESSION_TIMEOUT_MINUTES` in @bharat-benefits/shared).
 */

import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { SESSION_TIMEOUT_MINUTES } from '@bharat-benefits/shared';

/** Default token lifetime in seconds derived from the session timeout. */
export const DEFAULT_TOKEN_TTL_SECONDS = SESSION_TIMEOUT_MINUTES * 60;

/**
 * Minimum acceptable length (bytes) for the HS256 signing secret.
 *
 * RFC 8725 §3.2 recommends "the key MUST be at least as many bits as the
 * size of the hash output" — for HS256 that's 256 bits = 32 bytes.
 */
export const MIN_SECRET_LENGTH_BYTES = 32;

/**
 * Known placeholder strings shipped in `.env.example`. The application
 * refuses to start when any of these are used as the actual secret so a
 * forgotten "fill in the blank" never reaches production.
 */
const KNOWN_PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  'change-me-in-production-use-a-32-byte-random-string',
  'REPLACE_ME_WITH_A_RANDOM_32_BYTE_SECRET',
]);

/** Claims included in every issued access token. */
export interface AuthTokenClaims extends JwtPayload {
  /** Subject — the user's id. */
  sub: string;
  /** User's email address. */
  email: string;
  /** Authentication provider (e.g. "credentials", "google"). */
  authProvider?: string;
}

/**
 * Reads the JWT signing secret from the environment.
 *
 * Throws when the secret is missing, shorter than the HS256 minimum (32
 * bytes / 256 bits) or matches a known placeholder. Surfacing the
 * configuration error here means a misconfigured deployment fails fast at
 * the first auth call rather than running with a weak signing key.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_SECRET (or NEXTAUTH_SECRET) must be set in the environment',
    );
  }
  if (KNOWN_PLACEHOLDER_SECRETS.has(secret)) {
    throw new Error(
      'JWT_SECRET is using the .env.example placeholder. Generate a real secret with `node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"`.',
    );
  }
  // Use byte length, not string length — non-ASCII secrets pass length
  // checks visually but may not meet the required entropy floor.
  const byteLength = Buffer.byteLength(secret, 'utf8');
  if (byteLength < MIN_SECRET_LENGTH_BYTES) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_SECRET_LENGTH_BYTES} bytes (got ${byteLength}). ` +
        'Generate a stronger secret with `node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"`.',
    );
  }
  return secret;
}

/**
 * Signs an access token containing the provided claims.
 *
 * `expiresInSeconds` defaults to `DEFAULT_TOKEN_TTL_SECONDS` (30 minutes).
 */
export function signAuthToken(
  claims: Omit<AuthTokenClaims, 'iat' | 'exp'>,
  expiresInSeconds: number = DEFAULT_TOKEN_TTL_SECONDS,
  secret: string = getJwtSecret(),
): string {
  const options: SignOptions = {
    algorithm: 'HS256',
    expiresIn: expiresInSeconds,
  };
  return jwt.sign(claims, secret, options);
}

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

/**
 * Verifies a JWT and returns its claims. Throws `InvalidTokenError` for any
 * verification failure (expired, malformed, bad signature, missing claims).
 */
export function verifyAuthToken(
  token: string,
  secret: string = getJwtSecret(),
): AuthTokenClaims {
  if (typeof token !== 'string' || token.length === 0) {
    throw new InvalidTokenError('Token is missing or empty');
  }
  let decoded: string | JwtPayload;
  try {
    decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (err) {
    throw new InvalidTokenError(
      err instanceof Error ? err.message : 'Token verification failed',
    );
  }
  if (typeof decoded === 'string' || !decoded || typeof decoded.sub !== 'string') {
    throw new InvalidTokenError('Token payload missing required `sub` claim');
  }
  if (typeof (decoded as AuthTokenClaims).email !== 'string') {
    throw new InvalidTokenError('Token payload missing required `email` claim');
  }
  return decoded as AuthTokenClaims;
}

/**
 * Extracts a bearer token from an HTTP `Authorization` header value.
 * Returns the token string or `null` if the header is absent or malformed.
 */
export function extractBearerToken(authHeader: string | undefined | null): string | null {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}
