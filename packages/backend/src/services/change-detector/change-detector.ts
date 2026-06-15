/**
 * Change Detector Service — tracks scheme version history, notifies
 * affected citizens, and triggers downstream recalculations when scheme
 * benefit amounts change.
 *
 * Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 8.5
 *
 * Responsibilities:
 *   - Diff a newly-fetched scheme payload against the most-recent stored
 *     version and persist a `SchemeVersion` row capturing previousValues,
 *     newValues, changedFields, sourceUrl, and changeDetectedAt.
 *   - Maintain at least the {@link MIN_VERSION_HISTORY} (= 50) most recent
 *     versions per scheme via {@link ChangeDetectorService.pruneOldVersions}.
 *   - Notify affected citizens within 60 minutes of a detected change
 *     (Req 14.3) by enumerating SavedSchemes and dispatching to the
 *     injected NotificationService.
 *   - Trigger benefit-value recalculation within 30 seconds when a scheme's
 *     benefit amount changes (Req 14.5).
 *   - On source unavailability, retain the last known version unchanged and
 *     log the failure for retry on the next crawl cycle (Req 14.6).
 *
 * Why DI / structural typing for Prisma: matches the convention used by
 * `BenefitsDashboardService` so unit tests can supply an in-memory fake
 * without binding to the generated Prisma client. Notification and
 * recalculation services are both optional so this service can be safely
 * constructed during ingestion-only flows.
 */

import { MIN_VERSION_HISTORY } from '@bharat-benefits/shared';
import type {
  ApplicationStep,
  Benefit,
  DocumentRequirement,
  EligibilityCriterion,
  SchemeChange,
  SchemeObject,
} from '@bharat-benefits/shared';

// ─── Diffable scheme fields ──────────────────────────────────────────────────

/**
 * Fields compared between two scheme snapshots. The list mirrors the set
 * called out in Req 14.1 / 14.2: name, description, eligibilityCriteria,
 * benefits, deadline, applicationProcess, requiredDocuments, ministry.
 *
 * Exported so property tests can iterate over the canonical field list.
 */
export const DIFFABLE_SCHEME_FIELDS = [
  'name',
  'description',
  'eligibilityCriteria',
  'benefits',
  'deadline',
  'applicationProcess',
  'requiredDocuments',
  'ministry',
] as const;

export type DiffableSchemeField = (typeof DIFFABLE_SCHEME_FIELDS)[number];

/**
 * Snapshot of the scheme fields that participate in change detection.
 * Both sides of the comparison are normalised to this shape so the diff
 * is independent of how the values were originally loaded (DB row vs.
 * freshly-parsed `SchemeObject`).
 */
export interface SchemeSnapshot {
  name: string;
  description: string;
  eligibilityCriteria: EligibilityCriterion[];
  benefits: Benefit[];
  deadline: Date | null;
  applicationProcess: ApplicationStep[] | null;
  requiredDocuments: DocumentRequirement[] | null;
  ministry: string;
}

/**
 * Pure helper: returns the names of fields that differ between `prev`
 * and `next`. Comparison is deep and order-sensitive for arrays
 * (matches how the upstream parsers emit them — preserving order is the
 * correct semantics for criteria, benefits, application steps, etc.).
 *
 * Exported for property test 14.2 (Property 26: Version History
 * Completeness) so the universal "every changed field is captured"
 * invariant can be exercised in isolation.
 */
export function diffSchemeFields(
  prev: SchemeSnapshot,
  next: SchemeSnapshot,
): DiffableSchemeField[] {
  const changed: DiffableSchemeField[] = [];
  for (const field of DIFFABLE_SCHEME_FIELDS) {
    if (!isEqual(prev[field], next[field])) {
      changed.push(field);
    }
  }
  return changed;
}

/**
 * Deep equality with Date support. Plain JSON-compatible structures plus
 * Date instances are the only shapes that flow through scheme fields, so
 * a dedicated helper avoids pulling in lodash for one call site.
 */
function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date) || !(b instanceof Date)) return false;
    return a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (
        !isEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

// ─── Prisma surface ──────────────────────────────────────────────────────────

/**
 * Persisted SchemeVersion row shape, structurally typed so tests can use
 * an in-memory fake. Mirrors the `SchemeVersion` model in
 * `prisma/schema.prisma`.
 */
export interface SchemeVersionRow {
  id: string;
  schemeId: string;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  /** Comma-separated list of changed field names (DB stores this as a string). */
  changedFields: string;
  sourceUrl: string | null;
  changeDetectedAt: Date;
  versionNumber: number;
}

export interface ChangeDetectorPrisma {
  schemeVersion: {
    findFirst(args: {
      where: { schemeId: string };
      orderBy: { versionNumber: 'desc' };
    }): Promise<SchemeVersionRow | null>;

    findMany(args: {
      where: { schemeId: string };
      orderBy: { versionNumber: 'desc' };
      take?: number;
      skip?: number;
    }): Promise<SchemeVersionRow[]>;

    create(args: {
      data: {
        schemeId: string;
        previousValues: Record<string, unknown> | null;
        newValues: Record<string, unknown>;
        changedFields: string;
        sourceUrl: string;
        changeDetectedAt: Date;
        versionNumber: number;
      };
    }): Promise<SchemeVersionRow>;

    deleteMany(args: {
      where: { schemeId: string; versionNumber: { lt: number } };
    }): Promise<{ count: number }>;
  };
  savedScheme: {
    findMany(args: {
      where: { schemeId: string };
      select?: { userId: true };
    }): Promise<Array<{ userId: string }>>;
  };
}

// ─── Notification + recalculation contracts ──────────────────────────────────

/**
 * Minimal notification surface consumed by the change detector. The full
 * `NotificationService` exposes more, but the change detector only
 * dispatches change notifications — keeping the contract narrow makes
 * the test fakes trivial.
 */
export interface ChangeNotificationDispatcher {
  sendChangeNotification(
    userId: string,
    change: ChangeNotificationPayload,
  ): Promise<void>;
}

export interface ChangeNotificationPayload {
  schemeId: string;
  changedFields: string[];
  changeDetectedAt: Date;
  versionId: string;
  sourceUrl: string;
}

/**
 * Recalculator hook — invoked when a benefit-bearing field changes so the
 * Benefits Dashboard's Estimated Total Benefit Value (Req 14.5) is
 * refreshed within 30s. Production wiring points this at the
 * BenefitsDashboardService; tests inject a spy.
 */
export interface BenefitRecalculator {
  recalculateForScheme(schemeId: string): Promise<void>;
}

// ─── Logger ──────────────────────────────────────────────────────────────────

export interface ChangeDetectorLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: ChangeDetectorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Service ─────────────────────────────────────────────────────────────────

export interface ChangeDetectorServiceDeps {
  prisma: ChangeDetectorPrisma;
  notificationService?: ChangeNotificationDispatcher;
  benefitRecalculator?: BenefitRecalculator;
  logger?: ChangeDetectorLogger;
  /** Override for the wall clock — primarily for deterministic tests. */
  now?: () => Date;
}

export interface DetectChangesResult {
  /** Names of fields that changed between previous and new scheme data. */
  changedFields: string[];
  /** ID of the newly-recorded SchemeVersion row, or null if nothing changed. */
  versionId: string | null;
}

export class ChangeDetectorService {
  private readonly prisma: ChangeDetectorPrisma;
  private readonly notificationService: ChangeNotificationDispatcher | null;
  private readonly benefitRecalculator: BenefitRecalculator | null;
  private readonly logger: ChangeDetectorLogger;
  private readonly now: () => Date;

  constructor(deps: ChangeDetectorServiceDeps) {
    this.prisma = deps.prisma;
    this.notificationService = deps.notificationService ?? null;
    this.benefitRecalculator = deps.benefitRecalculator ?? null;
    this.logger = deps.logger ?? noopLogger;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Compare a freshly-fetched `SchemeObject` against the most recent
   * stored version and persist a new `SchemeVersion` row when any of the
   * diffable fields differs. Returns the changed field names and the new
   * version ID. When the scheme is unchanged, returns an empty list and
   * a null version ID — no row is written.
   *
   * The first call for a given scheme (no prior versions) records a
   * baseline `SchemeVersion` with `previousValues = null` and
   * `versionNumber = 1` so future comparisons have an anchor.
   */
  async detectChanges(
    schemeId: string,
    newScheme: SchemeObject,
    sourceUrl: string,
  ): Promise<DetectChangesResult> {
    if (!schemeId) throw new TypeError('schemeId is required');
    if (!newScheme) throw new TypeError('newScheme is required');
    if (!sourceUrl) throw new TypeError('sourceUrl is required');

    const newSnapshot = toSnapshot(newScheme);
    const previous = await this.prisma.schemeVersion.findFirst({
      where: { schemeId },
      orderBy: { versionNumber: 'desc' },
    });

    if (!previous) {
      // First-ever ingestion: seed a baseline version so subsequent
      // diffs have something to compare against. All diffable fields
      // count as "changed" because they had no prior value.
      const created = await this.prisma.schemeVersion.create({
        data: {
          schemeId,
          previousValues: null,
          newValues: snapshotToJson(newSnapshot),
          changedFields: DIFFABLE_SCHEME_FIELDS.join(','),
          sourceUrl,
          changeDetectedAt: this.now(),
          versionNumber: 1,
        },
      });
      return {
        changedFields: [...DIFFABLE_SCHEME_FIELDS],
        versionId: created.id,
      };
    }

    const previousSnapshot = jsonToSnapshot(previous.newValues);
    const changed = diffSchemeFields(previousSnapshot, newSnapshot);
    if (changed.length === 0) {
      return { changedFields: [], versionId: null };
    }

    const created = await this.prisma.schemeVersion.create({
      data: {
        schemeId,
        previousValues: snapshotToJson(previousSnapshot),
        newValues: snapshotToJson(newSnapshot),
        changedFields: changed.join(','),
        sourceUrl,
        changeDetectedAt: this.now(),
        versionNumber: previous.versionNumber + 1,
      },
    });

    return { changedFields: [...changed], versionId: created.id };
  }

  /**
   * Deletes versions older than the most recent `keepMin` for `schemeId`.
   * Always retains at least {@link MIN_VERSION_HISTORY} (= 50) versions
   * per scheme (Req 14.1) — `keepMin` may be increased above the
   * minimum but never decreased below it.
   *
   * Returns the number of rows deleted (0 when there are fewer than
   * `keepMin` rows total).
   */
  async pruneOldVersions(
    schemeId: string,
    keepMin: number = MIN_VERSION_HISTORY,
  ): Promise<number> {
    if (!schemeId) throw new TypeError('schemeId is required');
    const effectiveKeep = Math.max(keepMin, MIN_VERSION_HISTORY);

    // Look up the version-number boundary: anything strictly less than
    // the smallest of the most recent `effectiveKeep` versions can be
    // safely deleted. Querying the boundary with `take + skip` instead
    // of loading all rows keeps memory bounded for schemes with deep
    // history.
    const boundary = await this.prisma.schemeVersion.findMany({
      where: { schemeId },
      orderBy: { versionNumber: 'desc' },
      take: 1,
      skip: effectiveKeep - 1,
    });

    if (boundary.length === 0) {
      // Fewer than `effectiveKeep` versions exist — nothing to prune.
      return 0;
    }

    const minVersionToKeep = boundary[0].versionNumber;
    const deleted = await this.prisma.schemeVersion.deleteMany({
      where: { schemeId, versionNumber: { lt: minVersionToKeep } },
    });
    return deleted.count;
  }

  /**
   * Returns the version history for `schemeId` ordered from most recent
   * to oldest. `limit` defaults to {@link MIN_VERSION_HISTORY} so the UI
   * timeline (Req 14.4 — paginated at 20 per page in the frontend) can
   * always display the retained range.
   */
  async getVersionHistory(
    schemeId: string,
    limit: number = MIN_VERSION_HISTORY,
  ): Promise<SchemeChange[]> {
    if (!schemeId) throw new TypeError('schemeId is required');
    const rows = await this.prisma.schemeVersion.findMany({
      where: { schemeId },
      orderBy: { versionNumber: 'desc' },
      take: Math.max(1, limit),
    });
    return rows.map(rowToSchemeChange);
  }

  /**
   * Notifies every citizen who has saved `schemeId` that one or more
   * fields have changed. Best-effort: a failing dispatch for one user
   * does not abort the loop — the failure is logged so the operator
   * can investigate without losing notifications for the remaining
   * affected citizens.
   *
   * The 60-minute SLO (Req 14.3) is satisfied by callers invoking this
   * promptly after a successful `detectChanges` call.
   */
  async notifyAffectedCitizens(
    schemeId: string,
    changedFields: string[],
    options: {
      versionId?: string;
      sourceUrl?: string;
      changeDetectedAt?: Date;
    } = {},
  ): Promise<void> {
    if (!schemeId) throw new TypeError('schemeId is required');
    if (changedFields.length === 0) return;
    if (!this.notificationService) {
      this.logger.warn(
        'notifyAffectedCitizens called but no notification service is configured',
        { schemeId, changedFields },
      );
      return;
    }

    const saved = await this.prisma.savedScheme.findMany({
      where: { schemeId },
      select: { userId: true },
    });
    if (saved.length === 0) return;

    const payload: ChangeNotificationPayload = {
      schemeId,
      changedFields: [...changedFields],
      changeDetectedAt: options.changeDetectedAt ?? this.now(),
      versionId: options.versionId ?? '',
      sourceUrl: options.sourceUrl ?? '',
    };

    // Dedupe userIds — savedScheme rows are unique per (user, scheme)
    // but defensive dedupe is cheap and protects against mis-shaped fakes.
    const seen = new Set<string>();
    for (const row of saved) {
      if (seen.has(row.userId)) continue;
      seen.add(row.userId);
      try {
        await this.notificationService.sendChangeNotification(row.userId, payload);
      } catch (err) {
        this.logger.error('Failed to dispatch change notification', {
          userId: row.userId,
          schemeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Triggers benefit-value recalculation for all citizens subscribed
   * (i.e. who have saved) `schemeId`. Used when a scheme's benefit
   * amount changes (Req 14.5). The recalculator is responsible for
   * staying inside the 30-second SLO; this service only forwards the
   * trigger.
   */
  async recalculateBenefitValuesForSubscribers(schemeId: string): Promise<void> {
    if (!schemeId) throw new TypeError('schemeId is required');
    if (!this.benefitRecalculator) {
      this.logger.warn(
        'recalculateBenefitValuesForSubscribers called but no recalculator is configured',
        { schemeId },
      );
      return;
    }
    try {
      await this.benefitRecalculator.recalculateForScheme(schemeId);
    } catch (err) {
      this.logger.error('Benefit recalculator threw', {
        schemeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Records that the source for `schemeId` was unreachable. The change
   * detector's contract (Req 14.6) is to retain the last known version
   * unchanged and let the next crawl cycle retry — so this method is
   * intentionally side-effect-free with respect to scheme data. It only
   * logs the failure for operator visibility.
   */
  async handleSourceUnavailable(
    schemeId: string,
    sourceUrl: string,
    error: Error,
  ): Promise<void> {
    if (!schemeId) throw new TypeError('schemeId is required');
    this.logger.warn('Source unavailable; retaining last known version', {
      schemeId,
      sourceUrl,
      error: error.message,
      timestamp: this.now().toISOString(),
    });
  }
}

// ─── Snapshot helpers ────────────────────────────────────────────────────────

/**
 * Project a `SchemeObject` down to the fields tracked by change detection.
 * Required-but-empty optional fields are normalised to `null` so the
 * diff is consistent regardless of upstream representation.
 */
export function toSnapshot(scheme: SchemeObject): SchemeSnapshot {
  return {
    name: scheme.name,
    description: scheme.description,
    eligibilityCriteria: scheme.eligibilityCriteria,
    benefits: scheme.benefits,
    deadline: scheme.deadline ?? null,
    applicationProcess: scheme.applicationProcess ?? null,
    requiredDocuments: scheme.requiredDocuments ?? null,
    ministry: scheme.ministry,
  };
}

/**
 * Serialise a snapshot to a JSON-safe object for storage. Dates are
 * converted to ISO strings — Prisma's JsonB column accepts only
 * JSON-native types — and parsed back via {@link jsonToSnapshot} when
 * comparing future versions.
 */
function snapshotToJson(snapshot: SchemeSnapshot): Record<string, unknown> {
  return {
    name: snapshot.name,
    description: snapshot.description,
    eligibilityCriteria: snapshot.eligibilityCriteria,
    benefits: snapshot.benefits,
    deadline: snapshot.deadline ? snapshot.deadline.toISOString() : null,
    applicationProcess: snapshot.applicationProcess,
    requiredDocuments: snapshot.requiredDocuments,
    ministry: snapshot.ministry,
  };
}

function jsonToSnapshot(json: Record<string, unknown> | null): SchemeSnapshot {
  const safe = json ?? {};
  const deadlineRaw = safe['deadline'];
  let deadline: Date | null = null;
  if (typeof deadlineRaw === 'string') {
    const parsed = new Date(deadlineRaw);
    deadline = Number.isNaN(parsed.getTime()) ? null : parsed;
  } else if (deadlineRaw instanceof Date) {
    deadline = deadlineRaw;
  }
  return {
    name: (safe['name'] as string) ?? '',
    description: (safe['description'] as string) ?? '',
    eligibilityCriteria:
      (safe['eligibilityCriteria'] as EligibilityCriterion[]) ?? [],
    benefits: (safe['benefits'] as Benefit[]) ?? [],
    deadline,
    applicationProcess:
      (safe['applicationProcess'] as ApplicationStep[] | null) ?? null,
    requiredDocuments:
      (safe['requiredDocuments'] as DocumentRequirement[] | null) ?? null,
    ministry: (safe['ministry'] as string) ?? '',
  };
}

function rowToSchemeChange(row: SchemeVersionRow): SchemeChange {
  return {
    id: row.id,
    schemeId: row.schemeId,
    previousValues: (row.previousValues ?? {}) as Record<string, unknown>,
    newValues: (row.newValues ?? {}) as Record<string, unknown>,
    changedFields: row.changedFields
      ? row.changedFields.split(',').filter((f) => f.length > 0)
      : [],
    sourceUrl: row.sourceUrl ?? '',
    changeDetectedAt: row.changeDetectedAt,
    versionNumber: row.versionNumber,
  };
}
