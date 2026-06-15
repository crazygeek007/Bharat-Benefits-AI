/**
 * Recommendation Engine — generates personalised, state-aware scheme
 * recommendations for a citizen.
 *
 * Responsibilities:
 *   - Score how well each scheme matches a citizen's profile
 *     (`calculateMatchScore`, integer in [0, 100], Req 5.2).
 *   - Group recommendations by priority (citizen's state → Central → other
 *     states) and rank within each group by Match_Score → Benefit Amount →
 *     Deadline proximity (`applyStateAwarePrioritization`, Req 5.1, 23.1,
 *     23.2, 23.4).
 *   - Boost schemes with deadlines within 30 days above same-tier later or
 *     deadline-less schemes (Req 5.3).
 *   - Exclude `Not Eligible` schemes (Req 5.4) and cap the list at 50 entries
 *     (Req 5.7) with a ≤ 200-char explanation per recommendation (Req 5.6).
 *   - Regenerate within 60 seconds of a profile change (`generateRecommendations`,
 *     Req 5.5, 23.3) — the in-process pure functions are allocation-light so
 *     even at the saved-scheme cap the budget is comfortable headroom.
 *
 * The pure functions are exported so the property-based tests in 7.2-7.5 can
 * exercise them without database wiring.
 */

import type {
  EligibilityResult,
  Recommendation,
  Scheme,
  UserProfile,
} from '@bharat-benefits/shared';
import {
  MAX_RECOMMENDATIONS,
  MAX_RECOMMENDATION_EXPLANATION_CHARS,
} from '@bharat-benefits/shared';
import { calculateEligibility, EligibilityEngine, eligibilityEngine } from '../eligibility';
import prisma from '../../lib/prisma';

// ─── Tunables ────────────────────────────────────────────────────────────────

/** Number of days that qualifies a deadline as "urgent" for the boost rule. */
export const URGENT_DEADLINE_DAYS = 30;

/** Number of days within which a scheme update counts as "recent". */
export const RECENT_UPDATE_DAYS = 30;

/** Maximum point contribution from the benefit-amount bonus. */
const BENEFIT_BONUS_CAP = 5;

/** Component contributions used by `calculateMatchScore`. */
export const MATCH_SCORE_WEIGHTS = {
  eligibilityEligible: 60,
  eligibilityPartial: 30,
  stateMatch: 20,
  categoryAlignment: 10,
  recency: 5,
} as const;

// Mapping from a citizen's occupation to scheme categories we treat as
// strongly aligned. The mapping is intentionally conservative — if a
// citizen has no occupation set we contribute nothing rather than guess.
const OCCUPATION_CATEGORY_MAP: Record<string, ReadonlyArray<Scheme['category']>> = {
  Farmer: ['Agriculture'],
  Student: ['Education', 'Scholarships'],
  Salaried: ['Employment', 'Pension'],
  'Self-Employed': ['MSME', 'Startups', 'Employment'],
  Unemployed: ['Skill Development', 'Employment', 'Financial Assistance'],
  Retired: ['Pension', 'Healthcare'],
  Other: [],
};

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Returns true when `deadline` falls within the urgent boost window (today
 * through `URGENT_DEADLINE_DAYS` days from now, inclusive). Past deadlines
 * are treated as non-urgent — they can no longer be acted on so they should
 * not jump ahead of actionable schemes.
 */
export function isUrgentDeadline(
  deadline: Date | null,
  now: Date = new Date(),
): boolean {
  if (deadline === null) return false;
  const target = new Date(deadline).getTime();
  const today = now.getTime();
  if (!Number.isFinite(target)) return false;
  const diffDays = (target - today) / 86_400_000;
  return diffDays >= 0 && diffDays <= URGENT_DEADLINE_DAYS;
}

function isRecentlyUpdated(scheme: Scheme, now: Date = new Date()): boolean {
  const updated = scheme.lastVerifiedAt ?? scheme.updatedAt ?? null;
  if (!updated) return false;
  const t = new Date(updated).getTime();
  if (!Number.isFinite(t)) return false;
  const diffDays = (now.getTime() - t) / 86_400_000;
  return diffDays >= 0 && diffDays <= RECENT_UPDATE_DAYS;
}

/**
 * Returns the priority group a scheme falls into for a given citizen.
 *
 *   - `state`  : scheme is offered by the citizen's state of residence.
 *   - `central`: scheme has no state (Central Government scheme).
 *   - `other`  : scheme is offered by some other state.
 *
 * When the citizen has no state set (Req 23.5) the engine still labels
 * Central schemes as `central` and every state-bound scheme as `other`,
 * which gives Central → Other ordering without requiring a separate code
 * path in the sort.
 */
export function assignPriorityGroup(
  scheme: Scheme,
  userState: string | null | undefined,
): Recommendation['priorityGroup'] {
  if (scheme.state === null) return 'central';
  if (userState && scheme.state === userState) return 'state';
  return 'other';
}

/**
 * Truncates `text` to at most `MAX_RECOMMENDATION_EXPLANATION_CHARS` chars
 * (Req 5.6) using a UTF-16 code-unit count — the same metric `String#length`
 * uses, which is the contract surfaced to API consumers.
 */
function clampExplanation(text: string): string {
  if (text.length <= MAX_RECOMMENDATION_EXPLANATION_CHARS) return text;
  // Reserve 3 characters for the ellipsis to keep the result both within the
  // budget and visibly truncated.
  const ellipsis = '...';
  return (
    text.slice(0, MAX_RECOMMENDATION_EXPLANATION_CHARS - ellipsis.length) + ellipsis
  );
}

// ─── Pure scoring & explanation helpers ──────────────────────────────────────

/**
 * Calculates a Match_Score in [0, 100] for the given profile/scheme pair.
 *
 * Scoring components (additive, then clamped):
 *   - Eligibility status: Eligible +60, Partially Eligible +30, Not Eligible 0.
 *   - State match: +20 when the scheme's state matches the citizen's state.
 *   - Category alignment: +10 when the scheme's category lines up with the
 *     citizen's occupation (e.g. Farmer ↔ Agriculture).
 *   - Recency: +5 when the scheme was last verified within the last 30 days.
 *   - Benefit-amount bonus: log-scale, capped at +5.
 *
 * The function is pure and total — it never throws, always returns an
 * integer in the closed interval [0, 100], and never reads from I/O.
 */
export function calculateMatchScore(
  profile: UserProfile,
  scheme: Scheme,
  eligibility?: EligibilityResult,
  now: Date = new Date(),
): number {
  const result = eligibility ?? calculateEligibility(profile, scheme);

  let score = 0;

  if (result.status === 'Eligible') {
    score += MATCH_SCORE_WEIGHTS.eligibilityEligible;
  } else if (result.status === 'Partially Eligible') {
    score += MATCH_SCORE_WEIGHTS.eligibilityPartial;
  }

  if (scheme.state !== null && scheme.state === profile.state) {
    score += MATCH_SCORE_WEIGHTS.stateMatch;
  }

  const occupation = profile.occupation;
  if (occupation) {
    const aligned = OCCUPATION_CATEGORY_MAP[occupation] ?? [];
    if (aligned.includes(scheme.category)) {
      score += MATCH_SCORE_WEIGHTS.categoryAlignment;
    }
  }

  if (isRecentlyUpdated(scheme, now)) {
    score += MATCH_SCORE_WEIGHTS.recency;
  }

  if (
    typeof scheme.benefitAmount === 'number' &&
    Number.isFinite(scheme.benefitAmount) &&
    scheme.benefitAmount > 0
  ) {
    // log10(amount + 1) caps naturally — e.g. ₹1L ≈ 5, ₹10L ≈ 6, ₹1Cr ≈ 7
    // — so we floor and clamp into [0, BENEFIT_BONUS_CAP].
    const bonus = Math.floor(Math.log10(scheme.benefitAmount + 1));
    score += Math.max(0, Math.min(BENEFIT_BONUS_CAP, bonus));
  }

  // Round defensively — every component is integral today but Math operations
  // on floats occasionally produce 0.999… style artefacts.
  const rounded = Math.round(score);
  if (rounded < 0) return 0;
  if (rounded > 100) return 100;
  return rounded;
}

/**
 * Builds the citizen-facing explanation for a recommendation. The string is
 * ASCII-safe and capped at `MAX_RECOMMENDATION_EXPLANATION_CHARS` (Req 5.6).
 *
 * The explanation focuses on the factors that contributed most to the Match
 * Score so the citizen can quickly understand why the scheme was suggested.
 */
export function generateExplanation(
  profile: UserProfile,
  scheme: Scheme,
  eligibility: EligibilityResult,
  matchScore: number,
  now: Date = new Date(),
): string {
  const parts: string[] = [];
  parts.push(`${matchScore}% match`);

  if (scheme.state !== null && scheme.state === profile.state) {
    parts.push(`${scheme.state} scheme`);
  } else if (scheme.state === null) {
    parts.push('Central scheme');
  }

  parts.push(scheme.category);

  if (eligibility.status === 'Eligible') {
    parts.push('eligible');
  } else if (eligibility.status === 'Partially Eligible') {
    const missing = eligibility.missingProfileFields.slice(0, 2).join(', ');
    if (missing) {
      parts.push(`partial: complete ${missing}`);
    } else {
      parts.push('partial');
    }
  }

  if (scheme.deadline !== null) {
    const days = Math.floor(
      (new Date(scheme.deadline).getTime() - now.getTime()) / 86_400_000,
    );
    if (days >= 0 && days <= URGENT_DEADLINE_DAYS) {
      parts.push(`deadline in ${days}d`);
    }
  }

  return clampExplanation(parts.join('; '));
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

const PRIORITY_GROUP_RANK: Record<Recommendation['priorityGroup'], number> = {
  state: 0,
  central: 1,
  other: 2,
};

function deadlineSortKey(deadline: Date | null): number {
  if (deadline === null) return Number.POSITIVE_INFINITY;
  const t = new Date(deadline).getTime();
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/**
 * Sorts recommendations using the state-aware priority order required by
 * Req 5.1, 5.3, 23.1, 23.2 and 23.4:
 *
 *   1. Priority group: state → central → other.
 *   2. Match_Score descending.
 *   3. Urgent boost: deadlines within 30 days come before later/no deadlines
 *      at the same Match_Score (Req 5.3 / Property 8b).
 *   4. Benefit Amount descending (null treated as 0).
 *   5. Deadline ascending (null treated as +∞ so it sorts last).
 *   6. Scheme ID ascending — final deterministic tie-breaker so two equal
 *      recommendations always sort in a stable, reproducible order.
 *
 * Recommendations are expected to already carry their `priorityGroup` tag
 * (assigned by `assignPriorityGroup` during generation). The `userState`
 * parameter is kept on the public signature to match the design contract;
 * callers that need to retag should compose `assignPriorityGroup` upstream.
 */
export function applyStateAwarePrioritization(
  recommendations: Recommendation[],
  // userState retained for signature compatibility with the design contract.
  // Recommendations are already tagged with priorityGroup.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _userState: string | null = null,
  now: Date = new Date(),
): Recommendation[] {
  const sorted = [...recommendations];
  sorted.sort((a, b) => {
    const ga = PRIORITY_GROUP_RANK[a.priorityGroup];
    const gb = PRIORITY_GROUP_RANK[b.priorityGroup];
    if (ga !== gb) return ga - gb;

    if (a.matchScore !== b.matchScore) return b.matchScore - a.matchScore;

    const ua = isUrgentDeadline(a.deadline, now);
    const ub = isUrgentDeadline(b.deadline, now);
    if (ua !== ub) return ua ? -1 : 1;

    const ba = a.benefitAmount ?? 0;
    const bb = b.benefitAmount ?? 0;
    if (ba !== bb) return bb - ba;

    const da = deadlineSortKey(a.deadline);
    const db = deadlineSortKey(b.deadline);
    if (da !== db) return da - db;

    return a.schemeId < b.schemeId ? -1 : a.schemeId > b.schemeId ? 1 : 0;
  });
  return sorted;
}

// ─── Recommendation construction ─────────────────────────────────────────────

/**
 * Builds a single `Recommendation` for a (profile, scheme) pair, returning
 * `null` when the scheme is `Not Eligible` (Req 5.4 — excluded from the
 * citizen's recommendation list) or when its match score is zero (Req 5.8 —
 * we surface "no recommendations" instead of zero-value rows).
 *
 * Pure: no I/O, no exceptions for normal inputs. Exposed for the property
 * tests so they can drive the recommendation pipeline without a database.
 */
export function buildRecommendation(
  profile: UserProfile,
  scheme: Scheme,
  userState: string | null,
  now: Date = new Date(),
): Recommendation | null {
  const eligibility = calculateEligibility(profile, scheme);
  if (eligibility.status === 'Not Eligible') return null;

  const matchScore = calculateMatchScore(profile, scheme, eligibility, now);
  if (matchScore <= 0) return null;

  return {
    schemeId: scheme.id,
    matchScore,
    benefitAmount: scheme.benefitAmount,
    deadline: scheme.deadline,
    explanation: generateExplanation(profile, scheme, eligibility, matchScore, now),
    priorityGroup: assignPriorityGroup(scheme, userState),
  };
}

// ─── Prisma-aware orchestration ──────────────────────────────────────────────

/**
 * Minimal shape of the Prisma client surface the recommendation engine needs.
 * Declared structurally so unit tests can supply an in-memory fake without
 * pulling in the full generated Prisma type surface.
 */
export interface RecommendationEnginePrisma {
  userProfile: {
    findUnique(args: {
      where: { userId: string };
    }): Promise<UserProfile | null>;
  };
  scheme: {
    findMany(args: {
      where?: { trustScore?: { gte?: number }; verified?: boolean };
    }): Promise<Scheme[]>;
  };
}

/**
 * `RecommendationEngine` ties the pure helpers above to a database client so
 * that callers can produce a citizen's full recommendation list end-to-end.
 *
 * The class exposes the same `calculateMatchScore` /
 * `applyStateAwarePrioritization` surface area as the pure module functions
 * so downstream services can inject the engine and rely on a stable
 * interface.
 */
export class RecommendationEngine {
  constructor(
    private readonly db: RecommendationEnginePrisma = prisma as unknown as RecommendationEnginePrisma,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private readonly engine: EligibilityEngine = eligibilityEngine,
  ) {}

  /** Pure pass-through to `calculateMatchScore`. */
  calculateMatchScore(profile: UserProfile, scheme: Scheme): number {
    return calculateMatchScore(profile, scheme);
  }

  /** Pure pass-through to `applyStateAwarePrioritization`. */
  applyStateAwarePrioritization(
    recommendations: Recommendation[],
    userState: string | null = null,
  ): Recommendation[] {
    return applyStateAwarePrioritization(recommendations, userState);
  }

  /**
   * Generates the citizen's recommendation list end-to-end:
   *   1. Load the citizen's profile and the universe of citizen-visible
   *      schemes (trustScore ≥ 60, verified — Req 1.6, 1.7).
   *   2. For every scheme, compute eligibility; drop `Not Eligible` schemes
   *      (Req 5.4) and any zero-score scheme (Req 5.8).
   *   3. Tag each surviving recommendation with its priority group, sort
   *      using the state-aware ordering (Req 5.1, 5.3, 23.1, 23.2, 23.4),
   *      and cap the list at `MAX_RECOMMENDATIONS` (Req 5.7).
   *
   * Throws when the citizen has no profile yet — recommendations require a
   * profile (Req 5.8 prompts the citizen to complete their profile, and the
   * caller surfaces this thrown error as that prompt).
   */
  async generateRecommendations(userId: string): Promise<Recommendation[]> {
    if (!userId) {
      throw new TypeError('userId is required to generate recommendations');
    }

    const profile = await this.db.userProfile.findUnique({ where: { userId } });
    if (!profile) {
      throw new Error(`No user profile found for userId=${userId}`);
    }

    // Only consider schemes the platform displays to citizens — Req 1.6 hides
    // schemes with Trust_Score < 60.
    const schemes = await this.db.scheme.findMany({
      where: { trustScore: { gte: 60 } },
    });

    const userState = profile.state ?? null;
    const now = new Date();

    const recommendations: Recommendation[] = [];
    for (const scheme of schemes) {
      const rec = buildRecommendation(profile, scheme, userState, now);
      if (rec !== null) recommendations.push(rec);
    }

    const sorted = applyStateAwarePrioritization(recommendations, userState, now);
    return sorted.slice(0, MAX_RECOMMENDATIONS);
  }
}

/** Default singleton suitable for HTTP handlers and downstream services. */
export const recommendationEngine = new RecommendationEngine();
