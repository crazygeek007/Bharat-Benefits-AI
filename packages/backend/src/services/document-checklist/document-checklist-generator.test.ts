/**
 * Unit tests for DocumentChecklistGenerator.
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.6.
 *
 * Covers:
 *   - getChecklist groups documents into required / optional buckets.
 *   - getChecklist surfaces isEmpty=true when the scheme has no documents.
 *   - findSharedDocuments identifies documents in 2+ schemes.
 *   - findSharedDocuments returns an empty map when each doc appears once.
 *   - Document name matching is case-insensitive and trim-insensitive.
 *   - getSharedDocuments fetches a citizen's saved schemes and aggregates.
 *   - normalizeDocumentName collapses whitespace and casing.
 */

import { describe, it, expect } from 'vitest';
import type { DocumentRequirement } from '@bharat-benefits/shared';
import {
  DocumentChecklistGenerator,
  findSharedDocuments,
  normalizeDocumentName,
  type DocumentChecklistPrisma,
  type SchemeWithDocuments,
} from './document-checklist-generator';

// ─── Test helpers ────────────────────────────────────────────────────────────

interface DocRow {
  documentName: string;
  description: string | null;
  format: string | null;
  required: boolean;
}

function row(
  documentName: string,
  required: boolean,
  description: string | null = `Description of ${documentName}`,
  format: string | null = 'PDF',
): DocRow {
  return { documentName, description, format, required };
}

function fakeDb(opts: {
  documentsBySchemeId?: Record<string, DocRow[]>;
  savedSchemesByUser?: Record<
    string,
    Array<{ id: string; name: string; documents: DocRow[] }>
  >;
}): DocumentChecklistPrisma {
  const docs = opts.documentsBySchemeId ?? {};
  const saved = opts.savedSchemesByUser ?? {};
  return {
    schemeDocument: {
      async findMany({ where }) {
        return docs[where.schemeId] ?? [];
      },
    },
    savedScheme: {
      async findMany({ where }) {
        const schemes = saved[where.userId] ?? [];
        return schemes.map((scheme) => ({ scheme }));
      },
    },
  };
}

// ─── normalizeDocumentName ───────────────────────────────────────────────────

describe('normalizeDocumentName', () => {
  it('lowercases and trims surrounding whitespace', () => {
    expect(normalizeDocumentName('  Aadhaar Card  ')).toBe('aadhaar card');
  });

  it('treats different casings as equivalent', () => {
    expect(normalizeDocumentName('AADHAAR CARD')).toBe(
      normalizeDocumentName('aadhaar card'),
    );
    expect(normalizeDocumentName('Aadhaar Card')).toBe(
      normalizeDocumentName('aadhaar card'),
    );
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeDocumentName('Aadhaar    Card')).toBe('aadhaar card');
    expect(normalizeDocumentName('Aadhaar\tCard')).toBe('aadhaar card');
  });

  it('returns empty string for null / undefined / whitespace-only input', () => {
    expect(normalizeDocumentName(null)).toBe('');
    expect(normalizeDocumentName(undefined)).toBe('');
    expect(normalizeDocumentName('   ')).toBe('');
  });
});

// ─── DocumentChecklistGenerator.getChecklist ─────────────────────────────────

describe('DocumentChecklistGenerator.getChecklist', () => {
  it('groups documents into required and optional buckets (Req 8.1, 8.2)', async () => {
    const db = fakeDb({
      documentsBySchemeId: {
        'scheme-1': [
          row('Aadhaar Card', true),
          row('PAN Card', true),
          row('Caste Certificate', false),
        ],
      },
    });
    const gen = new DocumentChecklistGenerator(db);

    const result = await gen.getChecklist('scheme-1');

    expect(result.isEmpty).toBe(false);
    expect(result.required.map((d) => d.documentName)).toEqual([
      'Aadhaar Card',
      'PAN Card',
    ]);
    expect(result.optional.map((d) => d.documentName)).toEqual([
      'Caste Certificate',
    ]);
    // Description and format are surfaced for each entry (Req 8.3).
    expect(result.required[0]).toMatchObject({
      documentName: 'Aadhaar Card',
      description: 'Description of Aadhaar Card',
      format: 'PDF',
      required: true,
    });
  });

  it('returns isEmpty=true and empty buckets when the scheme has no documents (Req 8.6)', async () => {
    const db = fakeDb({ documentsBySchemeId: { 'scheme-empty': [] } });
    const gen = new DocumentChecklistGenerator(db);

    const result = await gen.getChecklist('scheme-empty');

    expect(result.isEmpty).toBe(true);
    expect(result.required).toEqual([]);
    expect(result.optional).toEqual([]);
  });

  it('substitutes empty strings for nullable description and format columns', async () => {
    const db = fakeDb({
      documentsBySchemeId: {
        'scheme-2': [row('Income Proof', true, null, null)],
      },
    });
    const gen = new DocumentChecklistGenerator(db);

    const result = await gen.getChecklist('scheme-2');

    expect(result.required[0]).toEqual<DocumentRequirement>({
      documentName: 'Income Proof',
      description: '',
      format: '',
      required: true,
    });
  });

  it('handles a scheme with only optional documents', async () => {
    const db = fakeDb({
      documentsBySchemeId: {
        'scheme-opt-only': [row('Recommendation Letter', false)],
      },
    });
    const gen = new DocumentChecklistGenerator(db);

    const result = await gen.getChecklist('scheme-opt-only');

    expect(result.isEmpty).toBe(false);
    expect(result.required).toEqual([]);
    expect(result.optional).toHaveLength(1);
  });

  it('rejects an empty schemeId', async () => {
    const gen = new DocumentChecklistGenerator(fakeDb({}));
    await expect(gen.getChecklist('')).rejects.toThrow(TypeError);
  });
});

// ─── findSharedDocuments (pure helper) ───────────────────────────────────────

describe('findSharedDocuments', () => {
  function doc(
    documentName: string,
    required = true,
  ): DocumentRequirement {
    return {
      documentName,
      description: `Description of ${documentName}`,
      format: 'PDF',
      required,
    };
  }

  it('identifies documents required by 2+ schemes', () => {
    const schemes: SchemeWithDocuments[] = [
      {
        schemeId: 's1',
        schemeName: 'Scheme A',
        documents: [doc('Aadhaar Card'), doc('PAN Card')],
      },
      {
        schemeId: 's2',
        schemeName: 'Scheme B',
        documents: [doc('Aadhaar Card'), doc('Income Certificate')],
      },
      {
        schemeId: 's3',
        schemeName: 'Scheme C',
        documents: [doc('Aadhaar Card'), doc('PAN Card')],
      },
    ];

    const shared = findSharedDocuments(schemes);

    // Aadhaar appears in all 3, PAN in s1+s3, Income only in s2 (not shared).
    expect(shared.size).toBe(2);

    const aadhaar = shared.get('aadhaar card');
    expect(aadhaar).toBeDefined();
    expect(aadhaar!.schemes.map((s) => s.schemeId).sort()).toEqual([
      's1',
      's2',
      's3',
    ]);

    const pan = shared.get('pan card');
    expect(pan).toBeDefined();
    expect(pan!.schemes.map((s) => s.schemeId).sort()).toEqual(['s1', 's3']);

    expect(shared.has('income certificate')).toBe(false);
  });

  it('returns an empty map when each document appears in only one scheme', () => {
    const schemes: SchemeWithDocuments[] = [
      {
        schemeId: 's1',
        schemeName: 'Scheme A',
        documents: [doc('Aadhaar Card'), doc('PAN Card')],
      },
      {
        schemeId: 's2',
        schemeName: 'Scheme B',
        documents: [doc('Voter ID'), doc('Income Certificate')],
      },
    ];

    expect(findSharedDocuments(schemes).size).toBe(0);
  });

  it('returns an empty map when given an empty input list', () => {
    expect(findSharedDocuments([]).size).toBe(0);
  });

  it('returns an empty map when given a single scheme even if it has duplicates', () => {
    const schemes: SchemeWithDocuments[] = [
      {
        schemeId: 's1',
        schemeName: 'Scheme A',
        documents: [doc('Aadhaar Card'), doc('Aadhaar Card')],
      },
    ];

    expect(findSharedDocuments(schemes).size).toBe(0);
  });

  it('matches documents case-insensitively', () => {
    const schemes: SchemeWithDocuments[] = [
      {
        schemeId: 's1',
        schemeName: 'Scheme A',
        documents: [doc('Aadhaar Card')],
      },
      {
        schemeId: 's2',
        schemeName: 'Scheme B',
        documents: [doc('aadhaar card')],
      },
    ];

    const shared = findSharedDocuments(schemes);

    expect(shared.size).toBe(1);
    const entry = shared.get('aadhaar card')!;
    expect(entry.schemes.map((s) => s.schemeId).sort()).toEqual(['s1', 's2']);
    // First-seen casing is preserved on the canonical document.
    expect(entry.document.documentName).toBe('Aadhaar Card');
  });

  it('matches documents trim-insensitively and collapses internal whitespace', () => {
    const schemes: SchemeWithDocuments[] = [
      {
        schemeId: 's1',
        schemeName: 'Scheme A',
        documents: [doc('  Aadhaar Card  ')],
      },
      {
        schemeId: 's2',
        schemeName: 'Scheme B',
        documents: [doc('Aadhaar    Card')],
      },
    ];

    const shared = findSharedDocuments(schemes);

    expect(shared.size).toBe(1);
    expect(shared.get('aadhaar card')!.schemes).toHaveLength(2);
  });

  it('does not double-count a scheme that lists the same document twice', () => {
    const schemes: SchemeWithDocuments[] = [
      {
        schemeId: 's1',
        schemeName: 'Scheme A',
        documents: [doc('Aadhaar Card'), doc('aadhaar card')],
      },
      {
        schemeId: 's2',
        schemeName: 'Scheme B',
        documents: [doc('Aadhaar Card')],
      },
    ];

    const shared = findSharedDocuments(schemes);

    expect(shared.size).toBe(1);
    const entry = shared.get('aadhaar card')!;
    expect(entry.schemes.map((s) => s.schemeId)).toEqual(['s1', 's2']);
  });

  it('skips entries with empty / whitespace-only document names', () => {
    const schemes: SchemeWithDocuments[] = [
      {
        schemeId: 's1',
        schemeName: 'Scheme A',
        documents: [doc('   '), doc('Aadhaar Card')],
      },
      {
        schemeId: 's2',
        schemeName: 'Scheme B',
        documents: [doc(''), doc('Aadhaar Card')],
      },
    ];

    const shared = findSharedDocuments(schemes);

    expect(shared.size).toBe(1);
    expect(shared.has('')).toBe(false);
  });
});

// ─── DocumentChecklistGenerator.getSharedDocuments ───────────────────────────

describe('DocumentChecklistGenerator.getSharedDocuments', () => {
  it("aggregates documents across the citizen's saved schemes (Req 8.4)", async () => {
    const db = fakeDb({
      savedSchemesByUser: {
        'user-1': [
          {
            id: 's1',
            name: 'Scheme A',
            documents: [row('Aadhaar Card', true), row('PAN Card', true)],
          },
          {
            id: 's2',
            name: 'Scheme B',
            documents: [row('Aadhaar Card', true), row('Voter ID', false)],
          },
        ],
      },
    });
    const gen = new DocumentChecklistGenerator(db);

    const shared = await gen.getSharedDocuments('user-1');

    expect(shared.size).toBe(1);
    const aadhaar = shared.get('aadhaar card')!;
    expect(aadhaar.schemes).toEqual([
      { schemeId: 's1', schemeName: 'Scheme A' },
      { schemeId: 's2', schemeName: 'Scheme B' },
    ]);
  });

  it('returns an empty map when no documents are shared across saved schemes', async () => {
    const db = fakeDb({
      savedSchemesByUser: {
        'user-1': [
          { id: 's1', name: 'Scheme A', documents: [row('Aadhaar Card', true)] },
          { id: 's2', name: 'Scheme B', documents: [row('PAN Card', true)] },
        ],
      },
    });
    const gen = new DocumentChecklistGenerator(db);

    const shared = await gen.getSharedDocuments('user-1');

    expect(shared.size).toBe(0);
  });

  it('returns an empty map when the citizen has no saved schemes', async () => {
    const db = fakeDb({ savedSchemesByUser: { 'user-1': [] } });
    const gen = new DocumentChecklistGenerator(db);

    const shared = await gen.getSharedDocuments('user-1');

    expect(shared.size).toBe(0);
  });

  it('matches across saved schemes case-insensitively', async () => {
    const db = fakeDb({
      savedSchemesByUser: {
        'user-1': [
          { id: 's1', name: 'Scheme A', documents: [row('Aadhaar Card', true)] },
          { id: 's2', name: 'Scheme B', documents: [row('aadhaar card', true)] },
        ],
      },
    });
    const gen = new DocumentChecklistGenerator(db);

    const shared = await gen.getSharedDocuments('user-1');

    expect(shared.size).toBe(1);
    expect(shared.get('aadhaar card')!.schemes).toHaveLength(2);
  });

  it('rejects an empty userId', async () => {
    const gen = new DocumentChecklistGenerator(fakeDb({}));
    await expect(gen.getSharedDocuments('')).rejects.toThrow(TypeError);
  });
});
