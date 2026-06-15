/**
 * Profile Update Integration Layer — event-driven wiring that triggers
 * downstream recalculations when a citizen's profile changes.
 *
 * Validates: Requirements 3.3, 5.5, 14.5, 23.3
 *
 * Responsibilities:
 *   - Emit `profile:updated` events when a profile is created or modified.
 *   - On `profile:updated`: trigger eligibility recalculation for all saved
 *     schemes within 30 seconds (Req 3.3).
 *   - On `profile:updated`: trigger recommendation regeneration within 60
 *     seconds (Req 5.5, 23.3).
 *   - On `scheme:changed` (from the Change Detector): trigger benefit-value
 *     recalculation (Req 14.5) and notify affected citizens within 60
 *     minutes (Req 14.3).
 *
 * Design:
 *   Uses a typed `EventEmitter` pattern so listeners can be tested in
 *   isolation by injecting mocked downstream services. The SLO budgets
 *   (30s / 60s / 60min) are comfortable since the underlying pure functions
 *   are allocation-light — the emitter dispatches asynchronously but the
 *   real latency is dominated by DB reads (profile + saved schemes).
 */

import { EventEmitter } from 'events';
import type { EligibilityEngine, SavedSchemeEligibility } from '../eligibility';
import type { RecommendationEngine } from '../recommendation';
import type { Recommendation } from '@bharat-benefits/shared';
import type {
  ChangeDetectorService,
  BenefitRecalculator,
  ChangeNotificationDispatcher,
  ChangeNotificationPayload,
} from '../change-detector';

// ─── Event types ─────────────────────────────────────────────────────────────

/** Payload emitted when a user profile is created or updated. */
export interface ProfileUpdatedEvent {
  userId: string;
  /** Fields that changed in this update (empty array for create). */
  changedFields: string[];
  /** Timestamp of the profile update. */
  updatedAt: Date;
}

/** Payload emitted when a scheme change is detected by the Change Detector. */
export interface SchemeChangedEvent {
  schemeId: string;
  /** Fields that changed. */
  changedFields: string[];
  /** ID of the version record. */
  versionId: string;
  /** Source URL of the scheme. */
  sourceUrl: string;
  /** When the change was detected. */
  changeDetectedAt: Date;
}

export type IntegrationEventMap = {
  'profile:updated': [ProfileUpdatedEvent];
  'scheme:changed': [SchemeChangedEvent];
};

// ─── Logger interface ────────────────────────────────────────────────────────

export interface IntegrationLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: IntegrationLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Dependencies ────────────────────────────────────────────────────────────

export interface ProfileUpdateIntegrationDeps {
  eligibilityEngine: Pick<EligibilityEngine, 'recalculateAllSavedSchemes'>;
  recommendationEngine: Pick<RecommendationEngine, 'generateRecommendations'>;
  changeDetectorService?: Pick<ChangeDetectorService, 'notifyAffectedCitizens' | 'recalculateBenefitValuesForSubscribers'>;
  logger?: IntegrationLogger;
}

// ─── Integration Service ─────────────────────────────────────────────────────

/**
 * Central integration hub that wires profile updates and scheme changes to
 * downstream services via an event-driven pattern.
 *
 * Consumers call `emitProfileUpdated` after persisting a profile change;
 * the service dispatches eligibility + recommendation recalculations
 * asynchronously. Similarly, `emitSchemeChanged` is called after the
 * Change Detector persists a new version; the service dispatches benefit
 * recalculation and citizen notifications.
 *
 * All downstream calls are best-effort: failures are logged but never
 * propagated to the emitter so a misbehaving downstream cannot block the
 * primary write path.
 */
export class ProfileUpdateIntegration {
  private readonly emitter = new EventEmitter();
  private readonly eligibilityEngine: Pick<EligibilityEngine, 'recalculateAllSavedSchemes'>;
  private readonly recommendationEngine: Pick<RecommendationEngine, 'generateRecommendations'>;
  private readonly changeDetectorService: Pick<ChangeDetectorService, 'notifyAffectedCitizens' | 'recalculateBenefitValuesForSubscribers'> | null;
  private readonly logger: IntegrationLogger;

  constructor(deps: ProfileUpdateIntegrationDeps) {
    this.eligibilityEngine = deps.eligibilityEngine;
    this.recommendationEngine = deps.recommendationEngine;
    this.changeDetectorService = deps.changeDetectorService ?? null;
    this.logger = deps.logger ?? noopLogger;

    this.setupProfileUpdateListeners();
    this.setupSchemeChangeListeners();
  }

  // ── Event emission ────────────────────────────────────────────────────────

  /**
   * Emit a profile-updated event. Call this after successfully persisting a
   * profile create or update. The downstream recalculations are dispatched
   * asynchronously — this method returns immediately.
   */
  emitProfileUpdated(event: ProfileUpdatedEvent): void {
    this.emitter.emit('profile:updated', event);
  }

  /**
   * Emit a scheme-changed event. Call this after the Change Detector
   * persists a new scheme version. Triggers benefit recalculation and
   * citizen notifications.
   */
  emitSchemeChanged(event: SchemeChangedEvent): void {
    this.emitter.emit('scheme:changed', event);
  }

  // ── Listener registration ─────────────────────────────────────────────────

  private setupProfileUpdateListeners(): void {
    this.emitter.on('profile:updated', (event: ProfileUpdatedEvent) => {
      this.handleProfileUpdated(event);
    });
  }

  private setupSchemeChangeListeners(): void {
    this.emitter.on('scheme:changed', (event: SchemeChangedEvent) => {
      this.handleSchemeChanged(event);
    });
  }

  // ── Handlers (best-effort, async, fire-and-forget) ────────────────────────

  /**
   * On profile update:
   *   1. Recalculate eligibility for all saved schemes (Req 3.3 — within 30s).
   *   2. Regenerate recommendations (Req 5.5, 23.3 — within 60s).
   *
   * Both calls are independent and executed in parallel via Promise.allSettled
   * so a failure in one does not block the other.
   */
  private handleProfileUpdated(event: ProfileUpdatedEvent): void {
    const { userId } = event;
    this.logger.info('Profile updated — triggering eligibility + recommendation recalculation', {
      userId,
      changedFields: event.changedFields,
    });

    // Fire-and-forget: downstream recalculations run asynchronously.
    void this.recalculateOnProfileChange(userId);
  }

  /**
   * Runs eligibility recalculation and recommendation regeneration in
   * parallel. Returns a combined result for observability / testing.
   */
  async recalculateOnProfileChange(userId: string): Promise<{
    eligibility: SavedSchemeEligibility[] | null;
    recommendations: Recommendation[] | null;
  }> {
    const [eligibilityResult, recommendationResult] = await Promise.allSettled([
      this.eligibilityEngine.recalculateAllSavedSchemes(userId),
      this.recommendationEngine.generateRecommendations(userId),
    ]);

    let eligibility: SavedSchemeEligibility[] | null = null;
    let recommendations: Recommendation[] | null = null;

    if (eligibilityResult.status === 'fulfilled') {
      eligibility = eligibilityResult.value;
      this.logger.info('Eligibility recalculation completed', {
        userId,
        schemeCount: eligibility.length,
      });
    } else {
      this.logger.error('Eligibility recalculation failed', {
        userId,
        error: eligibilityResult.reason instanceof Error
          ? eligibilityResult.reason.message
          : String(eligibilityResult.reason),
      });
    }

    if (recommendationResult.status === 'fulfilled') {
      recommendations = recommendationResult.value;
      this.logger.info('Recommendation regeneration completed', {
        userId,
        recommendationCount: recommendations.length,
      });
    } else {
      this.logger.error('Recommendation regeneration failed', {
        userId,
        error: recommendationResult.reason instanceof Error
          ? recommendationResult.reason.message
          : String(recommendationResult.reason),
      });
    }

    return { eligibility, recommendations };
  }

  /**
   * On scheme change:
   *   1. If benefit-bearing fields changed, trigger benefit-value
   *      recalculation (Req 14.5 — within 30s).
   *   2. Notify affected citizens (Req 14.3 — within 60 minutes).
   */
  private handleSchemeChanged(event: SchemeChangedEvent): void {
    const { schemeId, changedFields } = event;
    this.logger.info('Scheme changed — triggering downstream actions', {
      schemeId,
      changedFields,
    });

    void this.processSchemeChange(event);
  }

  /**
   * Processes a scheme change event: triggers benefit recalculation when
   * benefit-affecting fields changed, and notifies affected citizens.
   * Exposed as a public async method for testability.
   */
  async processSchemeChange(event: SchemeChangedEvent): Promise<{
    benefitRecalculated: boolean;
    citizensNotified: boolean;
  }> {
    const { schemeId, changedFields, versionId, sourceUrl, changeDetectedAt } = event;
    let benefitRecalculated = false;
    let citizensNotified = false;

    if (!this.changeDetectorService) {
      this.logger.warn('No change detector service configured — skipping scheme change processing', {
        schemeId,
      });
      return { benefitRecalculated, citizensNotified };
    }

    // Benefit-affecting fields that should trigger recalculation (Req 14.5).
    const benefitFields = ['benefits', 'eligibilityCriteria'];
    const hasBenefitChange = changedFields.some((f) => benefitFields.includes(f));

    const [recalcResult, notifyResult] = await Promise.allSettled([
      // Req 14.5: Recalculate benefit values when benefit amounts change.
      hasBenefitChange
        ? this.changeDetectorService.recalculateBenefitValuesForSubscribers(schemeId)
        : Promise.resolve(),
      // Req 14.3: Notify affected citizens within 60 minutes.
      this.changeDetectorService.notifyAffectedCitizens(schemeId, changedFields, {
        versionId,
        sourceUrl,
        changeDetectedAt,
      }),
    ]);

    if (recalcResult.status === 'fulfilled' && hasBenefitChange) {
      benefitRecalculated = true;
      this.logger.info('Benefit value recalculation triggered', { schemeId });
    } else if (recalcResult.status === 'rejected') {
      this.logger.error('Benefit value recalculation failed', {
        schemeId,
        error: recalcResult.reason instanceof Error
          ? recalcResult.reason.message
          : String(recalcResult.reason),
      });
    }

    if (notifyResult.status === 'fulfilled') {
      citizensNotified = true;
      this.logger.info('Citizen notifications dispatched', { schemeId });
    } else {
      this.logger.error('Citizen notification dispatch failed', {
        schemeId,
        error: notifyResult.reason instanceof Error
          ? notifyResult.reason.message
          : String(notifyResult.reason),
      });
    }

    return { benefitRecalculated, citizensNotified };
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  /** Remove all listeners — useful in tests to prevent memory leaks. */
  destroy(): void {
    this.emitter.removeAllListeners();
  }
}
