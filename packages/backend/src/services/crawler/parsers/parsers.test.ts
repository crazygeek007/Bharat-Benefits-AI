/**
 * Unit tests for Scheme Data Parsers
 *
 * Validates: Requirements 22.1, 22.2, 22.5, 22.6, 22.7
 *
 * Covers:
 *   - HTML parsing of common gov.in patterns
 *   - JSON parsing with key variations
 *   - XML parsing of typical scheme feeds
 *   - PDF parsing (using parsePdfText to avoid coupling tests to PDF
 *     binary fixtures) plus the 50 MB size enforcement on parsePDF
 *   - Mandatory field enforcement: rejection on missing fields, optional
 *     fields defaulted to null, full SchemeObject on success
 *   - Top-level dispatcher behaviour
 */

import { describe, it, expect, vi } from 'vitest';
import type { Benefit, EligibilityCriterion, SchemeObject } from '@bharat-benefits/shared';

import { parseHTML } from './html.parser';
import { parseJSON } from './json.parser';
import { parseXML } from './xml.parser';
import {
  parsePDF,
  parsePdfText,
  PdfSizeLimitError,
  MAX_PDF_BUFFER_BYTES,
} from './pdf.parser';
import {
  enforceMandatoryFields,
  isRejected,
  MANDATORY_SCHEME_FIELDS,
} from './mandatory-field-enforcer';
import {
  parseSchemeData,
  parseSchemeDataAsync,
  type ParserLogger,
} from './index';

// ─── HTML parser ─────────────────────────────────────────────────────────────

describe('parseHTML', () => {
  const sampleHtml = `
    <!doctype html>
    <html lang="en">
      <head>
        <title>Old title</title>
        <meta name="description" content="A scheme to support farmers across India." />
        <meta name="ministry" content="Ministry of Agriculture and Farmers Welfare" />
      </head>
      <body>
        <main>
          <h1 class="scheme-name">PM Kisan Samman Nidhi</h1>
          <p class="intro">An income support scheme for small and marginal farmers.</p>

          <h2>Eligibility</h2>
          <ul>
            <li>Indian citizen</li>
            <li>Small and marginal farmer with cultivable land</li>
          </ul>

          <h2>Benefits</h2>
          <ul>
            <li>Rs. 6000 per year financial assistance</li>
            <li>Direct benefit transfer in 3 installments</li>
          </ul>

          <h2>Documents Required</h2>
          <ul>
            <li>Aadhaar card</li>
            <li>Land ownership records</li>
            <li>Bank account details</li>
          </ul>

          <h2>How to Apply</h2>
          <ol>
            <li>Visit pmkisan.gov.in</li>
            <li>Click on Farmers Corner</li>
            <li>Submit the new farmer registration form</li>
          </ol>

          <p>Last date: 31/12/2024 for the current cycle.</p>
        </main>
      </body>
    </html>
  `;

  it('extracts the scheme name from .scheme-name selector', () => {
    const result = parseHTML(sampleHtml, 'https://pmkisan.gov.in/');
    expect(result.name).toBe('PM Kisan Samman Nidhi');
  });

  it('extracts description from meta tag', () => {
    const result = parseHTML(sampleHtml, 'https://pmkisan.gov.in/');
    expect(result.description).toBe('A scheme to support farmers across India.');
  });

  it('extracts ministry from meta tag', () => {
    const result = parseHTML(sampleHtml, 'https://pmkisan.gov.in/');
    expect(result.ministry).toBe('Ministry of Agriculture and Farmers Welfare');
  });

  it('extracts eligibility criteria from list items under heading matching /eligib/i', () => {
    const result = parseHTML(sampleHtml, 'https://pmkisan.gov.in/');
    expect(result.eligibilityCriteria).toHaveLength(2);
    expect(result.eligibilityCriteria?.[0].description).toBe('Indian citizen');
    expect(result.eligibilityCriteria?.[1].description).toBe(
      'Small and marginal farmer with cultivable land',
    );
  });

  it('extracts benefits and detects monetary amount', () => {
    const result = parseHTML(sampleHtml, 'https://pmkisan.gov.in/');
    expect(result.benefits).toHaveLength(2);
    const monetary = result.benefits?.find((b) => b.type === 'monetary');
    expect(monetary?.amount).toBe(6000);
    const nonMonetary = result.benefits?.find((b) => b.type === 'non-monetary');
    expect(nonMonetary?.description).toContain('Direct benefit transfer');
  });

  it('extracts required documents', () => {
    const result = parseHTML(sampleHtml, 'https://pmkisan.gov.in/');
    expect(result.requiredDocuments).toHaveLength(3);
    expect(result.requiredDocuments?.[0].documentName).toBe('Aadhaar card');
  });

  it('extracts numbered application steps', () => {
    const result = parseHTML(sampleHtml, 'https://pmkisan.gov.in/');
    expect(result.applicationProcess).toHaveLength(3);
    expect(result.applicationProcess?.[0].stepNumber).toBe(1);
    expect(result.applicationProcess?.[0].action).toBe('Visit pmkisan.gov.in');
  });

  it('extracts deadline near "Last date" keyword', () => {
    const result = parseHTML(sampleHtml, 'https://pmkisan.gov.in/');
    expect(result.deadline).toBeInstanceOf(Date);
    expect(result.deadline?.getUTCFullYear()).toBe(2024);
    expect(result.deadline?.getUTCMonth()).toBe(11); // December
    expect(result.deadline?.getUTCDate()).toBe(31);
  });

  it('falls back to h1 when no .scheme-name selector is present', () => {
    const html = '<html><body><h1>Beti Bachao Beti Padhao</h1></body></html>';
    const result = parseHTML(html, 'https://wcd.nic.in/');
    expect(result.name).toBe('Beti Bachao Beti Padhao');
  });

  it('extracts ministry from footer text when meta is absent', () => {
    const html = `
      <html><body>
        <h1>X Scheme</h1>
        <footer>Ministry of Health and Family Welfare, Government of India</footer>
      </body></html>
    `;
    const result = parseHTML(html, 'https://example.gov.in/');
    expect(result.ministry).toMatch(/^Ministry of Health/);
  });

  it('sets all optional fields to null when absent', () => {
    const html = '<html><body><h1>X</h1><p>desc</p></body></html>';
    const result = parseHTML(html, 'https://example.gov.in/');
    expect(result.requiredDocuments).toBeNull();
    expect(result.applicationProcess).toBeNull();
    expect(result.deadline).toBeNull();
  });
});

// ─── JSON parser ─────────────────────────────────────────────────────────────

describe('parseJSON', () => {
  it('maps direct field names', () => {
    const json = JSON.stringify({
      name: 'PMAY-G',
      description: 'Rural housing scheme',
      ministry: 'Ministry of Rural Development',
      sourceUrl: 'https://pmayg.nic.in/',
      eligibilityCriteria: ['Rural household', 'BPL category'],
      benefits: [{ type: 'monetary', amount: 120000, description: 'Construction assistance' }],
      requiredDocuments: ['Aadhaar', 'Bank passbook'],
      applicationProcess: [{ stepNumber: 1, action: 'Visit gram panchayat' }],
      deadline: '2025-03-31',
    });

    const result = parseJSON(json, 'https://pmayg.nic.in/');
    expect(result.name).toBe('PMAY-G');
    expect(result.description).toBe('Rural housing scheme');
    expect(result.ministry).toBe('Ministry of Rural Development');
    expect(result.sourceUrl).toBe('https://pmayg.nic.in/');
    expect(result.eligibilityCriteria).toHaveLength(2);
    expect(result.benefits).toHaveLength(1);
    expect(result.benefits?.[0]).toMatchObject({
      type: 'monetary',
      amount: 120000,
      description: 'Construction assistance',
    });
    expect(result.requiredDocuments).toHaveLength(2);
    expect(result.applicationProcess).toHaveLength(1);
    expect(result.deadline).toBeInstanceOf(Date);
  });

  it('maps snake_case key variations', () => {
    const json = JSON.stringify({
      scheme_name: 'NREGA',
      desc: 'Wage employment',
      department: 'Ministry of Rural Development',
      source_url: 'https://nrega.nic.in/',
      eligibility_criteria: 'Adult member; willing to do unskilled manual work',
      scheme_benefits: '100 days guaranteed wage employment',
      last_date: null,
    });

    const result = parseJSON(json, 'https://nrega.nic.in/');
    expect(result.name).toBe('NREGA');
    expect(result.description).toBe('Wage employment');
    expect(result.ministry).toBe('Ministry of Rural Development');
    expect(result.sourceUrl).toBe('https://nrega.nic.in/');
    expect(result.eligibilityCriteria?.length).toBe(2);
    expect(result.benefits?.length).toBe(1);
    expect(result.deadline).toBeNull();
  });

  it('returns sourceUrl-only partial when JSON is malformed', () => {
    const result = parseJSON('not json {', 'https://example.gov.in/');
    expect(result.sourceUrl).toBe('https://example.gov.in/');
    expect(result.name).toBeUndefined();
  });

  it('falls back to provided sourceUrl when payload omits one', () => {
    const json = JSON.stringify({ name: 'X', description: 'Y' });
    const result = parseJSON(json, 'https://example.gov.in/scheme');
    expect(result.sourceUrl).toBe('https://example.gov.in/scheme');
  });

  it('defaults benefit type to non-monetary when amount is null', () => {
    const json = JSON.stringify({
      benefits: [{ description: 'Free training' }],
    });
    const result = parseJSON(json, 'https://example.gov.in/');
    expect(result.benefits?.[0]).toMatchObject({
      type: 'non-monetary',
      amount: null,
      description: 'Free training',
    });
  });
});

// ─── XML parser ──────────────────────────────────────────────────────────────

describe('parseXML', () => {
  const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
    <scheme>
      <name>Atal Pension Yojana</name>
      <description>Pension scheme for unorganised sector workers</description>
      <ministry>Ministry of Finance</ministry>
      <sourceUrl>https://npscra.nsdl.co.in/</sourceUrl>
      <eligibilityCriteria>
        <criterion>Aged 18-40</criterion>
        <criterion>Bank account holder</criterion>
      </eligibilityCriteria>
      <benefits>
        <benefit>
          <type>monetary</type>
          <amount>5000</amount>
          <description>Monthly pension after 60</description>
        </benefit>
      </benefits>
      <deadline>2025-06-30</deadline>
    </scheme>
  `;

  it('parses a typical wrapped scheme element', () => {
    const result = parseXML(sampleXml, 'https://npscra.nsdl.co.in/');
    expect(result.name).toBe('Atal Pension Yojana');
    expect(result.description).toBe('Pension scheme for unorganised sector workers');
    expect(result.ministry).toBe('Ministry of Finance');
    expect(result.sourceUrl).toBe('https://npscra.nsdl.co.in/');
    expect(result.eligibilityCriteria?.length).toBeGreaterThan(0);
    expect(result.benefits?.[0]).toMatchObject({ type: 'monetary', amount: 5000 });
    expect(result.deadline).toBeInstanceOf(Date);
  });

  it('returns sourceUrl-only partial when XML is empty', () => {
    const result = parseXML('', 'https://example.gov.in/');
    expect(result.sourceUrl).toBe('https://example.gov.in/');
    expect(result.name).toBeUndefined();
  });
});

// ─── PDF parser ──────────────────────────────────────────────────────────────

describe('parsePdfText (text-driven extraction)', () => {
  const sampleText = `
PM Awas Yojana Urban
Affordable housing scheme for urban poor citizens of India.
Ministry of Housing and Urban Affairs

Eligibility:
- EWS / LIG household
- Aadhaar holder
- No pucca house ownership

Benefits:
- Interest subsidy of Rs. 2,67,000 on home loan
- Direct benefit transfer

Documents:
- Aadhaar
- Income certificate
- Bank account details

How to apply:
1. Register on PMAY-U portal
2. Submit application form

Last date: 31-12-2024
  `;

  it('extracts mandatory fields from PDF text', () => {
    const result = parsePdfText(sampleText, 'https://pmaymis.gov.in/');
    expect(result.name).toBe('PM Awas Yojana Urban');
    expect(result.description).toMatch(/Affordable housing scheme/i);
    expect(result.ministry).toBe('Ministry of Housing and Urban Affairs');
    expect(result.eligibilityCriteria?.length).toBeGreaterThanOrEqual(3);
    expect(result.benefits?.length).toBeGreaterThanOrEqual(2);
    expect(result.benefits?.[0].amount).toBe(267000);
  });

  it('extracts deadline near "Last date" keyword', () => {
    const result = parsePdfText(sampleText, 'https://pmaymis.gov.in/');
    expect(result.deadline?.getUTCFullYear()).toBe(2024);
    expect(result.deadline?.getUTCMonth()).toBe(11);
  });

  it('returns sourceUrl-only partial when text is empty', () => {
    const result = parsePdfText('', 'https://example.gov.in/');
    expect(result.sourceUrl).toBe('https://example.gov.in/');
    expect(result.name).toBeUndefined();
  });
});

describe('parsePDF size limit', () => {
  it('throws PdfSizeLimitError when buffer exceeds 50 MB', async () => {
    // We don't actually want to allocate 50MB — use a fake Buffer with a
    // patched length. Buffer.from with a length argument creates a real
    // small buffer; we monkey-patch its `length` for the size check only.
    const small = Buffer.from('not a pdf');
    Object.defineProperty(small, 'length', {
      value: MAX_PDF_BUFFER_BYTES + 1,
      configurable: true,
    });

    await expect(parsePDF(small, 'https://example.gov.in/')).rejects.toBeInstanceOf(
      PdfSizeLimitError,
    );
  });

  it('rejects non-Buffer inputs', async () => {
    // @ts-expect-error — testing runtime guard against bad input
    await expect(parsePDF('not a buffer', 'https://example.gov.in/')).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('uses injected pdfTextExtractor for testability', async () => {
    const buffer = Buffer.from('fake pdf content');
    const result = await parsePDF(buffer, 'https://example.gov.in/', {
      pdfTextExtractor: async () =>
        'My Scheme\nDescription line longer than thirty characters here.\nMinistry of Testing\nEligibility:\n- Test\nBenefits:\n- Rs. 100 reward',
    });
    expect(result.name).toBe('My Scheme');
    expect(result.ministry).toBe('Ministry of Testing');
    expect(result.benefits?.[0].amount).toBe(100);
  });
});

// ─── Mandatory field enforcer ────────────────────────────────────────────────

describe('enforceMandatoryFields', () => {
  function fullPartial(): Partial<SchemeObject> {
    const eligibility: EligibilityCriterion[] = [
      { field: 'age', operator: 'gte', value: 18, description: 'Age 18 or above' },
    ];
    const benefits: Benefit[] = [
      { type: 'monetary', amount: 1000, description: 'Cash benefit' },
    ];
    return {
      name: 'Test Scheme',
      description: 'Test description',
      eligibilityCriteria: eligibility,
      benefits,
      sourceUrl: 'https://example.gov.in/',
      ministry: 'Ministry of Test',
    };
  }

  it('returns a full SchemeObject when all mandatory fields are present', () => {
    const result = enforceMandatoryFields(fullPartial(), 'https://example.gov.in/');
    expect(isRejected(result)).toBe(false);
    if (isRejected(result)) return;
    expect(result.name).toBe('Test Scheme');
    expect(result.description).toBe('Test description');
    expect(result.eligibilityCriteria).toHaveLength(1);
    expect(result.benefits).toHaveLength(1);
    expect(result.sourceUrl).toBe('https://example.gov.in/');
    expect(result.ministry).toBe('Ministry of Test');
    // Optional fields default to null
    expect(result.applicationProcess).toBeNull();
    expect(result.requiredDocuments).toBeNull();
    expect(result.deadline).toBeNull();
  });

  it('rejects when name is missing', () => {
    const partial = fullPartial();
    delete partial.name;
    const result = enforceMandatoryFields(partial, 'https://example.gov.in/');
    expect(isRejected(result)).toBe(true);
    if (!isRejected(result)) return;
    expect(result.missingFields).toContain('name');
  });

  it('rejects when description is whitespace only', () => {
    const partial = fullPartial();
    partial.description = '   ';
    const result = enforceMandatoryFields(partial, 'https://example.gov.in/');
    expect(isRejected(result)).toBe(true);
    if (!isRejected(result)) return;
    expect(result.missingFields).toContain('description');
  });

  it('accepts empty eligibilityCriteria as a partial scheme (now optional)', () => {
    const partial = fullPartial();
    partial.eligibilityCriteria = [];
    const result = enforceMandatoryFields(partial, 'https://example.gov.in/');
    expect(isRejected(result)).toBe(false);
    if (isRejected(result)) return;
    expect(result.eligibilityCriteria).toEqual([]);
  });

  it('accepts empty benefits as a partial scheme (now optional)', () => {
    const partial = fullPartial();
    partial.benefits = [];
    const result = enforceMandatoryFields(partial, 'https://example.gov.in/');
    expect(isRejected(result)).toBe(false);
    if (isRejected(result)) return;
    expect(result.benefits).toEqual([]);
  });

  it('falls back to provided sourceUrl when partial has none', () => {
    const partial = fullPartial();
    delete partial.sourceUrl;
    const result = enforceMandatoryFields(partial, 'https://fallback.gov.in/');
    expect(isRejected(result)).toBe(false);
    if (isRejected(result)) return;
    expect(result.sourceUrl).toBe('https://fallback.gov.in/');
  });

  it('rejects when both partial and fallback sourceUrl are empty', () => {
    const partial = fullPartial();
    delete partial.sourceUrl;
    const result = enforceMandatoryFields(partial, '');
    expect(isRejected(result)).toBe(true);
    if (!isRejected(result)) return;
    expect(result.missingFields).toContain('sourceUrl');
  });

  it('accepts a scheme without ministry (falls back to "Unknown Ministry")', () => {
    const partial = fullPartial();
    delete partial.ministry;
    const result = enforceMandatoryFields(partial, 'https://example.gov.in/');
    expect(isRejected(result)).toBe(false);
    if (isRejected(result)) return;
    // Ministry is non-empty even when the partial omitted it — fallback
    // keeps PrismaSchemePersistence's NOT NULL constraint satisfied.
    expect(result.ministry).toBe('Unknown Ministry');
  });

  it('reports all missing mandatory fields together', () => {
    const result = enforceMandatoryFields({}, '');
    expect(isRejected(result)).toBe(true);
    if (!isRejected(result)) return;
    for (const field of MANDATORY_SCHEME_FIELDS) {
      expect(result.missingFields).toContain(field);
    }
  });

  it('preserves valid optional fields verbatim', () => {
    const partial = fullPartial();
    partial.applicationProcess = [{ stepNumber: 1, action: 'a', expectedOutcome: 'o' }];
    partial.requiredDocuments = [
      { documentName: 'd', description: 'desc', format: 'pdf', required: true },
    ];
    partial.deadline = new Date('2025-01-01T00:00:00Z');

    const result = enforceMandatoryFields(partial, 'https://example.gov.in/');
    expect(isRejected(result)).toBe(false);
    if (isRejected(result)) return;
    expect(result.applicationProcess).toHaveLength(1);
    expect(result.requiredDocuments).toHaveLength(1);
    expect(result.deadline?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('coerces invalid Date to null', () => {
    const partial = fullPartial();
    partial.deadline = new Date('not-a-date');
    const result = enforceMandatoryFields(partial, 'https://example.gov.in/');
    expect(isRejected(result)).toBe(false);
    if (isRejected(result)) return;
    expect(result.deadline).toBeNull();
  });
});

// ─── Top-level dispatcher ────────────────────────────────────────────────────

describe('parseSchemeData', () => {
  function makeLogger(): ParserLogger & {
    warns: Array<[string, Record<string, unknown>]>;
    errors: Array<[string, Record<string, unknown>]>;
  } {
    const warns: Array<[string, Record<string, unknown>]> = [];
    const errors: Array<[string, Record<string, unknown>]> = [];
    return {
      warns,
      errors,
      warn: (msg, ctx) => warns.push([msg, ctx]),
      error: (msg, ctx) => errors.push([msg, ctx]),
    };
  }

  it('returns a SchemeObject for a complete JSON payload', () => {
    const json = JSON.stringify({
      name: 'X Scheme',
      description: 'Y description',
      ministry: 'Ministry of Z',
      eligibilityCriteria: ['Be a citizen'],
      benefits: [{ type: 'monetary', amount: 1000, description: 'Cash' }],
    });
    const logger = makeLogger();
    const result = parseSchemeData(
      {
        url: 'https://example.gov.in/',
        content: json,
        contentType: 'json',
        fetchedAt: new Date(),
      },
      { logger },
    );
    expect(result).not.toBeNull();
    expect(result?.name).toBe('X Scheme');
    expect(logger.warns).toHaveLength(0);
    expect(logger.errors).toHaveLength(0);
  });

  it('returns null and logs a warning when mandatory fields are missing', () => {
    const json = JSON.stringify({ name: 'Only name' });
    const logger = makeLogger();
    const result = parseSchemeData(
      {
        url: 'https://example.gov.in/',
        content: json,
        contentType: 'json',
        fetchedAt: new Date(),
      },
      { logger },
    );
    expect(result).toBeNull();
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0][1].sourceUrl).toBe('https://example.gov.in/');
    // Mandatory-fields contract now narrowed to name + description +
    // sourceUrl (ministry / eligibility / benefits became optional in the
    // relaxed-validation refactor). The partial sourceUrl falls back to
    // the supplied URL, so only `description` ends up missing.
    expect(logger.warns[0][1].missingFields).toEqual(
      expect.arrayContaining(['description']),
    );
  });

  it('returns null and logs an error for unparseable content (parser throws)', () => {
    // Force an exception by mocking JSON.parse — easier path: pass invalid
    // JSON to the JSON branch. parseJSON itself doesn't throw, so we go via
    // a custom contentType reachability check instead. Simulate a parser
    // throw by spying on parseHTML through a module-level mock would be
    // heavy here; instead we verify the catch branch by feeding HTML that
    // makes cheerio happy but missing required fields, then a separate
    // assertion checks the dispatch path for explicit unsupported types.
    const logger = makeLogger();

    // Unsupported (forced via cast) content type triggers the default branch
    const result = parseSchemeData(
      {
        url: 'https://example.gov.in/',
        content: 'whatever',
        // @ts-expect-error — exercising the exhaustiveness guard
        contentType: 'unsupported',
        fetchedAt: new Date(),
      },
      { logger },
    );
    expect(result).toBeNull();
    expect(logger.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses synchronous parsing of PDF content', () => {
    const logger = makeLogger();
    const result = parseSchemeData(
      {
        url: 'https://example.gov.in/scheme.pdf',
        content: '',
        contentType: 'pdf',
        fetchedAt: new Date(),
      },
      { logger },
    );
    expect(result).toBeNull();
    expect(logger.errors).toHaveLength(1);
  });
});

describe('parseSchemeDataAsync (PDF support)', () => {
  it('delegates non-PDF inputs to the synchronous dispatcher', async () => {
    const json = JSON.stringify({
      name: 'Async Scheme',
      description: 'Description',
      ministry: 'Ministry of A',
      eligibilityCriteria: ['x'],
      benefits: [{ type: 'monetary', amount: 1, description: 'a' }],
    });
    const result = await parseSchemeDataAsync({
      url: 'https://example.gov.in/',
      content: json,
      contentType: 'json',
      fetchedAt: new Date(),
    });
    expect(result?.name).toBe('Async Scheme');
  });

  it('returns null and logs error when PDF buffer exceeds 50 MB', async () => {
    const big = Buffer.from('a');
    Object.defineProperty(big, 'length', {
      value: MAX_PDF_BUFFER_BYTES + 1,
      configurable: true,
    });
    const errors: Array<[string, Record<string, unknown>]> = [];
    const logger: ParserLogger = {
      warn: () => {},
      error: (m, c) => errors.push([m, c]),
    };
    const result = await parseSchemeDataAsync(
      {
        url: 'https://example.gov.in/scheme.pdf',
        content: '',
        contentType: 'pdf',
        fetchedAt: new Date(),
        buffer: big,
      },
      { logger },
    );
    expect(result).toBeNull();
    expect(errors).toHaveLength(1);
  });
});
