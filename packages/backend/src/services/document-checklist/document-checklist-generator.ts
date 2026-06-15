/**
 * Document Checklist Generator — produces the per-scheme document checklist
 * shown on a scheme's application details page and detects which documents are
 * shared across a citizen's saved schemes.
 *
 * Responsibilities:
 *   - Group a scheme's required documents into Required vs Optional buckets
 *     and surface name / description / format for each (Req 8.1, 8.2, 8.3).
 *   - Signal when a scheme has no document requirements so the UI can render
 *     the "no documents specified, see official source" message (Req 8.6).
 *   - Detect documents that appear across two or more of a citizen's saved
 *     schemes so the UI can show a shared-document indicator listing all
 *     other schemes that require that document (Req 8.4).
 *
 * Document name matching is case-insensitive and trim-insensitive — official
 * scheme sources frequently differ in casing and surrounding whitespace
 * ("Aadhaar Card" vs "aadhaar card") and citizens should still recognise
 * those as the same physical document. The first-seen presentation form is
 * preserved when surfacing the merged document so the UI keeps human-readable
 * casing.
 *
 * The pure helper `findSharedDocuments` is exported for use by the
 * Property 14 property-based test (task 11.2) so it can exercise the matching
 * logic without standing up a Prisma client.
 */

import type { DocumentRequirement } from '@bharat-benefits/shared';
import prisma from '../../lib/prisma';

// ─── Public types ────────────────────────────────────────────────────────────

/** A scheme reference shown in the shared-document indicator (Req 8.4). */
export interface SchemeReference {
  schemeId: string;
  schemeName: string;
}

/** Bundle of a scheme and the documents it requires, used for shared detection. */
export interface SchemeWithDocuments {
  schemeId: string;
  schemeName: string;
  documents: DocumentRequirement[];
}

/**
 * Result of the per-scheme checklist (Req 8.1, 8.2, 8.6).
 *
 * `isEmpty` is `true` only when the scheme has zero document requirements in
 * the official source — empty arrays alone don't carry that semantic so
 * downstream consumers must use this flag to drive the "no documents
 * specified" message.
 */
export interface ChecklistResult {
  required: DocumentRequirement[];
  optional: DocumentRequirement[];
  isEmpty: boolean;
}

/** Entry in the shared-document map produced by `findSharedDocuments`. */
export interface SharedDocumentEntry {
  document: DocumentRequirement;
  schemes: SchemeReference[];
}

/**
 * Map keyed by the *normalised* document name (case-insensitive, trimmed).
 * Values list the canonical document plus every saved scheme that requires
 * it, but only for documents that appear in two or more schemes.
 */
export type SharedDocumentMap = Map<string, SharedDocumentEntry>;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Normalises a document name for cross-scheme matching. Schemes published by
 * different ministries vary in casing and whitespace ("Aadhaar Card",
 * "aadhaar card", " Aadhaar  Card ") — we treat all of these as the same
 * document.
 *
 * Returns an empty string for missing / whitespace-only names; callers MUST
 * skip empty keys rather than attempt to match them.
 */
export function normalizeDocumentName(name: string | null | undefined): string {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Pure helper that finds documents shared across two or more schemes.
 *
 * Inputs are independent of the database — each entry carries a scheme ref
 * and the documents it requires. The result is a `SharedDocumentMap` keyed by
 * the normalised document name; only documents appearing in 2+ schemes are
 * included (Req 8.4).
 *
 * For the canonical `document` we keep the first-seen requirement so the UI
 * surfaces the original casing and description. Each scheme is recorded at
 * most once per document even if a scheme erroneously lists the same document
 * twice — duplicates within one scheme don't prove sharing.
 */
export function findSharedDocuments(
  schemes: ReadonlyArray<SchemeWithDocuments>,
): SharedDocumentMap {
  // First pass: bucket documents by normalised name, dedupe by scheme.
  interface Bucket {
    document: DocumentRequirement;
    schemes: SchemeReference[];
    schemeIds: Set<string>;
  }
  const buckets = new Map<string, Bucket>();

  for (const entry of schemes) {
    if (!entry || !Array.isArray(entry.documents)) continue;
    for (const doc of entry.documents) {
      if (!doc) continue;
      const key = normalizeDocumentName(doc.documentName);
      if (!key) continue;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          document: doc,
          schemes: [],
          schemeIds: new Set<string>(),
        };
        buckets.set(key, bucket);
      }
      if (!bucket.schemeIds.has(entry.schemeId)) {
        bucket.schemeIds.add(entry.schemeId);
        bucket.schemes.push({
          schemeId: entry.schemeId,
          schemeName: entry.schemeName,
        });
      }
    }
  }

  // Second pass: keep only documents that appear in two or more schemes.
  const shared: SharedDocumentMap = new Map();
  for (const [key, bucket] of buckets) {
    if (bucket.schemes.length >= 2) {
      shared.set(key, {
        document: bucket.document,
        schemes: bucket.schemes,
      });
    }
  }
  return shared;
}

// ─── Prisma surface ──────────────────────────────────────────────────────────

/**
 * Minimal Prisma surface this generator needs. Declared locally so unit tests
 * can supply an in-memory fake without depending on the generated Prisma
 * types or running a database.
 */
export interface DocumentChecklistPrisma {
  schemeDocument: {
    findMany(args: {
      where: { schemeId: string };
    }): Promise<
      Array<{
        documentName: string;
        description: string | null;
        format: string | null;
        required: boolean;
      }>
    >;
  };
  savedScheme: {
    findMany(args: {
      where: { userId: string };
      include: {
        scheme: {
          include: { documents: true };
        };
      };
    }): Promise<
      Array<{
        scheme: {
          id: string;
          name: string;
          documents: Array<{
            documentName: string;
            description: string | null;
            format: string | null;
            required: boolean;
          }>;
        };
      }>
    >;
  };
}

// ─── Database row → DocumentRequirement ──────────────────────────────────────

/**
 * Maps a SchemeDocument row to the public `DocumentRequirement` type. The DB
 * stores `description` and `format` as nullable strings, but the citizen-
 * facing type guarantees both fields are present — we substitute empty
 * strings so the UI can render predictably (Req 8.3).
 */
function rowToDocumentRequirement(row: {
  documentName: string;
  description: string | null;
  format: string | null;
  required: boolean;
}): DocumentRequirement {
  return {
    documentName: row.documentName,
    description: row.description ?? '',
    format: row.format ?? '',
    required: row.required,
  };
}

// ─── DocumentChecklistGenerator ──────────────────────────────────────────────

/**
 * `DocumentChecklistGenerator` couples the pure helpers above to a database
 * client so callers can fetch a scheme's checklist or a citizen's shared
 * documents without re-implementing the Prisma queries.
 */
export class DocumentChecklistGenerator {
  constructor(
    private readonly db: DocumentChecklistPrisma = prisma as unknown as DocumentChecklistPrisma,
  ) {}

  /**
   * Returns the checklist for a single scheme split into Required and
   * Optional buckets (Req 8.1, 8.2). When the scheme has no documents the
   * `isEmpty` flag is set so the UI can show the "no documents specified, see
   * official source" message (Req 8.6).
   */
  async getChecklist(schemeId: string): Promise<ChecklistResult> {
    if (!schemeId) {
      throw new TypeError('schemeId is required');
    }

    const rows = await this.db.schemeDocument.findMany({ where: { schemeId } });

    const required: DocumentRequirement[] = [];
    const optional: DocumentRequirement[] = [];
    for (const row of rows) {
      const doc = rowToDocumentRequirement(row);
      if (doc.required) {
        required.push(doc);
      } else {
        optional.push(doc);
      }
    }

    return {
      required,
      optional,
      isEmpty: rows.length === 0,
    };
  }

  /**
   * Returns the documents shared across two or more of the citizen's saved
   * schemes (Req 8.4).
   *
   * Result is keyed by the normalised document name so callers can perform
   * O(1) lookups when rendering a per-scheme checklist that needs to mark
   * documents already required elsewhere.
   */
  async getSharedDocuments(userId: string): Promise<SharedDocumentMap> {
    if (!userId) {
      throw new TypeError('userId is required');
    }

    const savedSchemes = await this.db.savedScheme.findMany({
      where: { userId },
      include: { scheme: { include: { documents: true } } },
    });

    const inputs: SchemeWithDocuments[] = savedSchemes.map((row) => ({
      schemeId: row.scheme.id,
      schemeName: row.scheme.name,
      documents: row.scheme.documents.map(rowToDocumentRequirement),
    }));

    return findSharedDocuments(inputs);
  }
}

/** Default singleton suitable for HTTP handlers and downstream services. */
export const documentChecklistGenerator = new DocumentChecklistGenerator();
