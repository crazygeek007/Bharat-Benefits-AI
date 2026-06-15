/**
 * Unit tests for {@link SchemeFlagsService}.
 *
 * Validates:
 *   - Req 17.3 — flags are returned sorted by `flaggedAt` descending.
 *   - Req 17.5 — approving a flag flips the underlying scheme to
 *     verified and lifts its trust score.
 *   - Req 17.6 — rejecting a flag keeps the scheme hidden and records
 *     the administrator-supplied reason.
 *   - Req 17.2 — every transition produces an audit-log entry capturing
 *     the administrator identity, the action, and the timestamp.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  APPROVED_FLAG_TRUST_SCORE,
  FlagAlreadyResolvedError,
  FlagNotFoundError,
  MissingRejectionReasonError,
  SchemeFlagsService,
  type AuditLogger,
} from './scheme-flags-service';

interface SchemeFlagFixture {
  id: string;
  schemeId: string;
  reason: string;
  flagSource: string;
  sourceUrl: string | null;
  status: string;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  flaggedAt: Date;
  scheme?: SchemeFixture | null;
}

interface SchemeFixture {
  id: string;
  name: string;
  ministry: string;
  state: string | null;
  trustScore: number;
  verified: boolean;
  lastVerifiedAt: Date | null;
}

function makeFakePrisma(seed: {
  flags?: SchemeFlagFixture[];
  schemes?: SchemeFixture[];
} = {}) {
  const flags = new Map<string, SchemeFlagFixture>();
  const schemes = new Map<string, SchemeFixture>();
  for (const f of seed.flags ?? []) flags.set(f.id, { ...f });
  for (const s of seed.schemes ?? []) schemes.set(s.id, { ...s });

  const fake = {
    schemeFlag: {
      async findMany(args: {
        where?: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
        skip?: number;
        include?: { scheme?: boolean };
      }) {
        let rows = Array.from(flags.values());
        const status = (args?.where as { status?: string } | undefined)?.status;
        if (status) {
          rows = rows.filter((r) => r.status === status);
        }
        const orderEntry = Array.isArray(args?.orderBy)
          ? (args!.orderBy as Array<{ flaggedAt?: 'asc' | 'desc' }>)[0]
          : (args?.orderBy as { flaggedAt?: 'asc' | 'desc' } | undefined);
        const order = orderEntry?.flaggedAt ?? 'desc';
        rows.sort((a, b) => {
          const cmp = a.flaggedAt.getTime() - b.flaggedAt.getTime();
          return order === 'desc' ? -cmp : cmp;
        });
        const skip = args?.skip ?? 0;
        const take = args?.take ?? rows.length;
        const sliced = rows.slice(skip, skip + take);
        if (args?.include?.scheme) {
          return sliced.map((r) => ({
            ...r,
            scheme: r.scheme ?? schemes.get(r.schemeId) ?? null,
          }));
        }
        return sliced.map((r) => ({ ...r }));
      },
      async count(args: { where?: Record<string, unknown> } = {}) {
        let rows = Array.from(flags.values());
        const status = (args?.where as { status?: string } | undefined)?.status;
        if (status) {
          rows = rows.filter((r) => r.status === status);
        }
        return rows.length;
      },
      async findUnique(args: {
        where: { id: string };
        include?: { scheme?: boolean };
      }) {
        const row = flags.get(args.where.id);
        if (!row) return null;
        if (args.include?.scheme) {
          return { ...row, scheme: row.scheme ?? schemes.get(row.schemeId) ?? null };
        }
        return { ...row };
      },
      async create(args: { data: Partial<SchemeFlagFixture> }) {
        const id = (args.data.id as string | undefined) ?? `flag-${flags.size + 1}`;
        const row: SchemeFlagFixture = {
          id,
          schemeId: args.data.schemeId as string,
          reason: args.data.reason as string,
          flagSource: (args.data.flagSource as string) ?? 'admin',
          sourceUrl: (args.data.sourceUrl as string | null) ?? null,
          status: (args.data.status as string) ?? 'pending',
          resolvedBy: null,
          resolvedAt: null,
          resolutionNote: null,
          flaggedAt: (args.data.flaggedAt as Date) ?? new Date(),
        };
        flags.set(id, row);
        return { ...row };
      },
      async update(args: { where: { id: string }; data: Partial<SchemeFlagFixture> }) {
        const row = flags.get(args.where.id);
        if (!row) throw new Error('flag not found');
        const next = { ...row, ...args.data };
        flags.set(args.where.id, next);
        return { ...next };
      },
    },
    scheme: {
      async update(args: { where: { id: string }; data: Partial<SchemeFixture> }) {
        const existing = schemes.get(args.where.id);
        if (!existing) throw new Error('scheme not found');
        const next = { ...existing, ...args.data };
        schemes.set(args.where.id, next);
        return { ...next };
      },
      async findUnique(args: { where: { id: string } }) {
        return schemes.get(args.where.id) ?? null;
      },
    },
    /** Test-only — read the latest version of a flag/scheme. */
    _peekFlag(id: string) {
      return flags.get(id);
    },
    _peekScheme(id: string) {
      return schemes.get(id);
    },
  };
  return fake;
}

function makeFlag(overrides: Partial<SchemeFlagFixture> = {}): SchemeFlagFixture {
  return {
    id: overrides.id ?? 'flag-1',
    schemeId: overrides.schemeId ?? 'scheme-1',
    reason: overrides.reason ?? 'Trust score below threshold',
    flagSource: overrides.flagSource ?? 'crawler',
    sourceUrl: overrides.sourceUrl ?? 'https://example.gov.in/source',
    status: overrides.status ?? 'pending',
    resolvedBy: overrides.resolvedBy ?? null,
    resolvedAt: overrides.resolvedAt ?? null,
    resolutionNote: overrides.resolutionNote ?? null,
    flaggedAt: overrides.flaggedAt ?? new Date('2024-05-01T00:00:00Z'),
    scheme: overrides.scheme,
  };
}

function makeScheme(overrides: Partial<SchemeFixture> = {}): SchemeFixture {
  return {
    id: overrides.id ?? 'scheme-1',
    name: overrides.name ?? 'Test Scheme',
    ministry: overrides.ministry ?? 'Ministry of Test',
    state: overrides.state ?? null,
    trustScore: overrides.trustScore ?? 30,
    verified: overrides.verified ?? false,
    lastVerifiedAt: overrides.lastVerifiedAt ?? null,
  };
}

describe('SchemeFlagsService.listFlags', () => {
  it('returns pending flags by default ordered by flaggedAt descending', async () => {
    const prisma = makeFakePrisma({
      schemes: [makeScheme()],
      flags: [
        makeFlag({ id: 'a', flaggedAt: new Date('2024-04-01') }),
        makeFlag({ id: 'b', flaggedAt: new Date('2024-06-01') }),
        makeFlag({ id: 'c', flaggedAt: new Date('2024-05-15') }),
        makeFlag({ id: 'd', flaggedAt: new Date('2024-06-30'), status: 'rejected' }),
      ],
    });
    const service = new SchemeFlagsService({ prisma, audit: vi.fn() });

    const result = await service.listFlags();
    expect(result.totalCount).toBe(3);
    expect(result.flags.map((f) => f.id)).toEqual(['b', 'c', 'a']);
    // Embedded scheme summary is included
    expect(result.flags[0].scheme?.id).toBe('scheme-1');
  });

  it('returns all flags (any status) when filter.status === "all"', async () => {
    const prisma = makeFakePrisma({
      schemes: [makeScheme()],
      flags: [
        makeFlag({ id: 'p', flaggedAt: new Date('2024-04-01'), status: 'pending' }),
        makeFlag({ id: 'a', flaggedAt: new Date('2024-05-01'), status: 'approved' }),
        makeFlag({ id: 'r', flaggedAt: new Date('2024-06-01'), status: 'rejected' }),
      ],
    });
    const service = new SchemeFlagsService({ prisma, audit: vi.fn() });

    const result = await service.listFlags({ status: 'all' });
    expect(result.totalCount).toBe(3);
    expect(result.flags.map((f) => f.id)).toEqual(['r', 'a', 'p']);
  });

  it('respects limit and offset for pagination', async () => {
    const prisma = makeFakePrisma({
      schemes: [makeScheme()],
      flags: Array.from({ length: 5 }, (_, i) =>
        makeFlag({
          id: `flag-${i}`,
          flaggedAt: new Date(2024, 0, i + 1),
        }),
      ),
    });
    const service = new SchemeFlagsService({ prisma, audit: vi.fn() });

    const page1 = await service.listFlags({ limit: 2, offset: 0 });
    expect(page1.flags).toHaveLength(2);
    const page2 = await service.listFlags({ limit: 2, offset: 2 });
    expect(page2.flags).toHaveLength(2);
    expect(page1.flags[0].id).not.toBe(page2.flags[0].id);
  });
});

describe('SchemeFlagsService.approveFlag', () => {
  it('lifts trust score above the visibility threshold and verifies the scheme', async () => {
    const prisma = makeFakePrisma({
      schemes: [makeScheme({ trustScore: 30, verified: false })],
      flags: [makeFlag({ id: 'flag-1', schemeId: 'scheme-1' })],
    });
    const audit = vi.fn().mockResolvedValue(undefined) as unknown as AuditLogger;
    const fixedNow = new Date('2024-07-15T12:00:00Z');
    const service = new SchemeFlagsService({
      prisma,
      audit,
      now: () => fixedNow,
    });

    const result = await service.approveFlag({
      flagId: 'flag-1',
      adminId: 'admin-42',
    });

    expect(result.status).toBe('approved');
    expect(result.resolvedBy).toBe('admin-42');
    expect(result.resolvedAt).toEqual(fixedNow);

    const updatedScheme = prisma._peekScheme('scheme-1');
    expect(updatedScheme).toBeDefined();
    expect(updatedScheme!.verified).toBe(true);
    expect(updatedScheme!.trustScore).toBe(APPROVED_FLAG_TRUST_SCORE);
    expect(updatedScheme!.lastVerifiedAt).toEqual(fixedNow);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-42',
        action: 'admin.flag.approve',
        resourceType: 'scheme',
        resourceId: 'scheme-1',
        actorIdentity: 'admin:admin-42',
      }),
    );
  });

  it('preserves a higher existing trust score when approving', async () => {
    const prisma = makeFakePrisma({
      schemes: [makeScheme({ trustScore: 85, verified: false })],
      flags: [makeFlag({ id: 'flag-1', schemeId: 'scheme-1' })],
    });
    const service = new SchemeFlagsService({ prisma, audit: vi.fn() });

    await service.approveFlag({ flagId: 'flag-1', adminId: 'admin-1' });

    expect(prisma._peekScheme('scheme-1')!.trustScore).toBe(85);
  });

  it('rejects approval of a flag that does not exist', async () => {
    const prisma = makeFakePrisma();
    const service = new SchemeFlagsService({ prisma, audit: vi.fn() });
    await expect(
      service.approveFlag({ flagId: 'missing', adminId: 'admin-1' }),
    ).rejects.toBeInstanceOf(FlagNotFoundError);
  });

  it('rejects approval of an already-resolved flag', async () => {
    const prisma = makeFakePrisma({
      schemes: [makeScheme()],
      flags: [makeFlag({ id: 'flag-1', status: 'approved' })],
    });
    const service = new SchemeFlagsService({ prisma, audit: vi.fn() });
    await expect(
      service.approveFlag({ flagId: 'flag-1', adminId: 'admin-1' }),
    ).rejects.toBeInstanceOf(FlagAlreadyResolvedError);
  });
});

describe('SchemeFlagsService.rejectFlag', () => {
  it('keeps the scheme hidden and records the rejection reason', async () => {
    const prisma = makeFakePrisma({
      schemes: [makeScheme({ verified: false })],
      flags: [makeFlag({ id: 'flag-1' })],
    });
    const audit = vi.fn().mockResolvedValue(undefined) as unknown as AuditLogger;
    const service = new SchemeFlagsService({ prisma, audit });

    const result = await service.rejectFlag({
      flagId: 'flag-1',
      adminId: 'admin-42',
      reason: 'Scheme is no longer in effect',
    });

    expect(result.status).toBe('rejected');
    expect(result.resolutionNote).toBe('Scheme is no longer in effect');
    expect(prisma._peekScheme('scheme-1')!.verified).toBe(false);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.flag.reject',
        actorIdentity: 'admin:admin-42',
        details: expect.objectContaining({
          reason: 'Scheme is no longer in effect',
        }),
      }),
    );
  });

  it('forces verified=false even when the scheme was already verified', async () => {
    const prisma = makeFakePrisma({
      schemes: [makeScheme({ verified: true, trustScore: 90 })],
      flags: [makeFlag({ id: 'flag-1' })],
    });
    const service = new SchemeFlagsService({ prisma, audit: vi.fn() });

    await service.rejectFlag({
      flagId: 'flag-1',
      adminId: 'admin-1',
      reason: 'No longer valid',
    });

    expect(prisma._peekScheme('scheme-1')!.verified).toBe(false);
  });

  it('throws when the rejection reason is empty', async () => {
    const prisma = makeFakePrisma({
      schemes: [makeScheme()],
      flags: [makeFlag({ id: 'flag-1' })],
    });
    const service = new SchemeFlagsService({ prisma, audit: vi.fn() });
    await expect(
      service.rejectFlag({ flagId: 'flag-1', adminId: 'admin-1', reason: '   ' }),
    ).rejects.toBeInstanceOf(MissingRejectionReasonError);
  });
});

describe('SchemeFlagsService.createFlag', () => {
  it('creates a pending flag with the supplied source URL', async () => {
    const prisma = makeFakePrisma({ schemes: [makeScheme()] });
    const service = new SchemeFlagsService({ prisma, audit: vi.fn() });

    const flag = await service.createFlag({
      schemeId: 'scheme-1',
      reason: 'Mandatory field missing',
      flagSource: 'crawler',
      sourceUrl: 'https://example.gov.in/source',
    });

    expect(flag.status).toBe('pending');
    expect(flag.reason).toBe('Mandatory field missing');
    expect(flag.flagSource).toBe('crawler');
    expect(flag.sourceUrl).toBe('https://example.gov.in/source');
  });

  it('rejects empty reasons', async () => {
    const prisma = makeFakePrisma();
    const service = new SchemeFlagsService({ prisma, audit: vi.fn() });
    await expect(
      service.createFlag({
        schemeId: 'scheme-1',
        reason: '   ',
        flagSource: 'admin',
      }),
    ).rejects.toThrow(/reason is required/i);
  });
});
