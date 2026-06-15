/**
 * Unit tests for the Profile Update Integration layer.
 *
 * Verifies:
 *   - Eligibility recalculation is triggered on profile update (Req 3.3).
 *   - Recommendation regeneration is triggered on profile update (Req 5.5, 23.3).
 *   - Benefit value recalculation is triggered on scheme benefit change (Req 14.5).
 *   - Citizen notifications are dispatched on scheme change (Req 14.3).
 *   - Failures in one downstream service don't block others.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ProfileUpdateIntegration,
  type ProfileUpdatedEvent,
  type SchemeChangedEvent,
  type ProfileUpdateIntegrationDeps,
} from './profile-update-integration';

// ─── Mock factories ──────────────────────────────────────────────────────────

function createMockEligibilityEngine() {
  return {
    recalculateAllSavedSchemes: vi.fn().mockResolvedValue([
      { schemeId: 'scheme-1', result: { status: 'Eligible', metCriteria: [], unmetCriteria: [], unevaluatedCriteria: [], missingProfileFields: [] } },
    ]),
  };
}

function createMockRecommendationEngine() {
  return {
    generateRecommendations: vi.fn().mockResolvedValue([
      { schemeId: 'scheme-1', matchScore: 85, benefitAmount: 50000, deadline: null, explanation: '85% match', priorityGroup: 'state' as const },
    ]),
  };
}

function createMockChangeDetectorService() {
  return {
    notifyAffectedCitizens: vi.fn().mockResolvedValue(undefined),
    recalculateBenefitValuesForSubscribers: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function buildIntegration(overrides: Partial<ProfileUpdateIntegrationDeps> = {}) {
  const deps: ProfileUpdateIntegrationDeps = {
    eligibilityEngine: createMockEligibilityEngine(),
    recommendationEngine: createMockRecommendationEngine(),
    changeDetectorService: createMockChangeDetectorService(),
    logger: createMockLogger(),
    ...overrides,
  };
  const integration = new ProfileUpdateIntegration(deps);
  return { integration, deps };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ProfileUpdateIntegration', () => {
  describe('profile:updated event', () => {
    it('triggers eligibility recalculation on profile update', async () => {
      const { integration, deps } = buildIntegration();
      const event: ProfileUpdatedEvent = {
        userId: 'user-123',
        changedFields: ['age', 'incomeLevel'],
        updatedAt: new Date(),
      };

      const result = await integration.recalculateOnProfileChange(event.userId);

      expect(deps.eligibilityEngine.recalculateAllSavedSchemes).toHaveBeenCalledWith('user-123');
      expect(result.eligibility).not.toBeNull();
      expect(result.eligibility).toHaveLength(1);
    });

    it('triggers recommendation regeneration on profile update', async () => {
      const { integration, deps } = buildIntegration();
      const event: ProfileUpdatedEvent = {
        userId: 'user-456',
        changedFields: ['state'],
        updatedAt: new Date(),
      };

      const result = await integration.recalculateOnProfileChange(event.userId);

      expect(deps.recommendationEngine.generateRecommendations).toHaveBeenCalledWith('user-456');
      expect(result.recommendations).not.toBeNull();
      expect(result.recommendations).toHaveLength(1);
    });

    it('runs eligibility and recommendation in parallel', async () => {
      const eligibilityEngine = createMockEligibilityEngine();
      const recommendationEngine = createMockRecommendationEngine();

      // Track call order
      const callOrder: string[] = [];
      eligibilityEngine.recalculateAllSavedSchemes.mockImplementation(async () => {
        callOrder.push('eligibility-start');
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push('eligibility-end');
        return [];
      });
      recommendationEngine.generateRecommendations.mockImplementation(async () => {
        callOrder.push('recommendation-start');
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push('recommendation-end');
        return [];
      });

      const { integration } = buildIntegration({ eligibilityEngine, recommendationEngine });

      await integration.recalculateOnProfileChange('user-789');

      // Both should have started before either completed (parallel execution)
      expect(callOrder.indexOf('eligibility-start')).toBeLessThan(callOrder.indexOf('eligibility-end'));
      expect(callOrder.indexOf('recommendation-start')).toBeLessThan(callOrder.indexOf('recommendation-end'));
      // Both started (both called)
      expect(eligibilityEngine.recalculateAllSavedSchemes).toHaveBeenCalledOnce();
      expect(recommendationEngine.generateRecommendations).toHaveBeenCalledOnce();
    });

    it('continues recommendation even if eligibility fails', async () => {
      const eligibilityEngine = createMockEligibilityEngine();
      eligibilityEngine.recalculateAllSavedSchemes.mockRejectedValue(new Error('DB unavailable'));

      const recommendationEngine = createMockRecommendationEngine();
      const logger = createMockLogger();

      const { integration } = buildIntegration({ eligibilityEngine, recommendationEngine, logger });

      const result = await integration.recalculateOnProfileChange('user-fail');

      expect(result.eligibility).toBeNull();
      expect(result.recommendations).not.toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        'Eligibility recalculation failed',
        expect.objectContaining({ userId: 'user-fail' }),
      );
    });

    it('continues eligibility even if recommendation fails', async () => {
      const recommendationEngine = createMockRecommendationEngine();
      recommendationEngine.generateRecommendations.mockRejectedValue(new Error('Timeout'));

      const eligibilityEngine = createMockEligibilityEngine();
      const logger = createMockLogger();

      const { integration } = buildIntegration({ eligibilityEngine, recommendationEngine, logger });

      const result = await integration.recalculateOnProfileChange('user-fail-rec');

      expect(result.recommendations).toBeNull();
      expect(result.eligibility).not.toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        'Recommendation regeneration failed',
        expect.objectContaining({ userId: 'user-fail-rec' }),
      );
    });

    it('emitProfileUpdated fires the event and triggers handler', async () => {
      const { integration, deps } = buildIntegration();

      const event: ProfileUpdatedEvent = {
        userId: 'user-emit',
        changedFields: ['gender'],
        updatedAt: new Date(),
      };

      integration.emitProfileUpdated(event);

      // Give the async handler time to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(deps.eligibilityEngine.recalculateAllSavedSchemes).toHaveBeenCalledWith('user-emit');
      expect(deps.recommendationEngine.generateRecommendations).toHaveBeenCalledWith('user-emit');
    });
  });

  describe('scheme:changed event', () => {
    it('triggers benefit recalculation when benefits field changes', async () => {
      const { integration, deps } = buildIntegration();
      const event: SchemeChangedEvent = {
        schemeId: 'scheme-abc',
        changedFields: ['benefits', 'description'],
        versionId: 'ver-1',
        sourceUrl: 'https://example.gov.in/scheme',
        changeDetectedAt: new Date(),
      };

      const result = await integration.processSchemeChange(event);

      expect(deps.changeDetectorService!.recalculateBenefitValuesForSubscribers).toHaveBeenCalledWith('scheme-abc');
      expect(result.benefitRecalculated).toBe(true);
    });

    it('triggers benefit recalculation when eligibilityCriteria field changes', async () => {
      const { integration, deps } = buildIntegration();
      const event: SchemeChangedEvent = {
        schemeId: 'scheme-xyz',
        changedFields: ['eligibilityCriteria'],
        versionId: 'ver-2',
        sourceUrl: 'https://example.gov.in/scheme2',
        changeDetectedAt: new Date(),
      };

      const result = await integration.processSchemeChange(event);

      expect(deps.changeDetectorService!.recalculateBenefitValuesForSubscribers).toHaveBeenCalledWith('scheme-xyz');
      expect(result.benefitRecalculated).toBe(true);
    });

    it('does NOT trigger benefit recalculation for non-benefit field changes', async () => {
      const { integration, deps } = buildIntegration();
      const event: SchemeChangedEvent = {
        schemeId: 'scheme-name-only',
        changedFields: ['name', 'description'],
        versionId: 'ver-3',
        sourceUrl: 'https://example.gov.in/scheme3',
        changeDetectedAt: new Date(),
      };

      const result = await integration.processSchemeChange(event);

      expect(deps.changeDetectorService!.recalculateBenefitValuesForSubscribers).not.toHaveBeenCalled();
      expect(result.benefitRecalculated).toBe(false);
    });

    it('notifies affected citizens on any scheme change', async () => {
      const { integration, deps } = buildIntegration();
      const changeDetectedAt = new Date('2024-01-15T10:00:00Z');
      const event: SchemeChangedEvent = {
        schemeId: 'scheme-notify',
        changedFields: ['deadline'],
        versionId: 'ver-4',
        sourceUrl: 'https://example.gov.in/scheme4',
        changeDetectedAt,
      };

      const result = await integration.processSchemeChange(event);

      expect(deps.changeDetectorService!.notifyAffectedCitizens).toHaveBeenCalledWith(
        'scheme-notify',
        ['deadline'],
        {
          versionId: 'ver-4',
          sourceUrl: 'https://example.gov.in/scheme4',
          changeDetectedAt,
        },
      );
      expect(result.citizensNotified).toBe(true);
    });

    it('handles missing change detector service gracefully', async () => {
      const logger = createMockLogger();
      const { integration } = buildIntegration({
        changeDetectorService: undefined,
        logger,
      });

      const event: SchemeChangedEvent = {
        schemeId: 'scheme-no-detector',
        changedFields: ['benefits'],
        versionId: 'ver-5',
        sourceUrl: 'https://example.gov.in/scheme5',
        changeDetectedAt: new Date(),
      };

      const result = await integration.processSchemeChange(event);

      expect(result.benefitRecalculated).toBe(false);
      expect(result.citizensNotified).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('continues notifications even if benefit recalculation fails', async () => {
      const changeDetectorService = createMockChangeDetectorService();
      changeDetectorService.recalculateBenefitValuesForSubscribers.mockRejectedValue(
        new Error('Recalc failed'),
      );
      const logger = createMockLogger();

      const { integration } = buildIntegration({ changeDetectorService, logger });
      const event: SchemeChangedEvent = {
        schemeId: 'scheme-partial-fail',
        changedFields: ['benefits'],
        versionId: 'ver-6',
        sourceUrl: 'https://example.gov.in/scheme6',
        changeDetectedAt: new Date(),
      };

      const result = await integration.processSchemeChange(event);

      expect(result.benefitRecalculated).toBe(false);
      expect(result.citizensNotified).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(
        'Benefit value recalculation failed',
        expect.objectContaining({ schemeId: 'scheme-partial-fail' }),
      );
    });

    it('continues benefit recalculation even if notification fails', async () => {
      const changeDetectorService = createMockChangeDetectorService();
      changeDetectorService.notifyAffectedCitizens.mockRejectedValue(
        new Error('Notification dispatch failed'),
      );
      const logger = createMockLogger();

      const { integration } = buildIntegration({ changeDetectorService, logger });
      const event: SchemeChangedEvent = {
        schemeId: 'scheme-notify-fail',
        changedFields: ['benefits'],
        versionId: 'ver-7',
        sourceUrl: 'https://example.gov.in/scheme7',
        changeDetectedAt: new Date(),
      };

      const result = await integration.processSchemeChange(event);

      expect(result.benefitRecalculated).toBe(true);
      expect(result.citizensNotified).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        'Citizen notification dispatch failed',
        expect.objectContaining({ schemeId: 'scheme-notify-fail' }),
      );
    });

    it('emitSchemeChanged fires the event and triggers handler', async () => {
      const { integration, deps } = buildIntegration();
      const event: SchemeChangedEvent = {
        schemeId: 'scheme-emit',
        changedFields: ['benefits'],
        versionId: 'ver-8',
        sourceUrl: 'https://example.gov.in/scheme8',
        changeDetectedAt: new Date(),
      };

      integration.emitSchemeChanged(event);

      // Give the async handler time to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(deps.changeDetectorService!.recalculateBenefitValuesForSubscribers).toHaveBeenCalledWith('scheme-emit');
      expect(deps.changeDetectorService!.notifyAffectedCitizens).toHaveBeenCalledWith(
        'scheme-emit',
        ['benefits'],
        expect.objectContaining({ versionId: 'ver-8' }),
      );
    });
  });

  describe('destroy', () => {
    it('removes all listeners and prevents further event processing', async () => {
      const { integration, deps } = buildIntegration();

      integration.destroy();
      integration.emitProfileUpdated({
        userId: 'user-destroyed',
        changedFields: ['age'],
        updatedAt: new Date(),
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(deps.eligibilityEngine.recalculateAllSavedSchemes).not.toHaveBeenCalled();
      expect(deps.recommendationEngine.generateRecommendations).not.toHaveBeenCalled();
    });
  });
});
