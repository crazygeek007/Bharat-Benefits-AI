/**
 * User Profile Service
 *
 * Manages user profile lifecycle with validation, persistence,
 * and 30-day deletion scheduling with confirmation flow.
 *
 * Validates: Requirements 3.1, 3.2, 3.4, 3.5, 3.6, 3.7
 */

import {
  CreateProfileInput,
  UpdateProfileInput,
  UserProfile,
  ValidationResult,
  FieldValidationError,
  PROFILE_CONSTRAINTS,
  Gender,
  Occupation,
  EducationLevel,
  CasteCategory,
  MaritalStatus,
  SupportedLanguage,
  INDIAN_STATES,
} from '@bharat-benefits/shared';
import prismaDefault from '../lib/prisma';

/** Number of days before scheduled deletion is finalized (Requirement 3.6). */
export const DELETION_WINDOW_DAYS = 30;

/** Validation mode for {@link validateProfileData}. */
export type ValidationMode = 'create' | 'update';

/** Result returned when scheduling a profile deletion. */
export interface DeletionSchedule {
  userId: string;
  scheduledAt: Date;
  scheduledDeletionDate: Date;
  status: 'pending_confirmation';
}

/**
 * Minimal Prisma client surface used by this service.
 * Declared structurally so tests can pass an in-memory fake without
 * pulling in the full generated client type.
 */
export interface ProfilePrismaClient {
  userProfile: {
    findUnique: (args: { where: { userId: string } }) => Promise<unknown | null>;
    create: (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    update: (args: {
      where: { userId: string };
      data: Record<string, unknown>;
    }) => Promise<Record<string, unknown>>;
    delete: (args: { where: { userId: string } }) => Promise<Record<string, unknown>>;
  };
  auditLog: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
    findFirst: (args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }) => Promise<Record<string, unknown> | null>;
  };
}

// ─── Pure Validation Function (exported for property tests) ──────────────────

/**
 * Pure validation function for profile data.
 *
 * In `'create'` mode, all required fields (age, gender, state, income) MUST
 * be present and valid. In `'update'` mode, only fields that are actually
 * provided are validated; missing fields are treated as "no change".
 *
 * Returns a {@link ValidationResult} listing any field-level errors. The
 * function is pure (no I/O, no side effects) and is safe to call from
 * property-based tests with arbitrary inputs.
 */
export function validateProfileData(
  data: Partial<CreateProfileInput & UpdateProfileInput>,
  mode: ValidationMode = 'create',
): ValidationResult {
  const errors: FieldValidationError[] = [];

  // Required-field check (create mode only).
  if (mode === 'create') {
    const requiredFieldMap: Record<string, unknown> = {
      age: data.age,
      gender: data.gender,
      state: data.state,
      income: data.incomeLevel,
    };
    for (const field of PROFILE_CONSTRAINTS.requiredFields) {
      const value = requiredFieldMap[field];
      if (value === undefined || value === null || value === '') {
        errors.push({
          field,
          value: value ?? null,
          reason: `${field} is a required field`,
        });
      }
    }
  }

  // Age range validation.
  if (data.age !== undefined && data.age !== null) {
    if (
      typeof data.age !== 'number' ||
      !Number.isInteger(data.age) ||
      data.age < PROFILE_CONSTRAINTS.age.min ||
      data.age > PROFILE_CONSTRAINTS.age.max
    ) {
      errors.push({
        field: 'age',
        value: data.age,
        reason: `age must be an integer between ${PROFILE_CONSTRAINTS.age.min} and ${PROFILE_CONSTRAINTS.age.max}`,
      });
    }
  }

  // Income range validation.
  if (data.incomeLevel !== undefined && data.incomeLevel !== null) {
    if (
      typeof data.incomeLevel !== 'number' ||
      Number.isNaN(data.incomeLevel) ||
      !Number.isFinite(data.incomeLevel) ||
      data.incomeLevel < PROFILE_CONSTRAINTS.income.min ||
      data.incomeLevel > PROFILE_CONSTRAINTS.income.max
    ) {
      errors.push({
        field: 'incomeLevel',
        value: data.incomeLevel,
        reason: `incomeLevel must be a number between ${PROFILE_CONSTRAINTS.income.min} and ${PROFILE_CONSTRAINTS.income.max}`,
      });
    }
  }

  // Gender enum validation.
  if (data.gender !== undefined && data.gender !== null) {
    if (!PROFILE_CONSTRAINTS.gender.includes(data.gender as Gender)) {
      errors.push({
        field: 'gender',
        value: data.gender,
        reason: `gender must be one of: ${PROFILE_CONSTRAINTS.gender.join(', ')}`,
      });
    }
  }

  // State validation against the configured Indian states list.
  if (data.state !== undefined && data.state !== null && data.state !== '') {
    if (!INDIAN_STATES.includes(data.state)) {
      errors.push({
        field: 'state',
        value: data.state,
        reason: 'state must be a valid Indian state or union territory',
      });
    }
  }

  // Occupation enum validation (optional).
  if (data.occupation !== undefined && data.occupation !== null) {
    if (!PROFILE_CONSTRAINTS.occupation.includes(data.occupation as Occupation)) {
      errors.push({
        field: 'occupation',
        value: data.occupation,
        reason: `occupation must be one of: ${PROFILE_CONSTRAINTS.occupation.join(', ')}`,
      });
    }
  }

  // Education enum validation (optional).
  if (data.educationLevel !== undefined && data.educationLevel !== null) {
    if (!PROFILE_CONSTRAINTS.education.includes(data.educationLevel as EducationLevel)) {
      errors.push({
        field: 'educationLevel',
        value: data.educationLevel,
        reason: `educationLevel must be one of: ${PROFILE_CONSTRAINTS.education.join(', ')}`,
      });
    }
  }

  // Caste enum validation (optional).
  if (data.casteCategory !== undefined && data.casteCategory !== null) {
    if (!PROFILE_CONSTRAINTS.caste.includes(data.casteCategory as CasteCategory)) {
      errors.push({
        field: 'casteCategory',
        value: data.casteCategory,
        reason: `casteCategory must be one of: ${PROFILE_CONSTRAINTS.caste.join(', ')}`,
      });
    }
  }

  // Marital status enum validation (optional).
  if (data.maritalStatus !== undefined && data.maritalStatus !== null) {
    if (!PROFILE_CONSTRAINTS.maritalStatus.includes(data.maritalStatus as MaritalStatus)) {
      errors.push({
        field: 'maritalStatus',
        value: data.maritalStatus,
        reason: `maritalStatus must be one of: ${PROFILE_CONSTRAINTS.maritalStatus.join(', ')}`,
      });
    }
  }

  // Dependents range validation (optional).
  if (data.dependents !== undefined && data.dependents !== null) {
    if (
      typeof data.dependents !== 'number' ||
      !Number.isInteger(data.dependents) ||
      data.dependents < PROFILE_CONSTRAINTS.dependents.min ||
      data.dependents > PROFILE_CONSTRAINTS.dependents.max
    ) {
      errors.push({
        field: 'dependents',
        value: data.dependents,
        reason: `dependents must be an integer between ${PROFILE_CONSTRAINTS.dependents.min} and ${PROFILE_CONSTRAINTS.dependents.max}`,
      });
    }
  }

  // Disability status (must be boolean if present).
  if (data.disabilityStatus !== undefined && data.disabilityStatus !== null) {
    if (typeof data.disabilityStatus !== 'boolean') {
      errors.push({
        field: 'disabilityStatus',
        value: data.disabilityStatus,
        reason: 'disabilityStatus must be a boolean',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ─── Service Class ───────────────────────────────────────────────────────────

/**
 * Service for managing citizen profiles.
 *
 * The Prisma client is injected for testability. In production the default
 * singleton from `lib/prisma` is used; tests can pass a fake implementing
 * {@link ProfilePrismaClient}.
 */
export class UserProfileService {
  constructor(private readonly prisma: ProfilePrismaClient = prismaDefault as unknown as ProfilePrismaClient) {}

  /**
   * Pure validation entry point on the service. Delegates to the exported
   * {@link validateProfileData} function so behaviour is identical regardless
   * of how validation is invoked.
   */
  validateProfileData(
    data: Partial<CreateProfileInput & UpdateProfileInput>,
    mode: ValidationMode = 'create',
  ): ValidationResult {
    return validateProfileData(data, mode);
  }

  /**
   * Creates a new profile after validation. Throws on validation failure or
   * if a profile already exists for the user.
   */
  async createProfile(userId: string, data: CreateProfileInput): Promise<UserProfile> {
    const validation = validateProfileData(data, 'create');
    if (!validation.valid) {
      throw new ProfileValidationError('Profile validation failed', validation.errors);
    }

    const existing = await this.prisma.userProfile.findUnique({ where: { userId } });
    if (existing) {
      throw new ProfileConflictError('Profile already exists for this user');
    }

    const created = await this.prisma.userProfile.create({
      data: {
        userId,
        age: data.age,
        gender: data.gender,
        state: data.state,
        district: data.district ?? null,
        incomeLevel: data.incomeLevel,
        occupation: data.occupation ?? null,
        educationLevel: data.educationLevel ?? null,
        casteCategory: data.casteCategory ?? null,
        disabilityStatus: data.disabilityStatus ?? null,
        maritalStatus: data.maritalStatus ?? null,
        dependents: data.dependents ?? null,
        languagePreference: data.languagePreference ?? 'en',
      },
    });

    return mapToUserProfile(created);
  }

  /**
   * Updates an existing profile after partial validation. If validation fails,
   * the previously stored values are retained (Requirement 3.4) — no DB write
   * is performed and a {@link ProfileValidationError} is thrown.
   */
  async updateProfile(userId: string, data: UpdateProfileInput): Promise<UserProfile> {
    const validation = validateProfileData(data, 'update');
    if (!validation.valid) {
      throw new ProfileValidationError('Profile validation failed', validation.errors);
    }

    const existing = await this.prisma.userProfile.findUnique({ where: { userId } });
    if (!existing) {
      throw new ProfileNotFoundError('Profile not found for this user');
    }

    const updateData: Record<string, unknown> = {};
    if (data.age !== undefined) updateData.age = data.age;
    if (data.gender !== undefined) updateData.gender = data.gender;
    if (data.state !== undefined) updateData.state = data.state;
    if (data.district !== undefined) updateData.district = data.district;
    if (data.incomeLevel !== undefined) updateData.incomeLevel = data.incomeLevel;
    if (data.occupation !== undefined) updateData.occupation = data.occupation;
    if (data.educationLevel !== undefined) updateData.educationLevel = data.educationLevel;
    if (data.casteCategory !== undefined) updateData.casteCategory = data.casteCategory;
    if (data.disabilityStatus !== undefined) updateData.disabilityStatus = data.disabilityStatus;
    if (data.maritalStatus !== undefined) updateData.maritalStatus = data.maritalStatus;
    if (data.dependents !== undefined) updateData.dependents = data.dependents;
    if (data.languagePreference !== undefined) updateData.languagePreference = data.languagePreference;

    const updated = await this.prisma.userProfile.update({
      where: { userId },
      data: updateData,
    });

    return mapToUserProfile(updated);
  }

  /**
   * Schedules profile deletion 30 days in the future and records the schedule
   * in the audit log. The profile is not actually deleted until the citizen
   * explicitly confirms via {@link confirmDeletion}, or the window elapses
   * (handled by a separate background job).
   */
  async deleteProfile(userId: string): Promise<DeletionSchedule> {
    const existing = (await this.prisma.userProfile.findUnique({ where: { userId } })) as
      | { id: string }
      | null;
    if (!existing) {
      throw new ProfileNotFoundError('Profile not found for this user');
    }

    const scheduledAt = new Date();
    const scheduledDeletionDate = new Date(scheduledAt.getTime());
    scheduledDeletionDate.setDate(scheduledDeletionDate.getDate() + DELETION_WINDOW_DAYS);

    await this.prisma.auditLog.create({
      data: {
        userId,
        action: 'PROFILE_DELETION_SCHEDULED',
        resourceType: 'user_profile',
        resourceId: existing.id,
        actorIdentity: `user:${userId}`,
        details: {
          scheduledAt: scheduledAt.toISOString(),
          scheduledDeletionDate: scheduledDeletionDate.toISOString(),
          status: 'pending_confirmation',
        },
      },
    });

    return {
      userId,
      scheduledAt,
      scheduledDeletionDate,
      status: 'pending_confirmation',
    };
  }

  /**
   * Confirms (or rejects) a previously scheduled deletion.
   *
   * - When `confirmation` is `true`, the profile is permanently deleted
   *   provided the confirmation occurs within the 30-day deletion window.
   * - When `confirmation` is `false`, the deletion is cancelled and the
   *   profile is retained.
   *
   * Throws {@link DeletionWindowExpiredError} if the citizen tries to confirm
   * after the 30-day window has elapsed.
   */
  async confirmDeletion(userId: string, confirmation: boolean): Promise<void> {
    if (!confirmation) {
      await this.cancelDeletion(userId);
      return;
    }

    const schedule = (await this.prisma.auditLog.findFirst({
      where: { userId, action: 'PROFILE_DELETION_SCHEDULED' },
      orderBy: { timestamp: 'desc' },
    })) as { details?: Record<string, unknown> } | null;

    if (!schedule) {
      throw new ProfileNotFoundError('No scheduled deletion found for this user');
    }

    const scheduledIso = schedule.details?.scheduledDeletionDate as string | undefined;
    if (scheduledIso) {
      const deadline = new Date(scheduledIso);
      if (Date.now() > deadline.getTime()) {
        throw new DeletionWindowExpiredError(
          'The 30-day deletion confirmation window has expired',
        );
      }
    }

    const existing = (await this.prisma.userProfile.findUnique({ where: { userId } })) as
      | { id: string }
      | null;
    if (!existing) {
      throw new ProfileNotFoundError('Profile not found for this user');
    }

    await this.prisma.userProfile.delete({ where: { userId } });

    await this.prisma.auditLog.create({
      data: {
        userId,
        action: 'PROFILE_DELETION_CONFIRMED',
        resourceType: 'user_profile',
        resourceId: existing.id,
        actorIdentity: `user:${userId}`,
        details: { deletedAt: new Date().toISOString() },
      },
    });
  }

  /**
   * Cancels a scheduled deletion before the 30-day window elapses.
   * Records the cancellation in the audit log for traceability.
   */
  async cancelDeletion(userId: string): Promise<void> {
    const schedule = await this.prisma.auditLog.findFirst({
      where: { userId, action: 'PROFILE_DELETION_SCHEDULED' },
      orderBy: { timestamp: 'desc' },
    });
    if (!schedule) {
      throw new ProfileNotFoundError('No scheduled deletion found for this user');
    }

    await this.prisma.auditLog.create({
      data: {
        userId,
        action: 'PROFILE_DELETION_CANCELLED',
        resourceType: 'user_profile',
        resourceId: null,
        actorIdentity: `user:${userId}`,
        details: { cancelledAt: new Date().toISOString() },
      },
    });
  }
}

// ─── Error Classes ───────────────────────────────────────────────────────────

/** Thrown when profile validation fails. Carries the full {@link ValidationResult}. */
export class ProfileValidationError extends Error {
  public readonly validationResult: ValidationResult;

  constructor(message: string, errors: FieldValidationError[]) {
    super(message);
    this.name = 'ProfileValidationError';
    this.validationResult = { valid: false, errors };
  }

  /** Convenience accessor for the underlying error array. */
  get errors(): FieldValidationError[] {
    return this.validationResult.errors;
  }
}

/** Thrown when a profile already exists for the user. */
export class ProfileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileConflictError';
  }
}

/** Thrown when a profile is not found. */
export class ProfileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileNotFoundError';
  }
}

/** Thrown when a deletion confirmation arrives after the 30-day window. */
export class DeletionWindowExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeletionWindowExpiredError';
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

interface UserProfileRow {
  id: string;
  userId: string;
  age: number | null;
  gender: string | null;
  state: string | null;
  district: string | null;
  incomeLevel: unknown;
  occupation: string | null;
  educationLevel: string | null;
  casteCategory: string | null;
  disabilityStatus: boolean | null;
  maritalStatus: string | null;
  dependents: number | null;
  languagePreference: string | null;
  updatedAt: Date;
}

function mapToUserProfile(row: Record<string, unknown>): UserProfile {
  const r = row as unknown as UserProfileRow;
  const income =
    r.incomeLevel === null || r.incomeLevel === undefined
      ? 0
      : typeof r.incomeLevel === 'number'
        ? r.incomeLevel
        : Number(r.incomeLevel as { toString(): string });
  return {
    id: r.id,
    userId: r.userId,
    age: r.age ?? 0,
    gender: (r.gender ?? 'Other') as Gender,
    state: r.state ?? '',
    district: r.district,
    incomeLevel: income,
    occupation: r.occupation as Occupation | null,
    educationLevel: r.educationLevel as EducationLevel | null,
    casteCategory: r.casteCategory as CasteCategory | null,
    disabilityStatus: r.disabilityStatus,
    maritalStatus: r.maritalStatus as MaritalStatus | null,
    dependents: r.dependents,
    languagePreference: (r.languagePreference ?? 'en') as SupportedLanguage,
    updatedAt: r.updatedAt,
  };
}

// ─── Singleton Export ────────────────────────────────────────────────────────

/** Default service instance backed by the application Prisma client. */
export const userProfileService = new UserProfileService();
