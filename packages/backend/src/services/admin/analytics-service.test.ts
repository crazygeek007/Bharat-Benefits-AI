/**
 * Unit tests for {@link AnalyticsService}.
 *
 * Validates:
 *   - Req 17.1 — System health metrics: crawler status, DB size, average
 *     API response time over the last 24 hours.
 *   - Req 17.4 — Analytics: total schemes, active citizens, queries/day,
 *     eligibility calcs/day over a rolling 30-day window.
 */

import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_WINDOW_DAYS,
  ANALYTICS_WINDOW_MS,
  ASSISTANT_QUERY_ACTION,
  AnalyticsService,
  ELIGIBILITY_CALC_ACTION,
} from './analytics-service';
import { ApiMetricsTracker } from './api-metrics-tracker';
import { CrawlerStatusTracker } from './crawler-status-tracker';

function makeService(overrides: {
  totalSchemes?: number;
  activeCitizens?: number;
  queryEvents?: number;
  eligibilityEvents?: number;
  dbSizeMb?: number;
  crawlerStatus?: 'running' | 'stopped' | 'error' | 'unknown';
  apiSamples?: Array<{ durationMs: number; recordedAt: number }>;
  now?: Date;
} = {}) {
  const fixedNow = overrides.now ?? new Date('2024-08-01T12:00:00Z');
  const crawlerTracker = new CrawlerStatusTracker();
  if (overrides.crawlerStatus === 'running') {
    crawlerTracker.markRunning(fixedNow);
  } else if (overrides.crawlerStatus === 'stopped') {
    crawlerTracker.markStopped(fixedNow);
  } else if (overrides.crawlerStatus === 'error') {
    crawlerTracker.markError('Timeout reaching source', fixedNow);
  }

  const apiTracker = new ApiMetricsTracker(1000);
  if (overrides.apiSamples) {
    for (const sample of overrides.apiSamples) {
      apiTracker.record(sample.durationMs, sample.recordedAt);
    }
  }

  return new AnalyticsService({
    apiTracker,
    crawlerTracker,
    countSchemes: async () => overrides.totalSchemes ?? 0,
    countActiveCitizens: async () => overrides.activeCitizens ?? 0,
    countAuditEvents: async (action: string) => {
      if (action === ASSISTANT_QUERY_ACTION) return overrides.queryEvents ?? 0;
      if (action === ELIGIBILITY_CALC_ACTION) return overrides.eligibilityEvents ?? 0;
      return 0;
    },
    probeDatabaseSize: async () => overrides.dbSizeMb ?? 0,
    now: () => fixedNow,
  });
}

describe('AnalyticsService.getSystemHealth', () => {
  it('returns crawler status, DB size, and API response time', async () => {
    const now = new Date('2024-08-01T12:00:00Z');
    const service = makeService({
      crawlerStatus: 'stopped',
      dbSizeMb: 256.75,
      apiSamples: [
        { durationMs: 30, recordedAt: now.getTime() - 1000 },
        { durationMs: 50, recordedAt: now.getTime() - 2000 },
        { durationMs: 40, recordedAt: now.getTime() - 3000 },
      ],
      now,
    });

    const health = await service.getSystemHealth();

    expect(health.crawler.status).toBe('stopped');
    expect(health.crawler.lastExecutionAt).toBe(now.toISOString());
    expect(health.crawler.errorMessage).toBeNull();
    expect(health.database.sizeMb).toBe(256.75);
    expect(health.api.averageResponseTimeMs).toBe(40);
    expect(health.api.sampleCount).toBe(3);
    expect(health.generatedAt).toBe(now.toISOString());
  });

  it('reports crawler error message when status is error', async () => {
    const service = makeService({ crawlerStatus: 'error' });
    const health = await service.getSystemHealth();
    expect(health.crawler.status).toBe('error');
    expect(health.crawler.errorMessage).toBe('Timeout reaching source');
  });

  it('reports zero DB size when the probe fails', async () => {
    const now = new Date('2024-08-01T12:00:00Z');
    const service = new AnalyticsService({
      apiTracker: new ApiMetricsTracker(10),
      crawlerTracker: new CrawlerStatusTracker(),
      countSchemes: async () => 0,
      countActiveCitizens: async () => 0,
      countAuditEvents: async () => 0,
      probeDatabaseSize: async () => {
        throw new Error('Connection refused');
      },
      now: () => now,
    });

    const health = await service.getSystemHealth();
    expect(health.database.sizeMb).toBe(0);
  });

  it('excludes API samples outside the 24h window', async () => {
    const now = new Date('2024-08-01T12:00:00Z');
    const oneDayAgoPlus1ms = now.getTime() - 24 * 60 * 60 * 1000 - 1;
    const service = makeService({
      apiSamples: [
        { durationMs: 100, recordedAt: oneDayAgoPlus1ms }, // outside window
        { durationMs: 20, recordedAt: now.getTime() - 1000 }, // inside window
      ],
      now,
    });

    const health = await service.getSystemHealth();
    expect(health.api.sampleCount).toBe(1);
    expect(health.api.averageResponseTimeMs).toBe(20);
  });
});

describe('AnalyticsService.getAnalytics', () => {
  it('returns total schemes and active citizens', async () => {
    const service = makeService({ totalSchemes: 500, activeCitizens: 120 });
    const analytics = await service.getAnalytics();
    expect(analytics.totalSchemes).toBe(500);
    expect(analytics.activeCitizens).toBe(120);
    expect(analytics.windowDays).toBe(ANALYTICS_WINDOW_DAYS);
  });

  it('computes queries per day as total events / 30', async () => {
    const service = makeService({ queryEvents: 300 });
    const analytics = await service.getAnalytics();
    expect(analytics.queriesPerDay).toBe(10);
  });

  it('computes eligibility calcs per day as total events / 30', async () => {
    const service = makeService({ eligibilityEvents: 150 });
    const analytics = await service.getAnalytics();
    expect(analytics.eligibilityCalculationsPerDay).toBe(5);
  });

  it('rounds per-day values to two decimal places', async () => {
    // 100 events / 30 = 3.333...
    const service = makeService({ queryEvents: 100 });
    const analytics = await service.getAnalytics();
    expect(analytics.queriesPerDay).toBe(3.33);
  });

  it('returns zero for all metrics when no data exists', async () => {
    const service = makeService();
    const analytics = await service.getAnalytics();
    expect(analytics.totalSchemes).toBe(0);
    expect(analytics.activeCitizens).toBe(0);
    expect(analytics.queriesPerDay).toBe(0);
    expect(analytics.eligibilityCalculationsPerDay).toBe(0);
  });

  it('includes the generatedAt timestamp', async () => {
    const now = new Date('2024-08-01T12:00:00Z');
    const service = makeService({ now });
    const analytics = await service.getAnalytics();
    expect(analytics.generatedAt).toBe(now.toISOString());
  });
});

describe('AnalyticsService constants', () => {
  it('defines a 30-day analytics window', () => {
    expect(ANALYTICS_WINDOW_DAYS).toBe(30);
    expect(ANALYTICS_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('defines correct audit action strings', () => {
    expect(ASSISTANT_QUERY_ACTION).toBe('assistant.query');
    expect(ELIGIBILITY_CALC_ACTION).toBe('eligibility.calculate');
  });
});
