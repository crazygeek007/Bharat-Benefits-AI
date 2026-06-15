/**
 * Scheme Data Parser Entry Point
 *
 * Dispatches a {@link RawSchemeData} payload to the appropriate
 * format-specific parser (HTML / PDF / JSON / XML) and runs the result
 * through {@link enforceMandatoryFields} to guarantee the SchemeObject
 * contract from Requirement 22.1.
 *
 * Per Requirements 22.6 / 22.7:
 *   - If any mandatory field is missing, the scheme is rejected and
 *     `null` is returned. The missing field names are logged together
 *     with the source URL so the source can be flagged for admin review.
 *   - If only optional fields cannot be parsed, those fields are set to
 *     null and a complete {@link SchemeObject} is returned.
 *
 * Per Requirement 22.5, unparseable content (parser throws) is logged
 * with the source URL and content type and `null` is returned, allowing
 * the caller to skip this scheme without affecting other ingestion.
 *
 * Validates: Requirements 22.1, 22.2, 22.5, 22.6, 22.7
 */

import type { RawSchemeData, SchemeObject } from '@bharat-benefits/shared';

import { parseHTML } from './html.parser';
import { parseJSON } from './json.parser';
import { parsePDF } from './pdf.parser';
import { parseXML } from './xml.parser';
import {
  enforceMandatoryFields,
  isRejected,
  type MandatorySchemeField,
} from './mandatory-field-enforcer';

export * from './mandatory-field-enforcer';
export { parseHTML } from './html.parser';
export { parseJSON, mapObjectToScheme } from './json.parser';
export { parsePDF, MAX_PDF_BUFFER_BYTES, PdfSizeLimitError } from './pdf.parser';
export { parseXML } from './xml.parser';

/** Minimal logger interface so tests / callers can capture rejections. */
export interface ParserLogger {
  warn(message: string, context: Record<string, unknown>): void;
  error(message: string, context: Record<string, unknown>): void;
}

const noopLogger: ParserLogger = {
  warn: () => {},
  error: () => {},
};

export interface ParseSchemeDataOptions {
  logger?: ParserLogger;
}

/**
 * Parses raw scheme data into a {@link SchemeObject}, or returns null when
 * the data should be skipped (mandatory fields missing or content
 * unparseable).
 *
 * For PDFs, the synchronous version isn't appropriate — see
 * {@link parseSchemeDataAsync}. The synchronous variant rejects PDF
 * content and logs an error.
 */
export function parseSchemeData(
  raw: RawSchemeData,
  options: ParseSchemeDataOptions = {},
): SchemeObject | null {
  const logger = options.logger ?? noopLogger;

  if (raw.contentType === 'pdf') {
    logger.error('PDF parsing requires parseSchemeDataAsync', {
      sourceUrl: raw.url,
      contentType: raw.contentType,
    });
    return null;
  }

  let partial;
  try {
    switch (raw.contentType) {
      case 'html':
        partial = parseHTML(raw.content, raw.url);
        break;
      case 'json':
        partial = parseJSON(raw.content, raw.url);
        break;
      case 'xml':
        partial = parseXML(raw.content, raw.url);
        break;
      default: {
        const exhaustive: never = raw.contentType;
        logger.error('Unsupported content type', {
          sourceUrl: raw.url,
          contentType: String(exhaustive),
        });
        return null;
      }
    }
  } catch (err) {
    logger.error('Parser threw while extracting scheme', {
      sourceUrl: raw.url,
      contentType: raw.contentType,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  return finalize(partial, raw, logger);
}

/**
 * Async variant supporting PDF inputs. The PDF buffer is taken from
 * `raw.content` interpreted as a base64-encoded string OR a Buffer.
 */
export async function parseSchemeDataAsync(
  raw: RawSchemeData & { buffer?: Buffer },
  options: ParseSchemeDataOptions = {},
): Promise<SchemeObject | null> {
  const logger = options.logger ?? noopLogger;

  if (raw.contentType !== 'pdf') {
    return parseSchemeData(raw, options);
  }

  let partial;
  try {
    const buffer =
      raw.buffer ?? Buffer.from(raw.content, 'base64');
    partial = await parsePDF(buffer, raw.url);
  } catch (err) {
    logger.error('PDF parser threw while extracting scheme', {
      sourceUrl: raw.url,
      contentType: raw.contentType,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  return finalize(partial, raw, logger);
}

// ─── Finalisation ────────────────────────────────────────────────────────────

function finalize(
  partial: Partial<SchemeObject>,
  raw: RawSchemeData,
  logger: ParserLogger,
): SchemeObject | null {
  const result = enforceMandatoryFields(partial, raw.url);
  if (isRejected(result)) {
    logger.warn('Rejecting scheme: missing mandatory fields', {
      sourceUrl: raw.url,
      contentType: raw.contentType,
      missingFields: result.missingFields satisfies MandatorySchemeField[],
    });
    return null;
  }
  return result;
}
