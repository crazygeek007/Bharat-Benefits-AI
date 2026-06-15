/**
 * Unit tests for Audit Log Service and Middleware
 *
 * Validates: Requirement 16.6 — Audit logs of all User_Profile data access
 * and modifications, retaining logs for minimum 365 days, including the action
 * performed, the timestamp, and the actor identity.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the prisma client BEFORE importing the service. The service imports
// prisma from '../lib/prisma' so we mock that module path.
vi.mock('../lib/prisma', () => {
  const auditLog = {
    create: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  };
  return { prisma: { auditLog }, default: { auditLog } };
});

import { prisma } from '../lib/prisma';
import {
  AUDIT_LOG_RETENTION_DAYS,
  logAccess,
  logModification,
  getAuditLogs,
  pruneOldLogs,
} from './audit.service';
import {
  isProfileRoute,
  extractUserId,
  extractActorIdentity,
  extractResourceId,
} from '../middleware/audit.middleware';

const mockedAuditLog = prisma.auditLog as unknown as {
  create: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};

// Default factory: return whatever the caller passed in plus a generated id.
function defaultCreate({ data }: { data: Record<string, unknown> }) {
  return Promise.resolve({
    id: 'generated-id',
    ...data,
  });
}

beforeEach(() => {
  mockedAuditLog.create.mockReset();
  mockedAuditLog.findMany.mockReset();
  mockedAuditLog.deleteMany.mockReset();
  mockedAuditLog.create.mockImplementation(defaultCreate);
  mockedAuditLog.findMany.mockResolvedValue([]);
  mockedAuditLog.deleteMany.mockResolvedValue({ count: 0 });
});

// ─── Audit Service: Retention Policy ─────────────────────────────────────────

describe('AuditService — retention policy', () => {
  it('enforces minimum 365-day retention period', () => {
    expect(AUDIT_LOG_RETENTION_DAYS).toBeGreaterThanOrEqual(365);
  });
});

// ─── Audit Service: logAccess ────────────────────────────────────────────────

describe('AuditService.logAccess', () => {
  it('writes a record with action, timestamp, actorIdentity, and resourceType', async () => {
    const before = Date.now();

    await logAccess({
      userId: 'user-1',
      actorIdentity: 'user:user-1',
      resourceType: 'user_profile',
      resourceId: 'profile-1',
    });

    const after = Date.now();

    expect(mockedAuditLog.create).toHaveBeenCalledTimes(1);
    const call = mockedAuditLog.create.mock.calls[0][0];
    expect(call.data.action).toBe('read');
    expect(call.data.actorIdentity).toBe('user:user-1');
    expect(call.data.resourceType).toBe('user_profile');
    expect(call.data.resourceId).toBe('profile-1');
    expect(call.data.userId).toBe('user-1');
    expect(call.data.timestamp).toBeInstanceOf(Date);

    // Timestamp should be the current moment
    const ts = (call.data.timestamp as Date).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('passes optional details through to the persisted record', async () => {
    await logAccess({
      userId: 'user-2',
      actorIdentity: 'admin:auditor',
      resourceType: 'user_profile',
      resourceId: 'profile-2',
      details: { ip: '10.0.0.1', method: 'GET' },
    });

    const call = mockedAuditLog.create.mock.calls[0][0];
    expect(call.data.details).toEqual({ ip: '10.0.0.1', method: 'GET' });
  });

  it('produces UTC timestamps', async () => {
    await logAccess({
      userId: 'user-3',
      actorIdentity: 'user:user-3',
      resourceType: 'user_profile',
      resourceId: null,
    });

    const call = mockedAuditLog.create.mock.calls[0][0];
    const ts = call.data.timestamp as Date;

    // Date instances are stored as UTC milliseconds since the epoch. The
    // canonical UTC ISO string must match the underlying timestamp value.
    expect(ts.toISOString()).toMatch(/Z$/);
    expect(new Date(ts.toISOString()).getTime()).toBe(ts.getTime());
  });
});

// ─── Audit Service: logModification ──────────────────────────────────────────

describe('AuditService.logModification', () => {
  it('captures both previous and new values inside details', async () => {
    await logModification({
      userId: 'user-4',
      actorIdentity: 'user:user-4',
      action: 'update',
      resourceType: 'user_profile',
      resourceId: 'profile-4',
      previousValues: { age: 30, state: 'KA' },
      newValues: { age: 31, state: 'KA' },
    });

    expect(mockedAuditLog.create).toHaveBeenCalledTimes(1);
    const call = mockedAuditLog.create.mock.calls[0][0];

    expect(call.data.action).toBe('update');
    expect(call.data.details).toMatchObject({
      previousValues: { age: 30, state: 'KA' },
      newValues: { age: 31, state: 'KA' },
    });
  });

  it('merges caller-provided details with previous/new values', async () => {
    await logModification({
      userId: 'user-5',
      actorIdentity: 'user:user-5',
      action: 'create',
      resourceType: 'user_profile',
      resourceId: 'profile-5',
      newValues: { age: 25 },
      details: { source: 'wizard' },
    });

    const call = mockedAuditLog.create.mock.calls[0][0];
    expect(call.data.details).toMatchObject({
      source: 'wizard',
      newValues: { age: 25 },
    });
    expect(call.data.details).not.toHaveProperty('previousValues');
  });

  it('records delete actions with previousValues only', async () => {
    await logModification({
      userId: 'user-6',
      actorIdentity: 'user:user-6',
      action: 'delete',
      resourceType: 'user_profile',
      resourceId: 'profile-6',
      previousValues: { age: 40 },
    });

    const call = mockedAuditLog.create.mock.calls[0][0];
    expect(call.data.action).toBe('delete');
    expect(call.data.details).toMatchObject({ previousValues: { age: 40 } });
    expect(call.data.details).not.toHaveProperty('newValues');
  });

  it('produces UTC timestamps', async () => {
    await logModification({
      userId: 'user-7',
      actorIdentity: 'user:user-7',
      action: 'update',
      resourceType: 'user_profile',
      resourceId: 'profile-7',
      newValues: { age: 50 },
    });

    const call = mockedAuditLog.create.mock.calls[0][0];
    const ts = call.data.timestamp as Date;
    expect(ts).toBeInstanceOf(Date);
    expect(ts.toISOString()).toMatch(/Z$/);
  });
});

// ─── Audit Service: getAuditLogs ─────────────────────────────────────────────

describe('AuditService.getAuditLogs', () => {
  it('passes filter values through to prisma', async () => {
    const start = new Date('2024-01-01T00:00:00Z');
    const end = new Date('2024-12-31T23:59:59Z');

    await getAuditLogs({
      userId: 'user-9',
      resourceType: 'user_profile',
      resourceId: 'profile-9',
      action: 'update',
      actorIdentity: 'admin:auditor',
      startDate: start,
      endDate: end,
      limit: 25,
      offset: 5,
    });

    expect(mockedAuditLog.findMany).toHaveBeenCalledTimes(1);
    const args = mockedAuditLog.findMany.mock.calls[0][0];

    expect(args.where).toMatchObject({
      userId: 'user-9',
      resourceType: 'user_profile',
      resourceId: 'profile-9',
      action: 'update',
      actorIdentity: 'admin:auditor',
    });
    expect(args.where.timestamp).toEqual({ gte: start, lte: end });
    expect(args.orderBy).toEqual({ timestamp: 'desc' });
    expect(args.take).toBe(25);
    expect(args.skip).toBe(5);
  });

  it('caps the limit to protect the database', async () => {
    await getAuditLogs({ limit: 100_000 });
    const args = mockedAuditLog.findMany.mock.calls[0][0];
    expect(args.take).toBeLessThanOrEqual(200);
  });

  it('uses an empty where clause when no filters are provided', async () => {
    await getAuditLogs();
    const args = mockedAuditLog.findMany.mock.calls[0][0];
    expect(args.where).toEqual({});
  });

  it('maps prisma rows to AuditLogEntry shape', async () => {
    const ts = new Date('2024-06-01T12:00:00Z');
    mockedAuditLog.findMany.mockResolvedValue([
      {
        id: 'a',
        userId: 'u',
        action: 'read',
        resourceType: 'user_profile',
        resourceId: 'p',
        details: { ip: '1.2.3.4' },
        actorIdentity: 'user:u',
        timestamp: ts,
      },
    ]);

    const rows = await getAuditLogs({ userId: 'u' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'a',
      userId: 'u',
      action: 'read',
      resourceType: 'user_profile',
      resourceId: 'p',
      details: { ip: '1.2.3.4' },
      actorIdentity: 'user:u',
      timestamp: ts,
    });
  });
});

// ─── Audit Service: pruneOldLogs ─────────────────────────────────────────────

describe('AuditService.pruneOldLogs', () => {
  it('does not delete logs newer than 365 days', async () => {
    mockedAuditLog.deleteMany.mockResolvedValue({ count: 0 });

    await pruneOldLogs(365);

    expect(mockedAuditLog.deleteMany).toHaveBeenCalledTimes(1);
    const args = mockedAuditLog.deleteMany.mock.calls[0][0];
    const cutoff = args.where.timestamp.lt as Date;

    // Cutoff must be at least 365 days in the past.
    const ageMs = Date.now() - cutoff.getTime();
    const minAgeMs = 365 * 24 * 60 * 60 * 1000;
    expect(ageMs).toBeGreaterThanOrEqual(minAgeMs - 1000); // small tolerance
  });

  it('clamps shorter retention requests to the 365-day minimum', async () => {
    await pruneOldLogs(30);

    const args = mockedAuditLog.deleteMany.mock.calls[0][0];
    const cutoff = args.where.timestamp.lt as Date;
    const ageMs = Date.now() - cutoff.getTime();
    const minAgeMs = 365 * 24 * 60 * 60 * 1000;

    // Even when 30 days were requested, the effective retention is 365 days.
    expect(ageMs).toBeGreaterThanOrEqual(minAgeMs - 1000);
  });

  it('honours longer retention windows when requested', async () => {
    await pruneOldLogs(730);

    const args = mockedAuditLog.deleteMany.mock.calls[0][0];
    const cutoff = args.where.timestamp.lt as Date;
    const ageMs = Date.now() - cutoff.getTime();
    const expectedMs = 730 * 24 * 60 * 60 * 1000;
    expect(ageMs).toBeGreaterThanOrEqual(expectedMs - 1000);
  });

  it('returns the number of deleted rows', async () => {
    mockedAuditLog.deleteMany.mockResolvedValue({ count: 7 });
    const deleted = await pruneOldLogs();
    expect(deleted).toBe(7);
  });
});

// ─── Middleware Helper Tests ─────────────────────────────────────────────────

describe('Audit Middleware Helpers', () => {
  describe('isProfileRoute', () => {
    it('matches /api/profile', () => {
      expect(isProfileRoute('/api/profile')).toBe(true);
    });

    it('matches /api/profile/ with trailing slash', () => {
      expect(isProfileRoute('/api/profile/')).toBe(true);
    });

    it('matches /api/profile/:id', () => {
      expect(isProfileRoute('/api/profile/abc-123')).toBe(true);
    });

    it('matches /api/profiles', () => {
      expect(isProfileRoute('/api/profiles')).toBe(true);
    });

    it('matches /api/user/profile', () => {
      expect(isProfileRoute('/api/user/profile')).toBe(true);
    });

    it('matches /api/users/profile', () => {
      expect(isProfileRoute('/api/users/profile')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isProfileRoute('/API/PROFILE')).toBe(true);
      expect(isProfileRoute('/Api/Profile')).toBe(true);
    });

    it('strips query parameters before matching', () => {
      expect(isProfileRoute('/api/profile?include=details')).toBe(true);
    });

    it('does NOT match /api/schemes', () => {
      expect(isProfileRoute('/api/schemes')).toBe(false);
    });

    it('does NOT match /api/notifications', () => {
      expect(isProfileRoute('/api/notifications')).toBe(false);
    });

    it('does NOT match /health', () => {
      expect(isProfileRoute('/health')).toBe(false);
    });

    it('does NOT match empty path', () => {
      expect(isProfileRoute('')).toBe(false);
    });
  });

  describe('extractUserId', () => {
    function mockRequest(overrides: Record<string, unknown> = {}) {
      return {
        headers: {},
        ...overrides,
      } as unknown as import('fastify').FastifyRequest;
    }

    it('extracts userId from request.user.id', () => {
      const req = mockRequest({ user: { id: 'user-123' } });
      expect(extractUserId(req)).toBe('user-123');
    });

    it('extracts userId from request.user.userId', () => {
      const req = mockRequest({ user: { userId: 'user-456' } });
      expect(extractUserId(req)).toBe('user-456');
    });

    it('extracts userId from request.user.sub (JWT)', () => {
      const req = mockRequest({ user: { sub: 'user-789' } });
      expect(extractUserId(req)).toBe('user-789');
    });

    it('falls back to x-user-id header', () => {
      const req = mockRequest({ headers: { 'x-user-id': 'header-user-1' } });
      expect(extractUserId(req)).toBe('header-user-1');
    });

    it('returns null when no user info is available', () => {
      const req = mockRequest({ headers: {} });
      expect(extractUserId(req)).toBeNull();
    });
  });

  describe('extractActorIdentity', () => {
    function mockRequest(overrides: Record<string, unknown> = {}) {
      return {
        headers: {},
        ip: '127.0.0.1',
        ...overrides,
      } as unknown as import('fastify').FastifyRequest;
    }

    it('returns admin identity from header', () => {
      const req = mockRequest({ headers: { 'x-admin-identity': 'admin:superuser' } });
      expect(extractActorIdentity(req)).toBe('admin:superuser');
    });

    it('returns service identity from header', () => {
      const req = mockRequest({ headers: { 'x-service-identity': 'service:crawler' } });
      expect(extractActorIdentity(req)).toBe('service:crawler');
    });

    it('returns user identity when user is available', () => {
      const req = mockRequest({ user: { id: 'user-abc' }, headers: {} });
      expect(extractActorIdentity(req)).toBe('user:user-abc');
    });

    it('returns anonymous with IP when no identity found', () => {
      const req = mockRequest({ headers: {}, ip: '192.168.1.1' });
      expect(extractActorIdentity(req)).toBe('anonymous:192.168.1.1');
    });
  });

  describe('extractResourceId', () => {
    it('extracts ID after /profile/', () => {
      expect(extractResourceId('/api/profile/abc-123')).toBe('abc-123');
    });

    it('extracts ID after /profiles/', () => {
      expect(extractResourceId('/api/profiles/def-456')).toBe('def-456');
    });

    it('extracts user ID from /users/:id/profile pattern', () => {
      expect(extractResourceId('/api/users/user-789/profile')).toBe('user-789');
    });

    it('returns null when no ID segment exists', () => {
      expect(extractResourceId('/api/profile')).toBeNull();
    });

    it('strips query parameters', () => {
      expect(extractResourceId('/api/profile/abc?include=all')).toBe('abc');
    });
  });
});
