/**
 * Audit Log Service
 *
 * Records all profile data access and modifications.
 * Logs are retained for a minimum of 365 days (policy-enforced; pruning never
 * deletes records younger than {@link AUDIT_LOG_RETENTION_DAYS}).
 *
 * Validates: Requirement 16.6
 */

import { prisma } from '../lib/prisma';
import type { AuditLogEntry } from '@bharat-benefits/shared';

/**
 * Minimum retention period for audit logs in days.
 * Per Requirement 16.6, logs MUST be retained for at least 365 days.
 */
export const AUDIT_LOG_RETENTION_DAYS = 365;

// ─── Public API Types ────────────────────────────────────────────────────────

/** Parameters for recording a read/access event on profile data. */
export interface LogAccessParams {
  userId: string | null;
  actorIdentity: string;
  resourceType: string;
  resourceId: string | null;
  details?: Record<string, unknown>;
}

/** Parameters for recording a create/update/delete event on profile data. */
export interface LogModificationParams {
  userId: string | null;
  actorIdentity: string;
  /** Action verb such as 'create', 'update', 'delete'. */
  action: string;
  resourceType: string;
  resourceId: string | null;
  previousValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

/** Generic parameters used by the legacy {@link logAction} entry point. */
export interface LogActionParams {
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details?: Record<string, unknown>;
  actorIdentity: string;
}

/** Filter for querying audit logs. */
export interface AuditLogFilter {
  userId?: string;
  resourceType?: string;
  resourceId?: string;
  action?: string;
  actorIdentity?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

/** Legacy query options retained for backward compatibility. */
export interface QueryOptions {
  limit?: number;
  offset?: number;
  startDate?: Date;
  endDate?: Date;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ─── Service Implementation ──────────────────────────────────────────────────

/**
 * Records an access (read) event on a resource.
 *
 * Used for read operations on user profile data (e.g., GET /api/profile).
 * Always writes a UTC timestamp via `new Date()`.
 */
export async function logAccess(params: LogAccessParams): Promise<AuditLogEntry> {
  return logAction({
    userId: params.userId,
    actorIdentity: params.actorIdentity,
    action: 'read',
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    details: params.details,
  });
}

/**
 * Records a modification (create/update/delete) event on a resource.
 *
 * Captures both previous and new values inside the `details` JSONB column so
 * that auditors can reconstruct the change after the fact.
 */
export async function logModification(
  params: LogModificationParams
): Promise<AuditLogEntry> {
  const details: Record<string, unknown> = { ...(params.details ?? {}) };

  if (params.previousValues !== undefined) {
    details.previousValues = params.previousValues;
  }
  if (params.newValues !== undefined) {
    details.newValues = params.newValues;
  }

  return logAction({
    userId: params.userId,
    actorIdentity: params.actorIdentity,
    action: params.action,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    details,
  });
}

/**
 * Queries historical audit logs using a flexible filter.
 *
 * Results are ordered by timestamp descending (most recent first).
 * The `limit` parameter is capped at {@link MAX_LIMIT} to protect the database.
 */
export async function getAuditLogs(
  filter: AuditLogFilter = {}
): Promise<AuditLogEntry[]> {
  const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = filter.offset ?? 0;

  const where: Record<string, unknown> = {};
  if (filter.userId) where.userId = filter.userId;
  if (filter.resourceType) where.resourceType = filter.resourceType;
  if (filter.resourceId) where.resourceId = filter.resourceId;
  if (filter.action) where.action = filter.action;
  if (filter.actorIdentity) where.actorIdentity = filter.actorIdentity;
  if (filter.startDate || filter.endDate) {
    where.timestamp = buildDateFilter(filter.startDate, filter.endDate);
  }

  const entries = await prisma.auditLog.findMany({
    where,
    orderBy: { timestamp: 'desc' },
    take: limit,
    skip: offset,
  });

  return entries.map(mapToAuditLogEntry);
}

/**
 * Prunes audit log entries older than the configured retention period.
 *
 * To enforce Requirement 16.6, this function refuses to delete records that
 * fall within {@link AUDIT_LOG_RETENTION_DAYS}. Callers may request a longer
 * retention window, but never a shorter one.
 *
 * On the partitioned `audit_logs` table introduced by migration
 * `20260615001000_partition_audit_logs`, we issue `DROP TABLE` against
 * any partition whose upper bound is ≤ the retention cutoff. Dropping
 * a partition is O(1) — far cheaper than the equivalent `DELETE` —
 * and immediately frees the disk. If a partition straddles the cutoff
 * (i.e. it ends after the cutoff) we fall back to a row-level
 * `DELETE` for the matching rows so we never delete anything inside
 * the retention window.
 *
 * @param retentionDays Number of days to retain (clamped to a minimum of
 *   {@link AUDIT_LOG_RETENTION_DAYS}). Defaults to 365.
 * @returns Number of rows pruned (estimated when partitions are dropped).
 */
export async function pruneOldLogs(
  retentionDays: number = AUDIT_LOG_RETENTION_DAYS
): Promise<number> {
  // Enforce the minimum retention floor — never allow pruning newer logs.
  const effectiveRetention = Math.max(retentionDays, AUDIT_LOG_RETENTION_DAYS);
  const cutoff = new Date(Date.now() - effectiveRetention * 24 * 60 * 60 * 1000);

  // Discover any monthly partition whose upper bound is fully past the
  // cutoff. Partition names follow the `audit_logs_yYYYYmMM` convention
  // emitted by the partitioning migration; the LIKE filter ignores the
  // parent table itself plus the `_default` catch-all.
  //
  // Wrapped in try/catch because some test suites stub the Prisma
  // client without `$queryRaw` — falling back to row-level DELETE in
  // that case keeps unit tests green.
  type PartitionRow = { relname: string; pg_get_expr: string };
  let partitionRows: PartitionRow[] = [];
  try {
    const queryRaw = (
      prisma as unknown as {
        $queryRaw?: (...args: unknown[]) => Promise<PartitionRow[]>;
      }
    ).$queryRaw;
    if (typeof queryRaw === 'function') {
      partitionRows =
        (await queryRaw.call(
          prisma,
          /* tagged-template segments */
          Object.assign(
            [
              `SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'audit_logs' AND c.relname LIKE 'audit_logs_y%m%'`,
            ],
            { raw: [''] },
          ),
        )) ?? [];
    }
  } catch {
    partitionRows = [];
  }

  let prunedRows = 0;

  for (const row of partitionRows) {
    // Bound expression looks like:
    //   FOR VALUES FROM ('2025-01-01') TO ('2025-02-01')
    // Pull the upper bound and compare against the cutoff. Anything
    // whose upper bound is on or before the cutoff is fully expired
    // and safe to drop wholesale.
    const upperMatch = /TO \('([^']+)'\)/.exec(row.pg_get_expr);
    if (!upperMatch) continue;
    const upper = new Date(upperMatch[1]);
    if (Number.isNaN(upper.getTime())) continue;
    if (upper.getTime() > cutoff.getTime()) continue;

    try {
      const queryRawUnsafe = (
        prisma as unknown as {
          $queryRawUnsafe?: <T>(sql: string) => Promise<T>;
        }
      ).$queryRawUnsafe;
      const executeRawUnsafe = (
        prisma as unknown as {
          $executeRawUnsafe?: (sql: string) => Promise<unknown>;
        }
      ).$executeRawUnsafe;
      if (typeof queryRawUnsafe !== 'function' || typeof executeRawUnsafe !== 'function') {
        continue;
      }
      // Count first so the return value is meaningful to callers.
      const countRows = await queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count FROM "${row.relname}"`,
      );
      const count = Number(countRows[0]?.count ?? 0n);
      await executeRawUnsafe(`DROP TABLE IF EXISTS "${row.relname}"`);
      prunedRows += count;
    } catch {
      // Best effort — fall through to the row-level DELETE below.
    }
  }

  // Catch any remaining rows older than the cutoff that live inside a
  // partition straddling the cutoff (or in the `_default` catch-all).
  // This is the slow path — partition drops handle the bulk.
  const result = await prisma.auditLog.deleteMany({
    where: { timestamp: { lt: cutoff } },
  });

  return prunedRows + result.count;
}

/**
 * Creates an audit log entry recording an action taken on a resource.
 *
 * Lower-level primitive used by {@link logAccess} and {@link logModification}
 * as well as the audit middleware. Always stamps `timestamp` in UTC.
 */
export async function logAction(params: LogActionParams): Promise<AuditLogEntry> {
  const { userId, action, resourceType, resourceId, details, actorIdentity } = params;

  const data: Record<string, unknown> = {
    userId,
    action,
    resourceType,
    resourceId,
    actorIdentity,
    timestamp: new Date(),
  };
  if (details !== undefined) {
    data.details = details;
  }

  const entry = await prisma.auditLog.create({
    // Prisma's generated `details` typing is `InputJsonValue`, which doesn't
    // accept generic `Record<string, unknown>`. Casting here keeps the public
    // API ergonomic while remaining structurally compatible at runtime.
    data: data as Parameters<typeof prisma.auditLog.create>[0]['data'],
  });

  return mapToAuditLogEntry(entry);
}

/**
 * Retrieves audit log entries for a specific user.
 * @deprecated Prefer {@link getAuditLogs} with a `userId` filter.
 */
export async function getLogsByUser(
  userId: string,
  options: QueryOptions = {}
): Promise<AuditLogEntry[]> {
  return getAuditLogs({ userId, ...options });
}

/**
 * Retrieves audit log entries for a specific resource.
 * @deprecated Prefer {@link getAuditLogs} with `resourceType` and `resourceId` filters.
 */
export async function getLogsByResource(
  resourceType: string,
  resourceId: string,
  options: QueryOptions = {}
): Promise<AuditLogEntry[]> {
  return getAuditLogs({ resourceType, resourceId, ...options });
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function buildDateFilter(startDate?: Date, endDate?: Date) {
  const filter: Record<string, Date> = {};
  if (startDate) filter.gte = startDate;
  if (endDate) filter.lte = endDate;
  return filter;
}

function mapToAuditLogEntry(entry: {
  id: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: unknown;
  actorIdentity: string | null;
  timestamp: Date;
}): AuditLogEntry {
  return {
    id: entry.id,
    userId: entry.userId ?? '',
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? '',
    details: (entry.details as Record<string, unknown>) ?? {},
    actorIdentity: entry.actorIdentity ?? 'system',
    timestamp: entry.timestamp,
  };
}
