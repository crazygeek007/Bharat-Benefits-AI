/**
 * Integration tests for the admin dashboard routes (Requirement 17).
 *
 * Builds a minimal Fastify app with stubbed admin services so the
 * tests focus purely on routing, request validation, and error
 * mapping. The auth + admin-guard pre-handlers are replaced with a
 * trivial stub that injects a synthetic admin id onto the request.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { registerAdminRoutes } from './admin.routes';
import {
  FlagAlreadyResolvedError,
  FlagNotFoundError,
  type SchemeFlagsService,
} from '../services/admin/scheme-flags-service';
import {
  InvalidEditPatchError,
  SchemeNotFoundError,
  type SchemeManagementService,
} from '../services/admin/scheme-management-service';
import type { AnalyticsService } from '../services/admin/analytics-service';

interface BuildOptions {
  analyticsService?: Partial<AnalyticsService>;
  schemeFlagsService?: Partial<SchemeFlagsService>;
  schemeManagementService?: Partial<SchemeManagementService>;
  /** Override auth to simulate a non-admin or unauthenticated user. */
  preHandler?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const STUB_ADMIN_ID = 'admin-test';

function buildApp(options: BuildOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  // Default pre-handler injects an admin id and bypasses real auth.
  const stubPreHandler =
    options.preHandler ??
    (async (request: FastifyRequest) => {
      (request as unknown as { user: { sub: string } }).user = {
        sub: STUB_ADMIN_ID,
      };
    });
  // Register a `requireAdmin`-equivalent stub that always allows.
  registerAdminRoutes(app, {
    analyticsService: options.analyticsService as AnalyticsService,
    schemeFlagsService: options.schemeFlagsService as SchemeFlagsService,
    schemeManagementService: options.schemeManagementService as SchemeManagementService,
    requireAdminPreHandler: stubPreHandler,
  });
  return app;
}

describe('GET /api/admin/health', () => {
  it('returns the system health snapshot', async () => {
    const snapshot = {
      crawler: { status: 'stopped', lastExecutionAt: null, errorMessage: null },
      database: { sizeMb: 12.5 },
      api: { averageResponseTimeMs: 42, sampleCount: 3, windowMs: 86400000 },
      generatedAt: new Date('2024-08-01T00:00:00Z').toISOString(),
    };
    const analytics: Partial<AnalyticsService> = {
      getSystemHealth: vi.fn().mockResolvedValue(snapshot),
      getAnalytics: vi.fn(),
    };
    const app = buildApp({ analyticsService: analytics });

    const res = await app.inject({ method: 'GET', url: '/api/admin/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(snapshot);
  });
});

describe('GET /api/admin/analytics', () => {
  it('returns the analytics rollup', async () => {
    const snapshot = {
      totalSchemes: 100,
      activeCitizens: 50,
      queriesPerDay: 12.5,
      eligibilityCalculationsPerDay: 7.5,
      windowDays: 30,
      generatedAt: new Date('2024-08-01T00:00:00Z').toISOString(),
    };
    const analytics: Partial<AnalyticsService> = {
      getSystemHealth: vi.fn(),
      getAnalytics: vi.fn().mockResolvedValue(snapshot),
    };
    const app = buildApp({ analyticsService: analytics });

    const res = await app.inject({ method: 'GET', url: '/api/admin/analytics' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(snapshot);
  });
});

describe('GET /api/admin/flags', () => {
  it('defaults to listing pending flags', async () => {
    const flags: Partial<SchemeFlagsService> = {
      listFlags: vi.fn().mockResolvedValue({
        flags: [],
        totalCount: 0,
      }),
    };
    const app = buildApp({ schemeFlagsService: flags });
    const res = await app.inject({ method: 'GET', url: '/api/admin/flags' });
    expect(res.statusCode).toBe(200);
    expect(flags.listFlags).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
    );
  });

  it('honors the status query parameter', async () => {
    const flags: Partial<SchemeFlagsService> = {
      listFlags: vi.fn().mockResolvedValue({ flags: [], totalCount: 0 }),
    };
    const app = buildApp({ schemeFlagsService: flags });
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/flags?status=all&limit=10&offset=5',
    });
    expect(res.statusCode).toBe(200);
    expect(flags.listFlags).toHaveBeenCalledWith({
      status: 'all',
      limit: 10,
      offset: 5,
    });
  });
});

describe('POST /api/admin/flags/:id/approve', () => {
  it('approves a flag and returns the updated record', async () => {
    const flagRecord = { id: 'flag-1', status: 'approved' };
    const flags: Partial<SchemeFlagsService> = {
      approveFlag: vi.fn().mockResolvedValue(flagRecord),
    };
    const app = buildApp({ schemeFlagsService: flags });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/flags/flag-1/approve',
      payload: { note: 'verified' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ flag: flagRecord });
    expect(flags.approveFlag).toHaveBeenCalledWith({
      flagId: 'flag-1',
      adminId: STUB_ADMIN_ID,
      note: 'verified',
    });
  });

  it('returns 404 when the flag does not exist', async () => {
    const flags: Partial<SchemeFlagsService> = {
      approveFlag: vi.fn().mockRejectedValue(new FlagNotFoundError('missing')),
    };
    const app = buildApp({ schemeFlagsService: flags });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/flags/missing/approve',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when the flag is already resolved', async () => {
    const flags: Partial<SchemeFlagsService> = {
      approveFlag: vi
        .fn()
        .mockRejectedValue(new FlagAlreadyResolvedError('flag-1', 'rejected')),
    };
    const app = buildApp({ schemeFlagsService: flags });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/flags/flag-1/approve',
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /api/admin/flags/:id/reject', () => {
  it('rejects a flag with the supplied reason', async () => {
    const flagRecord = { id: 'flag-1', status: 'rejected' };
    const flags: Partial<SchemeFlagsService> = {
      rejectFlag: vi.fn().mockResolvedValue(flagRecord),
    };
    const app = buildApp({ schemeFlagsService: flags });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/flags/flag-1/reject',
      payload: { reason: 'Source unreachable' },
    });
    expect(res.statusCode).toBe(200);
    expect(flags.rejectFlag).toHaveBeenCalledWith({
      flagId: 'flag-1',
      adminId: STUB_ADMIN_ID,
      reason: 'Source unreachable',
    });
  });

  it('returns 400 when the reason is missing', async () => {
    const flags: Partial<SchemeFlagsService> = {
      rejectFlag: vi.fn(),
    };
    const app = buildApp({ schemeFlagsService: flags });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/flags/flag-1/reject',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(flags.rejectFlag).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/schemes/:id/verify', () => {
  it('verifies a scheme', async () => {
    const updated = { id: 'scheme-1', verified: true, trustScore: 60 };
    const management: Partial<SchemeManagementService> = {
      verifyScheme: vi.fn().mockResolvedValue(updated),
    };
    const app = buildApp({ schemeManagementService: management });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/schemes/scheme-1/verify',
      payload: { note: 'manual review' },
    });
    expect(res.statusCode).toBe(200);
    expect(management.verifyScheme).toHaveBeenCalledWith({
      schemeId: 'scheme-1',
      adminId: STUB_ADMIN_ID,
      note: 'manual review',
    });
  });

  it('returns 404 for missing schemes', async () => {
    const management: Partial<SchemeManagementService> = {
      verifyScheme: vi.fn().mockRejectedValue(new SchemeNotFoundError('missing')),
    };
    const app = buildApp({ schemeManagementService: management });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/schemes/missing/verify',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/admin/schemes/:id', () => {
  it('edits a scheme using the supplied patch', async () => {
    const updated = { id: 'scheme-1', name: 'New Name' };
    const management: Partial<SchemeManagementService> = {
      editScheme: vi.fn().mockResolvedValue(updated),
    };
    const app = buildApp({ schemeManagementService: management });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/schemes/scheme-1',
      payload: { patch: { name: 'New Name' }, note: 'fixed typo' },
    });
    expect(res.statusCode).toBe(200);
    expect(management.editScheme).toHaveBeenCalledWith({
      schemeId: 'scheme-1',
      adminId: STUB_ADMIN_ID,
      patch: { name: 'New Name' },
      note: 'fixed typo',
    });
  });

  it('returns 400 when the body has no patch object', async () => {
    const management: Partial<SchemeManagementService> = {
      editScheme: vi.fn(),
    };
    const app = buildApp({ schemeManagementService: management });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/schemes/scheme-1',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(management.editScheme).not.toHaveBeenCalled();
  });

  it('returns 400 when the patch contains non-editable fields', async () => {
    const management: Partial<SchemeManagementService> = {
      editScheme: vi
        .fn()
        .mockRejectedValue(
          new InvalidEditPatchError('Field "trustScore" is not editable', 'trustScore'),
        ),
    };
    const app = buildApp({ schemeManagementService: management });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/schemes/scheme-1',
      payload: { patch: { trustScore: 99 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('trustScore');
  });
});

describe('DELETE /api/admin/schemes/:id', () => {
  it('removes a scheme with the supplied reason', async () => {
    const management: Partial<SchemeManagementService> = {
      removeScheme: vi.fn().mockResolvedValue(undefined),
    };
    const app = buildApp({ schemeManagementService: management });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/schemes/scheme-1',
      payload: { reason: 'Cancelled by ministry' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true, schemeId: 'scheme-1' });
    expect(management.removeScheme).toHaveBeenCalledWith({
      schemeId: 'scheme-1',
      adminId: STUB_ADMIN_ID,
      reason: 'Cancelled by ministry',
    });
  });

  it('returns 400 when the reason is missing', async () => {
    const management: Partial<SchemeManagementService> = {
      removeScheme: vi.fn(),
    };
    const app = buildApp({ schemeManagementService: management });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/schemes/scheme-1',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(management.removeScheme).not.toHaveBeenCalled();
  });
});

describe('admin route guard', () => {
  it('returns 401 when the pre-handler rejects the caller', async () => {
    const flags: Partial<SchemeFlagsService> = {
      listFlags: vi.fn(),
    };
    const app = buildApp({
      schemeFlagsService: flags,
      preHandler: async (_request, reply) => {
        reply.code(401).send({ error: 'Unauthorized', message: 'no auth' });
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/admin/flags' });
    expect(res.statusCode).toBe(401);
    expect(flags.listFlags).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is authenticated but not an admin', async () => {
    const flags: Partial<SchemeFlagsService> = {
      listFlags: vi.fn(),
    };
    const app = buildApp({
      schemeFlagsService: flags,
      preHandler: async (_request, reply) => {
        reply.code(403).send({ error: 'Forbidden', message: 'admin required' });
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/admin/flags' });
    expect(res.statusCode).toBe(403);
    expect(flags.listFlags).not.toHaveBeenCalled();
  });
});
