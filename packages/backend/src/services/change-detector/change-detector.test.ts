/**
 * Unit tests for the Change Detector Service.
 *
 * Validates: Requirements 14.1, 14.2, 14.3, 14.5, 14.6.
 *
 * Covers:
 *   - `detectChanges` records a new SchemeVersion with the correct
 *     previousValues / newValues / changedFields / sourceUrl / versionNumber.
 *   - `detectChanges` returns an empty changedFields list and writes no
 *     row when nothing changed.
 *   - `pruneOldVersions` retains at least the 50 most recent versions and
 *     deletes anything older when the history grows past the limit.
 *   - `pruneOldVersions` is a no-op when fewer than 50 rows exist.
 *   - `notifyAffectedCitizens` dispatches one notification per saved-scheme
 *     subscriber and survives a single failing dispatch without aborting.
 *   - `handleSourceUnavailable` does not modify any persisted data.
 */

import { describe, it, expect } from 'vitest';
import { MIN_VERSION_HISTORY } from '@bharat-benefits/shared';
import type { SchemeObject } from '@bharat-benefits/shared';
import {
  ChangeDetectorService,
  diffSchemeFields,
  toSnapshot,
  type ChangeDetectorPrisma,
  type ChangeNotificationDispatcher,
  type ChangeNotificationPayload,
  type SchemeVersionRow,
} from './change-detector';

// ─── Test fixtures ───────────────────────────────────────────────────────────

const NOW = new Date('2024-06-15T12:00:00Z');

function makeSchemeObject(overrides: Partial<SchemeObject> = {}): SchemeObject {
  return {
    name: 'PM Kisan Samman Nidhi',
    description: 'Direct income support for small and marginal farmers.',
    eligibilityCriteria: [
      {
        field: 'occupation',
        operator: 'eq',
        value: 'Farmer',
        description: 'Must be a farmer',
      },
    ],
    benefits: [
      {
        type: 'monetary',
        amount: 6000,
        description: '₹6,000/year direct benefit',
      },
    ],
    sourceUrl: 'https://pmkisan.gov.in/',
    ministry: 'Ministry of Agriculture & Farmers Welfare',
    applicationProcess: null,
    requiredDocuments: null,
    deadline: null,
    ...overrides,
  };
}

// ─── In-memory fakes ─────────────────────────────────────────────────────────

interface FakeState {
  versions: SchemeVersionRow[];
  saved: Array<{ userId: string; schemeId: string }>;
  nextId: number;
}

function makeFakeState(): FakeState {
  return { versions: [], saved: [], nextId: 1 };
}

function makeFakePrisma(state: FakeState): ChangeDetectorPrisma {
  return {
    schemeVersion: {
      async findFirst({ where, orderBy }) {
        const rows = state.versions
          .filter((v) => v.schemeId === where.schemeId)
          .sort((a, b) =>
            orderBy.versionNumber === 'desc'
              ? b.versionNumber - a.versionNumber
              : a.versionNumber - b.versionNumber,
          );
        return rows[0] ?? null;
      },
      async findMany({ where, orderBy, take, skip }) {
        const rows = state.versions
          .filter((v) => v.schemeId === where.schemeId)
          .sort((a, b) =>
            orderBy.versionNumber === 'desc'
              ? b.versionNumber - a.versionNumber
              : a.versionNumber - b.versionNumber,
          );
        const start = skip ?? 0;
        const end = take === undefined ? rows.length : start + take;
        return rows.slice(start, end);
      },
      async create({ data }) {
        const row: SchemeVersionRow = {
          id: `version-${state.nextId++}`,
          schemeId: data.schemeId,
          previousValues: data.previousValues,
          newValues: data.newValues,
          changedFields: data.changedFields,
          sourceUrl: data.sourceUrl,
          changeDetectedAt: data.changeDetectedAt,
          versionNumber: data.versionNumber,
        };
        state.versions.push(row);
        return row;
      },
      async deleteMany({ where }) {
        const before = state.versions.length;
        state.versions = state.versions.filter(
          (v) =>
            !(
              v.schemeId === where.schemeId &&
              v.versionNumber < where.versionNumber.lt
            ),
        );
        return { count: before - state.versions.length };
      },
    },
    savedScheme: {
      async findMany({ where }) {
        return state.saved
          .filter((s) => s.schemeId === where.schemeId)
          .map((s) => ({ userId: s.userId }));
      },
    },
  };
}

function makeFakeNotificationService(): {
  service: ChangeNotificationDispatcher;
  calls: Array<{ userId: string; payload: ChangeNotificationPayload }>;
} {
  const calls: Array<{ userId: string; payload: ChangeNotificationPayload }> = [];
  const service: ChangeNotificationDispatcher = {
    async sendChangeNotification(userId, payload) {
      calls.push({ userId, payload });
    },
  };
  return { service, calls };
}

// ─── diffSchemeFields ────────────────────────────────────────────────────────

describe('diffSchemeFields', () => {
  it('returns empty list when snapshots are identical', () => {
    const scheme = makeSchemeObject();
    const a = toSnapshot(scheme);
    const b = toSnapshot(scheme);
    expect(diffSchemeFields(a, b)).toEqual([]);
  });

  it('detects a change in benefit amount', () => {
    const a = toSnapshot(makeSchemeObject());
    const b = toSnapshot(
      makeSchemeObject({
        benefits: [{ type: 'monetary', amount: 8000, description: 'updated' }],
      }),
    );
    expect(diffSchemeFields(a, b)).toEqual(['benefits']);
  });

  it('detects multiple changes in a single diff', () => {
    const a = toSnapshot(makeSchemeObject());
    const b = toSnapshot(
      makeSchemeObject({
        name: 'PM Kisan (Revised)',
        deadline: new Date('2025-03-31T00:00:00Z'),
      }),
    );
    expect(diffSchemeFields(a, b).sort()).toEqual(['deadline', 'name']);
  });

  it('treats Date objects equally when their epoch matches', () => {
    const a = toSnapshot(
      makeSchemeObject({ deadline: new Date('2025-01-01T00:00:00Z') }),
    );
    const b = toSnapshot(
      makeSchemeObject({ deadline: new Date('2025-01-01T00:00:00Z') }),
    );
    expect(diffSchemeFields(a, b)).toEqual([]);
  });
});

// ─── detectChanges ───────────────────────────────────────────────────────────

describe('ChangeDetectorService.detectChanges', () => {
  it('records a baseline version when no prior history exists', async () => {
    const state = makeFakeState();
    const service = new ChangeDetectorService({
      prisma: makeFakePrisma(state),
      now: () => NOW,
    });

    const scheme = makeSchemeObject();
    const result = await service.detectChanges(
      'scheme-1',
      scheme,
      'https://pmkisan.gov.in/',
    );

    expect(result.versionId).not.toBeNull();
    expect(result.changedFields.length).toBeGreaterThan(0);
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]).toMatchObject({
      schemeId: 'scheme-1',
      previousValues: null,
      versionNumber: 1,
      sourceUrl: 'https://pmkisan.gov.in/',
      changeDetectedAt: NOW,
    });
    expect(state.versions[0].newValues).toMatchObject({
      name: scheme.name,
      ministry: scheme.ministry,
    });
  });

  it('records a new version with correct previous and new values when fields change', async () => {
    const state = makeFakeState();
    const service = new ChangeDetectorService({
      prisma: makeFakePrisma(state),
      now: () => NOW,
    });

    const original = makeSchemeObject();
    await service.detectChanges('scheme-1', original, 'https://pmkisan.gov.in/');

    const updated = makeSchemeObject({
      benefits: [
        { type: 'monetary', amount: 9000, description: 'Increased benefit' },
      ],
      ministry: 'Ministry of Agriculture',
    });

    const result = await service.detectChanges(
      'scheme-1',
      updated,
      'https://pmkisan.gov.in/2024',
    );

    expect(result.changedFields.sort()).toEqual(['benefits', 'ministry']);
    expect(result.versionId).not.toBeNull();
    expect(state.versions).toHaveLength(2);

    const latest = state.versions[1];
    expect(latest.versionNumber).toBe(2);
    expect(latest.changedFields).toBe('benefits,ministry');
    expect(latest.sourceUrl).toBe('https://pmkisan.gov.in/2024');
    expect(latest.previousValues).toMatchObject({
      benefits: original.benefits,
      ministry: original.ministry,
    });
    expect(latest.newValues).toMatchObject({
      benefits: updated.benefits,
      ministry: updated.ministry,
    });
  });

  it('returns empty changedFields and writes no row when nothing changed', async () => {
    const state = makeFakeState();
    const service = new ChangeDetectorService({
      prisma: makeFakePrisma(state),
      now: () => NOW,
    });

    const scheme = makeSchemeObject();
    await service.detectChanges('scheme-1', scheme, 'https://pmkisan.gov.in/');

    const before = state.versions.length;
    const result = await service.detectChanges(
      'scheme-1',
      scheme,
      'https://pmkisan.gov.in/',
    );

    expect(result.changedFields).toEqual([]);
    expect(result.versionId).toBeNull();
    expect(state.versions.length).toBe(before);
  });
});

// ─── pruneOldVersions ────────────────────────────────────────────────────────

describe('ChangeDetectorService.pruneOldVersions', () => {
  it('does not delete anything when fewer than the minimum history exists', async () => {
    const state = makeFakeState();
    // Seed 30 versions — well below MIN_VERSION_HISTORY (50).
    for (let i = 1; i <= 30; i++) {
      state.versions.push(makeVersionRow('scheme-1', i));
    }

    const service = new ChangeDetectorService({ prisma: makeFakePrisma(state) });
    const deleted = await service.pruneOldVersions('scheme-1');

    expect(deleted).toBe(0);
    expect(state.versions.length).toBe(30);
  });

  it('retains exactly the most recent MIN_VERSION_HISTORY versions when history exceeds the cap', async () => {
    const state = makeFakeState();
    // Seed 75 versions — 25 should be pruned, 50 should remain.
    for (let i = 1; i <= 75; i++) {
      state.versions.push(makeVersionRow('scheme-1', i));
    }

    const service = new ChangeDetectorService({ prisma: makeFakePrisma(state) });
    const deleted = await service.pruneOldVersions('scheme-1');

    expect(deleted).toBe(75 - MIN_VERSION_HISTORY);
    expect(state.versions.length).toBe(MIN_VERSION_HISTORY);

    const remainingNumbers = state.versions
      .map((v) => v.versionNumber)
      .sort((a, b) => a - b);
    expect(remainingNumbers[0]).toBe(75 - MIN_VERSION_HISTORY + 1);
    expect(remainingNumbers[remainingNumbers.length - 1]).toBe(75);
  });

  it('floors keepMin to MIN_VERSION_HISTORY even when a smaller value is requested', async () => {
    const state = makeFakeState();
    for (let i = 1; i <= 60; i++) {
      state.versions.push(makeVersionRow('scheme-1', i));
    }

    const service = new ChangeDetectorService({ prisma: makeFakePrisma(state) });
    const deleted = await service.pruneOldVersions('scheme-1', 10);

    // Even though the caller asked to keep 10, the service must keep at
    // least 50 — only 10 of the 60 should be pruned.
    expect(deleted).toBe(10);
    expect(state.versions.length).toBe(50);
  });

  it('does not affect versions of other schemes', async () => {
    const state = makeFakeState();
    for (let i = 1; i <= 60; i++) {
      state.versions.push(makeVersionRow('scheme-1', i));
    }
    for (let i = 1; i <= 5; i++) {
      state.versions.push(makeVersionRow('scheme-2', i));
    }

    const service = new ChangeDetectorService({ prisma: makeFakePrisma(state) });
    await service.pruneOldVersions('scheme-1');

    const schemeTwoVersions = state.versions.filter(
      (v) => v.schemeId === 'scheme-2',
    );
    expect(schemeTwoVersions.length).toBe(5);
  });
});

// ─── notifyAffectedCitizens ──────────────────────────────────────────────────

describe('ChangeDetectorService.notifyAffectedCitizens', () => {
  it('dispatches a change notification to every saved-scheme user', async () => {
    const state = makeFakeState();
    state.saved.push(
      { userId: 'user-1', schemeId: 'scheme-1' },
      { userId: 'user-2', schemeId: 'scheme-1' },
      { userId: 'user-3', schemeId: 'scheme-1' },
      { userId: 'user-4', schemeId: 'scheme-other' },
    );

    const { service: notifier, calls } = makeFakeNotificationService();
    const service = new ChangeDetectorService({
      prisma: makeFakePrisma(state),
      notificationService: notifier,
      now: () => NOW,
    });

    await service.notifyAffectedCitizens('scheme-1', ['benefits'], {
      versionId: 'version-42',
      sourceUrl: 'https://pmkisan.gov.in/',
    });

    expect(calls.map((c) => c.userId).sort()).toEqual(['user-1', 'user-2', 'user-3']);
    for (const call of calls) {
      expect(call.payload).toMatchObject({
        schemeId: 'scheme-1',
        changedFields: ['benefits'],
        versionId: 'version-42',
        sourceUrl: 'https://pmkisan.gov.in/',
        changeDetectedAt: NOW,
      });
    }
  });

  it('continues notifying remaining users when a single dispatch throws', async () => {
    const state = makeFakeState();
    state.saved.push(
      { userId: 'user-1', schemeId: 'scheme-1' },
      { userId: 'user-2', schemeId: 'scheme-1' },
      { userId: 'user-3', schemeId: 'scheme-1' },
    );

    const calls: string[] = [];
    const flakyNotifier: ChangeNotificationDispatcher = {
      async sendChangeNotification(userId) {
        calls.push(userId);
        if (userId === 'user-2') throw new Error('SES outage');
      },
    };

    const service = new ChangeDetectorService({
      prisma: makeFakePrisma(state),
      notificationService: flakyNotifier,
      now: () => NOW,
    });

    await service.notifyAffectedCitizens('scheme-1', ['deadline']);

    expect(calls).toEqual(['user-1', 'user-2', 'user-3']);
  });

  it('is a no-op when no users have saved the scheme', async () => {
    const state = makeFakeState();
    const { service: notifier, calls } = makeFakeNotificationService();
    const service = new ChangeDetectorService({
      prisma: makeFakePrisma(state),
      notificationService: notifier,
      now: () => NOW,
    });

    await service.notifyAffectedCitizens('scheme-1', ['benefits']);
    expect(calls).toEqual([]);
  });

  it('is a no-op when changedFields is empty', async () => {
    const state = makeFakeState();
    state.saved.push({ userId: 'user-1', schemeId: 'scheme-1' });
    const { service: notifier, calls } = makeFakeNotificationService();
    const service = new ChangeDetectorService({
      prisma: makeFakePrisma(state),
      notificationService: notifier,
    });

    await service.notifyAffectedCitizens('scheme-1', []);
    expect(calls).toEqual([]);
  });
});

// ─── recalculateBenefitValuesForSubscribers ──────────────────────────────────

describe('ChangeDetectorService.recalculateBenefitValuesForSubscribers', () => {
  it('forwards the trigger to the injected recalculator', async () => {
    const state = makeFakeState();
    const recalculated: string[] = [];
    const service = new ChangeDetectorService({
      prisma: makeFakePrisma(state),
      benefitRecalculator: {
        async recalculateForScheme(schemeId) {
          recalculated.push(schemeId);
        },
      },
    });

    await service.recalculateBenefitValuesForSubscribers('scheme-1');
    expect(recalculated).toEqual(['scheme-1']);
  });

  it('is a no-op when no recalculator is configured', async () => {
    const state = makeFakeState();
    const service = new ChangeDetectorService({ prisma: makeFakePrisma(state) });
    await expect(
      service.recalculateBenefitValuesForSubscribers('scheme-1'),
    ).resolves.toBeUndefined();
  });
});

// ─── handleSourceUnavailable ─────────────────────────────────────────────────

describe('ChangeDetectorService.handleSourceUnavailable', () => {
  it('does not modify any persisted version data (Req 14.6)', async () => {
    const state = makeFakeState();
    state.versions.push(makeVersionRow('scheme-1', 1));
    state.versions.push(makeVersionRow('scheme-1', 2));
    const before = JSON.stringify(state.versions);

    const service = new ChangeDetectorService({
      prisma: makeFakePrisma(state),
      now: () => NOW,
    });
    await service.handleSourceUnavailable(
      'scheme-1',
      'https://pmkisan.gov.in/',
      new Error('ETIMEDOUT'),
    );

    const after = JSON.stringify(state.versions);
    expect(after).toBe(before);
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeVersionRow(
  schemeId: string,
  versionNumber: number,
): SchemeVersionRow {
  return {
    id: `version-${schemeId}-${versionNumber}`,
    schemeId,
    previousValues: null,
    newValues: { name: `v${versionNumber}` },
    changedFields: 'name',
    sourceUrl: 'https://example.gov.in/',
    changeDetectedAt: new Date('2024-01-01T00:00:00Z'),
    versionNumber,
  };
}
