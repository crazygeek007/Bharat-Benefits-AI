/**
 * Scheme Serialization
 *
 * JSON serialization and deserialization for {@link SchemeObject} values
 * with stable, canonical output. The pair `serializeScheme` /
 * `deserializeScheme` is designed so that
 *
 *   serialize(deserialize(serialize(scheme))) === serialize(scheme)
 *
 * for any well-formed scheme (round-trip stability), and so that
 * `areSchemesSemanticallyEqual(scheme, deserialize(serialize(scheme)))` is
 * `true` for any well-formed scheme (semantic equivalence).
 *
 * Validates: Requirements 22.3, 22.4
 */

import type {
  ApplicationStep,
  Benefit,
  DocumentRequirement,
  EligibilityCriterion,
  SchemeObject,
} from '@bharat-benefits/shared';

/**
 * Error thrown when a JSON payload cannot be deserialized into a valid
 * {@link SchemeObject}.
 */
export class SchemeDeserializationError extends Error {
  public readonly field: string | null;

  constructor(message: string, field: string | null = null) {
    super(message);
    this.name = 'SchemeDeserializationError';
    this.field = field;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Serializes a {@link SchemeObject} to a canonical JSON string.
 *
 * Properties of the output:
 *   - object keys are emitted in lexicographic order at every depth
 *     (stable key ordering)
 *   - {@link Date} values are emitted as ISO 8601 strings
 *   - `null` optional fields are preserved as JSON `null`
 *   - no indentation / whitespace, so equality of strings implies
 *     structural equality
 */
export function serializeScheme(scheme: SchemeObject): string {
  return JSON.stringify(canonicalize(toJsonReady(scheme)));
}

/**
 * Parses a JSON string into a {@link SchemeObject}, validating that all
 * mandatory fields are present and well-typed.
 *
 * - Mandatory fields: `name`, `description`, `eligibilityCriteria`,
 *   `benefits`, `sourceUrl`, `ministry`. Missing or wrong-typed mandatory
 *   fields raise {@link SchemeDeserializationError}.
 * - Optional fields (`applicationProcess`, `requiredDocuments`,
 *   `deadline`) default to `null` if absent. `deadline`, when present as a
 *   string, is parsed as ISO 8601 into a {@link Date}.
 *
 * Unknown additional fields on the input are silently ignored.
 */
export function deserializeScheme(json: string): SchemeObject {
  if (typeof json !== 'string') {
    throw new SchemeDeserializationError('Input must be a JSON string');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown parse error';
    throw new SchemeDeserializationError(`Invalid JSON: ${reason}`);
  }

  if (!isPlainObject(parsed)) {
    throw new SchemeDeserializationError('Top-level value must be a JSON object');
  }

  const name = requireString(parsed, 'name');
  const description = requireString(parsed, 'description');
  const sourceUrl = requireString(parsed, 'sourceUrl');
  const ministry = requireString(parsed, 'ministry');

  const eligibilityCriteria = parseEligibilityCriteria(parsed['eligibilityCriteria']);
  const benefits = parseBenefits(parsed['benefits']);

  const applicationProcess = parseApplicationProcess(parsed['applicationProcess']);
  const requiredDocuments = parseRequiredDocuments(parsed['requiredDocuments']);
  const deadline = parseDeadline(parsed['deadline']);

  return {
    name,
    description,
    eligibilityCriteria,
    benefits,
    sourceUrl,
    ministry,
    applicationProcess,
    requiredDocuments,
    deadline,
  };
}

/**
 * Returns true iff two scheme objects are semantically equivalent: same
 * mandatory and optional field values, ignoring object key ordering.
 *
 * - {@link Date} values are compared by `getTime()`
 * - `null` is distinguished from `undefined` and from missing
 * - arrays are compared positionally (order matters within an array)
 * - objects are compared by their union of keys
 */
export function areSchemesSemanticallyEqual(a: SchemeObject, b: SchemeObject): boolean {
  return deepEqual(toComparable(a), toComparable(b));
}

/**
 * Recursively sorts object keys for stable serialization.
 *
 * - Arrays are mapped element-wise (their order is preserved).
 * - Plain objects have their keys sorted lexicographically.
 * - Primitives (and `null`) are returned as-is.
 *
 * This function operates on JSON-ready values — i.e. {@link Date} should
 * already have been converted to a string by {@link toJsonReady}.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

// ─── Internal helpers: serialization ─────────────────────────────────────────

/**
 * Converts a {@link SchemeObject} into a JSON-ready value: `Date` becomes
 * an ISO 8601 string, everything else is structurally preserved.
 */
function toJsonReady(scheme: SchemeObject): Record<string, unknown> {
  return {
    name: scheme.name,
    description: scheme.description,
    eligibilityCriteria: scheme.eligibilityCriteria.map((c) => ({ ...c })),
    benefits: scheme.benefits.map((b) => ({ ...b })),
    sourceUrl: scheme.sourceUrl,
    ministry: scheme.ministry,
    applicationProcess:
      scheme.applicationProcess === null
        ? null
        : scheme.applicationProcess.map((s) => ({ ...s })),
    requiredDocuments:
      scheme.requiredDocuments === null
        ? null
        : scheme.requiredDocuments.map((d) => ({ ...d })),
    deadline: scheme.deadline === null ? null : scheme.deadline.toISOString(),
  };
}

// ─── Internal helpers: deserialization ───────────────────────────────────────

function requireString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string') {
    throw new SchemeDeserializationError(
      `Mandatory field "${field}" is missing or not a string`,
      field,
    );
  }
  return value;
}

function parseEligibilityCriteria(value: unknown): EligibilityCriterion[] {
  if (!Array.isArray(value)) {
    throw new SchemeDeserializationError(
      'Mandatory field "eligibilityCriteria" is missing or not an array',
      'eligibilityCriteria',
    );
  }
  return value.map((entry, idx) => parseEligibilityCriterion(entry, idx));
}

const VALID_OPERATORS: ReadonlySet<EligibilityCriterion['operator']> = new Set([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'between',
]);

function parseEligibilityCriterion(value: unknown, idx: number): EligibilityCriterion {
  const path = `eligibilityCriteria[${idx}]`;
  if (!isPlainObject(value)) {
    throw new SchemeDeserializationError(`${path} must be an object`, path);
  }
  const field = value['field'];
  const operator = value['operator'];
  const description = value['description'];
  if (typeof field !== 'string') {
    throw new SchemeDeserializationError(`${path}.field must be a string`, `${path}.field`);
  }
  if (typeof operator !== 'string' || !VALID_OPERATORS.has(operator as EligibilityCriterion['operator'])) {
    throw new SchemeDeserializationError(
      `${path}.operator must be one of ${[...VALID_OPERATORS].join(', ')}`,
      `${path}.operator`,
    );
  }
  if (typeof description !== 'string') {
    throw new SchemeDeserializationError(
      `${path}.description must be a string`,
      `${path}.description`,
    );
  }
  return {
    field,
    operator: operator as EligibilityCriterion['operator'],
    value: value['value'],
    description,
  };
}

function parseBenefits(value: unknown): Benefit[] {
  if (!Array.isArray(value)) {
    throw new SchemeDeserializationError(
      'Mandatory field "benefits" is missing or not an array',
      'benefits',
    );
  }
  return value.map((entry, idx) => parseBenefit(entry, idx));
}

function parseBenefit(value: unknown, idx: number): Benefit {
  const path = `benefits[${idx}]`;
  if (!isPlainObject(value)) {
    throw new SchemeDeserializationError(`${path} must be an object`, path);
  }
  const type = value['type'];
  const description = value['description'];
  const amount = value['amount'];
  if (type !== 'monetary' && type !== 'non-monetary') {
    throw new SchemeDeserializationError(
      `${path}.type must be "monetary" or "non-monetary"`,
      `${path}.type`,
    );
  }
  if (typeof description !== 'string') {
    throw new SchemeDeserializationError(
      `${path}.description must be a string`,
      `${path}.description`,
    );
  }
  let parsedAmount: number | null;
  if (amount === null || amount === undefined) {
    parsedAmount = null;
  } else if (typeof amount === 'number' && Number.isFinite(amount)) {
    parsedAmount = amount;
  } else {
    throw new SchemeDeserializationError(
      `${path}.amount must be a finite number or null`,
      `${path}.amount`,
    );
  }
  return { type, amount: parsedAmount, description };
}

function parseApplicationProcess(value: unknown): ApplicationStep[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new SchemeDeserializationError(
      'Optional field "applicationProcess" must be an array or null',
      'applicationProcess',
    );
  }
  return value.map((entry, idx) => parseApplicationStep(entry, idx));
}

function parseApplicationStep(value: unknown, idx: number): ApplicationStep {
  const path = `applicationProcess[${idx}]`;
  if (!isPlainObject(value)) {
    throw new SchemeDeserializationError(`${path} must be an object`, path);
  }
  const stepNumber = value['stepNumber'];
  const action = value['action'];
  const expectedOutcome = value['expectedOutcome'];
  if (typeof stepNumber !== 'number' || !Number.isInteger(stepNumber)) {
    throw new SchemeDeserializationError(
      `${path}.stepNumber must be an integer`,
      `${path}.stepNumber`,
    );
  }
  if (typeof action !== 'string') {
    throw new SchemeDeserializationError(`${path}.action must be a string`, `${path}.action`);
  }
  if (typeof expectedOutcome !== 'string') {
    throw new SchemeDeserializationError(
      `${path}.expectedOutcome must be a string`,
      `${path}.expectedOutcome`,
    );
  }
  return { stepNumber, action, expectedOutcome };
}

function parseRequiredDocuments(value: unknown): DocumentRequirement[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new SchemeDeserializationError(
      'Optional field "requiredDocuments" must be an array or null',
      'requiredDocuments',
    );
  }
  return value.map((entry, idx) => parseDocumentRequirement(entry, idx));
}

function parseDocumentRequirement(value: unknown, idx: number): DocumentRequirement {
  const path = `requiredDocuments[${idx}]`;
  if (!isPlainObject(value)) {
    throw new SchemeDeserializationError(`${path} must be an object`, path);
  }
  const documentName = value['documentName'];
  const description = value['description'];
  const format = value['format'];
  const required = value['required'];
  if (typeof documentName !== 'string') {
    throw new SchemeDeserializationError(
      `${path}.documentName must be a string`,
      `${path}.documentName`,
    );
  }
  if (typeof description !== 'string') {
    throw new SchemeDeserializationError(
      `${path}.description must be a string`,
      `${path}.description`,
    );
  }
  if (typeof format !== 'string') {
    throw new SchemeDeserializationError(`${path}.format must be a string`, `${path}.format`);
  }
  if (typeof required !== 'boolean') {
    throw new SchemeDeserializationError(
      `${path}.required must be a boolean`,
      `${path}.required`,
    );
  }
  return { documentName, description, format, required };
}

function parseDeadline(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new SchemeDeserializationError(
      'Optional field "deadline" must be an ISO 8601 string or null',
      'deadline',
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new SchemeDeserializationError(
      `Optional field "deadline" is not a valid ISO 8601 date: ${value}`,
      'deadline',
    );
  }
  return parsed;
}

// ─── Internal helpers: equality ──────────────────────────────────────────────

/**
 * Maps a {@link SchemeObject} to a value suitable for structural deep
 * equality: `Date` becomes its numeric timestamp, everything else is
 * preserved.
 */
function toComparable(scheme: SchemeObject): unknown {
  return {
    name: scheme.name,
    description: scheme.description,
    eligibilityCriteria: scheme.eligibilityCriteria,
    benefits: scheme.benefits,
    sourceUrl: scheme.sourceUrl,
    ministry: scheme.ministry,
    applicationProcess: scheme.applicationProcess,
    requiredDocuments: scheme.requiredDocuments,
    deadline: scheme.deadline === null ? null : scheme.deadline.getTime(),
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date) || !(b instanceof Date)) return false;
    return a.getTime() === b.getTime();
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
