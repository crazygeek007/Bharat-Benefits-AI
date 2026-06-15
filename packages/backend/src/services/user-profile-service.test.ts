/**
 * Unit tests for User Profile Service.
 *
 * Validates: Requirements 3.1, 3.2, 3.4, 3.5, 3.6, 3.7
 *
 * Property-based tests for validateProfileData live in task 3.2; this file
 * covers concrete examples and integration-style flows using an in-memory
 * fake Prisma client so the tests run hermetically.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  UserProfileService,
  validateProfileData,
  ProfileValidationError,
  ProfileConflictError,
  ProfileNotFoundError,
  DeletionWindowExpiredError,
  DELETION_WINDOW_DAYS,
  type ProfilePrismaClient,
} from './user-profile-service';

// ─── Fake Prisma Client ──────────────────────────────────────────────────────

interface FakeProfileRow {
  id: string;
  userId: string;
  age: number | null;
  gender: string | null;
  state: string | null;
  district: string | null;
  incomeLevel: number | null;
  occupation: string | null;
  educationLevel: string | null;
  casteCategory: string | null;
  disabilityStatus: boolean | null;
  maritalStatus: string | null;
  dependents: number | null;
  languagePreference: string | null;
  updatedAt: Date;
}

interface FakeAuditRow {
  id: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  actorIdentity: string | null;
  timestamp: Date;
}

function createFakePrisma(): ProfilePrismaClient & {
  _profiles: Map<string, FakeProfileRow>;
  _audits: FakeAuditRow[];
} {
  const profiles = new Map<string, FakeProfileRow>();
  const audits: FakeAuditRow[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _profiles: profiles,
    _audits: audits,
    userProfile: {
      async findUnique({ where }) {
        return profiles.get(where.userId) ?? null;
      },
      async create({ data }) {
        const row: FakeProfileRow = {
          id: nextId(),
          userId: data.userId as string,
          age: (data.age as number | null) ?? null,
          gender: (data.gender as string | null) ?? null,
          state: (data.state as string | null) ?? null,
          district: (data.district as string | null) ?? null,
          incomeLevel: (data.incomeLevel as number | null) ?? null,
          occupation: (data.occupation as string | null) ?? null,
          educationLevel: (data.educationLevel as string | null) ?? null,
          casteCategory: (data.casteCategory as string | null) ?? null,
          disabilityStatus: (data.disabilityStatus as boolean | null) ?? null,
          maritalStatus: (data.maritalStatus as string | null) ?? null,
          dependents: (data.dependents as number | null) ?? null,
          languagePreference: (data.languagePreference as string | null) ?? null,
          updatedAt: new Date(),
        };
        profiles.set(row.userId, row);
        return row as unknown as Record<string, unknown>;
      },
      async update({ where, data }) {
        const current = profiles.get(where.userId);
        if (!current) throw new Error('Not found');
        const updated: FakeProfileRow = { ...current, ...(data as Partial<FakeProfileRow>), updatedAt: new Date() };
        profiles.set(where.userId, updated);
        return updated as unknown as Record<string, unknown>;
      },
      async delete({ where }) {
        const current = profiles.get(where.userId);
        if (!current) throw new Error('Not found');
        profiles.delete(where.userId);
        return current as unknown as Record<string, unknown>;
      },
    },
    auditLog: {
      async create({ data }) {
        const row: FakeAuditRow = {
          id: nextId(),
          userId: (data.userId as string | null) ?? null,
          action: data.action as string,
          resourceType: data.resourceType as string,
          resourceId: (data.resourceId as string | null) ?? null,
          details: (data.details as Record<string, unknown> | null) ?? null,
          actorIdentity: (data.actorIdentity as string | null) ?? null,
          timestamp: new Date(),
        };
        audits.push(row);
        return row;
      },
      async findFirst({ where }) {
        const filtered = audits.filter((a) => {
          for (const [k, v] of Object.entries(where)) {
            if ((a as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        });
        // Order by timestamp desc.
        filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        return (filtered[0] as unknown as Record<string, unknown>) ?? null;
      },
    },
  };
}

// ─── Validation Tests ────────────────────────────────────────────────────────

describe('validateProfileData (pure)', () => {
  const validInput = {
    age: 25,
    gender: 'Male' as const,
    state: 'Karnataka',
    incomeLevel: 500000,
  };

  it('accepts a complete valid create payload', () => {
    const result = validateProfileData(validInput, 'create');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects when required fields are missing in create mode', () => {
    const result = validateProfileData({}, 'create');
    expect(result.valid).toBe(false);
    const fields = result.errors.map((e) => e.field).sort();
    expect(fields).toEqual(['age', 'gender', 'income', 'state']);
  });

  it('accepts an empty payload in update mode', () => {
    const result = validateProfileData({}, 'update');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects age below 0', () => {
    const result = validateProfileData({ ...validInput, age: -1 }, 'create');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'age')).toBe(true);
  });

  it('rejects age above 150', () => {
    const result = validateProfileData({ ...validInput, age: 151 }, 'create');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'age')).toBe(true);
  });

  it('accepts boundary ages 0 and 150', () => {
    expect(validateProfileData({ ...validInput, age: 0 }, 'create').valid).toBe(true);
    expect(validateProfileData({ ...validInput, age: 150 }, 'create').valid).toBe(true);
  });

  it('rejects non-integer age', () => {
    const result = validateProfileData({ ...validInput, age: 25.5 }, 'create');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'age')).toBe(true);
  });

  it('rejects income below 0', () => {
    const result = validateProfileData({ ...validInput, incomeLevel: -1 }, 'create');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'incomeLevel')).toBe(true);
  });

  it('rejects income above 9_999_999_999', () => {
    const result = validateProfileData({ ...validInput, incomeLevel: 10_000_000_000 }, 'create');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'incomeLevel')).toBe(true);
  });

  it('rejects invalid gender', () => {
    const result = validateProfileData(
      { ...validInput, gender: 'Unknown' as unknown as 'Male' },
      'create',
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'gender')).toBe(true);
  });

  it('rejects invalid state', () => {
    const result = validateProfileData({ ...validInput, state: 'Mars' }, 'create');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'state')).toBe(true);
  });

  it('rejects invalid occupation', () => {
    const result = validateProfileData(
      { ...validInput, occupation: 'Astronaut' as unknown as 'Farmer' },
      'create',
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'occupation')).toBe(true);
  });

  it('rejects invalid education level', () => {
    const result = validateProfileData(
      { ...validInput, educationLevel: 'PhD' as unknown as 'Doctorate' },
      'create',
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'educationLevel')).toBe(true);
  });

  it('rejects invalid caste category', () => {
    const result = validateProfileData(
      { ...validInput, casteCategory: 'Other' as unknown as 'OBC' },
      'create',
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'casteCategory')).toBe(true);
  });

  it('rejects invalid marital status', () => {
    const result = validateProfileData(
      { ...validInput, maritalStatus: 'Engaged' as unknown as 'Single' },
      'create',
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'maritalStatus')).toBe(true);
  });

  it('rejects dependents out of range', () => {
    expect(
      validateProfileData({ ...validInput, dependents: -1 }, 'create').valid,
    ).toBe(false);
    expect(
      validateProfileData({ ...validInput, dependents: 21 }, 'create').valid,
    ).toBe(false);
  });

  it('accepts all valid optional fields together', () => {
    const result = validateProfileData(
      {
        ...validInput,
        district: 'Bengaluru',
        occupation: 'Salaried',
        educationLevel: 'Graduate',
        casteCategory: 'General',
        disabilityStatus: false,
        maritalStatus: 'Single',
        dependents: 2,
        languagePreference: 'en',
      },
      'create',
    );
    expect(result.valid).toBe(true);
  });

  it('update mode validates only provided fields', () => {
    // Bad age, no other fields — should still flag age and nothing else.
    const result = validateProfileData({ age: 200 }, 'update');
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('age');
  });
});

// ─── Service Lifecycle Tests ─────────────────────────────────────────────────

describe('UserProfileService (with fake Prisma)', () => {
  let prisma: ReturnType<typeof createFakePrisma>;
  let service: UserProfileService;

  const validInput = {
    age: 30,
    gender: 'Female' as const,
    state: 'Maharashtra',
    incomeLevel: 750000,
  };

  beforeEach(() => {
    prisma = createFakePrisma();
    service = new UserProfileService(prisma);
  });

  describe('createProfile', () => {
    it('creates a new profile when validation passes', async () => {
      const profile = await service.createProfile('user-1', validInput);
      expect(profile.userId).toBe('user-1');
      expect(profile.age).toBe(30);
      expect(profile.state).toBe('Maharashtra');
      expect(prisma._profiles.size).toBe(1);
    });

    it('throws ProfileValidationError when input is invalid', async () => {
      await expect(
        service.createProfile('user-1', { ...validInput, age: -5 }),
      ).rejects.toBeInstanceOf(ProfileValidationError);
      expect(prisma._profiles.size).toBe(0);
    });

    it('throws ProfileConflictError when profile already exists', async () => {
      await service.createProfile('user-1', validInput);
      await expect(service.createProfile('user-1', validInput)).rejects.toBeInstanceOf(
        ProfileConflictError,
      );
    });
  });

  describe('updateProfile', () => {
    it('updates only provided fields and retains the rest', async () => {
      await service.createProfile('user-1', validInput);
      const updated = await service.updateProfile('user-1', { age: 31 });
      expect(updated.age).toBe(31);
      expect(updated.state).toBe('Maharashtra'); // unchanged
    });

    it('retains old values when validation fails', async () => {
      await service.createProfile('user-1', validInput);
      await expect(
        service.updateProfile('user-1', { age: 999 }),
      ).rejects.toBeInstanceOf(ProfileValidationError);
      const stored = prisma._profiles.get('user-1');
      expect(stored?.age).toBe(30); // original retained
    });

    it('throws ProfileNotFoundError when no profile exists', async () => {
      await expect(
        service.updateProfile('missing-user', { age: 35 }),
      ).rejects.toBeInstanceOf(ProfileNotFoundError);
    });
  });

  describe('deleteProfile', () => {
    it('schedules deletion 30 days in the future', async () => {
      await service.createProfile('user-1', validInput);
      const before = Date.now();
      const schedule = await service.deleteProfile('user-1');
      const after = Date.now();

      const delta = schedule.scheduledDeletionDate.getTime() - schedule.scheduledAt.getTime();
      const expected = DELETION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      expect(delta).toBe(expected);
      expect(schedule.scheduledAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(schedule.scheduledAt.getTime()).toBeLessThanOrEqual(after);
      expect(schedule.status).toBe('pending_confirmation');

      // Profile is NOT deleted yet — only scheduled.
      expect(prisma._profiles.has('user-1')).toBe(true);

      // Audit log records the schedule.
      const audit = prisma._audits.find((a) => a.action === 'PROFILE_DELETION_SCHEDULED');
      expect(audit).toBeDefined();
    });

    it('throws ProfileNotFoundError when no profile exists', async () => {
      await expect(service.deleteProfile('missing-user')).rejects.toBeInstanceOf(
        ProfileNotFoundError,
      );
    });
  });

  describe('confirmDeletion', () => {
    it('permanently deletes the profile when confirmed within window', async () => {
      await service.createProfile('user-1', validInput);
      await service.deleteProfile('user-1');

      await service.confirmDeletion('user-1', true);

      expect(prisma._profiles.has('user-1')).toBe(false);
      const confirmed = prisma._audits.find((a) => a.action === 'PROFILE_DELETION_CONFIRMED');
      expect(confirmed).toBeDefined();
    });

    it('cancels the deletion when confirmation is false', async () => {
      await service.createProfile('user-1', validInput);
      await service.deleteProfile('user-1');

      await service.confirmDeletion('user-1', false);

      expect(prisma._profiles.has('user-1')).toBe(true);
      const cancelled = prisma._audits.find((a) => a.action === 'PROFILE_DELETION_CANCELLED');
      expect(cancelled).toBeDefined();
    });

    it('throws DeletionWindowExpiredError after the 30-day window', async () => {
      await service.createProfile('user-1', validInput);
      await service.deleteProfile('user-1');

      // Tamper the audit log to simulate the schedule being in the past.
      const audit = prisma._audits.find((a) => a.action === 'PROFILE_DELETION_SCHEDULED');
      if (audit?.details) {
        const pastDate = new Date(Date.now() - 1000);
        audit.details.scheduledDeletionDate = pastDate.toISOString();
      }

      await expect(service.confirmDeletion('user-1', true)).rejects.toBeInstanceOf(
        DeletionWindowExpiredError,
      );
      // Profile is preserved when window expired.
      expect(prisma._profiles.has('user-1')).toBe(true);
    });
  });

  describe('cancelDeletion', () => {
    it('records a cancellation audit entry', async () => {
      await service.createProfile('user-1', validInput);
      await service.deleteProfile('user-1');

      await service.cancelDeletion('user-1');

      const cancelled = prisma._audits.find((a) => a.action === 'PROFILE_DELETION_CANCELLED');
      expect(cancelled).toBeDefined();
      expect(prisma._profiles.has('user-1')).toBe(true);
    });

    it('throws ProfileNotFoundError when no schedule exists', async () => {
      await expect(service.cancelDeletion('missing-user')).rejects.toBeInstanceOf(
        ProfileNotFoundError,
      );
    });
  });
});
