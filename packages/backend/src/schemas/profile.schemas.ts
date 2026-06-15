/**
 * Zod schemas for citizen profile routes.
 *
 * Mirrors the constants in `@bharat-benefits/shared/PROFILE_CONSTRAINTS`
 * and `INDIAN_STATES` so HTTP-level validation matches the service-level
 * validation. The service layer still re-validates after parsing so the
 * schemas remain a defence-in-depth check rather than the source of truth.
 */

import { z } from 'zod';
import {
  INDIAN_STATES,
  PROFILE_CONSTRAINTS,
} from '@bharat-benefits/shared';

const StateEnum = z.enum(
  INDIAN_STATES as unknown as readonly [string, ...string[]],
);

const GenderEnum = z.enum(
  PROFILE_CONSTRAINTS.gender as unknown as readonly [string, ...string[]],
);

const OccupationEnum = z.enum(
  PROFILE_CONSTRAINTS.occupation as unknown as readonly [string, ...string[]],
);

const EducationEnum = z.enum(
  PROFILE_CONSTRAINTS.education as unknown as readonly [string, ...string[]],
);

const CasteEnum = z.enum(
  PROFILE_CONSTRAINTS.caste as unknown as readonly [string, ...string[]],
);

const MaritalEnum = z.enum(
  PROFILE_CONSTRAINTS.maritalStatus as unknown as readonly [string, ...string[]],
);

const LanguageEnum = z.enum(['en', 'hi', 'bn', 'ta', 'te', 'mr']);

/** Required fields for `POST /api/profile`. */
export const CreateProfileSchema = z.object({
  age: z
    .number()
    .int()
    .min(PROFILE_CONSTRAINTS.age.min)
    .max(PROFILE_CONSTRAINTS.age.max),
  gender: GenderEnum,
  state: StateEnum,
  district: z.string().trim().max(100).optional(),
  incomeLevel: z
    .number()
    .finite()
    .min(PROFILE_CONSTRAINTS.income.min)
    .max(PROFILE_CONSTRAINTS.income.max),
  occupation: OccupationEnum.optional(),
  educationLevel: EducationEnum.optional(),
  casteCategory: CasteEnum.optional(),
  disabilityStatus: z.boolean().optional(),
  maritalStatus: MaritalEnum.optional(),
  dependents: z
    .number()
    .int()
    .min(PROFILE_CONSTRAINTS.dependents.min)
    .max(PROFILE_CONSTRAINTS.dependents.max)
    .optional(),
  languagePreference: LanguageEnum.optional(),
});

/**
 * Update schema — every field is optional, but the body must contain at
 * least one field so a misbehaving client can't burn a write with an
 * empty PATCH.
 */
export const UpdateProfileSchema = CreateProfileSchema.partial().refine(
  (obj) => Object.keys(obj).length > 0,
  { message: 'update body must contain at least one field' },
);

/** Body for `POST /api/profile/deletion/confirm`. */
export const ConfirmDeletionSchema = z.object({
  confirm: z.boolean(),
});
