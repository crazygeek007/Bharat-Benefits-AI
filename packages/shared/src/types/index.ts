/**
 * Shared type definitions for Bharat Benefits AI platform.
 *
 * Core interfaces and types used across frontend, backend, and AI pipeline services.
 */

// ─── Language & Category Types ───────────────────────────────────────────────

/** Supported languages for the platform (6 Indian languages) */
export type SupportedLanguage = 'en' | 'hi' | 'bn' | 'ta' | 'te' | 'mr';

/** Scheme categories for browsing and filtering */
export type SchemeCategory =
  | 'Education'
  | 'Agriculture'
  | 'Healthcare'
  | 'Women'
  | 'Employment'
  | 'Skill Development'
  | 'Housing'
  | 'Startups'
  | 'MSME'
  | 'Pension'
  | 'Scholarships'
  | 'Financial Assistance';

/** Scheme status for dashboard grouping */
export type SchemeStatus = 'Eligible' | 'Applied' | 'Saved' | 'Expired';

// ─── Profile Constraint Types ────────────────────────────────────────────────

/** Valid gender values */
export type Gender = 'Male' | 'Female' | 'Other';

/** Valid occupation values */
export type Occupation =
  | 'Farmer'
  | 'Student'
  | 'Salaried'
  | 'Self-Employed'
  | 'Unemployed'
  | 'Retired'
  | 'Other';

/** Valid education levels */
export type EducationLevel =
  | 'None'
  | 'Primary'
  | 'Secondary'
  | 'Higher Secondary'
  | 'Graduate'
  | 'Post-Graduate'
  | 'Doctorate';

/** Valid caste categories */
export type CasteCategory = 'General' | 'OBC' | 'SC' | 'ST';

/** Valid marital status values */
export type MaritalStatus = 'Single' | 'Married' | 'Widowed' | 'Divorced' | 'Separated';

/** User profile validation constraints */
export interface ProfileConstraints {
  age: { min: 0; max: 150 };
  income: { min: 0; max: 9999999999 };
  dependents: { min: 0; max: 20 };
  gender: Gender[];
  occupation: Occupation[];
  education: EducationLevel[];
  caste: CasteCategory[];
  maritalStatus: MaritalStatus[];
  requiredFields: ('age' | 'gender' | 'state' | 'income')[];
}

/** Password policy configuration */
export interface PasswordPolicy {
  minLength: 8;
  maxLength: 128;
  requireUppercase: true;
  requireLowercase: true;
  requireDigit: true;
  requireSpecialChar: true;
}

// ─── User & Profile Interfaces ───────────────────────────────────────────────

/** User account entity */
export interface User {
  id: string;
  email: string;
  passwordHash: string;
  authProvider: string;
  emailVerified: boolean;
  lastLogin: Date | null;
  sessionExpiresAt: Date | null;
  createdAt: Date;
}

/** Citizen profile with demographic and financial data */
export interface UserProfile {
  id: string;
  userId: string;
  age: number;
  gender: Gender;
  state: string;
  district: string | null;
  incomeLevel: number;
  occupation: Occupation | null;
  educationLevel: EducationLevel | null;
  casteCategory: CasteCategory | null;
  disabilityStatus: boolean | null;
  maritalStatus: MaritalStatus | null;
  dependents: number | null;
  languagePreference: SupportedLanguage;
  updatedAt: Date;
}

/** Input for creating a new profile */
export interface CreateProfileInput {
  age: number;
  gender: Gender;
  state: string;
  district?: string;
  incomeLevel: number;
  occupation?: Occupation;
  educationLevel?: EducationLevel;
  casteCategory?: CasteCategory;
  disabilityStatus?: boolean;
  maritalStatus?: MaritalStatus;
  dependents?: number;
  languagePreference?: SupportedLanguage;
}

/** Input for updating an existing profile */
export interface UpdateProfileInput {
  age?: number;
  gender?: Gender;
  state?: string;
  district?: string;
  incomeLevel?: number;
  occupation?: Occupation;
  educationLevel?: EducationLevel;
  casteCategory?: CasteCategory;
  disabilityStatus?: boolean;
  maritalStatus?: MaritalStatus;
  dependents?: number;
  languagePreference?: SupportedLanguage;
}

// ─── Scheme Interfaces ───────────────────────────────────────────────────────

/** Eligibility criterion with operator-based evaluation */
export interface EligibilityCriterion {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'between';
  value: unknown;
  description: string;
}

/** Benefit type for a scheme */
export interface Benefit {
  type: 'monetary' | 'non-monetary';
  amount: number | null;
  description: string;
}

/** Application step instruction */
export interface ApplicationStep {
  stepNumber: number;
  action: string;
  expectedOutcome: string;
}

/** Document requirement for scheme application */
export interface DocumentRequirement {
  documentName: string;
  description: string;
  format: string;
  required: boolean;
}

/** Core Scheme entity */
export interface Scheme {
  id: string;
  name: string;
  description: string;
  ministry: string;
  state: string | null;
  category: SchemeCategory;
  sourceUrl: string;
  benefitType: 'monetary' | 'non-monetary';
  benefitAmount: number | null;
  deadline: Date | null;
  applicationMode: 'online' | 'offline' | 'hybrid';
  applicationUrl: string | null;
  eligibilityCriteria: EligibilityCriterion[];
  benefits: Benefit[];
  applicationSteps: ApplicationStep[] | null;
  requiredDocuments: DocumentRequirement[] | null;
  trustScore: number;
  verified: boolean;
  discoveredAt: Date;
  lastVerifiedAt: Date;
  updatedAt: Date;
}

/**
 * Scheme object for serialization (mandatory/optional field structure).
 * Used by the Crawler System when parsing scheme data.
 */
export interface SchemeObject {
  // Mandatory fields
  name: string;
  description: string;
  eligibilityCriteria: EligibilityCriterion[];
  benefits: Benefit[];
  sourceUrl: string;
  ministry: string;

  // Optional fields
  applicationProcess: ApplicationStep[] | null;
  requiredDocuments: DocumentRequirement[] | null;
  deadline: Date | null;
}

// ─── Eligibility Interfaces ──────────────────────────────────────────────────

/** Result of evaluating a single criterion */
export interface CriterionResult {
  met: boolean;
  criterionName: string;
  requirement: string;
  profileValue: unknown;
  missingField: string | null;
}

/** Result of evaluating a single criterion against a profile value */
export interface CriterionEvaluation {
  criterionName: string;
  requirement: string;
  profileValue: unknown;
  met: boolean;
}

/** Criterion that could not be evaluated due to missing profile data */
export interface UnevaluatedCriterion {
  criterionName: string;
  requirement: string;
  missingField: string;
}

/** Full eligibility calculation result */
export interface EligibilityResult {
  status: 'Eligible' | 'Partially Eligible' | 'Not Eligible';
  metCriteria: CriterionEvaluation[];
  unmetCriteria: CriterionEvaluation[];
  unevaluatedCriteria: UnevaluatedCriterion[];
  missingProfileFields: string[];
}

// ─── Recommendation Interfaces ───────────────────────────────────────────────

/** A single scheme recommendation with scoring */
export interface Recommendation {
  schemeId: string;
  matchScore: number;
  benefitAmount: number | null;
  deadline: Date | null;
  explanation: string;
  priorityGroup: 'state' | 'central' | 'other';
}

// ─── Compatibility Interfaces ────────────────────────────────────────────────

/** Relationship type between schemes */
export type SchemeRelationshipType =
  | 'can_combine_with'
  | 'cannot_combine_with'
  | 'prerequisite_schemes';

/** Relationship between two schemes */
export interface SchemeRelationship {
  relatedSchemeId: string;
  relatedSchemeName: string;
  type: SchemeRelationshipType;
  officialRule: string;
  sourceUrl: string;
}

/** Result of checking compatibility between two schemes */
export interface CompatibilityCheck {
  compatible: boolean;
  rule: string | null;
  sourceUrl: string | null;
}

/** Prerequisite chain for a scheme */
export interface PrerequisiteChain {
  schemeId: string;
  prerequisites: Array<{
    schemeId: string;
    schemeName: string;
    order: number;
  }>;
}

// ─── AI Assistant Interfaces ─────────────────────────────────────────────────

/** Source citation for scheme data referenced in assistant responses */
export interface SourceCitation {
  schemeId: string;
  schemeName: string;
  sourceUrl: string;
  lastUpdated: Date;
}

/** Response from the Scheme Assistant (RAG) */
export interface AssistantResponse {
  answer: string;
  sources: SourceCitation[];
  language: SupportedLanguage;
  traceId: string;
}

/** Retrieved chunk from vector database */
export interface RetrievedChunk {
  schemeId: string;
  chunkText: string;
  similarity: number;
  chunkIndex: number;
}

// ─── Multi-Agent Pipeline Interfaces ─────────────────────────────────────────

/** Agent names in the multi-agent pipeline */
export type AgentName =
  | 'planner'
  | 'eligibility'
  | 'retrieval'
  | 'compatibility'
  | 'recommendation'
  | 'response';

/** Query type classification by the planner agent */
export type QueryType = 'eligibility' | 'recommendation' | 'information' | 'comparison';

/** Routing plan produced by the planner agent */
export interface AgentRoutingPlan {
  queryType: QueryType;
  requiredAgents: AgentName[];
  skippedAgents: AgentName[];
}

/** Output from an individual agent in the pipeline */
export interface AgentOutput {
  agentName: AgentName;
  result: unknown;
  duration: number;
  success: boolean;
}

/** Full pipeline execution result */
export interface PipelineResult {
  response: string;
  sources: SourceCitation[];
  traceId: string;
  agentOutputs: Map<AgentName, AgentOutput>;
  totalDuration: number;
}

// ─── Dashboard Interfaces ────────────────────────────────────────────────────

/** Scheme with its dashboard status */
export interface SchemeWithStatus {
  scheme: Scheme;
  status: SchemeStatus;
  savedAt: Date;
  appliedAt: Date | null;
}

/** Summary of missed benefits */
export interface MissedBenefitsSummary {
  totalCount: number;
  totalMonetaryValue: number;
  schemes: Array<{
    schemeId: string;
    schemeName: string;
    benefitAmount: number | null;
    deadline: Date;
    metCriteria: string[];
  }>;
}

/** Full Benefits Dashboard data */
export interface Dashboard {
  eligible: SchemeWithStatus[];
  applied: SchemeWithStatus[];
  saved: SchemeWithStatus[];
  expired: SchemeWithStatus[];
  estimatedTotalBenefitValue: number;
  missedBenefitsSummary: MissedBenefitsSummary;
  counts: {
    eligible: number;
    applied: number;
    saved: number;
    expired: number;
  };
}

// ─── Notification Interfaces ─────────────────────────────────────────────────

/** Notification type */
export type NotificationType = 'deadline' | 'change' | 'reopening' | 'missed_benefit';

/** Notification delivery channel */
export type NotificationChannel = 'email' | 'in_app';

/** Notification delivery status */
export type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed';

/** Notification entity */
export interface Notification {
  id: string;
  userId: string;
  schemeId: string;
  type: NotificationType;
  channel: NotificationChannel;
  status: NotificationStatus;
  retryCount: number;
  payload: Record<string, unknown>;
  sentAt: Date | null;
  deliveredAt: Date | null;
}

/** Result of attempting notification delivery */
export interface DeliveryResult {
  success: boolean;
  channel: NotificationChannel;
  error: string | null;
}

// ─── Change Tracking Interfaces ──────────────────────────────────────────────

/** Record of a change to a scheme */
export interface SchemeChange {
  id: string;
  schemeId: string;
  previousValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
  changedFields: string[];
  sourceUrl: string;
  changeDetectedAt: Date;
  versionNumber: number;
}

// ─── Crawler Interfaces ──────────────────────────────────────────────────────

/** Raw data extracted from a source before processing */
export interface RawSchemeData {
  url: string;
  content: string;
  contentType: 'html' | 'pdf' | 'json' | 'xml';
  fetchedAt: Date;
}

/** Scheme data extracted from a source after parsing */
export interface SchemeData {
  name: string | null;
  description: string | null;
  eligibilityCriteria: EligibilityCriterion[] | null;
  benefits: Benefit[] | null;
  sourceUrl: string | null;
  ministry: string | null;
  applicationProcess: ApplicationStep[] | null;
  requiredDocuments: DocumentRequirement[] | null;
  deadline: Date | null;
}

/** A newly discovered scheme before full processing */
export interface DiscoveredScheme {
  url: string;
  rawData: RawSchemeData;
  discoveredAt: Date;
}

/** A scheme after processing, validation, and trust scoring */
export interface ProcessedScheme {
  schemeObject: SchemeObject;
  sourceUrl: string;
  trustScore: number;
  verified: boolean;
  discoveredAt: Date;
  lastVerifiedAt: Date;
  category: SchemeCategory | null;
  state: string | null;
}

/** Compatibility relationship extracted during ingestion */
export interface CompatibilityRelation {
  sourceSchemeUrl: string;
  relatedSchemeIdentifier: string;
  type: SchemeRelationshipType;
  officialRule: string;
  sourceUrl: string;
}

/** Result of a daily crawl operation */
export interface CrawlResult {
  newSchemes: number;
  updatedSchemes: number;
  failedSources: FailedSource[];
  duration: number;
  completedAt: Date;
}

/** A source that failed during crawling */
export interface FailedSource {
  url: string;
  reason: string;
  errorCode: string | null;
}

/** Trust score configuration */
export interface TrustScoreConfig {
  minimumForDisplay: 60;
  range: { min: 0; max: 100 };
}

// ─── Voice Assistant Interfaces ──────────────────────────────────────────────

/** Speech-to-text result */
export interface STTResult {
  text: string;
  confidence: number;
  language: SupportedLanguage;
}

// ─── Embedding Interfaces ────────────────────────────────────────────────────

/** Scheme embedding stored in vector database */
export interface SchemeEmbedding {
  id: string;
  schemeId: string;
  chunkText: string;
  embedding: number[];
  chunkIndex: number;
}

// ─── Validation Interfaces ───────────────────────────────────────────────────

/** Result of validating profile data */
export interface ValidationResult {
  valid: boolean;
  errors: FieldValidationError[];
}

/** A single field validation error */
export interface FieldValidationError {
  field: string;
  value: unknown;
  reason: string;
}

// ─── Comparison Interfaces ───────────────────────────────────────────────────

/** Attribute compared across schemes */
export interface ComparisonAttribute {
  attributeName: string;
  values: Array<{
    schemeId: string;
    value: unknown;
  }>;
  differs: boolean;
}

/** Result of comparing 2-3 schemes */
export interface SchemeComparison {
  schemes: Scheme[];
  attributes: ComparisonAttribute[];
}

// ─── Audit Interfaces ────────────────────────────────────────────────────────

/** Audit log entry */
export interface AuditLogEntry {
  id: string;
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  details: Record<string, unknown>;
  actorIdentity: string;
  timestamp: Date;
}

// ─── Saved Scheme Interfaces ─────────────────────────────────────────────────

/** A scheme saved by a citizen */
export interface SavedScheme {
  id: string;
  userId: string;
  schemeId: string;
  status: SchemeStatus;
  savedAt: Date;
  appliedAt: Date | null;
}

// ─── Runtime Constants ───────────────────────────────────────────────────────

/** Runtime profile constraints for validation logic */
export const PROFILE_CONSTRAINTS: ProfileConstraints = {
  age: { min: 0, max: 150 },
  income: { min: 0, max: 9999999999 },
  dependents: { min: 0, max: 20 },
  gender: ['Male', 'Female', 'Other'],
  occupation: ['Farmer', 'Student', 'Salaried', 'Self-Employed', 'Unemployed', 'Retired', 'Other'],
  education: [
    'None',
    'Primary',
    'Secondary',
    'Higher Secondary',
    'Graduate',
    'Post-Graduate',
    'Doctorate',
  ],
  caste: ['General', 'OBC', 'SC', 'ST'],
  maritalStatus: ['Single', 'Married', 'Widowed', 'Divorced', 'Separated'],
  requiredFields: ['age', 'gender', 'state', 'income'],
};

/** Runtime password policy for validation logic */
export const PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  requireSpecialChar: true,
};

/** Runtime trust score configuration */
export const TRUST_SCORE_CONFIG: TrustScoreConfig = {
  minimumForDisplay: 60,
  range: { min: 0, max: 100 },
};

/** Maximum number of schemes a citizen can save */
export const MAX_SAVED_SCHEMES = 100;

/** Maximum number of schemes in recommendation list */
export const MAX_RECOMMENDATIONS = 50;

/** Maximum word count for assistant responses */
export const MAX_ASSISTANT_RESPONSE_WORDS = 500;

/** Maximum character count for recommendation explanations */
export const MAX_RECOMMENDATION_EXPLANATION_CHARS = 200;

/** Deadline notification threshold in days */
export const DEADLINE_NOTIFICATION_DAYS = 7;

/** High-priority notification thresholds in hours */
export const HIGH_PRIORITY_NOTIFICATION_HOURS = [24, 6];

/** Calendar/timeline view deadline window in days */
export const DEADLINE_DISPLAY_WINDOW_DAYS = 90;

/** Maximum schemes for comparison */
export const MAX_COMPARISON_SCHEMES = 3;

/** Minimum versions retained per scheme */
export const MIN_VERSION_HISTORY = 50;

/** Session inactivity timeout in minutes */
export const SESSION_TIMEOUT_MINUTES = 30;

/** Number of consecutive failed login attempts that triggers account lockout */
export const ACCOUNT_LOCKOUT_THRESHOLD = 5;

/** Duration of an account lockout in minutes after threshold is exceeded */
export const ACCOUNT_LOCKOUT_DURATION_MINUTES = 15;
