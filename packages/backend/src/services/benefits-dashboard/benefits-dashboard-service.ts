/**
 * Benefits Dashboard Service — aggregates a citizen's saved schemes into the
 * status-grouped Benefits_Dashboard view, calculates the Estimated Total
 * Benefit Value, and exposes the save / mark-as-applied lifecycle operations.
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 10.1.
 *
 * Responsibilities:
 *   - Group saved schemes into Eligible / Applied / Saved / Expired buckets
 *     (Req 11.1, 11.4) and surface counts per bucket (Req 11.5).
 *   - Calculate the Estimated Total Benefit Value as the sum of monetary
 *     benefit amounts of Eligible schemes only — non-monetary or schemes
 *     missing a quantifiable amount are excluded (Req 11.2, 11.6).
 *   - Move a scheme to the Applied bucket and pin it there regardless of
 *     deadline status when the citizen marks it as applied (Req 11.3).
 *   - Save a scheme to the dashboard while enforcing the 100-scheme cap
 *     (Req 10.1).
 *   - Expose an empty-state-friendly Dashboard for citizens with no saved
 *     schemes (Req 11.7) — buckets are empty arrays and counts are zero so
 *     the UI can render an encouragement message.
 *
 * The pure helpers `transitionStatuses` and `calculateEstimatedBenefitValue`
 * are exported for reuse by Property tests 16 and 17 (tasks 12.2 and 12.3) so
 * the universal grouping / valuation invariants can be exercised without a
 * database.
 *
 * The `missedBenefitsSummary` field is filled by the optional
 * `MissedBenefitsAnalyzer` dependency (Task 14.3 / Req 15.5). When no
 * analyzer is injected the service falls back to a deterministic
 * placeholder (zero counts, empty schemes list) so downstream consumers
 * can rely on a non-null shape.
 */

import {
  MAX_SAVED_SCHEMES,
  type Dashboard,
  type EligibilityResult,
  type MissedBenefitsSummary,
  type SavedScheme,
  type Scheme,
  type SchemeStatus,
  type SchemeWithStatus,
} from '@bharat-benefits/shared';
import prismaDefault from '../../lib/prisma';
import { EligibilityEngine } from '../eligibility';
import type { MissedBenefitsAnalyzer } from '../missed-benefits';

// ─── Pure helpers (exported for property tests 12.2 / 12.3) ─────────────────

/**
 * A saved scheme paired with the scheme record itself. Used by callers that
 * have already joined the two and want to avoid a redundant lookup.
 */
export interface SavedSchemeWithScheme {
  saved: SavedScheme;
  scheme: Scheme;
}

/**
 * Determines the dashboard status for a single saved scheme.
 *
 * Status precedence (Req 11.1, 11.3, 11.4):
 *   1. `Applied` — set when the citizen has marked the scheme applied
 *      (`appliedAt` is non-null OR persisted status is already `Applied`).
 *      Applied schemes stay in this bucket regardless of deadline (Req 11.3).
 *   2. `Expired` — set when the scheme's deadline has passed and the
 *      citizen has not marked it applied (Req 11.4).
 *   3. `Eligible` — set when the eligibility result for this scheme is
 *      `Eligible` and the deadline (if any) has not passed.
 *   4. `Saved` — fallback for schemes the citizen saved but is not yet
 *      eligible for (e.g. Partially Eligible or Not Eligible) and whose
 *      deadline has not passed.
 *
 * The function is pure (no I/O, no exceptions for normal inputs) and is the
 * sole source of truth for status transitions consumed by `getDashboard`.
 */
export function deriveStatus(
  saved: Pick<SavedScheme, 'status' | 'appliedAt'>,
  scheme: Pick<Scheme, 'deadline'>,
  eligibility: EligibilityResult | undefined,
  now: Date,
): SchemeStatus {
  // Applied is a one-way latch: citizen explicitly marked the scheme as
  // applied so we keep it in the Applied bucket regardless of deadline
  // (Req 11.3).
  if (saved.status === 'Applied' || saved.appliedAt !== null) {
    return 'Applied';
  }

  // Deadline-driven expiry (Req 11.4). A scheme without a deadline is treated
  // as rolling/no-deadline and never expires through this path (Req 10.7's
  // "Open/No Deadline" semantics align with that — the dashboard simply
  // surfaces the scheme under Eligible / Saved).
  if (scheme.deadline !== null && scheme.deadline.getTime() < now.getTime()) {
    return 'Expired';
  }

  // Eligibility-driven grouping. Without an eligibility result we cannot
  // promote the scheme to Eligible, so it stays in the Saved bucket.
  if (eligibility?.status === 'Eligible') {
    return 'Eligible';
  }

  return 'Saved';
}

/**
 * Pure helper that re-derives the dashboard status of every saved scheme
 * from the current eligibility map and wall-clock time. Returns a copy of
 * each input row with `status` (and, where appropriate, `appliedAt`)
 * synchronised to the derived value.
 *
 * `eligibilityResults` is keyed by `schemeId`. Rows without a matching key
 * fall through to the default branches in `deriveStatus`.
 *
 * Validates: Requirements 11.1, 11.3, 11.4, 11.5.
 */
export function transitionStatuses(
  savedSchemes: SavedSchemeWithScheme[],
  eligibilityResults: Map<string, EligibilityResult>,
  now: Date,
): SavedScheme[] {
  return savedSchemes.map(({ saved, scheme }) => {
    const status = deriveStatus(
      saved,
      scheme,
      eligibilityResults.get(scheme.id),
      now,
    );
    return {
      ...saved,
      status,
    };
  });
}

/**
 * Pure helper that computes the Estimated Total Benefit Value (in INR) for a
 * set of schemes that the dashboard has classified as Eligible.
 *
 * Per Req 11.2 and 11.6 the value is the sum of monetary benefit amounts.
 * Schemes are excluded from the sum when:
 *   - `benefitType` is not `monetary`, OR
 *   - `benefitAmount` is null / undefined / non-finite / negative.
 *
 * The helper is deliberately tolerant of malformed scheme records — a single
 * unparseable amount must not poison the running total or throw.
 *
 * Validates: Requirements 11.2, 11.6.
 */
export function calculateEstimatedBenefitValue(
  eligibleSchemes: ReadonlyArray<Pick<Scheme, 'benefitType' | 'benefitAmount'>>,
): number {
  let total = 0;
  for (const scheme of eligibleSchemes) {
    if (scheme.benefitType !== 'monetary') continue;
    const amount = scheme.benefitAmount;
    if (amount === null || amount === undefined) continue;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) continue;
    total += amount;
  }
  return total;
}

/**
 * Pure helper that computes the Estimated Total Benefit Value over a list of
 * dashboard rows tagged with their derived `SchemeStatus`.
 *
 * Whereas `calculateEstimatedBenefitValue` assumes every input is already in
 * the Eligible bucket, this helper performs the bucket filter itself —
 * schemes whose status is not `Eligible` (i.e. Applied / Saved / Expired)
 * are excluded from the sum even when their `benefitType === 'monetary'`.
 *
 * This is the function exercised by Property 17: it lets the property test
 * vary the status across the full domain `{Eligible, Applied, Saved,
 * Expired}` while still observing the same monetary-only invariant.
 *
 * Validates: Requirements 11.2, 11.6.
 */
export function computeEstimatedBenefitValue(
  schemes: ReadonlyArray<{
    status: SchemeStatus;
    benefitType: 'monetary' | 'non-monetary';
    benefitAmount: number | null;
  }>,
): number {
  return calculateEstimatedBenefitValue(
    schemes.filter((s) => s.status === 'Eligible'),
  );
}

/** Empty MissedBenefitsSummary — populated by Task 14.3 once available. */
function emptyMissedBenefitsSummary(): MissedBenefitsSummary {
  return {
    totalCount: 0,
    totalMonetaryValue: 0,
    schemes: [],
  };
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown by `saveScheme` when the citizen has already saved
 * `MAX_SAVED_SCHEMES` schemes (Req 10.1). The HTTP layer is expected to
 * translate this into a 409 Conflict with a citizen-friendly message.
 */
export class SavedSchemeLimitExceededError extends Error {
  readonly limit: number;
  constructor(limit: number = MAX_SAVED_SCHEMES) {
    super(
      `Cannot save scheme — citizen has already saved the maximum of ${limit} schemes`,
    );
    this.name = 'SavedSchemeLimitExceededError';
    this.limit = limit;
  }
}

/** Thrown when `markAsApplied` / `saveScheme` cannot find the target scheme. */
export class SchemeNotFoundError extends Error {
  readonly schemeId: string;
  constructor(schemeId: string) {
    super(`Scheme not found: ${schemeId}`);
    this.name = 'SchemeNotFoundError';
    this.schemeId = schemeId;
  }
}

/**
 * Thrown by `markAsApplied` when the citizen does not have the target scheme
 * saved on their dashboard.
 */
export class SavedSchemeNotFoundError extends Error {
  constructor(userId: string, schemeId: string) {
    super(`No saved scheme found for userId=${userId} schemeId=${schemeId}`);
    this.name = 'SavedSchemeNotFoundError';
  }
}

// ─── Prisma surface ──────────────────────────────────────────────────────────

/**
 * Minimal Prisma client surface used by the service. Declared structurally so
 * unit tests can supply an in-memory fake without depending on the generated
 * Prisma types.
 */
export interface BenefitsDashboardPrisma {
  savedScheme: {
    findMany(args: {
      where: { userId: string };
      include?: { scheme: true };
    }): Promise<Array<SavedScheme & { scheme: Scheme }>>;

    count(args: { where: { userId: string } }): Promise<number>;

    findUnique(args: {
      where: { uq_user_saved_scheme: { userId: string; schemeId: string } };
    }): Promise<SavedScheme | null>;

    create(args: {
      data: {
        userId: string;
        schemeId: string;
        status: SchemeStatus;
        savedAt: Date;
        appliedAt: Date | null;
      };
    }): Promise<SavedScheme>;

    update(args: {
      where: { uq_user_saved_scheme: { userId: string; schemeId: string } };
      data: Partial<Pick<SavedScheme, 'status' | 'appliedAt'>>;
    }): Promise<SavedScheme>;
  };
  scheme: {
    findUnique(args: { where: { id: string } }): Promise<Scheme | null>;
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

/** Dependencies injected into the BenefitsDashboardService. */
export interface BenefitsDashboardServiceDeps {
  prisma?: BenefitsDashboardPrisma;
  eligibilityEngine?: Pick<EligibilityEngine, 'recalculateAllSavedSchemes'>;
  /**
   * Optional missed-benefits analyzer. When supplied, `getDashboard`
   * populates `missedBenefitsSummary` from it (Req 15.5). When absent the
   * dashboard falls back to a zeroed summary so the response shape stays
   * stable for callers / tests that don't care about missed benefits.
   */
  missedBenefitsAnalyzer?: Pick<MissedBenefitsAnalyzer, 'getSummary'>;
  /** Override for the wall clock — primarily for deterministic tests. */
  now?: () => Date;
}

/**
 * Service producing the Benefits_Dashboard view for a citizen and managing
 * the save / apply lifecycle.
 */
export class BenefitsDashboardService {
  private readonly prisma: BenefitsDashboardPrisma;
  private readonly eligibilityEngine: Pick<
    EligibilityEngine,
    'recalculateAllSavedSchemes'
  >;
  private readonly missedBenefitsAnalyzer:
    | Pick<MissedBenefitsAnalyzer, 'getSummary'>
    | undefined;
  private readonly now: () => Date;

  constructor(deps: BenefitsDashboardServiceDeps = {}) {
    this.prisma =
      deps.prisma ?? (prismaDefault as unknown as BenefitsDashboardPrisma);
    this.eligibilityEngine = deps.eligibilityEngine ?? new EligibilityEngine();
    this.missedBenefitsAnalyzer = deps.missedBenefitsAnalyzer;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Builds the full Benefits_Dashboard for a citizen.
   *
   * Empty-state semantics (Req 11.7): when the citizen has no saved schemes
   * the returned dashboard has empty arrays for every bucket, a zero
   * `estimatedTotalBenefitValue`, and a zeroed `missedBenefitsSummary`. The
   * UI uses this shape to render the "discover schemes" empty state.
   */
  async getDashboard(userId: string): Promise<Dashboard> {
    if (!userId) {
      throw new TypeError('userId is required to build the benefits dashboard');
    }

    const rows = await this.prisma.savedScheme.findMany({
      where: { userId },
      include: { scheme: true },
    });

    if (rows.length === 0) {
      return {
        eligible: [],
        applied: [],
        saved: [],
        expired: [],
        estimatedTotalBenefitValue: 0,
        missedBenefitsSummary: await this.resolveMissedBenefitsSummary(userId),
        counts: { eligible: 0, applied: 0, saved: 0, expired: 0 },
      };
    }

    // Recalculate eligibility once for every saved scheme. The eligibility
    // engine already enforces the 30-second SLA for up to MAX_SAVED_SCHEMES
    // (100) entries (Req 3.3).
    let eligibilityResults: Map<string, EligibilityResult>;
    try {
      const calculated =
        await this.eligibilityEngine.recalculateAllSavedSchemes(userId);
      eligibilityResults = new Map(
        calculated.map((entry) => [entry.schemeId, entry.result]),
      );
    } catch {
      // If eligibility cannot be computed (e.g. profile missing) we still
      // surface a useful dashboard — schemes simply can't be promoted to the
      // Eligible bucket and stay under Saved.
      eligibilityResults = new Map();
    }

    const now = this.now();
    const eligible: SchemeWithStatus[] = [];
    const applied: SchemeWithStatus[] = [];
    const saved: SchemeWithStatus[] = [];
    const expired: SchemeWithStatus[] = [];

    for (const row of rows) {
      const status = deriveStatus(
        { status: row.status, appliedAt: row.appliedAt },
        { deadline: row.scheme.deadline },
        eligibilityResults.get(row.schemeId),
        now,
      );
      const entry: SchemeWithStatus = {
        scheme: row.scheme,
        status,
        savedAt: row.savedAt,
        appliedAt: row.appliedAt,
      };

      switch (status) {
        case 'Eligible':
          eligible.push(entry);
          break;
        case 'Applied':
          applied.push(entry);
          break;
        case 'Expired':
          expired.push(entry);
          break;
        case 'Saved':
        default:
          saved.push(entry);
          break;
      }
    }

    const estimatedTotalBenefitValue = calculateEstimatedBenefitValue(
      eligible.map((entry) => entry.scheme),
    );

    return {
      eligible,
      applied,
      saved,
      expired,
      estimatedTotalBenefitValue,
      missedBenefitsSummary: await this.resolveMissedBenefitsSummary(userId),
      counts: {
        eligible: eligible.length,
        applied: applied.length,
        saved: saved.length,
        expired: expired.length,
      },
    };
  }

  /**
   * Resolve the `missedBenefitsSummary` shown on the Benefits_Dashboard
   * (Req 15.5). Delegates to the injected analyzer when available; falls
   * back to a zeroed summary otherwise. Errors are swallowed so a
   * misbehaving analyzer cannot break the dashboard.
   */
  private async resolveMissedBenefitsSummary(
    userId: string,
  ): Promise<MissedBenefitsSummary> {
    if (!this.missedBenefitsAnalyzer) return emptyMissedBenefitsSummary();
    try {
      return await this.missedBenefitsAnalyzer.getSummary(userId);
    } catch {
      // Analyzer failure must not poison the dashboard render — fall back
      // to the empty summary and let upstream observability surface the
      // underlying error.
      return emptyMissedBenefitsSummary();
    }
  }

  /**
   * Marks a saved scheme as Applied (Req 11.3). The scheme must already be
   * saved by the citizen — the operation never silently creates a
   * SavedScheme record.
   *
   * Idempotent: calling with an already-applied scheme leaves the persisted
   * `appliedAt` timestamp unchanged so dashboards remain stable across
   * retries.
   */
  async markAsApplied(userId: string, schemeId: string): Promise<void> {
    if (!userId) throw new TypeError('userId is required');
    if (!schemeId) throw new TypeError('schemeId is required');

    const existing = await this.prisma.savedScheme.findUnique({
      where: { uq_user_saved_scheme: { userId, schemeId } },
    });
    if (!existing) {
      throw new SavedSchemeNotFoundError(userId, schemeId);
    }

    if (existing.status === 'Applied' && existing.appliedAt !== null) {
      // Idempotent — already applied, nothing to do.
      return;
    }

    await this.prisma.savedScheme.update({
      where: { uq_user_saved_scheme: { userId, schemeId } },
      data: {
        status: 'Applied',
        appliedAt: existing.appliedAt ?? this.now(),
      },
    });
  }

  /**
   * Saves a scheme to the citizen's dashboard.
   *
   * Enforces the 100-scheme cap (Req 10.1) — a citizen attempting to save a
   * 101st scheme triggers `SavedSchemeLimitExceededError`. Re-saving a
   * scheme that is already on the dashboard is idempotent and does not
   * count toward the limit.
   */
  async saveScheme(userId: string, schemeId: string): Promise<void> {
    if (!userId) throw new TypeError('userId is required');
    if (!schemeId) throw new TypeError('schemeId is required');

    // Idempotency check first so duplicate saves don't unnecessarily count
    // against the cap or cause a unique-constraint violation.
    const existing = await this.prisma.savedScheme.findUnique({
      where: { uq_user_saved_scheme: { userId, schemeId } },
    });
    if (existing) {
      return;
    }

    // Confirm the scheme exists before counting / inserting so we surface a
    // clear error rather than a foreign-key violation from Prisma.
    const scheme = await this.prisma.scheme.findUnique({ where: { id: schemeId } });
    if (!scheme) {
      throw new SchemeNotFoundError(schemeId);
    }

    const currentCount = await this.prisma.savedScheme.count({
      where: { userId },
    });
    if (currentCount >= MAX_SAVED_SCHEMES) {
      throw new SavedSchemeLimitExceededError();
    }

    await this.prisma.savedScheme.create({
      data: {
        userId,
        schemeId,
        status: 'Saved',
        savedAt: this.now(),
        appliedAt: null,
      },
    });
  }

  /**
   * Pure helper exposed on the service for parity with the design-doc
   * interface and for use by Property test 17 (task 12.3). Sums monetary
   * benefit amounts of the supplied (already-Eligible) schemes.
   */
  calculateEstimatedBenefitValue(
    eligibleSchemes: ReadonlyArray<Pick<Scheme, 'benefitType' | 'benefitAmount'>>,
  ): number {
    return calculateEstimatedBenefitValue(eligibleSchemes);
  }
}

/** Default singleton suitable for HTTP handlers and downstream services. */
export const benefitsDashboardService = new BenefitsDashboardService();
