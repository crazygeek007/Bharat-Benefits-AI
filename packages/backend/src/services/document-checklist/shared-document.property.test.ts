/**
 * Property-based tests for shared-document detection.
 *
 * **Property 14: Shared Document Detection**
 * **Validates: Requirements 8.4**
 *
 * Property statement (from design.md):
 * "For any set of saved schemes for a citizen, when two or more schemes
 * require the same document (by document name), the
 * Document_Checklist_Generator SHALL identify that document as shared and
 * list all schemes requiring it."
 *
 * Document name matching is case-insensitive, trim-insensitive, and collapses
 * runs of internal whitespace to a single space (see `normalizeDocumentName`
 * in document-checklist-generator.ts). These tests use fast-check to verify
 * the universal correctness of `findSharedDocuments` across the full input
 * space using a reference predicate that mirrors that matching rule.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { DocumentRequirement } from '@bharat-benefits/shared';
import {
  findSharedDocuments,
  normalizeDocumentName,
  type SchemeWithDocuments,
} from './document-checklist-generator';

// ─── Constants ───────────────────────────────────────────────────────────────

const NUM_RUNS = 200;

/**
 * Realistic pool of Indian welfare scheme document names. A small constant
 * pool intentionally encourages overlap across generated schemes — without
 * collisions the "shared" branch of the function would rarely be exercised.
 */
const DOCUMENT_NAME_POOL = [
  'Aadhaar Card',
  'PAN Card',
  'Voter ID',
  'Income Certificate',
  'Caste Certificate',
  'Bank Passbook',
] as const;

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** A canonical (well-formed) document name from the realistic pool. */
const arbDocumentName = fc.constantFrom(...DOCUMENT_NAME_POOL);

/**
 * A document name that may have its case randomised and surrounding /
 * internal whitespace perturbed. Used to verify the function still groups
 * names that normalise to the same key.
 */
const arbPerturbedDocumentName = fc
  .tuple(
    arbDocumentName,
    // Toggle each character's case independently.
    fc.array(fc.boolean(), { minLength: 0, maxLength: 30 }),
    // Surrounding whitespace prefix / suffix.
    fc.stringMatching(/^[ \t]{0,4}$/),
    fc.stringMatching(/^[ \t]{0,4}$/),
    // Optional extra spaces between words.
    fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 0, maxLength: 5 }),
  )
  .map(([name, caseMask, prefix, suffix, extraSpaces]) => {
    let cased = '';
    for (let i = 0; i < name.length; i++) {
      const ch = name[i];
      const flip = caseMask[i % caseMask.length] ?? false;
      cased += flip ? ch.toUpperCase() : ch.toLowerCase();
    }
    // Inject extra whitespace runs at existing space boundaries.
    const parts = cased.split(' ');
    const rebuilt = parts
      .map((part, idx) => {
        if (idx === parts.length - 1) return part;
        const extra = extraSpaces[idx % Math.max(extraSpaces.length, 1)] ?? 0;
        return part + ' '.repeat(1 + extra);
      })
      .join('');
    return `${prefix}${rebuilt}${suffix}`;
  });

/** A DocumentRequirement built around a realistic (canonical) document name. */
const arbDocRequirement: fc.Arbitrary<DocumentRequirement> = fc.record({
  documentName: arbDocumentName,
  description: fc.string({ maxLength: 50 }),
  format: fc.constantFrom('PDF', 'JPEG', 'PNG', 'Original', ''),
  required: fc.boolean(),
});

/** A DocumentRequirement that may use a perturbed (cased / spaced) name. */
const arbPerturbedDocRequirement: fc.Arbitrary<DocumentRequirement> = fc.record({
  documentName: arbPerturbedDocumentName,
  description: fc.string({ maxLength: 50 }),
  format: fc.constantFrom('PDF', 'JPEG', 'PNG', 'Original', ''),
  required: fc.boolean(),
});

/**
 * A scheme with a unique-ish id (drawn from a wide range), a non-empty name,
 * and an array of 0–6 document requirements.
 */
function makeSchemeArb(
  docArb: fc.Arbitrary<DocumentRequirement>,
): fc.Arbitrary<SchemeWithDocuments> {
  return fc.record({
    schemeId: fc
      .integer({ min: 0, max: 1_000_000 })
      .map((n) => `scheme-${n.toString(36)}`),
    schemeName: fc
      .string({ minLength: 1, maxLength: 24 })
      .map((s) => `Scheme ${s.replace(/\s+/g, ' ').trim() || 'X'}`),
    documents: fc.array(docArb, { minLength: 0, maxLength: 6 }),
  });
}

const arbSchemeWithDocs = makeSchemeArb(arbDocRequirement);
const arbPerturbedSchemeWithDocs = makeSchemeArb(arbPerturbedDocRequirement);

/**
 * A list of schemes where every scheme has a distinct schemeId. The function
 * is documented to operate on a citizen's saved schemes, which by domain
 * invariant are unique — generating duplicates would be outside the
 * contract.
 */
const arbSchemeList = fc.uniqueArray(arbSchemeWithDocs, {
  selector: (s) => s.schemeId,
  minLength: 0,
  maxLength: 8,
});

const arbPerturbedSchemeList = fc.uniqueArray(arbPerturbedSchemeWithDocs, {
  selector: (s) => s.schemeId,
  minLength: 0,
  maxLength: 8,
});

// ─── Reference helpers ───────────────────────────────────────────────────────

/**
 * Reference implementation of "schemes that require document with normalised
 * name k". Used to cross-check `findSharedDocuments` without re-using its
 * implementation logic.
 */
function expectedSchemesByKey(
  schemes: ReadonlyArray<SchemeWithDocuments>,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const s of schemes) {
    const seenInThisScheme = new Set<string>();
    for (const d of s.documents) {
      const key = normalizeDocumentName(d.documentName);
      if (!key) continue;
      if (seenInThisScheme.has(key)) continue;
      seenInThisScheme.add(key);
      let bucket = map.get(key);
      if (!bucket) {
        bucket = new Set<string>();
        map.set(key, bucket);
      }
      bucket.add(s.schemeId);
    }
  }
  return map;
}

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 14: Shared Document Detection', () => {
  // ── 1. Bidirectional property ──────────────────────────────────────────────
  describe('bidirectional: map keys correspond exactly to documents shared by 2+ schemes', () => {
    it('every key in the result has at least 2 distinct schemes', () => {
      fc.assert(
        fc.property(arbPerturbedSchemeList, (schemes) => {
          const shared = findSharedDocuments(schemes);
          for (const [, entry] of shared) {
            expect(entry.schemes.length).toBeGreaterThanOrEqual(2);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('for any pair of distinct schemes sharing a doc by normalised name, the result covers both', () => {
      fc.assert(
        fc.property(arbPerturbedSchemeList, (schemes) => {
          const expected = expectedSchemesByKey(schemes);
          const shared = findSharedDocuments(schemes);

          // Every (key) where 2+ distinct schemes require it MUST appear in
          // the shared map and contain those scheme ids.
          for (const [key, schemeIds] of expected) {
            if (schemeIds.size < 2) continue;
            const entry = shared.get(key);
            expect(entry, `expected shared map to include key "${key}"`).toBeDefined();
            const actualIds = new Set(entry!.schemes.map((s) => s.schemeId));
            for (const id of schemeIds) {
              expect(actualIds.has(id)).toBe(true);
            }
            expect(actualIds.size).toBe(schemeIds.size);
          }

          // Conversely, every key in the result MUST correspond to a
          // normalised document required by 2+ distinct schemes.
          for (const [key, entry] of shared) {
            const expectedIds = expected.get(key);
            expect(expectedIds, `unexpected key "${key}" in shared map`).toBeDefined();
            expect(expectedIds!.size).toBeGreaterThanOrEqual(2);
            const actualIds = new Set(entry.schemes.map((s) => s.schemeId));
            expect(actualIds).toEqual(expectedIds);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ── 2. Single-scheme exclusion ─────────────────────────────────────────────
  describe('single-scheme exclusion: a document required by only one scheme is not in the result', () => {
    it('keys whose reference scheme set has size 1 are absent from the map', () => {
      fc.assert(
        fc.property(arbPerturbedSchemeList, (schemes) => {
          const expected = expectedSchemesByKey(schemes);
          const shared = findSharedDocuments(schemes);
          for (const [key, schemeIds] of expected) {
            if (schemeIds.size === 1) {
              expect(shared.has(key)).toBe(false);
            }
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('a single scheme listing many distinct documents yields an empty map', () => {
      fc.assert(
        fc.property(arbSchemeWithDocs, (scheme) => {
          const shared = findSharedDocuments([scheme]);
          expect(shared.size).toBe(0);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ── 3. Case-insensitive matching ───────────────────────────────────────────
  describe('case-insensitive matching: differently-cased copies of the same name share a key', () => {
    it('two schemes with the same name in different casings are grouped', () => {
      const arbCasedPair = arbDocumentName.chain((name) =>
        fc.tuple(
          fc.constant(name),
          fc.array(fc.boolean(), { minLength: name.length, maxLength: name.length }),
        ),
      );
      fc.assert(
        fc.property(arbCasedPair, ([name, caseMask]) => {
          const cased = name
            .split('')
            .map((ch, i) => (caseMask[i] ? ch.toUpperCase() : ch.toLowerCase()))
            .join('');

          const docA: DocumentRequirement = {
            documentName: name,
            description: '',
            format: '',
            required: true,
          };
          const docB: DocumentRequirement = {
            documentName: cased,
            description: '',
            format: '',
            required: true,
          };
          const schemes: SchemeWithDocuments[] = [
            { schemeId: 's1', schemeName: 'A', documents: [docA] },
            { schemeId: 's2', schemeName: 'B', documents: [docB] },
          ];

          const shared = findSharedDocuments(schemes);
          expect(shared.size).toBe(1);
          const expectedKey = normalizeDocumentName(name);
          expect(shared.has(expectedKey)).toBe(true);
          expect(shared.get(expectedKey)!.schemes).toHaveLength(2);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ── 4. Whitespace-insensitive matching ─────────────────────────────────────
  describe('whitespace-insensitive matching: surrounding/internal whitespace does not split keys', () => {
    it('schemes whose names differ only in whitespace are grouped', () => {
      const arbWhitespacedPair = arbDocumentName.chain((name) =>
        fc.tuple(
          fc.constant(name),
          fc.stringMatching(/^[ \t]{0,4}$/),
          fc.stringMatching(/^[ \t]{0,4}$/),
          fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 5 }),
        ),
      );
      fc.assert(
        fc.property(
          arbWhitespacedPair,
          ([name, prefix, suffix, extraSpaces]) => {
            const parts = name.split(' ');
            const spaced = parts
              .map((part, idx) => {
                if (idx === parts.length - 1) return part;
                const extra = extraSpaces[idx % extraSpaces.length] ?? 1;
                return part + ' '.repeat(extra);
              })
              .join('');
            const perturbed = `${prefix}${spaced}${suffix}`;

            const schemes: SchemeWithDocuments[] = [
              {
                schemeId: 's1',
                schemeName: 'A',
                documents: [
                  { documentName: name, description: '', format: '', required: true },
                ],
              },
              {
                schemeId: 's2',
                schemeName: 'B',
                documents: [
                  {
                    documentName: perturbed,
                    description: '',
                    format: '',
                    required: true,
                  },
                ],
              },
            ];

            const shared = findSharedDocuments(schemes);
            expect(shared.size).toBe(1);
            const expectedKey = normalizeDocumentName(name);
            expect(shared.has(expectedKey)).toBe(true);
            expect(shared.get(expectedKey)!.schemes).toHaveLength(2);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ── 5. Within-scheme dedup ─────────────────────────────────────────────────
  describe('within-scheme dedup: a scheme listing the same document twice is not double-counted', () => {
    it('duplicating a document inside one scheme does not promote it to "shared"', () => {
      fc.assert(
        fc.property(
          arbDocumentName,
          fc.integer({ min: 2, max: 6 }),
          (name, copies) => {
            const docs: DocumentRequirement[] = Array.from({ length: copies }, () => ({
              documentName: name,
              description: '',
              format: '',
              required: true,
            }));
            const schemes: SchemeWithDocuments[] = [
              { schemeId: 's1', schemeName: 'A', documents: docs },
            ];
            // With only one scheme, the document — duplicated or not —
            // cannot be shared.
            expect(findSharedDocuments(schemes).size).toBe(0);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('a scheme listing a document many times still counts as one scheme in the shared entry', () => {
      fc.assert(
        fc.property(
          arbDocumentName,
          fc.integer({ min: 2, max: 6 }),
          (name, copies) => {
            const docsA: DocumentRequirement[] = Array.from({ length: copies }, () => ({
              documentName: name,
              description: '',
              format: '',
              required: true,
            }));
            const schemes: SchemeWithDocuments[] = [
              { schemeId: 's1', schemeName: 'A', documents: docsA },
              {
                schemeId: 's2',
                schemeName: 'B',
                documents: [
                  { documentName: name, description: '', format: '', required: true },
                ],
              },
            ];
            const shared = findSharedDocuments(schemes);
            const entry = shared.get(normalizeDocumentName(name))!;
            expect(entry).toBeDefined();
            // s1 contributed `copies` duplicates but should appear only once.
            expect(entry.schemes).toHaveLength(2);
            expect(entry.schemes.filter((s) => s.schemeId === 's1')).toHaveLength(1);
            expect(entry.schemes.filter((s) => s.schemeId === 's2')).toHaveLength(1);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ── 6. Each scheme appears at most once per document ───────────────────────
  describe('uniqueness: each entry lists each schemeId at most once', () => {
    it('every entry in the result has unique schemeIds in its schemes list', () => {
      fc.assert(
        fc.property(arbPerturbedSchemeList, (schemes) => {
          const shared = findSharedDocuments(schemes);
          for (const [, entry] of shared) {
            const ids = entry.schemes.map((s) => s.schemeId);
            const unique = new Set(ids);
            expect(unique.size).toBe(ids.length);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
