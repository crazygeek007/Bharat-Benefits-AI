/**
 * JSON Parser for Scheme Data
 *
 * Parses a structured API response into a {@link SchemeObject} shape.
 * Tolerant of common key variations seen across different ministry APIs:
 *
 *   - name        ← name | scheme_name | schemeName | title
 *   - description ← description | desc | summary | scheme_description
 *   - ministry    ← ministry | department | nodal_ministry
 *   - sourceUrl   ← sourceUrl | source_url | url | link | source
 *   - eligibility ← eligibilityCriteria | eligibility_criteria | eligibility
 *                   | criteria
 *   - benefits    ← benefits | benefit | scheme_benefits
 *   - deadline    ← deadline | last_date | application_deadline
 *   - documents   ← requiredDocuments | required_documents | documents
 *   - apply       ← applicationProcess | application_process | how_to_apply
 *
 * The function never throws on malformed JSON: invalid input yields a
 * Partial<SchemeObject> with only the source URL set, so the
 * mandatory-field enforcer can reject it cleanly.
 *
 * Validates: Requirements 22.1, 22.2, 22.5, 22.7
 */

import type {
  ApplicationStep,
  Benefit,
  DocumentRequirement,
  EligibilityCriterion,
  SchemeObject,
} from '@bharat-benefits/shared';

const NAME_KEYS = ['name', 'scheme_name', 'schemeName', 'title'];
const DESCRIPTION_KEYS = [
  'description',
  'desc',
  'summary',
  'scheme_description',
  'schemeDescription',
];
const MINISTRY_KEYS = ['ministry', 'department', 'nodal_ministry', 'nodalMinistry'];
const SOURCE_URL_KEYS = ['sourceUrl', 'source_url', 'url', 'link', 'source'];
const ELIGIBILITY_KEYS = [
  'eligibilityCriteria',
  'eligibility_criteria',
  'eligibility',
  'criteria',
];
const BENEFITS_KEYS = ['benefits', 'benefit', 'scheme_benefits', 'schemeBenefits'];
const DEADLINE_KEYS = ['deadline', 'last_date', 'lastDate', 'application_deadline'];
const DOCUMENTS_KEYS = [
  'requiredDocuments',
  'required_documents',
  'documents',
];
const APPLICATION_KEYS = [
  'applicationProcess',
  'application_process',
  'how_to_apply',
  'howToApply',
  'applicationSteps',
];

/**
 * Parses a JSON-serialised scheme payload into a Partial<SchemeObject>.
 * Falls back to `{ sourceUrl }` if `content` cannot be parsed as JSON.
 */
export function parseJSON(content: string, sourceUrl: string): Partial<SchemeObject> {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { sourceUrl, applicationProcess: null, requiredDocuments: null, deadline: null };
  }

  if (!isObject(raw)) {
    return { sourceUrl, applicationProcess: null, requiredDocuments: null, deadline: null };
  }

  return mapObjectToScheme(raw, sourceUrl);
}

/**
 * Maps an already-parsed JS object (e.g. from `JSON.parse` or an XML parser)
 * onto the SchemeObject shape using the same key-variation rules.
 *
 * Exposed as a helper so the XML parser can reuse the mapping logic.
 */
export function mapObjectToScheme(
  obj: Record<string, unknown>,
  sourceUrl: string,
): Partial<SchemeObject> {
  const out: Partial<SchemeObject> = {};

  // ─── Strings ─────────────────────────────────────────────────────────────
  const name = pickString(obj, NAME_KEYS);
  if (name) out.name = name;

  const description = pickString(obj, DESCRIPTION_KEYS);
  if (description) out.description = description;

  const ministry = pickString(obj, MINISTRY_KEYS);
  if (ministry) out.ministry = ministry;

  out.sourceUrl = pickString(obj, SOURCE_URL_KEYS) ?? sourceUrl;

  // ─── Eligibility ─────────────────────────────────────────────────────────
  const eligibilityRaw = pick(obj, ELIGIBILITY_KEYS);
  const eligibility = normalizeEligibility(eligibilityRaw);
  if (eligibility !== null) out.eligibilityCriteria = eligibility;

  // ─── Benefits ────────────────────────────────────────────────────────────
  const benefitsRaw = pick(obj, BENEFITS_KEYS);
  const benefits = normalizeBenefits(benefitsRaw);
  if (benefits !== null) out.benefits = benefits;

  // ─── Optional: deadline ──────────────────────────────────────────────────
  const deadlineRaw = pick(obj, DEADLINE_KEYS);
  out.deadline = normalizeDeadline(deadlineRaw);

  // ─── Optional: documents ─────────────────────────────────────────────────
  const documentsRaw = pick(obj, DOCUMENTS_KEYS);
  out.requiredDocuments = normalizeDocuments(documentsRaw);

  // ─── Optional: application process ───────────────────────────────────────
  const applicationRaw = pick(obj, APPLICATION_KEYS);
  out.applicationProcess = normalizeApplicationSteps(applicationRaw);

  return out;
}

// ─── Normalisers ─────────────────────────────────────────────────────────────

function normalizeEligibility(raw: unknown): EligibilityCriterion[] | null {
  const list = toItemArray(raw);
  if (list === null) return null;

  const criteria: EligibilityCriterion[] = list.map((item): EligibilityCriterion => {
    if (typeof item === 'string') {
      return {
        field: 'unknown',
        operator: 'eq',
        value: null,
        description: item,
      };
    }
    if (isObject(item)) {
      const description =
        pickString(item, ['description', 'criterion', 'rule', 'text']) ??
        JSON.stringify(item);
      const field = pickString(item, ['field', 'attribute', 'name']) ?? 'unknown';
      const operator = pickString(item, ['operator', 'op']) ?? 'eq';
      const value = item['value'] ?? item['threshold'] ?? null;
      return {
        field,
        operator: normalizeOperator(operator),
        value,
        description,
      };
    }
    return {
      field: 'unknown',
      operator: 'eq',
      value: null,
      description: String(item),
    };
  });
  return criteria.length > 0 ? criteria : null;
}

function normalizeBenefits(raw: unknown): Benefit[] | null {
  const list = toItemArray(raw);
  if (list === null) return null;

  const benefits: Benefit[] = list.map((item): Benefit => {
    if (typeof item === 'string') {
      return { type: 'non-monetary', amount: null, description: item };
    }
    if (isObject(item)) {
      const description =
        pickString(item, ['description', 'benefit', 'detail', 'text']) ??
        JSON.stringify(item);
      const rawAmount = item['amount'] ?? item['value'] ?? null;
      const amount =
        typeof rawAmount === 'number' && Number.isFinite(rawAmount)
          ? rawAmount
          : typeof rawAmount === 'string' && rawAmount.trim().length > 0
          ? Number(rawAmount.replace(/[^\d.]/g, '')) || null
          : null;
      const typeRaw = pickString(item, ['type', 'benefitType']);
      const type: Benefit['type'] =
        typeRaw === 'monetary' || typeRaw === 'non-monetary'
          ? typeRaw
          : amount === null
          ? 'non-monetary'
          : 'monetary';
      return { type, amount, description };
    }
    return { type: 'non-monetary', amount: null, description: String(item) };
  });
  return benefits.length > 0 ? benefits : null;
}

function normalizeDeadline(raw: unknown): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw;
  }
  if (typeof raw === 'number') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function normalizeDocuments(raw: unknown): DocumentRequirement[] | null {
  const list = toItemArray(raw);
  if (list === null) return null;

  const docs: DocumentRequirement[] = list.map((item): DocumentRequirement => {
    if (typeof item === 'string') {
      return {
        documentName: item,
        description: item,
        format: 'unknown',
        required: true,
      };
    }
    if (isObject(item)) {
      const documentName =
        pickString(item, ['documentName', 'document_name', 'name']) ?? 'unknown';
      const description =
        pickString(item, ['description', 'detail']) ?? documentName;
      const format = pickString(item, ['format', 'fileFormat']) ?? 'unknown';
      const requiredRaw = item['required'];
      const required =
        typeof requiredRaw === 'boolean' ? requiredRaw : true;
      return { documentName, description, format, required };
    }
    return {
      documentName: String(item),
      description: String(item),
      format: 'unknown',
      required: true,
    };
  });
  return docs.length > 0 ? docs : null;
}

function normalizeApplicationSteps(raw: unknown): ApplicationStep[] | null {
  const list = toItemArray(raw);
  if (list === null) return null;

  const steps: ApplicationStep[] = list.map((item, idx): ApplicationStep => {
    if (typeof item === 'string') {
      return { stepNumber: idx + 1, action: item, expectedOutcome: '' };
    }
    if (isObject(item)) {
      const stepNumberRaw = item['stepNumber'] ?? item['step'] ?? idx + 1;
      const stepNumber =
        typeof stepNumberRaw === 'number' && Number.isFinite(stepNumberRaw)
          ? stepNumberRaw
          : idx + 1;
      const action = pickString(item, ['action', 'description', 'text']) ?? '';
      const expectedOutcome =
        pickString(item, ['expectedOutcome', 'expected_outcome', 'outcome']) ?? '';
      return { stepNumber, action, expectedOutcome };
    }
    return { stepNumber: idx + 1, action: String(item), expectedOutcome: '' };
  });
  return steps.length > 0 ? steps : null;
}

// ─── Generic helpers ─────────────────────────────────────────────────────────

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  const value = pick(obj, keys);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerces a value into an array of items suitable for normalising:
 *   - arrays are returned unchanged
 *   - strings are split on '\n' / ';' / ','
 *   - objects with a single key (the XML-container pattern, e.g.
 *     `{ benefit: { … } }` or `{ criterion: ['A','B'] }`) are unwrapped
 *     to their inner value before being treated as items
 *   - other objects are wrapped in a single-element array
 *   - anything else returns null
 */
function toItemArray(value: unknown): unknown[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.filter((v) => v != null);
  if (typeof value === 'string') {
    const parts = value
      .split(/\r?\n|;|,(?![^(]*\))/) // commas only when not inside parentheses
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    return parts.length > 0 ? parts : null;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const inner = value[keys[0]];
      if (Array.isArray(inner)) return inner.filter((v) => v != null);
      if (inner == null) return null;
      return [inner];
    }
    return [value];
  }
  return null;
}

const ALLOWED_OPERATORS = new Set([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'between',
] as const);

function normalizeOperator(op: string): EligibilityCriterion['operator'] {
  const lower = op.toLowerCase();
  return (ALLOWED_OPERATORS as Set<string>).has(lower)
    ? (lower as EligibilityCriterion['operator'])
    : 'eq';
}
