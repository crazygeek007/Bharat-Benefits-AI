/**
 * AES-256-GCM encryption helpers for sensitive user profile data at rest.
 *
 * Provides authenticated encryption (confidentiality + integrity) using the
 * platform's master key configured via the `PROFILE_ENCRYPTION_KEY`
 * environment variable. The master key must be a 32-byte value supplied as
 * either:
 *   - 64 hex characters, or
 *   - 44 base64 characters (32 raw bytes), or
 *   - exactly 32 raw characters.
 *
 * Validates: Requirement 16.3 (AES-256 encryption at rest).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM uses a 12-byte (96-bit) nonce per recommendation. */
const NONCE_LENGTH_BYTES = 12;
/** Authentication tag length for GCM (128-bit). */
const AUTH_TAG_LENGTH_BYTES = 16;
/** AES-256 requires a 32-byte (256-bit) key. */
const KEY_LENGTH_BYTES = 32;
/** Algorithm identifier for Node's crypto module. */
const ALGORITHM = 'aes-256-gcm';

/** Envelope of an encrypted payload, base64-encoded for storage. */
export interface EncryptedPayload {
  /** Algorithm marker so we can rotate algorithms in the future. */
  alg: 'aes-256-gcm';
  /** Base64-encoded 12-byte nonce. */
  nonce: string;
  /** Base64-encoded 16-byte GCM authentication tag. */
  tag: string;
  /** Base64-encoded ciphertext. */
  ciphertext: string;
}

/**
 * Reads the configured master encryption key from the environment.
 * Throws if the key is missing or not exactly 32 bytes once decoded.
 */
export function getEncryptionKey(): Buffer {
  const raw = process.env.PROFILE_ENCRYPTION_KEY;
  if (!raw || raw.length === 0) {
    throw new Error(
      'PROFILE_ENCRYPTION_KEY env var must be set (32 raw bytes, 64-char hex, or 44-char base64)',
    );
  }
  return decodeKey(raw);
}

/**
 * Decodes a key string in any of the supported encodings into a 32-byte buffer.
 */
export function decodeKey(raw: string): Buffer {
  // Try hex first.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // Try base64 (44 chars typically encodes 32 bytes).
  if (/^[A-Za-z0-9+/]{43}=?$/.test(raw)) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === KEY_LENGTH_BYTES) return buf;
  }
  // Fallback: raw 32-character string (not recommended for production).
  if (raw.length === KEY_LENGTH_BYTES) {
    return Buffer.from(raw, 'utf8');
  }
  throw new Error(
    `PROFILE_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH_BYTES} bytes`,
  );
}

/**
 * Generates a fresh 32-byte AES-256 key. Useful for tests and key bootstrap
 * tooling. The returned buffer can be base64- or hex-encoded for storage.
 */
export function generateEncryptionKey(): Buffer {
  return randomBytes(KEY_LENGTH_BYTES);
}

/**
 * Encrypts a UTF-8 plaintext string using AES-256-GCM with a fresh nonce.
 * Returns a structured envelope suitable for JSON storage.
 */
export function encrypt(plaintext: string, key: Buffer = getEncryptionKey()): EncryptedPayload {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt requires a string plaintext');
  }
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`Encryption key must be exactly ${KEY_LENGTH_BYTES} bytes`);
  }
  const nonce = randomBytes(NONCE_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'aes-256-gcm',
    nonce: nonce.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

/**
 * Decrypts a payload produced by `encrypt`. Throws if the authentication tag
 * does not match (i.e. the ciphertext or associated data has been tampered
 * with), or if the envelope is malformed.
 */
export function decrypt(payload: EncryptedPayload, key: Buffer = getEncryptionKey()): string {
  if (!payload || payload.alg !== 'aes-256-gcm') {
    throw new Error('Unsupported or missing encryption algorithm');
  }
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`Encryption key must be exactly ${KEY_LENGTH_BYTES} bytes`);
  }

  const nonce = Buffer.from(payload.nonce, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');

  if (nonce.length !== NONCE_LENGTH_BYTES) {
    throw new Error(`Nonce must decode to ${NONCE_LENGTH_BYTES} bytes`);
  }
  if (tag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error(`Auth tag must decode to ${AUTH_TAG_LENGTH_BYTES} bytes`);
  }

  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Encrypts an arbitrary JSON-serialisable value. Convenience wrapper around
 * `encrypt(JSON.stringify(...))`.
 */
export function encryptJson(value: unknown, key?: Buffer): EncryptedPayload {
  return encrypt(JSON.stringify(value), key);
}

/**
 * Decrypts a payload and JSON-parses the plaintext. Throws if either step
 * fails.
 */
export function decryptJson<T = unknown>(payload: EncryptedPayload, key?: Buffer): T {
  return JSON.parse(decrypt(payload, key)) as T;
}
