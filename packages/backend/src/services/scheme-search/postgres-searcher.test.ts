import { describe, expect, it, vi } from 'vitest';
import { createPostgresSearcher } from './postgres-searcher';
import { SEARCH_MAX_PAGE_SIZE } from './scheme-search';

function makePrismaStub(rows: unknown[]) {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue(rows),
  };
}

describe('createPostgresSearcher', () => {
  it('returns ranked hits in score-desc order with positive scores only', async () => {
    const prisma = makePrismaStub([
      { scheme_id: 'a', score: 0.7 },
      { scheme_id: 'b', score: 0.3 },
      { scheme_id: 'c', score: 0 }, // zero-rank rows must be dropped
    ]);
    const searcher = createPostgresSearcher(prisma);

    const hits = await searcher.searchSchemeIndex('pradhan mantri farmer', 25);

    expect(hits).toEqual([
      { schemeId: 'a', score: 0.7 },
      { schemeId: 'b', score: 0.3 },
    ]);
  });

  it('passes the trimmed query, default trust threshold, and clamped limit to Postgres', async () => {
    const prisma = makePrismaStub([]);
    const searcher = createPostgresSearcher(prisma);

    await searcher.searchSchemeIndex('   scholarship   ', 50);

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, query, minTrust, limit] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/websearch_to_tsquery/);
    expect(sql).toMatch(/ts_rank_cd/);
    expect(sql).toMatch(/search_doc/);
    expect(query).toBe('scholarship');
    expect(minTrust).toBe(60);
    expect(limit).toBe(50);
  });

  it('honours a custom minTrustScore for admin-context callers', async () => {
    const prisma = makePrismaStub([]);
    const searcher = createPostgresSearcher(prisma, { minTrustScore: 0 });

    await searcher.searchSchemeIndex('anything', 10);

    const [, , minTrust] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(minTrust).toBe(0);
  });

  it('clamps limit to SEARCH_MAX_PAGE_SIZE when caller asks for more', async () => {
    const prisma = makePrismaStub([]);
    const searcher = createPostgresSearcher(prisma);

    await searcher.searchSchemeIndex('foo', 10_000);

    const [, , , limit] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(limit).toBe(SEARCH_MAX_PAGE_SIZE);
  });

  it('falls back to SEARCH_MAX_PAGE_SIZE when limit is non-finite or below 1', async () => {
    const prisma = makePrismaStub([]);
    const searcher = createPostgresSearcher(prisma);

    await searcher.searchSchemeIndex('foo', Number.NaN);
    await searcher.searchSchemeIndex('foo', 0);
    await searcher.searchSchemeIndex('foo', -5);

    for (const call of prisma.$queryRawUnsafe.mock.calls) {
      expect(call[3]).toBe(SEARCH_MAX_PAGE_SIZE);
    }
  });

  it('returns an empty array immediately for a query with only whitespace', async () => {
    const prisma = makePrismaStub([]);
    const searcher = createPostgresSearcher(prisma);

    const hits = await searcher.searchSchemeIndex('   ', 25);

    expect(hits).toEqual([]);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('coerces stringly-typed numeric scores from the driver', async () => {
    const prisma = makePrismaStub([
      { scheme_id: 'x', score: '0.42' },
      { scheme_id: 'y', score: '0.10' },
    ]);
    const searcher = createPostgresSearcher(prisma);

    const hits = await searcher.searchSchemeIndex('thing', 25);

    expect(hits).toEqual([
      { schemeId: 'x', score: 0.42 },
      { schemeId: 'y', score: 0.1 },
    ]);
  });

  it('skips rows with missing scheme_id rather than emitting empty hits', async () => {
    const prisma = makePrismaStub([
      { scheme_id: '', score: 0.5 },
      { scheme_id: null, score: 0.4 },
      { scheme_id: 'real', score: 0.3 },
    ]);
    const searcher = createPostgresSearcher(prisma);

    const hits = await searcher.searchSchemeIndex('mixed', 25);

    expect(hits).toEqual([{ schemeId: 'real', score: 0.3 }]);
  });
});
