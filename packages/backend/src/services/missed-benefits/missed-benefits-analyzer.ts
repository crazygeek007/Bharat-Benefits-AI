/**
 * Missed Benefits Analyzer — surfaces schemes a citizen was eligible for
 * but failed to apply to before the deadline expired, plus an estimated
 * monetary value of the benefits they let slip.
 *
 * Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6.
 *
 * Responsibilities:
 *   - `identifyMissedSchemes(userId, asOf)` — for every scheme whose
 *     deadline has already passed, check whether the citizen was eligible
 *     and did not mark the scheme `Applied`. Returns the records the UI
 *     renders on the Benefits_Dashboard "Missed" panel (Req 15.1, 15.3).
 *   - `calculateMissedBenefitsValue(missed)` — sum the monetary benefit
 *     amounts of missed schemes. Non-monetary or unparseable values are
 *     excluded (Req 15.2, 15.6).
 *   - `getSummary(userId)` — pack the above into a `MissedBenefitsSummary`
 *     for the dashboard (Req 15.5).
 *   - `notifyOnReopening(schemeId)` — when a previously-missed scheme
 *     reopens (a new cycle / deadline appears), notify every citizen who
 *     missed it via in-app notification + email (Req 15.4).
 *
 * The pure helper `isMissed` is exported so Property test 14.4 can exercise
 * the universal predicate without Prisma / clock mocks.
 *
 * Notes on profile history:
 *   The platform does not retain User_Profile snapshots, so eligibility at
 *   the time of the deadline is approximated by evaluating the citizen's
 *   *current* profile against the scheme's officially published criteria.
 *   This is the convention the task plan calls out — and is sound because
 *   most demographic fields (state, gender, caste, etc.) change rarely; the
 *   approximation only goes wrong when a citizen's age / income / marital
 *   status flips relative to a threshold between deadline and analysis.
 */

import {
  type EligibilityResult,
  type MissedBenefitsSummary,
  type SavedScheme,
  type Scheme,
  type SchemeStatus,
  type UserProfile,
} from '@bharat-benefits/shared';
import {
  EligibilityEngine,
  calculateEligibility,
} from '../eligibility/eligibility-engine';
import type {
  NotificationService,
  OutboundNotification,
} from '../notifications/notification-service';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * One row in the analyzer's missed-schemes output. Carries everything the
 * Benefits_Dashboard "missed" panel needs without forcing a re-join (Req
 * 15.3).
 *
 * `benefitAmount` is `null` for non-monetary schemes (Req 15.6) — those
 * still appear in the missed list with a descriptive label but are excluded
 * from the monetary total.
 */
export interface MissedSchemeRecord {
  schemeId: string;
  schemeName: string;
  benefitAmount: number | null;
  benefitType: 'monetary' | 'non-monetary';
  /** Always set — `isMissed` requires a non-null deadline before flagging. */
  deadline: Date;
  /** Names of the eligibility criteria that the citizen satisfied. */
  metCriteria: string[];
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Pure predicate: is this scheme "missed" relative to `asOf`?
 *
 * Returns true iff *every* one of the following holds:
 *   - The scheme has a fixed deadline that strictly precedes `asOf`
 *     (rolling / "Open / No Deadline" schemes per Req 10.7 are never
 *     missed — there is no window to miss).
 *   - The citizen's saved record (if any) is not in the `Applied` bucket
 *     — i.e. the citizen never marked the scheme applied (Req 15.1).
 *   - The citizen's eligibility result is `Eligible`. Partially Eligible
 *     and Not Eligible are excluded: we cannot honestly say the citizen
 *     "missed" a scheme they would not have qualified for.
 *
 * Pure: depends only on its arguments. Exported for use by Property 25
 * (task 14.4) so the property generator can drive every input dimension.
 */
export function isMissed(
  scheme: { deadline: Date | null },
  savedScheme: { status: SchemeStatus } | null,
  eligibility: { status: EligibilityResult['status'] } | null,
  asOf: Date,
): boolean {
  // Deadline must exist and be strictly in the past.
  const deadline = scheme.deadline;
  if (
    deadline === null ||
    !(deadline instanceof Date) ||
    Number.isNaN(deadline.getTime())
  ) {
    return false;
  }
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) return false;
  if (deadline.getTime() >= asOf.getTime()) return false;

  // Applied citizens have not "missed" anything (Req 15.1).
  if (savedScheme && savedScheme.status === 'Applied') return false;

  // Eligibility gate (Property 25).
  if (!eligibility || eligibility.status !== 'Eligible') return false;

  return true;
}

/**
 * Pure helper: sum the monetary benefit amounts in a list of missed
 * schemes. Schemes with `benefitType !== 'monetary'`, `null` amounts, or
 * non-finite amounts are excluded (Req 15.2, 15.6).
 *
 * Tolerant of malformed input — a single bad amount must not poison the
 * running total or throw.
 */
export function sumMonetaryMissedBenefits(
  missed: ReadonlyArray<Pick<MissedSchemeRecord, 'benefitType' | 'benefitAmount'>>,
): number {
  let total = 0;
  for (const m of missed) {
    if (m.benefitType !== 'monetary') continue;
    const amount = m.benefitAmount;
    if (amount === null || amount === undefined) continue;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) continue;
    total += amount;
  }
  return total;
}

// ─── Prisma surface ──────────────────────────────────────────────────────────

/**
 * Minimal Prisma client surface used by the analyzer. Declared structurally
 * so unit tests can supply an in-memory fake without depending on the
 * generated Prisma types.
 */
export interface MissedBenefitsPrisma {
  scheme: {
    findMany(args?: {
      where?: Record<string, unknown>;
    }): Promise<Scheme[]>;
    findUnique(args: { where: { id: string } }): Promise<Scheme | null>;
  };
  savedScheme: {
    findMany(args: {
      where: { userId?: string; schemeId?: string };
    }): Promise<SavedScheme[]>;
  };
  userProfile: {
    findUnique(args: { where: { userId: string } }): Promise<UserProfile | null>;
  };
}

// ─── Eligibility engine surface ──────────────────────────────────────────────

/**
 * Narrow eligibility-engine surface accepted by the analyzer. Lets tests
 * inject a fake without standing up the real engine, while in production
 * the full `EligibilityEngine` plugs in.
 */
export interface EligibilityCalculator {
  calculateEligibility(profile: UserProfile, scheme: Scheme): EligibilityResult;
}

// ─── Service ─────────────────────────────────────────────────────────────────

/** Dependencies injected into the MissedBenefitsAnalyzer. */
export interface MissedBenefitsAnalyzerDeps {
  prisma: MissedBenefitsPrisma;
  eligibilityEngine?: EligibilityCalculator;
  /** Optional — when omitted, `notifyOnReopening` is a silent no-op. */
  notificationService?: Pick<NotificationService, 'deliverWithRetry'>;
  /**
   * Resolves a citizen's email address for notifications. Defaults to
   * returning an empty string, in which case the email channel
   * short-circuits and the in-app fallback fires (Req 10.8 retry contract
   * inside `NotificationService`).
   */
  recipientEmailFor?: (userId: string) => string | Promise<string>;
}

/**
 * Service that computes a citizen's missed-benefits view and dispatches
 * reopening notifications. Stateless; safe to share across requests.
 */
export class MissedBenefitsAnalyzer {
  private readonly prisma: MissedBenefitsPrisma;
  private readonly eligibilityEngine: EligibilityCalculator;
  private readonly notificationService:
    | Pick<NotificationService, 'deliverWithRetry'>
    | undefined;
  private readonly recipientEmailFor: (
    userId: string,
  ) => string | Promise<string>;

  constructor(deps: MissedBenefitsAnalyzerDeps) {
    if (!deps.prisma) {
      throw new TypeError('MissedBenefitsAnalyzer requires a prisma client');
    }
    this.prisma = deps.prisma;
    // Default to the singleton wrapper around the pure `calculateEligibility`
    // — saves callers from wiring the engine when they only need the pure
    // computation. Prefer DI in tests so we can inject deterministic
    // results.
    this.eligibilityEngine =
      deps.eligibilityEngine ?? new EligibilityEngine();
    this.notificationService = deps.notificationService;
    this.recipientEmailFor = deps.recipientEmailFor ?? (() => '');
  }

  /**
   * Identify every scheme the citizen missed as of `asOf` (default: now).
   *
   * Algorithm:
   *   1. Load the citizen's profile (required — without it we cannot
   *      evaluate eligibility).
   *   2. Load every scheme with a non-null deadline strictly before `asOf`.
   *   3. Load the citizen's saved-scheme map so we can answer "did they
   *      apply?" in O(1) per scheme.
   *   4. For each candidate scheme: run eligibility, then `isMissed`.
   *   5. Collect the survivors into `MissedSchemeRecord` rows.
   *
   * The function is read-only and side-effect free.
   */
  async identifyMissedSchemes(
    userId: string,
    asOf: Date = new Date(),
  ): Promise<MissedSchemeRecord[]> {
    if (!userId) {
      throw new TypeError('userId is required to identify missed schemes');
    }
    if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
      throw new TypeError('asOf must be a valid Date');
    }

    const profile = await this.prisma.userProfile.findUnique({
      where: { userId },
    });
    if (!profile) {
      // No profile → cannot evaluate eligibility → no missed schemes can be
      // honestly identified. Return empty rather than throw so the
      // dashboard can still render an empty-state view.
      return [];
    }

    // Pull every scheme with a fixed past deadline. We deliberately let the
    // caller supply nothing here (some test fakes ignore the where filter)
    // and re-apply the deadline filter in-memory below for safety.
    const schemes = await this.prisma.scheme.findMany({
      where: {
        deadline: { lt: asOf, not: null },
      },
    });

    const savedRows = await this.prisma.savedScheme.findMany({
      where: { userId },
    });
    const savedBySchemeId = new Map<string, SavedScheme>();
    for (const row of savedRows) {
      savedBySchemeId.set(row.schemeId, row);
    }

    const missed: MissedSchemeRecord[] = [];
    for (const scheme of schemes) {
      // Defensive: re-apply the deadline filter in case the fake / real
      // store returned a wider set.
      if (
        scheme.deadline === null ||
        !(scheme.deadline instanceof Date) ||
        scheme.deadline.getTime() >= asOf.getTime()
      ) {
        continue;
      }

      const eligibility = this.eligibilityEngine.calculateEligibility(
        profile,
        scheme,
      );
      const saved = savedBySchemeId.get(scheme.id) ?? null;

      if (
        !isMissed(
          { deadline: scheme.deadline },
          saved,
          { status: eligibility.status },
          asOf,
        )
      ) {
        continue;
      }

      missed.push({
        schemeId: scheme.id,
        schemeName: scheme.name,
        // Non-monetary schemes have no quantifiable amount (Req 15.6) — set
        // to null so the summary calculator excludes them while the UI can
        // still render a descriptive label.
        benefitAmount:
          scheme.benefitType === 'monetary' ? scheme.benefitAmount : null,
        benefitType: scheme.benefitType,
        deadline: scheme.deadline,
        metCriteria: eligibility.metCriteria.map((c) => c.criterionName),
      });
    }

    return missed;
  }

  /**
   * Sum the monetary benefit amounts of a missed-schemes list (Req 15.2).
   * Pure pass-through to `sumMonetaryMissedBenefits` — exposed on the
   * service for parity with the design-doc interface.
   */
  calculateMissedBenefitsValue(missed: ReadonlyArray<MissedSchemeRecord>): number {
    return sumMonetaryMissedBenefits(missed);
  }

  /**
   * Build the dashboard summary (Req 15.5):
   *   - `totalCount` — number of missed schemes (monetary + non-monetary).
   *   - `totalMonetaryValue` — monetary subtotal only (Req 15.6).
   *   - `schemes` — projected to the shape the Dashboard type expects.
   */
  async getSummary(
    userId: string,
    asOf: Date = new Date(),
  ): Promise<MissedBenefitsSummary> {
    const missed = await this.identifyMissedSchemes(userId, asOf);
    return {
      totalCount: missed.length,
      totalMonetaryValue: sumMonetaryMissedBenefits(missed),
      schemes: missed.map((m) => ({
        schemeId: m.schemeId,
        schemeName: m.schemeName,
        benefitAmount: m.benefitAmount,
        deadline: m.deadline,
        metCriteria: m.metCriteria,
      })),
    };
  }

  /**
   * Dispatch reopening notifications for `schemeId` (Req 15.4).
   *
   * Trigger: invoked by the Change_Detector after a scheme update flips the
   * deadline from "passed" to "future", or after the crawler ingests a new
   * cycle for an existing scheme.
   *
   * Recipients: every citizen who has the scheme on their dashboard but
   * never marked it `Applied`. This is the population that previously had
   * the scheme classified as `Expired` (or `Saved` with a passed deadline)
   * — i.e. the population the analyzer would have flagged as missed.
   *
   * Each citizen receives one outbound notification dispatched through
   * `NotificationService.deliverWithRetry`, which handles the email retry
   * + in-app fallback contract from Req 10.8.
   */
  async notifyOnReopening(schemeId: string): Promise<void> {
    if (!schemeId) {
      throw new TypeError('schemeId is required');
    }
    if (!this.notificationService) {
      // No transport configured — silently no-op so callers that don't
      // care about notifications don't have to inject one.
      return;
    }

    const scheme = await this.prisma.scheme.findUnique({
      where: { id: schemeId },
    });
    if (!scheme) return; // unknown scheme — nothing we can say.

    const savedRows = await this.prisma.savedScheme.findMany({
      where: { schemeId },
    });

    for (const row of savedRows) {
      if (row.status === 'Applied') continue; // already applied — not missed.

      const recipientEmail = await this.recipientEmailFor(row.userId);
      const message: OutboundNotification = {
        userId: row.userId,
        schemeId: scheme.id,
        type: 'reopening',
        recipientEmail,
        subject: `Reopened: ${scheme.name}`,
        body: formatReopeningBody(scheme),
        highPriority: false,
        payload: {
          schemeId: scheme.id,
          schemeName: scheme.name,
          newDeadline: scheme.deadline ? scheme.deadline.toISOString() : null,
          sourceUrl: scheme.sourceUrl,
        },
      };
      await this.notificationService.deliverWithRetry(message);
    }
  }
}

// ─── Message builders ────────────────────────────────────────────────────────

function formatReopeningBody(scheme: Scheme): string {
  const lines = [
    `Good news — "${scheme.name}" is open for applications again.`,
  ];
  if (scheme.deadline) {
    lines.push(`New deadline: ${scheme.deadline.toISOString().slice(0, 10)}.`);
  } else {
    lines.push('Applications are accepted on a rolling basis.');
  }
  lines.push(`Verify the official details at ${scheme.sourceUrl}.`);
  return lines.join('\n');
}
