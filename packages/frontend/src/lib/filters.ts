/**
 * Shared parsers/serialisers for filter inputs that travel through Next.js
 * `searchParams`. Used by the server-rendered scheme listing pages.
 */

import type { SchemeCategory } from '@bharat-benefits/shared';
import type { SchemeFilters } from './api';

const CATEGORIES: ReadonlySet<SchemeCategory> = new Set<SchemeCategory>([
  'Education',
  'Agriculture',
  'Healthcare',
  'Women',
  'Employment',
  'Skill Development',
  'Housing',
  'Startups',
  'MSME',
  'Pension',
  'Scholarships',
  'Financial Assistance',
]);

export const SCHEME_CATEGORIES: SchemeCategory[] = [
  'Education',
  'Agriculture',
  'Healthcare',
  'Women',
  'Employment',
  'Skill Development',
  'Housing',
  'Startups',
  'MSME',
  'Pension',
  'Scholarships',
  'Financial Assistance',
];

export const GENDER_OPTIONS = ['Male', 'Female', 'Other'];
export const OCCUPATION_OPTIONS = [
  'Farmer',
  'Student',
  'Salaried',
  'Self-Employed',
  'Unemployed',
  'Retired',
  'Other',
];
export const BENEFIT_TYPE_OPTIONS = ['monetary', 'non-monetary'] as const;

type RawSearchParams = Record<string, string | string[] | undefined>;

function readString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(value: string | string[] | undefined): number | undefined {
  const str = readString(value);
  if (str === undefined) return undefined;
  const n = Number(str);
  return Number.isFinite(n) ? n : undefined;
}

function readCategory(value: string | string[] | undefined): SchemeCategory | undefined {
  const str = readString(value);
  if (str === undefined) return undefined;
  return CATEGORIES.has(str as SchemeCategory) ? (str as SchemeCategory) : undefined;
}

/** Parses Next.js `searchParams` into a typed `SchemeFilters` object. */
export function parseFiltersFromSearchParams(
  searchParams: RawSearchParams = {},
): SchemeFilters {
  const filters: SchemeFilters = {};

  const state = readString(searchParams.state);
  if (state) filters.state = state;

  const category = readCategory(searchParams.category);
  if (category) filters.category = category;

  const benefitType = readString(searchParams.benefitType);
  if (benefitType === 'monetary' || benefitType === 'non-monetary') {
    filters.benefitType = benefitType;
  }

  const gender = readString(searchParams.gender);
  if (gender) filters.gender = gender;

  const occupation = readString(searchParams.occupation);
  if (occupation) filters.occupation = occupation;

  const age = readNumber(searchParams.age);
  if (age !== undefined) filters.age = age;

  const incomeLevel = readNumber(searchParams.incomeLevel);
  if (incomeLevel !== undefined) filters.incomeLevel = incomeLevel;

  return filters;
}

export function parsePageFromSearchParams(
  searchParams: RawSearchParams = {},
): number {
  const n = readNumber(searchParams.page);
  return n !== undefined && n >= 1 ? Math.floor(n) : 1;
}
