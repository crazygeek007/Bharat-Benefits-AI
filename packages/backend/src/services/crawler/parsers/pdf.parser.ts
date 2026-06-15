/**
 * PDF Parser for Scheme Data
 *
 * Extracts plain text from a PDF buffer (using `pdf-parse`) and runs the
 * same heuristic field-extraction logic as the HTML parser, but driven by
 * regular expressions over the flat text rather than a DOM.
 *
 * Per Requirement 22.2, the parser supports PDF documents up to 50 MB. PDFs
 * larger than this limit are rejected up-front with an error, before
 * pdf-parse is invoked.
 *
 * Validates: Requirements 22.1, 22.2, 22.5, 22.7
 */

import pdfParse from 'pdf-parse';
import type {
  ApplicationStep,
  Benefit,
  DocumentRequirement,
  EligibilityCriterion,
  SchemeObject,
} from '@bharat-benefits/shared';
import { extractRupeeAmount, parseDateFromText } from './html.parser';

/** Maximum allowed PDF size, in bytes. Per Requirement 22.2 this is 50 MB. */
export const MAX_PDF_BUFFER_BYTES = 50 * 1024 * 1024;

/**
 * Thrown when a PDF buffer exceeds {@link MAX_PDF_BUFFER_BYTES}.
 *
 * Preserves a typed marker (`code = 'PDF_TOO_LARGE'`) so callers can
 * distinguish size violations from generic parsing errors.
 */
export class PdfSizeLimitError extends Error {
  public readonly code = 'PDF_TOO_LARGE';
  public readonly sizeBytes: number;
  public readonly limitBytes: number;

  constructor(sizeBytes: number, limitBytes: number = MAX_PDF_BUFFER_BYTES) {
    super(
      `PDF buffer of ${sizeBytes} bytes exceeds ${limitBytes}-byte (50MB) limit`,
    );
    this.name = 'PdfSizeLimitError';
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * Parses a PDF buffer into a Partial<SchemeObject>. The 50 MB cap is
 * enforced before any work happens. The mandatory-field check is delegated
 * to {@link enforceMandatoryFields} downstream.
 *
 * Optional injection point: a custom `pdfTextExtractor` may be supplied,
 * which makes the parser easy to test without crafting a real PDF binary.
 */
export async function parsePDF(
  buffer: Buffer,
  sourceUrl: string,
  options?: {
    pdfTextExtractor?: (buffer: Buffer) => Promise<string>;
  },
): Promise<Partial<SchemeObject>> {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('parsePDF: expected a Buffer');
  }

  if (buffer.length > MAX_PDF_BUFFER_BYTES) {
    throw new PdfSizeLimitError(buffer.length);
  }

  const extractor =
    options?.pdfTextExtractor ?? defaultPdfTextExtractor;

  const text = await extractor(buffer);
  return parsePdfText(text, sourceUrl);
}

async function defaultPdfTextExtractor(buffer: Buffer): Promise<string> {
  const result = await pdfParse(buffer);
  return result.text ?? '';
}

/**
 * Pure text-driven extraction logic — exported for direct unit testing
 * without going through `pdf-parse`.
 */
export function parsePdfText(
  text: string,
  sourceUrl: string,
): Partial<SchemeObject> {
  const result: Partial<SchemeObject> = { sourceUrl };
  if (!text || typeof text !== 'string') {
    result.applicationProcess = null;
    result.requiredDocuments = null;
    result.deadline = null;
    return result;
  }

  // ─── Name ────────────────────────────────────────────────────────────────
  // Use the first non-empty line as a best-effort scheme name; many gov PDFs
  // start with the scheme name as the document title.
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const nonEmpty = lines.filter((l) => l.length > 0);
  if (nonEmpty.length > 0) {
    result.name = nonEmpty[0];
  }

  // ─── Description ─────────────────────────────────────────────────────────
  // Heuristic: first paragraph of meaningful text after the title.
  if (nonEmpty.length > 1) {
    const candidate = nonEmpty
      .slice(1)
      .find((l) => l.length >= 30); // first reasonably long line
    if (candidate) result.description = candidate;
  }

  // ─── Ministry ────────────────────────────────────────────────────────────
  const ministryMatch =
    text.match(/Ministry of [^\n.,;|]+/i) ??
    text.match(/Department of [^\n.,;|]+/i);
  if (ministryMatch) {
    result.ministry = ministryMatch[0].trim();
  }

  // ─── Eligibility ─────────────────────────────────────────────────────────
  const eligibilityItems = extractSection(text, /eligib[a-z]*[:\s-]/i);
  if (eligibilityItems.length > 0) {
    result.eligibilityCriteria = eligibilityItems.map<EligibilityCriterion>(
      (item) => ({
        field: 'unknown',
        operator: 'eq',
        value: null,
        description: item,
      }),
    );
  }

  // ─── Benefits ────────────────────────────────────────────────────────────
  const benefitItems = extractSection(text, /benefit[s]?[:\s-]/i);
  if (benefitItems.length > 0) {
    result.benefits = benefitItems.map<Benefit>((item) => {
      const amount = extractRupeeAmount(item);
      return {
        type: amount === null ? 'non-monetary' : 'monetary',
        amount,
        description: item,
      };
    });
  }

  // ─── Optional: Documents ─────────────────────────────────────────────────
  const documentItems = extractSection(text, /documents?[:\s-]/i);
  result.requiredDocuments =
    documentItems.length > 0
      ? documentItems.map<DocumentRequirement>((item) => ({
          documentName: item,
          description: item,
          format: 'unknown',
          required: true,
        }))
      : null;

  // ─── Optional: Application process ───────────────────────────────────────
  const applyItems = extractSection(
    text,
    /(how to apply|application process)[:\s-]/i,
  );
  result.applicationProcess =
    applyItems.length > 0
      ? applyItems.map<ApplicationStep>((item, idx) => ({
          stepNumber: idx + 1,
          action: item,
          expectedOutcome: '',
        }))
      : null;

  // ─── Optional: Deadline ──────────────────────────────────────────────────
  result.deadline = extractDeadlineFromText(text);

  return result;
}

// ─── Text-section extraction ─────────────────────────────────────────────────

/**
 * Scans for a section heading matching `headingRegex` and collects bullet /
 * numbered list items that follow it, until the next blank line or the next
 * recognisable section heading.
 */
function extractSection(text: string, headingRegex: RegExp): string[] {
  const lines = text.split(/\r?\n/);
  const items: string[] = [];

  let inSection = false;
  let sawAnyContent = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (!inSection) {
      if (headingRegex.test(line)) {
        inSection = true;
        // Capture inline content after the colon, e.g. "Eligibility: …"
        const inline = line.replace(headingRegex, '').trim();
        if (inline.length > 0) {
          // Split simple "a, b, c" or "a; b; c" inline lists
          const parts = inline
            .split(/[;,]+/)
            .map((p) => p.trim())
            .filter((p) => p.length > 0);
          items.push(...parts);
          sawAnyContent = true;
        }
      }
      continue;
    }

    // In the section: stop when we hit another known heading or two blank
    // lines in a row.
    if (
      /^(eligib|benefit|documents?|how to apply|application process|deadline|last date)/i.test(
        line,
      ) &&
      !headingRegex.test(line)
    ) {
      break;
    }

    if (line.length === 0) {
      // A single blank line within a list is tolerated; two in a row ends
      // the section.
      if (sawAnyContent && (i + 1 >= lines.length || lines[i + 1].trim() === '')) {
        break;
      }
      continue;
    }

    // Bullet or numbered item — strip the marker.
    const stripped = line.replace(
      /^(?:[-*•·]|\d+[.)])\s*/,
      '',
    );
    if (stripped.length > 0) {
      items.push(stripped);
      sawAnyContent = true;
    }
  }

  return items;
}

function extractDeadlineFromText(text: string): Date | null {
  const lines = text.split(/\r?\n|\.|;/);
  for (const line of lines) {
    if (!/(deadline|last date|closing date|apply by|due date)/i.test(line)) continue;
    const d = parseDateFromText(line);
    if (d) return d;
  }
  return null;
}
