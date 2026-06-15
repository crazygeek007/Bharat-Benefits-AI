/**
 * Source URL Validation, Trust Score Calculation, and Citizen Visibility
 *
 * This module is the single source of truth for three closely-coupled
 * concerns of the Crawler_System:
 *
 *  1. {@link validateSource} — accepts a URL iff its host belongs to an
 *     officially-recognized government domain.
 *  2. {@link calculateTrustScore} — assigns an integer Trust_Score in
 *     [0, 100] to a scheme based on source-reliability and completeness
 *     signals.
 *  3. {@link isSchemeVisibleToCitizens} — gates citizen-facing display by
 *     the configured minimum trust score.
 *
 * All three functions are pure, exported, and have no I/O.
 *
 * Validates: Requirements 1.1, 1.2, 1.6, 1.7
 */

import { TRUST_SCORE_CONFIG } from '@bharat-benefits/shared';

// ─── Configurable allow-list ─────────────────────────────────────────────────

/**
 * Configurable list of officially-recognized portal domains that are NOT
 * already covered by `gov.in` or `nic.in`. Subdomains of any listed domain
 * are also accepted.
 *
 * Add ministry-specific or state-portal domains here as they are formally
 * onboarded (e.g. `'pmkisan.gov.in'`, `'mygov.in'`, `'india.gov.in'`).
 */
export const ADDITIONAL_OFFICIAL_DOMAINS: readonly string[] = ['mygov.in', 'india.gov.in'];

// ─── Source URL validation (Requirements 1.1, 1.2) ───────────────────────────

/**
 * Returns true iff `url` is a syntactically valid URL whose hostname is, or
 * is a subdomain of, `gov.in`, `nic.in`, or any domain in
 * {@link ADDITIONAL_OFFICIAL_DOMAINS}.
 *
 * Domain matching is performed on label boundaries to defeat trivial
 * spoofing attempts:
 *   - `scholarships.gov.in`            → accepted
 *   - `state.mygov.in`                 → accepted (configured)
 *   - `gov.in.malicious.com`           → rejected
 *   - `evilgov.in`                     → rejected
 *   - malformed URLs                   → rejected
 */
export function validateSource(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Only http/https schemes are meaningful sources for the crawler. Reject
  // file://, javascript:, ftp:, etc.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0 || hostname.endsWith('.')) {
    return false;
  }

  if (hostMatchesDomain(hostname, 'gov.in') || hostMatchesDomain(hostname, 'nic.in')) {
    return true;
  }

  for (const portal of ADDITIONAL_OFFICIAL_DOMAINS) {
    if (hostMatchesDomain(hostname, portal.toLowerCase())) {
      return true;
    }
  }

  return false;
}

// ─── Trust score (Requirements 1.6, 1.7) ─────────────────────────────────────

/** Days within which a `lastVerifiedAt` is considered "recent". */
export const RECENT_VERIFICATION_WINDOW_DAYS = 30;

/**
 * Score weights — additive components, each contributes its weight when its
 * predicate is satisfied. Final score is clamped to [0, 100] and rounded to
 * an integer.
 */
export const TRUST_SCORE_WEIGHTS = {
  /** +40 if hostname is or ends with gov.in / nic.in. */
  govDomain: 40,
  /** +20 if the source URL uses HTTPS. */
  https: 20,
  /** +15 if the scheme has a non-empty ministry/department name. */
  ministry: 15,
  /** +15 if `lastVerifiedAt` is within the last 30 days. */
  recentlyVerified: 15,
  /** +10 if all six mandatory fields are populated. */
  mandatoryFieldsComplete: 10,
} as const;

/**
 * Minimal input shape required to compute a trust score.
 *
 * The function intentionally accepts a permissive shape so callers can pass
 * a `ProcessedScheme`, a `SchemeObject`, or an ad-hoc partial — only the
 * documented signal fields are read.
 */
export interface TrustScoreInput {
  sourceUrl?: string | null;
  ministry?: string | null;
  lastVerifiedAt?: Date | null;
  name?: string | null;
  description?: string | null;
  eligibilityCriteria?: ReadonlyArray<unknown> | null;
  benefits?: ReadonlyArray<unknown> | null;
}

/**
 * Returns an integer Trust_Score in
 * [{@link TRUST_SCORE_CONFIG.range.min}, {@link TRUST_SCORE_CONFIG.range.max}]
 * for the given scheme input.
 *
 * The function is pure. The optional `now` parameter is exposed for
 * deterministic testing of the "recently verified" signal.
 */
export function calculateTrustScore(scheme: TrustScoreInput, now: Date = new Date()): number {
  let score = 0;

  const parsed = tryParseUrl(scheme.sourceUrl ?? '');

  if (parsed) {
    const hostname = parsed.hostname.toLowerCase();
    if (hostMatchesDomain(hostname, 'gov.in') || hostMatchesDomain(hostname, 'nic.in')) {
      score += TRUST_SCORE_WEIGHTS.govDomain;
    }
    if (parsed.protocol === 'https:') {
      score += TRUST_SCORE_WEIGHTS.https;
    }
  }

  if (isNonEmptyString(scheme.ministry)) {
    score += TRUST_SCORE_WEIGHTS.ministry;
  }

  if (isRecentlyVerified(scheme.lastVerifiedAt, now)) {
    score += TRUST_SCORE_WEIGHTS.recentlyVerified;
  }

  if (hasAllMandatoryFields(scheme)) {
    score += TRUST_SCORE_WEIGHTS.mandatoryFieldsComplete;
  }

  return clampToIntRange(score);
}

// ─── Visibility (Requirement 1.7) ────────────────────────────────────────────

/**
 * Returns true iff a scheme with the given trust score should be visible to
 * citizens, i.e. its score is at least
 * {@link TRUST_SCORE_CONFIG.minimumForDisplay} (currently 60).
 *
 * Non-finite or non-numeric inputs are treated as not visible.
 */
export function isSchemeVisibleToCitizens(trustScore: number): boolean {
  if (typeof trustScore !== 'number' || !Number.isFinite(trustScore)) {
    return false;
  }
  return trustScore >= TRUST_SCORE_CONFIG.minimumForDisplay;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Matches a hostname against an apex domain on label boundaries.
 *
 * `hostMatchesDomain('scholarships.gov.in', 'gov.in')` → true
 * `hostMatchesDomain('gov.in', 'gov.in')`              → true
 * `hostMatchesDomain('evilgov.in', 'gov.in')`          → false
 * `hostMatchesDomain('gov.in.attacker.com', 'gov.in')` → false
 */
function hostMatchesDomain(hostname: string, domain: string): boolean {
  if (hostname === domain) return true;
  return hostname.endsWith(`.${domain}`);
}

function tryParseUrl(url: string): URL | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasAllMandatoryFields(scheme: TrustScoreInput): boolean {
  return (
    isNonEmptyString(scheme.name) &&
    isNonEmptyString(scheme.description) &&
    Array.isArray(scheme.eligibilityCriteria) &&
    scheme.eligibilityCriteria.length > 0 &&
    Array.isArray(scheme.benefits) &&
    scheme.benefits.length > 0 &&
    isNonEmptyString(scheme.sourceUrl) &&
    isNonEmptyString(scheme.ministry)
  );
}

function isRecentlyVerified(lastVerifiedAt: Date | null | undefined, now: Date): boolean {
  if (!(lastVerifiedAt instanceof Date) || Number.isNaN(lastVerifiedAt.getTime())) {
    return false;
  }
  const ageMs = now.getTime() - lastVerifiedAt.getTime();
  // Treat future-dated stamps as "not recent" — safer than rewarding clock
  // skew or bad upstream data.
  if (ageMs < 0) return false;
  const windowMs = RECENT_VERIFICATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return ageMs <= windowMs;
}

function clampToIntRange(score: number): number {
  if (!Number.isFinite(score)) return TRUST_SCORE_CONFIG.range.min;
  const clamped = Math.min(
    TRUST_SCORE_CONFIG.range.max,
    Math.max(TRUST_SCORE_CONFIG.range.min, score),
  );
  return Math.round(clamped);
}
