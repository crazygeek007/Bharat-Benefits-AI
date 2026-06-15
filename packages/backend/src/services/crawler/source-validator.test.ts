/**
 * Unit tests for source URL validation, trust score calculation, and
 * citizen-visibility logic.
 *
 * Validates: Requirements 1.1, 1.2, 1.6, 1.7
 *
 * Property-based tests for the same surface live in tasks 5.2 and 5.3 — these
 * tests cover specific examples and edge cases.
 */

import { describe, it, expect } from 'vitest';
import { TRUST_SCORE_CONFIG } from '@bharat-benefits/shared';
import {
  ADDITIONAL_OFFICIAL_DOMAINS,
  RECENT_VERIFICATION_WINDOW_DAYS,
  TRUST_SCORE_WEIGHTS,
  calculateTrustScore,
  isSchemeVisibleToCitizens,
  validateSource,
  type TrustScoreInput,
} from './source-validator';

// ─── validateSource ──────────────────────────────────────────────────────────

describe('validateSource', () => {
  describe('accepted gov.in / nic.in domains', () => {
    it.each([
      'https://gov.in',
      'https://gov.in/',
      'https://gov.in/schemes',
      'https://www.gov.in/',
      'https://scholarships.gov.in/',
      'https://scholarships.gov.in/apply?ref=home',
      'https://nic.in',
      'https://www.nic.in/about',
      'https://state.nic.in/portal',
      'http://gov.in/legacy', // http is also accepted; HTTPS is rewarded by trust score, not validateSource
    ])('accepts %s', (url) => {
      expect(validateSource(url)).toBe(true);
    });
  });

  describe('accepted configured additional official domains', () => {
    it('accepts each configured domain at the apex', () => {
      for (const domain of ADDITIONAL_OFFICIAL_DOMAINS) {
        expect(validateSource(`https://${domain}/`)).toBe(true);
      }
    });

    it('accepts subdomains of configured domains', () => {
      for (const domain of ADDITIONAL_OFFICIAL_DOMAINS) {
        expect(validateSource(`https://state.${domain}/`)).toBe(true);
      }
    });
  });

  describe('rejected domains', () => {
    it.each([
      'https://gov.in.malicious.com/',
      'https://malicious.com/gov.in',
      'https://evilgov.in/',
      'https://nic.in.attacker.io/',
      'https://example.com/',
      'https://google.com/search?q=gov.in',
      'https://india.org/',
      'https://gov.uk/',
    ])('rejects %s', (url) => {
      expect(validateSource(url)).toBe(false);
    });
  });

  describe('malformed and unsupported inputs', () => {
    it.each([
      '',
      'not a url',
      'gov.in', // no scheme
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://gov.in/',
      '://gov.in',
    ])('rejects malformed/unsupported url %s', (url) => {
      expect(validateSource(url)).toBe(false);
    });

    it('rejects non-string inputs', () => {
      expect(validateSource(undefined as unknown as string)).toBe(false);
      expect(validateSource(null as unknown as string)).toBe(false);
      expect(validateSource(123 as unknown as string)).toBe(false);
    });

    it('is case-insensitive on hostname', () => {
      expect(validateSource('https://Scholarships.GOV.IN/apply')).toBe(true);
      expect(validateSource('HTTPS://NIC.IN/')).toBe(true);
    });
  });
});

// ─── calculateTrustScore ─────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function fullyPopulatedScheme(overrides: Partial<TrustScoreInput> = {}): TrustScoreInput {
  return {
    sourceUrl: 'https://scholarships.gov.in/scheme-x',
    ministry: 'Ministry of Education',
    name: 'Scheme X',
    description: 'A welfare scheme',
    eligibilityCriteria: [{ field: 'age', operator: 'gte', value: 18 }],
    benefits: [{ type: 'monetary', amount: 50000, description: 'INR 50,000' }],
    lastVerifiedAt: new Date('2025-01-15T00:00:00Z'),
    ...overrides,
  };
}

describe('calculateTrustScore', () => {
  describe('range and integer guarantees', () => {
    it('returns a value in [0, 100] for a fully-populated gov.in scheme', () => {
      const score = calculateTrustScore(
        fullyPopulatedScheme(),
        new Date('2025-01-20T00:00:00Z'),
      );
      expect(score).toBeGreaterThanOrEqual(TRUST_SCORE_CONFIG.range.min);
      expect(score).toBeLessThanOrEqual(TRUST_SCORE_CONFIG.range.max);
    });

    it('always returns an integer', () => {
      const inputs: TrustScoreInput[] = [
        {},
        { sourceUrl: 'https://gov.in/' },
        fullyPopulatedScheme(),
        { sourceUrl: 'not a url', ministry: 'X' },
      ];
      for (const input of inputs) {
        const score = calculateTrustScore(input, new Date('2025-01-20T00:00:00Z'));
        expect(Number.isInteger(score)).toBe(true);
      }
    });

    it('returns 0 for a fully-empty input', () => {
      expect(calculateTrustScore({})).toBe(0);
    });
  });

  describe('component contributions', () => {
    const now = new Date('2025-01-20T00:00:00Z');

    it('awards the gov-domain weight for gov.in / nic.in / their subdomains', () => {
      const govScore = calculateTrustScore({ sourceUrl: 'http://gov.in/' }, now);
      const nicScore = calculateTrustScore({ sourceUrl: 'http://nic.in/' }, now);
      const subScore = calculateTrustScore({ sourceUrl: 'http://state.gov.in/' }, now);
      // No https, no ministry, no fields → only the gov-domain weight applies.
      expect(govScore).toBe(TRUST_SCORE_WEIGHTS.govDomain);
      expect(nicScore).toBe(TRUST_SCORE_WEIGHTS.govDomain);
      expect(subScore).toBe(TRUST_SCORE_WEIGHTS.govDomain);
    });

    it('does not award the gov-domain weight for non-gov domains', () => {
      const score = calculateTrustScore({ sourceUrl: 'http://example.com/' }, now);
      expect(score).toBe(0);
    });

    it('awards the https weight for https schemes', () => {
      const score = calculateTrustScore({ sourceUrl: 'https://example.com/' }, now);
      expect(score).toBe(TRUST_SCORE_WEIGHTS.https);
    });

    it('awards the ministry weight when ministry is non-empty', () => {
      const score = calculateTrustScore({ ministry: 'Ministry of Health' }, now);
      expect(score).toBe(TRUST_SCORE_WEIGHTS.ministry);
    });

    it('does not award the ministry weight for empty/whitespace ministry', () => {
      expect(calculateTrustScore({ ministry: '' }, now)).toBe(0);
      expect(calculateTrustScore({ ministry: '   ' }, now)).toBe(0);
      expect(calculateTrustScore({ ministry: null }, now)).toBe(0);
    });

    it('awards the recently-verified weight inside the 30-day window', () => {
      const lastVerifiedAt = new Date(now.getTime() - 5 * MS_PER_DAY);
      const score = calculateTrustScore({ lastVerifiedAt }, now);
      expect(score).toBe(TRUST_SCORE_WEIGHTS.recentlyVerified);
    });

    it('treats verification at the 30-day boundary as recent', () => {
      const lastVerifiedAt = new Date(
        now.getTime() - RECENT_VERIFICATION_WINDOW_DAYS * MS_PER_DAY,
      );
      const score = calculateTrustScore({ lastVerifiedAt }, now);
      expect(score).toBe(TRUST_SCORE_WEIGHTS.recentlyVerified);
    });

    it('does not award the recently-verified weight for stale verifications', () => {
      const lastVerifiedAt = new Date(
        now.getTime() - (RECENT_VERIFICATION_WINDOW_DAYS + 1) * MS_PER_DAY,
      );
      const score = calculateTrustScore({ lastVerifiedAt }, now);
      expect(score).toBe(0);
    });

    it('does not award the recently-verified weight for future-dated stamps', () => {
      const lastVerifiedAt = new Date(now.getTime() + MS_PER_DAY);
      const score = calculateTrustScore({ lastVerifiedAt }, now);
      expect(score).toBe(0);
    });

    it('awards the mandatory-fields weight only when all six are present', () => {
      const complete = calculateTrustScore(
        {
          sourceUrl: 'http://example.com/',
          ministry: 'M',
          name: 'N',
          description: 'D',
          eligibilityCriteria: [{}],
          benefits: [{}],
        },
        now,
      );
      // Score = ministry (15) + mandatoryFieldsComplete (10) = 25
      expect(complete).toBe(TRUST_SCORE_WEIGHTS.ministry + TRUST_SCORE_WEIGHTS.mandatoryFieldsComplete);

      const missingDescription = calculateTrustScore(
        {
          sourceUrl: 'http://example.com/',
          ministry: 'M',
          name: 'N',
          eligibilityCriteria: [{}],
          benefits: [{}],
        },
        now,
      );
      // Mandatory bonus dropped → only ministry remains.
      expect(missingDescription).toBe(TRUST_SCORE_WEIGHTS.ministry);
    });

    it('does not award the mandatory-fields weight when criteria/benefits are empty arrays', () => {
      const score = calculateTrustScore(
        {
          sourceUrl: 'http://example.com/',
          ministry: 'M',
          name: 'N',
          description: 'D',
          eligibilityCriteria: [],
          benefits: [],
        },
        now,
      );
      // Only ministry counts.
      expect(score).toBe(TRUST_SCORE_WEIGHTS.ministry);
    });
  });

  describe('end-to-end scoring scenarios', () => {
    const now = new Date('2025-01-20T00:00:00Z');

    it('produces a high score for a complete recently-verified gov.in scheme', () => {
      const scheme = fullyPopulatedScheme({
        lastVerifiedAt: new Date(now.getTime() - 7 * MS_PER_DAY),
      });
      const score = calculateTrustScore(scheme, now);
      // 40 (gov) + 20 (https) + 15 (ministry) + 15 (recent) + 10 (fields) = 100
      expect(score).toBe(100);
      expect(isSchemeVisibleToCitizens(score)).toBe(true);
    });

    it('produces a low score for a scheme missing core data', () => {
      const score = calculateTrustScore(
        {
          sourceUrl: 'https://example.com/',
          // no ministry, no fields, no verification stamp
        },
        now,
      );
      // 0 (non-gov) + 20 (https) = 20
      expect(score).toBe(20);
      expect(isSchemeVisibleToCitizens(score)).toBe(false);
    });

    it('produces zero for completely empty input', () => {
      expect(calculateTrustScore({}, now)).toBe(0);
    });

    it('handles malformed source URLs gracefully', () => {
      const score = calculateTrustScore(
        { sourceUrl: 'not a url', ministry: 'M' },
        now,
      );
      // No domain or https credit; only ministry.
      expect(score).toBe(TRUST_SCORE_WEIGHTS.ministry);
    });
  });
});

// ─── isSchemeVisibleToCitizens ───────────────────────────────────────────────

describe('isSchemeVisibleToCitizens', () => {
  it('returns true at the threshold (60)', () => {
    expect(isSchemeVisibleToCitizens(TRUST_SCORE_CONFIG.minimumForDisplay)).toBe(true);
  });

  it('returns false just below the threshold (59)', () => {
    expect(isSchemeVisibleToCitizens(TRUST_SCORE_CONFIG.minimumForDisplay - 1)).toBe(false);
  });

  it('returns true above the threshold', () => {
    expect(isSchemeVisibleToCitizens(75)).toBe(true);
    expect(isSchemeVisibleToCitizens(100)).toBe(true);
  });

  it('returns false for low scores', () => {
    expect(isSchemeVisibleToCitizens(0)).toBe(false);
    expect(isSchemeVisibleToCitizens(30)).toBe(false);
  });

  it('returns false for non-finite or non-numeric inputs', () => {
    expect(isSchemeVisibleToCitizens(Number.NaN)).toBe(false);
    expect(isSchemeVisibleToCitizens(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSchemeVisibleToCitizens(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isSchemeVisibleToCitizens('60' as unknown as number)).toBe(false);
    expect(isSchemeVisibleToCitizens(undefined as unknown as number)).toBe(false);
  });
});
