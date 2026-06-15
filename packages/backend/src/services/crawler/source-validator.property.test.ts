/**
 * Property-based tests for source URL validation.
 *
 * **Property 1: Source URL Validation**
 * **Validates: Requirements 1.1, 1.2**
 *
 * Property statement (from design.md):
 * "For any URL string, the source validation function SHALL accept the URL
 * if and only if its domain ends with `gov.in` or `nic.in` or belongs to
 * the configured list of official ministry/state portals, and SHALL reject
 * all other URLs."
 *
 * The test suite is organized around three groups of properties:
 *
 *   1. Bidirectional iff      — `validateSource` agrees with an independent
 *                               reference predicate on every input.
 *   2. Acceptance properties  — Randomly-generated URLs whose hostnames are
 *                               or are subdomains of an official domain are
 *                               always accepted.
 *   3. Rejection properties   — Spoof patterns, non-http(s) schemes, empty
 *                               and non-string inputs are always rejected.
 *
 * The reference predicate is implemented from the requirement statement
 * with no dependency on the implementation under test, so passing the
 * bidirectional property strongly evidences correctness.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ADDITIONAL_OFFICIAL_DOMAINS,
  validateSource,
} from './source-validator';

// ─── Reference predicate ─────────────────────────────────────────────────────

/**
 * Independent re-statement of the requirement, derived directly from the
 * acceptance criteria and design.md property statement. Used as the oracle
 * for the bidirectional iff property.
 */
function isOfficialUrlByReference(input: unknown): boolean {
  if (typeof input !== 'string' || input.length === 0) return false;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0 || hostname.endsWith('.')) return false;

  const officialDomains = ['gov.in', 'nic.in', ...ADDITIONAL_OFFICIAL_DOMAINS.map((d) => d.toLowerCase())];

  return officialDomains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** A DNS label: 1-20 lowercase letters/digits, must start with a letter. */
const arbLabel = fc
  .stringMatching(/^[a-z][a-z0-9]{0,19}$/);

/** Zero or more leading subdomain labels joined by '.', possibly empty. */
const arbSubdomainPrefix = fc
  .array(arbLabel, { minLength: 0, maxLength: 4 })
  .map((labels) => (labels.length === 0 ? '' : labels.join('.') + '.'));

/** A URL path/query/fragment suffix, possibly empty. */
const arbUrlSuffix = fc.oneof(
  fc.constant(''),
  fc.constant('/'),
  fc.webPath(),
  fc.tuple(fc.webPath(), fc.string({ minLength: 0, maxLength: 16 })).map(
    ([path, q]) => `${path}?q=${encodeURIComponent(q)}`,
  ),
);

const arbHttpOrHttps = fc.constantFrom('http', 'https');

/**
 * URL whose hostname is exactly one of the official apex domains or a
 * randomly-generated subdomain of one. Always with http(s) protocol.
 */
function arbOfficialUrl(apex: string) {
  return fc
    .tuple(arbHttpOrHttps, arbSubdomainPrefix, arbUrlSuffix)
    .map(([scheme, sub, suffix]) => `${scheme}://${sub}${apex}${suffix}`);
}

const arbGovInUrl = arbOfficialUrl('gov.in');
const arbNicInUrl = arbOfficialUrl('nic.in');
const arbAdditionalDomainUrl = fc
  .constantFrom(...ADDITIONAL_OFFICIAL_DOMAINS)
  .chain((domain) => arbOfficialUrl(domain));

/**
 * URL whose hostname does NOT contain `gov.in` or `nic.in` or any of the
 * additional official domains as a suffix on label boundaries. We
 * post-filter with the reference predicate to be safe — fast-check
 * generators are best-effort, the oracle is authoritative.
 */
const arbNonOfficialUrl = fc
  .tuple(
    arbHttpOrHttps,
    arbSubdomainPrefix,
    arbLabel, // base label
    fc.constantFrom('com', 'org', 'net', 'io', 'co', 'uk', 'in', 'us'),
    arbUrlSuffix,
  )
  .map(([scheme, sub, base, tld, suffix]) => `${scheme}://${sub}${base}.${tld}${suffix}`)
  .filter((url) => !isOfficialUrlByReference(url));

/** Spoofing patterns: official domain appears as a subdomain prefix. */
const arbSpoofUrl = fc
  .tuple(
    arbHttpOrHttps,
    fc.constantFrom('gov.in', 'nic.in', ...ADDITIONAL_OFFICIAL_DOMAINS),
    arbLabel,
    fc.constantFrom('com', 'org', 'net', 'io', 'co'),
    arbUrlSuffix,
  )
  .map(
    ([scheme, official, attacker, tld, suffix]) =>
      `${scheme}://${official}.${attacker}.${tld}${suffix}`,
  );

/** "evilgov.in" / "fakenic.in" — official domain glued to another label. */
const arbGluedSpoofUrl = fc
  .tuple(
    arbHttpOrHttps,
    arbLabel,
    fc.constantFrom('gov.in', 'nic.in'),
    arbUrlSuffix,
  )
  .map(([scheme, prefix, official, suffix]) => `${scheme}://${prefix}${official}${suffix}`)
  .filter((url) => !isOfficialUrlByReference(url));

/** Non-http(s) protocol URLs (file://, javascript:, ftp://, ...). */
const arbNonHttpUrl = fc
  .tuple(
    fc.constantFrom('file', 'javascript', 'ftp', 'data', 'gopher', 'ws', 'wss'),
    fc.string({ minLength: 1, maxLength: 32 }),
  )
  .map(([scheme, rest]) => `${scheme}:${rest}`);

/** Non-string inputs and empty strings — always rejected. */
const arbNonStringInput = fc.oneof<fc.Arbitrary<unknown>[]>(
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.float(),
  fc.boolean(),
  fc.array(fc.string()),
  fc.object(),
);

// ─── Property 1: Source URL Validation ───────────────────────────────────────

describe('Property 1: Source URL Validation', () => {
  // ── Bidirectional iff: validateSource ⇔ reference predicate ──────────────

  it('agrees with the reference predicate on randomly-generated URLs (built-in fc.webUrl)', () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        expect(validateSource(url)).toBe(isOfficialUrlByReference(url));
      }),
      { numRuns: 200 },
    );
  });

  it('agrees with the reference predicate on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(validateSource(s)).toBe(isOfficialUrlByReference(s));
      }),
      { numRuns: 200 },
    );
  });

  it('agrees with the reference predicate across a mix of crafted URL shapes', () => {
    const arbAny = fc.oneof(
      arbGovInUrl,
      arbNicInUrl,
      arbAdditionalDomainUrl,
      arbNonOfficialUrl,
      arbSpoofUrl,
      arbGluedSpoofUrl,
      arbNonHttpUrl,
      fc.webUrl(),
    );
    fc.assert(
      fc.property(arbAny, (url) => {
        expect(validateSource(url)).toBe(isOfficialUrlByReference(url));
      }),
      { numRuns: 200 },
    );
  });

  // ── Acceptance properties ─────────────────────────────────────────────────

  it('accepts every gov.in subdomain URL', () => {
    fc.assert(
      fc.property(arbGovInUrl, (url) => {
        expect(validateSource(url)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('accepts every nic.in subdomain URL', () => {
    fc.assert(
      fc.property(arbNicInUrl, (url) => {
        expect(validateSource(url)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('accepts every URL whose host is a configured additional official domain or subdomain thereof', () => {
    fc.assert(
      fc.property(arbAdditionalDomainUrl, (url) => {
        expect(validateSource(url)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  // ── Rejection properties ─────────────────────────────────────────────────

  it('rejects every URL whose host is not gov.in / nic.in / a configured additional domain', () => {
    fc.assert(
      fc.property(arbNonOfficialUrl, (url) => {
        expect(validateSource(url)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects spoof patterns where the official domain is only a subdomain prefix', () => {
    fc.assert(
      fc.property(arbSpoofUrl, (url) => {
        expect(validateSource(url)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects glued-label spoofs such as evilgov.in / fakenic.in', () => {
    fc.assert(
      fc.property(arbGluedSpoofUrl, (url) => {
        expect(validateSource(url)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects every URL with a non-http(s) protocol', () => {
    fc.assert(
      fc.property(arbNonHttpUrl, (url) => {
        expect(validateSource(url)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects empty and non-string inputs', () => {
    expect(validateSource('')).toBe(false);
    fc.assert(
      fc.property(arbNonStringInput, (value) => {
        expect(validateSource(value as unknown as string)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
