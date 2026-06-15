/**
 * Unit tests for {@link SchemeManagementService}.
 *
 * Validates Req 17.2: administrators can manually verify, edit, or
 * remove a scheme, and the platform records the administrator
 * identity, action, and timestamp for each modification.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  EDITABLE_SCHEME_FIELDS,
  InvalidEditPatchError,
  MissingRemovalReasonError,
  SchemeManagementService,
  SchemeNotFoundError,
  VERIFIED_SCHEME_TRUST_SCORE,
  type AuditLogger,
} from './scheme-management-service';

interface SchemeRowFixture {
  id: string;
  name: string;
  description: string;
  ministry: string;
  state: string | null;
  category: string;
  sourceUrl: string;
  benefitType: string | null;
  benefitAmount: unknown;
  deadline: Date | null;
  applicationMode: string | null;
  applicationUrl: string | null;
  eligibilityCriteria: unknown;
  applicationSteps: unknown;
  trustScore: number;
  verified: boolean;
  lastVerifiedAt: Date | null;
  updatedAt: Date;
}

function makeScheme(overrides: Partial<SchemeRowFixture> = {}): SchemeRowFixture {
  return {
    id: 'scheme-1',
    name: 'Test Scheme',
    description: 'desc',
    ministry: 'Ministry',
    state: null,
    category: 'Education',
    sourceUrl: 'https://example.gov.in',
    benefitType: 'monetary',
    benefitAmount: 1000,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: null,
    eligibilityCriteria: [],
    applicationSteps: null,
    trustScore: 30,
    verified: false,
    lastVerifiedAt: null,
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeFakePrisma(seed: SchemeRowFixture[] = []) {
  const schemes = new Map<string, SchemeRowFixture>();
  for (const s of seed) schemes.set(s.id, { ...s });
  return {
    scheme: {
      async findUnique(args: { where: { id: string } }) {
        return schemes.get(args.where.id) ?? null;
      },
      async update(args: { where: { id: string }; data: Record<string, unknown> }) {
        const existing = schemes.get(args.where.id);
        if (!existing) throw new Error('not found');
        const next = { ...existing, ...args.data } as SchemeRowFixture;
        schemes.set(args.where.id, next);
        return { ...next };
      },
      async delete(args: { where: { id: string } }) {
        const existing = schemes.get(args.where.id);
        if (!existing) throw new Error('not found');
        schemes.delete(args.where.id);
        return { ...existing };
      },
    },
    _peek(id: string) {
      return schemes.get(id);
    },
  };
}

describe('SchemeManagementService.verifyScheme', () => {
  it('verifies an unverified scheme and lifts trust score above the threshold', async () => {
    const prisma = makeFakePrisma([makeScheme({ trustScore: 30, verified: false })]);
    const audit = vi.fn().mockResolvedValue(undefined) as unknown as AuditLogger;
    const fixedNow = new Date('2024-08-01T00:00:00Z');
    const service = new SchemeManagementService({ prisma, audit, now: () => fixedNow });

    const updated = await service.verifyScheme({
      schemeId: 'scheme-1',
      adminId: 'admin-1',
      note: 'Manually re-verified',
    });

    expect(updated.verified).toBe(true);
    expect(updated.trustScore).toBe(VERIFIED_SCHEME_TRUST_SCORE);
    expect(updated.lastVerifiedAt).toEqual(fixedNow);
    expect(prisma._peek('scheme-1')!.verified).toBe(true);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        action: 'admin.scheme.verify',
        resourceType: 'scheme',
        resourceId: 'scheme-1',
        actorIdentity: 'admin:admin-1',
        details: expect.objectContaining({
          previousTrustScore: 30,
          newTrustScore: VERIFIED_SCHEME_TRUST_SCORE,
          previousVerified: false,
          newVerified: true,
          note: 'Manually re-verified',
        }),
      }),
    );
  });

  it('throws SchemeNotFoundError when the scheme does not exist', async () => {
    const prisma = makeFakePrisma();
    const service = new SchemeManagementService({ prisma, audit: vi.fn() });
    await expect(
      service.verifyScheme({ schemeId: 'missing', adminId: 'a' }),
    ).rejects.toBeInstanceOf(SchemeNotFoundError);
  });
});

describe('SchemeManagementService.editScheme', () => {
  it('updates whitelisted fields and records previous + new values in the audit log', async () => {
    const prisma = makeFakePrisma([
      makeScheme({ name: 'Old Name', benefitAmount: 500 }),
    ]);
    const audit = vi.fn().mockResolvedValue(undefined) as unknown as AuditLogger;
    const service = new SchemeManagementService({ prisma, audit });

    const updated = await service.editScheme({
      schemeId: 'scheme-1',
      adminId: 'admin-1',
      patch: { name: 'New Name', benefitAmount: 750 },
      note: 'Updated per ministry circular',
    });

    expect(updated.name).toBe('New Name');
    expect(updated.benefitAmount).toBe(750);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.scheme.edit',
        actorIdentity: 'admin:admin-1',
        details: expect.objectContaining({
          changedFields: expect.arrayContaining(['name', 'benefitAmount']),
          previousValues: expect.objectContaining({
            name: 'Old Name',
            benefitAmount: 500,
          }),
          newValues: expect.objectContaining({
            name: 'New Name',
            benefitAmount: 750,
          }),
          note: 'Updated per ministry circular',
        }),
      }),
    );
  });

  it('rejects patches that include non-editable fields', async () => {
    const prisma = makeFakePrisma([makeScheme()]);
    const service = new SchemeManagementService({ prisma, audit: vi.fn() });
    await expect(
      service.editScheme({
        schemeId: 'scheme-1',
        adminId: 'admin-1',
        patch: { trustScore: 99 } as unknown as Record<string, unknown>,
      }),
    ).rejects.toBeInstanceOf(InvalidEditPatchError);
  });

  it('rejects empty patches with no editable fields', async () => {
    const prisma = makeFakePrisma([makeScheme()]);
    const service = new SchemeManagementService({ prisma, audit: vi.fn() });
    await expect(
      service.editScheme({ schemeId: 'scheme-1', adminId: 'admin-1', patch: {} }),
    ).rejects.toBeInstanceOf(InvalidEditPatchError);
  });

  it('coerces deadline strings to Date objects', async () => {
    const prisma = makeFakePrisma([makeScheme()]);
    const service = new SchemeManagementService({ prisma, audit: vi.fn() });
    const updated = await service.editScheme({
      schemeId: 'scheme-1',
      adminId: 'admin-1',
      patch: { deadline: '2025-01-15T00:00:00Z' },
    });
    expect(updated.deadline).toEqual(new Date('2025-01-15T00:00:00Z'));
  });

  it('rejects invalid date values', async () => {
    const prisma = makeFakePrisma([makeScheme()]);
    const service = new SchemeManagementService({ prisma, audit: vi.fn() });
    await expect(
      service.editScheme({
        schemeId: 'scheme-1',
        adminId: 'admin-1',
        patch: { deadline: 'definitely-not-a-date' },
      }),
    ).rejects.toBeInstanceOf(InvalidEditPatchError);
  });

  it('rejects negative benefit amounts', async () => {
    const prisma = makeFakePrisma([makeScheme()]);
    const service = new SchemeManagementService({ prisma, audit: vi.fn() });
    await expect(
      service.editScheme({
        schemeId: 'scheme-1',
        adminId: 'admin-1',
        patch: { benefitAmount: -1 },
      }),
    ).rejects.toBeInstanceOf(InvalidEditPatchError);
  });

  it('whitelist matches every field in EDITABLE_SCHEME_FIELDS', () => {
    // Sanity check — keep tests in sync with the public constant.
    expect(EDITABLE_SCHEME_FIELDS).toContain('name');
    expect(EDITABLE_SCHEME_FIELDS).toContain('description');
    expect(EDITABLE_SCHEME_FIELDS).not.toContain('trustScore');
    expect(EDITABLE_SCHEME_FIELDS).not.toContain('verified');
  });
});

describe('SchemeManagementService.removeScheme', () => {
  it('deletes the scheme and audits the removal with the supplied reason', async () => {
    const prisma = makeFakePrisma([makeScheme()]);
    const audit = vi.fn().mockResolvedValue(undefined) as unknown as AuditLogger;
    const service = new SchemeManagementService({ prisma, audit });

    await service.removeScheme({
      schemeId: 'scheme-1',
      adminId: 'admin-1',
      reason: 'Scheme cancelled by ministry',
    });

    expect(prisma._peek('scheme-1')).toBeUndefined();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.scheme.remove',
        actorIdentity: 'admin:admin-1',
        details: expect.objectContaining({
          reason: 'Scheme cancelled by ministry',
          snapshot: expect.objectContaining({ id: 'scheme-1' }),
        }),
      }),
    );
  });

  it('throws when the removal reason is empty', async () => {
    const prisma = makeFakePrisma([makeScheme()]);
    const service = new SchemeManagementService({ prisma, audit: vi.fn() });
    await expect(
      service.removeScheme({ schemeId: 'scheme-1', adminId: 'a', reason: '' }),
    ).rejects.toBeInstanceOf(MissingRemovalReasonError);
  });

  it('throws SchemeNotFoundError when the scheme does not exist', async () => {
    const prisma = makeFakePrisma();
    const service = new SchemeManagementService({ prisma, audit: vi.fn() });
    await expect(
      service.removeScheme({ schemeId: 'missing', adminId: 'a', reason: 'x' }),
    ).rejects.toBeInstanceOf(SchemeNotFoundError);
  });
});
