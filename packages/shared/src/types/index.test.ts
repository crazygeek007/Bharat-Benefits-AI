import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type {
  SupportedLanguage,
  SchemeCategory,
  SchemeStatus,
  Gender,
  Occupation,
  EducationLevel,
  CasteCategory,
  MaritalStatus,
  ProfileConstraints,
  PasswordPolicy,
  EligibilityCriterion,
  Benefit,
  SchemeObject,
  EligibilityResult,
  Recommendation,
  SchemeRelationship,
  AssistantResponse,
  Dashboard,
  UserProfile,
  Scheme,
  SchemeEmbedding,
  DiscoveredScheme,
  ProcessedScheme,
  CompatibilityRelation,
  SchemeData,
  CriterionResult,
} from './index';
import {
  PROFILE_CONSTRAINTS,
  PASSWORD_POLICY,
  TRUST_SCORE_CONFIG,
  MAX_SAVED_SCHEMES,
  MAX_RECOMMENDATIONS,
  MAX_ASSISTANT_RESPONSE_WORDS,
  MAX_RECOMMENDATION_EXPLANATION_CHARS,
  DEADLINE_NOTIFICATION_DAYS,
  DEADLINE_DISPLAY_WINDOW_DAYS,
  MAX_COMPARISON_SCHEMES,
  MIN_VERSION_HISTORY,
  SESSION_TIMEOUT_MINUTES,
} from './index';

describe('Shared Types', () => {
  it('SupportedLanguage type accepts valid language codes', () => {
    const validLanguages: SupportedLanguage[] = ['en', 'hi', 'bn', 'ta', 'te', 'mr'];
    expect(validLanguages).toHaveLength(6);
  });

  it('SchemeCategory type covers all required categories', () => {
    const categories: SchemeCategory[] = [
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
    expect(categories).toHaveLength(12);
  });

  it('SchemeStatus type covers all dashboard statuses', () => {
    const statuses: SchemeStatus[] = ['Eligible', 'Applied', 'Saved', 'Expired'];
    expect(statuses).toHaveLength(4);
  });

  it('ProfileConstraints has correct validation bounds', () => {
    expect(PROFILE_CONSTRAINTS.age).toEqual({ min: 0, max: 150 });
    expect(PROFILE_CONSTRAINTS.income).toEqual({ min: 0, max: 9999999999 });
    expect(PROFILE_CONSTRAINTS.dependents).toEqual({ min: 0, max: 20 });
    expect(PROFILE_CONSTRAINTS.gender).toEqual(['Male', 'Female', 'Other']);
    expect(PROFILE_CONSTRAINTS.occupation).toHaveLength(7);
    expect(PROFILE_CONSTRAINTS.education).toHaveLength(7);
    expect(PROFILE_CONSTRAINTS.caste).toEqual(['General', 'OBC', 'SC', 'ST']);
    expect(PROFILE_CONSTRAINTS.maritalStatus).toHaveLength(5);
    expect(PROFILE_CONSTRAINTS.requiredFields).toEqual(['age', 'gender', 'state', 'income']);
  });

  it('PasswordPolicy has correct requirements', () => {
    expect(PASSWORD_POLICY.minLength).toBe(8);
    expect(PASSWORD_POLICY.maxLength).toBe(128);
    expect(PASSWORD_POLICY.requireUppercase).toBe(true);
    expect(PASSWORD_POLICY.requireLowercase).toBe(true);
    expect(PASSWORD_POLICY.requireDigit).toBe(true);
    expect(PASSWORD_POLICY.requireSpecialChar).toBe(true);
  });

  it('TrustScoreConfig has correct thresholds', () => {
    expect(TRUST_SCORE_CONFIG.minimumForDisplay).toBe(60);
    expect(TRUST_SCORE_CONFIG.range).toEqual({ min: 0, max: 100 });
  });

  it('constants have correct values', () => {
    expect(MAX_SAVED_SCHEMES).toBe(100);
    expect(MAX_RECOMMENDATIONS).toBe(50);
    expect(MAX_ASSISTANT_RESPONSE_WORDS).toBe(500);
    expect(MAX_RECOMMENDATION_EXPLANATION_CHARS).toBe(200);
    expect(DEADLINE_NOTIFICATION_DAYS).toBe(7);
    expect(DEADLINE_DISPLAY_WINDOW_DAYS).toBe(90);
    expect(MAX_COMPARISON_SCHEMES).toBe(3);
    expect(MIN_VERSION_HISTORY).toBe(50);
    expect(SESSION_TIMEOUT_MINUTES).toBe(30);
  });

  it('EligibilityCriterion supports all operator types', () => {
    const operators: EligibilityCriterion['operator'][] = [
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'in',
      'between',
    ];
    expect(operators).toHaveLength(8);
  });

  it('Benefit supports monetary and non-monetary types', () => {
    const monetary: Benefit = { type: 'monetary', amount: 50000, description: 'Cash grant' };
    const nonMonetary: Benefit = {
      type: 'non-monetary',
      amount: null,
      description: 'Free training',
    };
    expect(monetary.type).toBe('monetary');
    expect(nonMonetary.amount).toBeNull();
  });

  it('SchemeObject enforces mandatory/optional structure', () => {
    const scheme: SchemeObject = {
      name: 'Test Scheme',
      description: 'A test scheme',
      eligibilityCriteria: [{ field: 'age', operator: 'gte', value: 18, description: 'Must be 18+' }],
      benefits: [{ type: 'monetary', amount: 10000, description: 'Monthly stipend' }],
      sourceUrl: 'https://example.gov.in/scheme',
      ministry: 'Ministry of Test',
      applicationProcess: null,
      requiredDocuments: null,
      deadline: null,
    };
    expect(scheme.name).toBe('Test Scheme');
    expect(scheme.applicationProcess).toBeNull();
  });

  it('fast-check is working correctly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (n) => {
        return n >= 0 && n <= 100;
      }),
    );
  });
});
