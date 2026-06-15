/**
 * Ingestion Helpers — building the persisted record for a successfully
 * ingested scheme.
 *
 * Per Requirement 1.3:
 *
 *   "When a new Scheme is discovered, THE Crawler_System SHALL store the
 *    official source URL, ministry or department name, date discovered,
 *    last verified date, and Trust_Score."
 *
 * A scheme is considered "successfully ingested" once it has passed
 * {@link enforceMandatoryFields} — at that point its `sourceUrl` and
 * `ministry` are guaranteed to be non-empty strings. This module
 * supplies the remaining metadata (discoveredAt, lastVerifiedAt,
 * Trust_Score) and packages everything into an {@link IngestedRecord}
 * suitable for persistence.
 *
 * The function is pure: it performs no I/O, takes its current time from
 * the caller (so tests are deterministic), and never returns a record
 * with null/missing values for the five metadata fields named in
 * Requirement 1.3. Optional categorisation fields (`category`, `state`)
 * remain explicitly nullable.
 *
 * Validates: Requirement 1.3
 */

import type {
  SchemeCategory,
  SchemeObject,
} from '@bharat-benefits/shared';

import {
  calculateTrustScore,
  isSchemeVisibleToCitizens,
} from './source-validator';

/**
 * Persisted record for a scheme that has cleared mandatory-field
 * enforcement. The five fields named in Requirement 1.3 — `sourceUrl`,
 * `ministry`, `discoveredAt`, `lastVerifiedAt`, `trustScore` — are all
 * non-nullable.
 *
 * `category` and `state` are intentionally nullable: not every scheme
 * advertises a category or a state of issuance, and the absence of one
 * is meaningful information rather than a failure.
 */
export interface IngestedRecord {
  schemeObject: SchemeObject;
  sourceUrl: string;
  ministry: string;
  trustScore: number;
  discoveredAt: Date;
  lastVerifiedAt: Date;
  category: SchemeCategory | null;
  state: string | null;
  verified: boolean;
}

/** Options for {@link buildIngestedRecord}. All fields are optional. */
export interface BuildIngestedRecordOptions {
  /** Explicit discovery date. Defaults to `now` (or new Date() at call time). */
  discoveredAt?: Date;
  /** Explicit last-verified date. Defaults to `now` (or new Date() at call time). */
  lastVerifiedAt?: Date;
  /** Categorisation, if known. */
  category?: SchemeCategory | null;
  /** State of issuance for state schemes; null for Central schemes. */
  state?: string | null;
  /**
   * Reference "current time" used for defaulting timestamps and for
   * computing the recently-verified component of the trust score.
   * Exposed for deterministic testing.
   */
  now?: Date;
}

/**
 * Builds an {@link IngestedRecord} for a scheme that has already passed
 * mandatory-field enforcement.
 *
 * Defaults:
 *   - `discoveredAt`    → `options.discoveredAt` ?? `options.now` ?? `new Date()`
 *   - `lastVerifiedAt`  → `options.lastVerifiedAt` ?? `options.now` ?? `new Date()`
 *   - `category`        → `options.category` ?? null
 *   - `state`           → `options.state`    ?? null
 *
 * The `trustScore` is always computed via {@link calculateTrustScore}
 * and is therefore an integer in
 * [TRUST_SCORE_CONFIG.range.min, TRUST_SCORE_CONFIG.range.max] = [0, 100].
 * `verified` is derived from {@link isSchemeVisibleToCitizens}.
 *
 * Pre-condition: `scheme` must have non-empty `sourceUrl` and
 * `ministry`. This is guaranteed for any scheme that has cleared
 * `enforceMandatoryFields`.
 */
export function buildIngestedRecord(
  scheme: SchemeObject,
  options: BuildIngestedRecordOptions = {},
): IngestedRecord {
  const now = options.now ?? new Date();
  const discoveredAt = options.discoveredAt ?? now;
  const lastVerifiedAt = options.lastVerifiedAt ?? now;

  const trustScore = calculateTrustScore(
    {
      sourceUrl: scheme.sourceUrl,
      ministry: scheme.ministry,
      name: scheme.name,
      description: scheme.description,
      eligibilityCriteria: scheme.eligibilityCriteria,
      benefits: scheme.benefits,
      lastVerifiedAt,
    },
    now,
  );

  return {
    schemeObject: scheme,
    sourceUrl: scheme.sourceUrl,
    ministry: scheme.ministry,
    trustScore,
    discoveredAt,
    lastVerifiedAt,
    category: options.category ?? null,
    state: options.state ?? null,
    verified: isSchemeVisibleToCitizens(trustScore),
  };
}
