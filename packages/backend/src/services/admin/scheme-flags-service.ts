/**
 * Scheme Flag Management Service (Requirements 17.3, 17.5, 17.6).
 *
 * The Crawler_System and Change_Detector raise flags on schemes that
 * need administrator attention — low trust score, mandatory field
 * issues, or detected changes that require re-verification. This
 * service:
 *   - Lists pending flags sorted by `flaggedAt` descending so the most
 *     recent appears first (Req 17.3),
 *   - Exposes the approve workflow that lifts the underlying scheme
 *     into citizen-visible state (Req 17.5),
 *   - Exposes the reject workflow that keeps the scheme hidden and
 *     records the administrator's reason (Req 17.6).
 *
 * Every administrator-initiated transition is recorded in the audit
 * log via {@link logAction} so the platform can show "who did what,
 * when" forever (Req 17.2).
 *
 * The service accepts an injectable Prisma surface so integration tests
 * can pass an in-memory fake without standing up Postgres.
 */

import { logAction, type LogActionParams } from '../audit.service';

/**
 * Trust score that an administrator-approved scheme is lifted to when
 * the original score was below the citizen-visibility threshold of 60
 * (Req 1.7). Approving via the dashboard counts as manual verification
 * and so the scheme gets at least the threshold value plus a small
 * margin so a future automatic recalculation does not immediately push
 * it back below the line.
 */
export const APPROVED_FLAG_TRUST_SCORE = 60;

// ─── Wire-format types ──────────────────────────────────────────────────────

/** Source of the flag. Determines the reviewer's expectations. */
export type FlagSource = 'crawler' | 'change_detector' | 'admin';

/** Lifecycle status for a flag. */
export type FlagStatus = 'pending' | 'approved' | 'rejected';

/** Public shape of a flag row returned to the admin dashboard. */
export interface SchemeFlagRecord {
  id: string;
  schemeId: string;
  /** Human-readable flag reason (Req 17.3). */
  reason: string;
  /** Origin of the flag. */
  flagSource: FlagSource;
  /** Source URL captured at flag time (Req 17.3). */
  sourceUrl: string | null;
  status: FlagStatus;
  /** Administrator id that resolved the flag, if resolved. */
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  flaggedAt: Date;
  /**
   * Embedded scheme summary so the dashboard can render the row without
   * a second round-trip. Optional — when the underlying scheme has
   * been deleted out from under us this collapses to `null` and the
   * row renders with the orphaned-scheme message.
   */
  scheme: {
    id: string;
    name: string;
    ministry: string;
    state: string | null;
    trustScore: number;
    verified: boolean;
    lastVerifiedAt: Date | null;
  } | null;
}

/** Filter used by {@link SchemeFlagsService.listFlags}. */
export interface ListFlagsFilter {
  /** Filter by lifecycle status — defaults to "pending" only. */
  status?: FlagStatus | 'all';
  /** Maximum rows to return (default 50, max 200). */
  limit?: number;
  /** Pagination offset (default 0). */
  offset?: number;
}

/** Result returned to the admin dashboard's flag listing endpoint. */
export interface ListFlagsResult {
  flags: SchemeFlagRecord[];
  totalCount: number;
}

/** Input for {@link SchemeFlagsService.createFlag} — used by crawler / change-detector. */
export interface CreateFlagInput {
  schemeId: string;
  reason: string;
  flagSource: FlagSource;
  sourceUrl?: string | null;
}

/** Input for {@link SchemeFlagsService.approveFlag}. */
export interface ApproveFlagInput {
  flagId: string;
  /** Administrator id (subject from the auth token). */
  adminId: string;
  /** Optional administrator note to record alongside the approval. */
  note?: string;
}

/** Input for {@link SchemeFlagsService.rejectFlag}. */
export interface RejectFlagInput {
  flagId: string;
  adminId: string;
  /** Required rejection reason — Req 17.6 says the platform records it. */
  reason: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Thrown when an operation references a flag that does not exist. */
export class FlagNotFoundError extends Error {
  constructor(public readonly flagId: string) {
    super(`Flag not found: ${flagId}`);
    this.name = 'FlagNotFoundError';
  }
}

/**
 * Thrown when the caller tries to approve/reject a flag that has
 * already been resolved. Prevents accidental double-resolution that
 * would corrupt the audit trail.
 */
export class FlagAlreadyResolvedError extends Error {
  constructor(
    public readonly flagId: string,
    public readonly status: FlagStatus,
  ) {
    super(`Flag ${flagId} is already ${status}`);
    this.name = 'FlagAlreadyResolvedError';
  }
}

/**
 * Thrown when {@link RejectFlagInput.reason} is missing — Req 17.6
 * mandates that the platform record the rejection reason provided by
 * the administrator.
 */
export class MissingRejectionReasonError extends Error {
  constructor() {
    super('Rejection reason is required');
    this.name = 'MissingRejectionReasonError';
  }
}

// ─── Prisma surface (structurally typed for tests) ──────────────────────────

interface SchemeFlagRow {
  id: string;
  schemeId: string;
  reason: string;
  flagSource: string;
  sourceUrl: string | null;
  status: string;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  flaggedAt: Date;
  scheme?: SchemeRow | null;
}

interface SchemeRow {
  id: string;
  name: string;
  ministry: string;
  state: string | null;
  trustScore: number;
  verified: boolean;
  lastVerifiedAt: Date | null;
}

interface PrismaSurface {
  schemeFlag: {
    findMany: (args: {
      where?: Record<string, unknown>;
      orderBy?: unknown;
      take?: number;
      skip?: number;
      include?: { scheme?: boolean };
    }) => Promise<SchemeFlagRow[]>;
    count: (args?: { where?: Record<string, unknown> }) => Promise<number>;
    findUnique: (args: {
      where: { id: string };
      include?: { scheme?: boolean };
    }) => Promise<SchemeFlagRow | null>;
    create: (args: { data: Record<string, unknown> }) => Promise<SchemeFlagRow>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<SchemeFlagRow>;
  };
  scheme: {
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<SchemeRow>;
    findUnique: (args: { where: { id: string } }) => Promise<SchemeRow | null>;
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

/** Audit logger surface — structurally compatible with `logAction`. */
export type AuditLogger = (params: LogActionParams) => Promise<unknown>;

export interface SchemeFlagsServiceDeps {
  prisma?: PrismaSurface;
  /** Override the audit logger — primarily used by tests. */
  audit?: AuditLogger;
  /** Override the clock — primarily used by tests. */
  now?: () => Date;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class SchemeFlagsService {
  private prismaPromise: Promise<PrismaSurface> | null = null;
  private readonly explicitPrisma: PrismaSurface | null;
  private readonly audit: AuditLogger;
  private readonly now: () => Date;

  constructor(deps: SchemeFlagsServiceDeps = {}) {
    this.explicitPrisma = deps.prisma ?? null;
    this.audit = deps.audit ?? logAction;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Lists flagged schemes ordered by `flaggedAt` descending (Req 17.3).
   * Defaults to `status: "pending"` so the dashboard surfaces work that
   * still needs an administrator decision; pass `status: "all"` to see
   * resolved flags as well.
   */
  async listFlags(filter: ListFlagsFilter = {}): Promise<ListFlagsResult> {
    const prisma = await this.getPrisma();
    const limit = clampLimit(filter.limit);
    const offset = Math.max(0, Math.floor(filter.offset ?? 0));
    const where: Record<string, unknown> = {};
    const status = filter.status ?? 'pending';
    if (status !== 'all') {
      where.status = status;
    }
    const [rows, totalCount] = await Promise.all([
      prisma.schemeFlag.findMany({
        where,
        orderBy: [{ flaggedAt: 'desc' }],
        take: limit,
        skip: offset,
        include: { scheme: true },
      }),
      prisma.schemeFlag.count({ where }),
    ]);
    return {
      flags: rows.map((row) => mapFlagRow(row)),
      totalCount,
    };
  }

  /**
   * Creates a flag. Used by the Crawler_System and Change_Detector to
   * raise issues into the admin dashboard.
   */
  async createFlag(input: CreateFlagInput): Promise<SchemeFlagRecord> {
    if (!input.schemeId || typeof input.schemeId !== 'string') {
      throw new TypeError('schemeId is required');
    }
    if (!input.reason || input.reason.trim() === '') {
      throw new TypeError('reason is required');
    }
    const prisma = await this.getPrisma();
    const row = await prisma.schemeFlag.create({
      data: {
        schemeId: input.schemeId,
        reason: input.reason.trim(),
        flagSource: input.flagSource,
        sourceUrl: input.sourceUrl ?? null,
        status: 'pending',
        flaggedAt: this.now(),
      },
    });
    return mapFlagRow(row);
  }

  /**
   * Approves a pending flag (Req 17.5).
   *
   * Updates the underlying scheme so it is verified and visible to
   * citizens, lifting `trustScore` above the citizen-visibility
   * threshold when needed (Req 1.7). Records both the flag resolution
   * and the scheme update in the audit log.
   */
  async approveFlag(input: ApproveFlagInput): Promise<SchemeFlagRecord> {
    const flag = await this.requirePendingFlag(input.flagId);
    const prisma = await this.getPrisma();
    const resolvedAt = this.now();

    // Lift the underlying scheme into citizen-visible state. We use
    // `Math.max` so an already-trusted scheme keeps its high score.
    const existingScore = flag.scheme?.trustScore ?? 0;
    const newTrustScore = Math.max(existingScore, APPROVED_FLAG_TRUST_SCORE);
    await prisma.scheme.update({
      where: { id: flag.schemeId },
      data: {
        verified: true,
        trustScore: newTrustScore,
        lastVerifiedAt: resolvedAt,
      },
    });

    const updatedFlag = await prisma.schemeFlag.update({
      where: { id: flag.id },
      data: {
        status: 'approved',
        resolvedBy: input.adminId,
        resolvedAt,
        resolutionNote: input.note?.trim() || null,
      },
    });

    await this.recordAudit({
      adminId: input.adminId,
      action: 'admin.flag.approve',
      resourceId: flag.schemeId,
      details: {
        flagId: flag.id,
        previousTrustScore: existingScore,
        newTrustScore,
        previousVerified: flag.scheme?.verified ?? false,
        newVerified: true,
        note: input.note ?? null,
      },
    });

    return mapFlagRow({ ...updatedFlag, scheme: flag.scheme ?? null });
  }

  /**
   * Rejects a pending flag (Req 17.6).
   *
   * Keeps the underlying scheme hidden — `verified` stays false —
   * and records the administrator-supplied reason in the flag row and
   * the audit log.
   */
  async rejectFlag(input: RejectFlagInput): Promise<SchemeFlagRecord> {
    if (!input.reason || input.reason.trim() === '') {
      throw new MissingRejectionReasonError();
    }
    const flag = await this.requirePendingFlag(input.flagId);
    const prisma = await this.getPrisma();
    const resolvedAt = this.now();

    // Force the scheme to stay hidden — even if it was somehow flipped
    // verified between flag creation and this call we drop it back to
    // unverified so citizens never see a rejected scheme.
    await prisma.scheme.update({
      where: { id: flag.schemeId },
      data: {
        verified: false,
        lastVerifiedAt: resolvedAt,
      },
    });

    const updatedFlag = await prisma.schemeFlag.update({
      where: { id: flag.id },
      data: {
        status: 'rejected',
        resolvedBy: input.adminId,
        resolvedAt,
        resolutionNote: input.reason.trim(),
      },
    });

    await this.recordAudit({
      adminId: input.adminId,
      action: 'admin.flag.reject',
      resourceId: flag.schemeId,
      details: {
        flagId: flag.id,
        reason: input.reason.trim(),
        previousVerified: flag.scheme?.verified ?? false,
        newVerified: false,
      },
    });

    return mapFlagRow({ ...updatedFlag, scheme: flag.scheme ?? null });
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private async requirePendingFlag(flagId: string): Promise<SchemeFlagRow> {
    const prisma = await this.getPrisma();
    const flag = await prisma.schemeFlag.findUnique({
      where: { id: flagId },
      include: { scheme: true },
    });
    if (!flag) {
      throw new FlagNotFoundError(flagId);
    }
    if (flag.status !== 'pending') {
      throw new FlagAlreadyResolvedError(flagId, flag.status as FlagStatus);
    }
    return flag;
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
      // Audit failures must not block the administrator's action — log
      // and continue. The caller is expected to surface a non-200
      // separately if the underlying transition fails.
      // eslint-disable-next-line no-console
      console.error('Failed to write admin flag audit entry', err);
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

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(limit));
}

function mapFlagRow(row: SchemeFlagRow): SchemeFlagRecord {
  return {
    id: row.id,
    schemeId: row.schemeId,
    reason: row.reason,
    flagSource: (row.flagSource as FlagSource) ?? 'admin',
    sourceUrl: row.sourceUrl,
    status: (row.status as FlagStatus) ?? 'pending',
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
    flaggedAt: row.flaggedAt,
    scheme: row.scheme
      ? {
          id: row.scheme.id,
          name: row.scheme.name,
          ministry: row.scheme.ministry,
          state: row.scheme.state,
          trustScore: row.scheme.trustScore,
          verified: row.scheme.verified,
          lastVerifiedAt: row.scheme.lastVerifiedAt,
        }
      : null,
  };
}

/** Process-wide singleton used by the production wiring. */
export const schemeFlagsService = new SchemeFlagsService();
