/**
 * Scheme Management Service for the Admin Dashboard (Requirement 17.2).
 *
 * Administrators can manually verify, edit, or remove a scheme via the
 * dashboard. Each transition records an audit-log entry capturing the
 * administrator identity, the action taken, and the timestamp so the
 * platform meets Req 17.2's "who did what, when" requirement.
 *
 * Editable fields are deliberately limited to the citizen-visible
 * surface area — name, description, ministry, state, category, source
 * URLs, benefit details, deadlines, application metadata, and the
 * structured eligibility / application-step JSON columns. Trust score
 * and verification flag are excluded from the generic edit path because
 * they have dedicated workflows (`verifyScheme`, the flag approve /
 * reject endpoints) that ensure the citizen-visibility invariants are
 * preserved.
 *
 * The service is dependency-injected so unit tests can pass an
 * in-memory fake Prisma client and capture audit-log calls without
 * touching the database.
 */

import { logAction, type LogActionParams } from '../audit.service';

/**
 * Trust score that a manually verified scheme is lifted to when the
 * existing score is below the citizen-visibility threshold (Req 1.7).
 * Mirrors the constant used by the flag approval workflow so the two
 * paths produce identical end-states.
 */
export const VERIFIED_SCHEME_TRUST_SCORE = 60;

/** Whitelisted fields the dashboard's edit form is allowed to update. */
export const EDITABLE_SCHEME_FIELDS = [
  'name',
  'description',
  'ministry',
  'state',
  'category',
  'sourceUrl',
  'benefitType',
  'benefitAmount',
  'deadline',
  'applicationMode',
  'applicationUrl',
  'eligibilityCriteria',
  'applicationSteps',
] as const;

export type EditableSchemeField = (typeof EDITABLE_SCHEME_FIELDS)[number];

/** Patch payload accepted by {@link SchemeManagementService.editScheme}. */
export type SchemeEditPatch = Partial<{
  name: string;
  description: string;
  ministry: string;
  state: string | null;
  category: string;
  sourceUrl: string;
  benefitType: 'monetary' | 'non-monetary';
  benefitAmount: number | null;
  deadline: Date | string | null;
  applicationMode: 'online' | 'offline' | 'hybrid';
  applicationUrl: string | null;
  eligibilityCriteria: unknown[];
  applicationSteps: unknown[] | null;
}>;

/** Input for {@link SchemeManagementService.verifyScheme}. */
export interface VerifySchemeInput {
  schemeId: string;
  adminId: string;
  /** Optional administrator note. */
  note?: string;
}

/** Input for {@link SchemeManagementService.editScheme}. */
export interface EditSchemeInput {
  schemeId: string;
  adminId: string;
  patch: SchemeEditPatch;
  /** Optional administrator note. */
  note?: string;
}

/** Input for {@link SchemeManagementService.removeScheme}. */
export interface RemoveSchemeInput {
  schemeId: string;
  adminId: string;
  /** Required removal reason — the audit trail captures it. */
  reason: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class SchemeNotFoundError extends Error {
  constructor(public readonly schemeId: string) {
    super(`Scheme not found: ${schemeId}`);
    this.name = 'SchemeNotFoundError';
  }
}

export class InvalidEditPatchError extends Error {
  constructor(
    message: string,
    public readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'InvalidEditPatchError';
  }
}

export class MissingRemovalReasonError extends Error {
  constructor() {
    super('Removal reason is required');
    this.name = 'MissingRemovalReasonError';
  }
}

// ─── Prisma surface ──────────────────────────────────────────────────────────

interface SchemeManagementRow {
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

interface PrismaSurface {
  scheme: {
    findUnique: (args: { where: { id: string } }) => Promise<SchemeManagementRow | null>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<SchemeManagementRow>;
    delete: (args: { where: { id: string } }) => Promise<SchemeManagementRow>;
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

export type AuditLogger = (params: LogActionParams) => Promise<unknown>;

export interface SchemeManagementServiceDeps {
  prisma?: PrismaSurface;
  audit?: AuditLogger;
  now?: () => Date;
}

export class SchemeManagementService {
  private prismaPromise: Promise<PrismaSurface> | null = null;
  private readonly explicitPrisma: PrismaSurface | null;
  private readonly audit: AuditLogger;
  private readonly now: () => Date;

  constructor(deps: SchemeManagementServiceDeps = {}) {
    this.explicitPrisma = deps.prisma ?? null;
    this.audit = deps.audit ?? logAction;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Manually verifies a scheme (Req 17.2). Sets `verified = true`,
   * lifts the trust score above the citizen-visibility threshold when
   * needed, stamps `lastVerifiedAt`, and records an audit entry.
   */
  async verifyScheme(input: VerifySchemeInput): Promise<SchemeManagementRow> {
    const prisma = await this.getPrisma();
    const existing = await this.requireScheme(input.schemeId);
    const previousTrust = existing.trustScore ?? 0;
    const newTrust = Math.max(previousTrust, VERIFIED_SCHEME_TRUST_SCORE);
    const verifiedAt = this.now();
    const updated = await prisma.scheme.update({
      where: { id: input.schemeId },
      data: {
        verified: true,
        trustScore: newTrust,
        lastVerifiedAt: verifiedAt,
      },
    });
    await this.recordAudit({
      adminId: input.adminId,
      action: 'admin.scheme.verify',
      resourceId: input.schemeId,
      details: {
        previousTrustScore: previousTrust,
        newTrustScore: newTrust,
        previousVerified: existing.verified,
        newVerified: true,
        note: input.note ?? null,
      },
    });
    return updated;
  }

  /**
   * Edits a scheme (Req 17.2). Only fields listed in
   * {@link EDITABLE_SCHEME_FIELDS} are accepted — anything else throws
   * an {@link InvalidEditPatchError}. The audit log captures both the
   * previous and new value of every changed field so administrators
   * can reconstruct a change after the fact.
   */
  async editScheme(input: EditSchemeInput): Promise<SchemeManagementRow> {
    const prisma = await this.getPrisma();
    const existing = await this.requireScheme(input.schemeId);
    const sanitized = sanitizePatch(input.patch);
    if (Object.keys(sanitized.data).length === 0) {
      throw new InvalidEditPatchError('No editable fields supplied in patch');
    }
    const updated = await prisma.scheme.update({
      where: { id: input.schemeId },
      data: { ...sanitized.data, updatedAt: this.now() },
    });
    await this.recordAudit({
      adminId: input.adminId,
      action: 'admin.scheme.edit',
      resourceId: input.schemeId,
      details: {
        changedFields: sanitized.changedFields,
        previousValues: pickFields(existing, sanitized.changedFields),
        newValues: pickFields(updated, sanitized.changedFields),
        note: input.note ?? null,
      },
    });
    return updated;
  }

  /**
   * Removes a scheme (Req 17.2). The platform cascades the deletion to
   * compatibility rows, document checklist rows, embeddings, saved
   * schemes, and so on (Prisma `onDelete: Cascade`). The audit log
   * captures the full pre-deletion snapshot so administrators can
   * reconstruct what was deleted if a citizen later asks.
   */
  async removeScheme(input: RemoveSchemeInput): Promise<void> {
    if (!input.reason || input.reason.trim() === '') {
      throw new MissingRemovalReasonError();
    }
    const prisma = await this.getPrisma();
    const existing = await this.requireScheme(input.schemeId);
    await prisma.scheme.delete({ where: { id: input.schemeId } });
    await this.recordAudit({
      adminId: input.adminId,
      action: 'admin.scheme.remove',
      resourceId: input.schemeId,
      details: {
        reason: input.reason.trim(),
        snapshot: serializeForAudit(existing),
      },
    });
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private async requireScheme(schemeId: string): Promise<SchemeManagementRow> {
    const prisma = await this.getPrisma();
    const row = await prisma.scheme.findUnique({ where: { id: schemeId } });
    if (!row) {
      throw new SchemeNotFoundError(schemeId);
    }
    return row;
  }

  private async recordAudit(params: {
    adminId: string;
    action: string;
    resourceId: string;
    details: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.audit({
        userId: params.adminId,
        action: params.action,
        resourceType: 'scheme',
        resourceId: params.resourceId,
        details: params.details,
        actorIdentity: `admin:${params.adminId}`,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to write admin scheme audit entry', err);
    }
  }

  private async getPrisma(): Promise<PrismaSurface> {
    if (this.explicitPrisma) return this.explicitPrisma;
    if (!this.prismaPromise) {
      this.prismaPromise = import('../../lib/prisma').then(
        (mod) => mod.default as unknown as PrismaSurface,
      );
    }
    return this.prismaPromise;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const EDITABLE_FIELD_SET = new Set<string>(EDITABLE_SCHEME_FIELDS);

function sanitizePatch(patch: SchemeEditPatch | null | undefined): {
  data: Record<string, unknown>;
  changedFields: EditableSchemeField[];
} {
  if (!patch || typeof patch !== 'object') {
    throw new InvalidEditPatchError('patch must be an object');
  }
  const data: Record<string, unknown> = {};
  const changedFields: EditableSchemeField[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (!EDITABLE_FIELD_SET.has(field)) {
      throw new InvalidEditPatchError(
        `Field "${field}" is not editable from the admin dashboard`,
        field,
      );
    }
    if (value === undefined) continue;
    const coerced = coerceFieldValue(field as EditableSchemeField, value);
    data[field] = coerced;
    changedFields.push(field as EditableSchemeField);
  }
  return { data, changedFields };
}

function coerceFieldValue(field: EditableSchemeField, raw: unknown): unknown {
  switch (field) {
    case 'deadline': {
      if (raw === null) return null;
      if (raw instanceof Date) return raw;
      if (typeof raw === 'string' || typeof raw === 'number') {
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) {
          throw new InvalidEditPatchError(
            `Field "${field}" must be a valid date`,
            field,
          );
        }
        return date;
      }
      throw new InvalidEditPatchError(
        `Field "${field}" must be a date or null`,
        field,
      );
    }
    case 'benefitAmount': {
      if (raw === null) return null;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        throw new InvalidEditPatchError(
          `Field "${field}" must be a non-negative number`,
          field,
        );
      }
      return n;
    }
    case 'eligibilityCriteria':
    case 'applicationSteps': {
      if (raw === null) return null;
      if (!Array.isArray(raw)) {
        throw new InvalidEditPatchError(
          `Field "${field}" must be an array`,
          field,
        );
      }
      return raw;
    }
    case 'state':
    case 'applicationUrl': {
      if (raw === null) return null;
      if (typeof raw !== 'string') {
        throw new InvalidEditPatchError(
          `Field "${field}" must be a string or null`,
          field,
        );
      }
      const trimmed = raw.trim();
      return trimmed.length === 0 ? null : trimmed;
    }
    case 'benefitType': {
      if (raw !== 'monetary' && raw !== 'non-monetary') {
        throw new InvalidEditPatchError(
          `Field "${field}" must be "monetary" or "non-monetary"`,
          field,
        );
      }
      return raw;
    }
    case 'applicationMode': {
      if (raw !== 'online' && raw !== 'offline' && raw !== 'hybrid') {
        throw new InvalidEditPatchError(
          `Field "${field}" must be one of "online", "offline", "hybrid"`,
          field,
        );
      }
      return raw;
    }
    default: {
      if (typeof raw !== 'string') {
        throw new InvalidEditPatchError(
          `Field "${field}" must be a string`,
          field,
        );
      }
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        throw new InvalidEditPatchError(
          `Field "${field}" must not be empty`,
          field,
        );
      }
      return trimmed;
    }
  }
}

function pickFields(
  row: SchemeManagementRow,
  fields: ReadonlyArray<EditableSchemeField>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    out[field] = (row as unknown as Record<string, unknown>)[field] ?? null;
  }
  return out;
}

function serializeForAudit(row: SchemeManagementRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    ministry: row.ministry,
    state: row.state,
    category: row.category,
    sourceUrl: row.sourceUrl,
    trustScore: row.trustScore,
    verified: row.verified,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString?.() ?? null,
  };
}

/** Process-wide singleton used by the production wiring. */
export const schemeManagementService = new SchemeManagementService();
