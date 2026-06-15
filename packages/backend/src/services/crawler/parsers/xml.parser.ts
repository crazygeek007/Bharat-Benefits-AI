/**
 * XML Parser for Scheme Data
 *
 * Uses `fast-xml-parser` to convert XML into a JS object, then delegates
 * field mapping to {@link mapObjectToScheme} so the same key-variation
 * tolerance applied to JSON is applied to XML.
 *
 * Validates: Requirements 22.1, 22.2, 22.5, 22.7
 */

import { XMLParser } from 'fast-xml-parser';
import type { SchemeObject } from '@bharat-benefits/shared';
import { mapObjectToScheme } from './json.parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: true,
  parseAttributeValue: true,
  // Drop <?xml … ?> declarations and PI tags so they don't pollute the
  // top-level keys (which would confuse the wrapper-unwrapping below).
  ignoreDeclaration: true,
  ignorePiTags: true,
  // Most ministry feeds wrap everything in a <scheme> element; keep array
  // detection automatic and rely on downstream coercion.
});

/**
 * Parses an XML scheme payload into a Partial<SchemeObject>. Returns
 * `{ sourceUrl }` only when the document cannot be parsed.
 */
export function parseXML(content: string, sourceUrl: string): Partial<SchemeObject> {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { sourceUrl, applicationProcess: null, requiredDocuments: null, deadline: null };
  }

  let parsed: unknown;
  try {
    parsed = parser.parse(content);
  } catch {
    return { sourceUrl, applicationProcess: null, requiredDocuments: null, deadline: null };
  }

  const root = unwrapRoot(parsed);
  if (!isObject(root)) {
    return { sourceUrl, applicationProcess: null, requiredDocuments: null, deadline: null };
  }

  return mapObjectToScheme(root, sourceUrl);
}

/**
 * Extracts the scheme object from typical XML wrappers. Accepts:
 *   - <scheme>…</scheme>
 *   - <root><scheme>…</scheme></root>
 *   - top-level objects whose first key is the scheme container
 */
function unwrapRoot(value: unknown): Record<string, unknown> | unknown {
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 0) return value;

  // If the document has a single top-level wrapper, descend through it
  // until we find an object that exposes recognisable scheme fields.
  let current: Record<string, unknown> = value;
  let depth = 0;
  while (depth < 5) {
    if (looksLikeScheme(current)) return current;
    const childKey = Object.keys(current)[0];
    const child = current[childKey];
    if (isObject(child)) {
      current = child;
      depth += 1;
    } else if (Array.isArray(child) && child.length > 0 && isObject(child[0])) {
      current = child[0] as Record<string, unknown>;
      depth += 1;
    } else {
      break;
    }
  }
  return current;
}

function looksLikeScheme(obj: Record<string, unknown>): boolean {
  const recognized = [
    'name',
    'scheme_name',
    'schemeName',
    'title',
    'description',
    'eligibility',
    'eligibilityCriteria',
    'eligibility_criteria',
    'benefits',
    'ministry',
    'department',
  ];
  return recognized.some((k) => k in obj);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
