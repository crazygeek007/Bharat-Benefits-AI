/**
 * Unit tests for AES-256-GCM encryption helpers.
 *
 * Validates: Requirement 16.3 (AES-256 encryption at rest).
 */

import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  encryptJson,
  decryptJson,
  generateEncryptionKey,
  decodeKey,
} from './encryption';

const KEY = generateEncryptionKey();

describe('AES-256-GCM encryption', () => {
  it('round-trips a UTF-8 string', () => {
    const payload = encrypt('Mehul, age 30, lives in Maharashtra', KEY);
    expect(payload.alg).toBe('aes-256-gcm');
    expect(payload.ciphertext).not.toBe('');
    const recovered = decrypt(payload, KEY);
    expect(recovered).toBe('Mehul, age 30, lives in Maharashtra');
  });

  it('produces a fresh nonce per encryption', () => {
    const a = encrypt('hello', KEY);
    const b = encrypt('hello', KEY);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails decryption with the wrong key', () => {
    const payload = encrypt('secret', KEY);
    const wrongKey = generateEncryptionKey();
    expect(() => decrypt(payload, wrongKey)).toThrow();
  });

  it('fails decryption when the ciphertext is tampered with', () => {
    const payload = encrypt('secret', KEY);
    // Flip the first ciphertext byte.
    const flipped = { ...payload, ciphertext: flipFirstByte(payload.ciphertext) };
    expect(() => decrypt(flipped, KEY)).toThrow();
  });

  it('fails decryption when the auth tag is tampered with', () => {
    const payload = encrypt('secret', KEY);
    const flipped = { ...payload, tag: flipFirstByte(payload.tag) };
    expect(() => decrypt(flipped, KEY)).toThrow();
  });

  it('encryptJson / decryptJson preserves structured data', () => {
    const data = { name: 'Asha', age: 41, dependents: [{ name: 'Kiran', age: 12 }] };
    const payload = encryptJson(data, KEY);
    const recovered = decryptJson<typeof data>(payload, KEY);
    expect(recovered).toEqual(data);
  });

  it('rejects incorrectly sized keys', () => {
    expect(() => decodeKey('too-short')).toThrow();
    expect(() => encrypt('plaintext', Buffer.alloc(16))).toThrow();
  });

  it('decodeKey accepts hex, base64, and 32-char raw forms', () => {
    const hex = KEY.toString('hex');
    expect(decodeKey(hex)).toEqual(KEY);
    const base64 = KEY.toString('base64');
    expect(decodeKey(base64)).toEqual(KEY);
    const raw = 'a'.repeat(32);
    expect(decodeKey(raw).length).toBe(32);
  });
});

function flipFirstByte(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  buf[0] = buf[0] ^ 0xff;
  return buf.toString('base64');
}
