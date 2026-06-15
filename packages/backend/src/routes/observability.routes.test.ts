/**
 * Unit tests for the AI observability routes (Req 21.1–21.7).
 *
 * Tests validate:
 *   - Citizen feedback submission (POST /api/assistant/feedback) — Req 21.3
 *   - Input validation for missing/invalid fields
 *   - Admin metrics endpoint (GET /api/admin/observability/metrics) — Req 21.2
 *   - Admin helpfulness snapshot (GET /api/admin/observability/helpfulness) — Req 21.4
 *   - Admin evaluation status (GET /api/admin/observability/evaluations) — Req 21.6
 *   - Admin degraded traces (GET /api/admin/observability/degraded) — Req 21.7
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import {
  HelpfulnessMonitor,
  InMemoryAIQueryLogStore,
  InMemoryEvaluationRunStore,
  InMemoryFeedbackStore,
  ObservabilityService,
} from '../services/ai-observability';
import { registerObservabilityRoutes } from './observability.routes';

// ─── Test harness ────────────────────────────────────────────────────────────

function buildTestApp(): {
  app: FastifyInstance;
  service: ObservabilityService;
  feedbackStore: InMemoryFeedbackStore;
  queryLogStore: InMemoryAIQueryLogStore;
} {
  const queryLogStore = new InMemoryAIQueryLogStore();
  const feedbackStore = new InMemoryFeedbackStore();
  const evaluationRunStore = new InMemoryEvaluationRunStore();
  const helpfulnessMonitor = new HelpfulnessMonitor(feedbackStore);
  const service = new ObservabilityService(
    { queryLogStore, feedbackStore, helpfulnessMonitor, evaluationRunStore },
  );

  const app = Fastify();

  // Mock user injection for auth — `email` is required by AuthTokenClaims
  // even though the observability routes don't read it themselves.
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    request.user = {
      sub: 'test-user-id',
      email: 'test@example.com',
      role: 'admin',
    } as unknown as NonNullable<typeof request.user>;
  });

  // No-op admin guard for tests
  const noopAdminGuard = async () => undefined;

  registerObservabilityRoutes(app, {
    service,
    requireAdminPreHandler: noopAdminGuard as unknown as ReturnType<typeof import('../middleware/admin-auth.middleware').requireAdmin>,
  });

  return { app, service, feedbackStore, queryLogStore };
}

// ─── Feedback endpoint (Req 21.3) ────────────────────────────────────────────

describe('POST /api/assistant/feedback (Req 21.3)', () => {
  let app: FastifyInstance;
  let service: ObservabilityService;

  beforeEach(() => {
    const harness = buildTestApp();
    app = harness.app;
    service = harness.service;
  });

  it('accepts a valid helpful rating and returns 201', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/feedback',
      payload: { traceId: 'trace-123', rating: 'helpful' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.feedback.traceId).toBe('trace-123');
    expect(body.feedback.rating).toBe('helpful');
    expect(body.feedback.id).toBeTruthy();
    expect(body.helpfulness.ratedResponses).toBe(1);
    expect(body.helpfulness.helpfulCount).toBe(1);
  });

  it('accepts a valid unhelpful rating', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/feedback',
      payload: { traceId: 'trace-456', rating: 'unhelpful', comment: 'Not useful' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.feedback.rating).toBe('unhelpful');
    expect(body.helpfulness.helpfulCount).toBe(0);
  });

  it('rejects missing traceId with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/feedback',
      payload: { rating: 'helpful' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/traceId/);
  });

  it('rejects invalid rating value with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/feedback',
      payload: { traceId: 'trace-789', rating: 'neutral' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/rating/);
  });

  it('rejects empty traceId with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/feedback',
      payload: { traceId: '', rating: 'helpful' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/traceId/);
  });
});

// ─── Admin metrics endpoint (Req 21.2) ───────────────────────────────────────

describe('GET /api/admin/observability/metrics (Req 21.2)', () => {
  it('returns daily RAG metrics', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/observability/metrics',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('date');
    expect(body).toHaveProperty('ratedResponses');
    expect(body).toHaveProperty('precision');
    expect(body).toHaveProperty('recall');
    expect(body.ratedResponses).toBe(0);
    expect(body.precision).toBe(0);
    expect(body.recall).toBe(0);
  });

  it('accepts a date parameter', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/observability/metrics?date=2024-03-15',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.date).toContain('2024-03-15');
  });
});

// ─── Admin helpfulness endpoint (Req 21.4) ───────────────────────────────────

describe('GET /api/admin/observability/helpfulness (Req 21.4)', () => {
  it('returns the helpfulness snapshot', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/observability/helpfulness',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('ratedResponses');
    expect(body).toHaveProperty('helpfulCount');
    expect(body).toHaveProperty('helpfulRate');
    expect(body).toHaveProperty('shouldAlert');
    expect(body).toHaveProperty('threshold');
    expect(body).toHaveProperty('windowSize');
    expect(body.windowSize).toBe(100);
    expect(body.threshold).toBe(80);
  });

  it('reflects accumulated feedback', async () => {
    const { app, service } = buildTestApp();

    // Record some feedback
    await service.recordFeedback({ traceId: 'trace-1', userId: 'u1', rating: 'helpful' });
    await service.recordFeedback({ traceId: 'trace-2', userId: 'u2', rating: 'unhelpful' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/observability/helpfulness',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ratedResponses).toBe(2);
    expect(body.helpfulCount).toBe(1);
    expect(body.helpfulRate).toBeCloseTo(0.5, 2);
    expect(body.shouldAlert).toBe(false); // window not full
  });
});

// ─── Admin evaluation status (Req 21.6) ──────────────────────────────────────

describe('GET /api/admin/observability/evaluations (Req 21.6)', () => {
  it('returns evaluation status', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/observability/evaluations',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('shouldRunNextEvaluation');
    // No prior run → should run
    expect(body.shouldRunNextEvaluation).toBe(true);
  });
});

// ─── Admin degraded traces (Req 21.7) ────────────────────────────────────────

describe('GET /api/admin/observability/degraded (Req 21.7)', () => {
  it('returns degraded trace info', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/observability/degraded',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.thresholdMs).toBe(10_000);
  });
});

// ─── Admin logs endpoint (Req 21.1) ──────────────────────────────────────────

describe('GET /api/admin/observability/logs (Req 21.1)', () => {
  it('returns info message when no traceId provided', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/observability/logs',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.message).toBeTruthy();
  });

  it('looks up a specific trace by traceId', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/observability/logs?traceId=trace-abc',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.traceId).toBe('trace-abc');
  });
});
