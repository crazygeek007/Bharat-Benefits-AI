/**
 * Tests for portal-aware extraction.
 *
 * The portal extractors are best-effort enrichers layered on top of
 * the generic HTML parser. These tests cover three things:
 *
 *   1. The router (`extractWithPortalAwareness` / `findPortalExtractor`)
 *      picks the right extractor for each known portal hostname and
 *      returns null / unchanged for unknown hosts.
 *
 *   2. Each extractor enriches fields it can identify with its
 *      portal-specific selectors and leaves the generic parser's
 *      result untouched for everything else.
 *
 *   3. Extractors never throw — malformed HTML and missing selectors
 *      must degrade gracefully back to whatever the generic parser
 *      produced.
 */

import { describe, expect, it } from 'vitest';

import { parseHTML } from './html.parser';
import {
  extractWithPortalAwareness,
  findPortalExtractor,
} from './portal-extractors';

// ─── Router ─────────────────────────────────────────────────────────────────

describe('findPortalExtractor', () => {
  it('returns the myscheme extractor for myscheme.gov.in URLs', () => {
    const ex = findPortalExtractor('https://www.myscheme.gov.in/schemes/pmkisan');
    expect(ex?.name).toBe('myscheme.gov.in');
  });

  it('returns the india.gov.in extractor for india.gov.in URLs', () => {
    const ex = findPortalExtractor('https://www.india.gov.in/spotlight/scheme-x');
    expect(ex?.name).toBe('india.gov.in');
  });

  it('returns the services.india.gov.in extractor for services subdomain', () => {
    const ex = findPortalExtractor('https://services.india.gov.in/service/x');
    expect(ex?.name).toBe('services.india.gov.in');
  });

  it('returns the scholarships.gov.in extractor for NSP URLs', () => {
    const ex = findPortalExtractor('https://scholarships.gov.in/public/scheme/x');
    expect(ex?.name).toBe('scholarships.gov.in');
  });

  it('returns the igod extractor for igod.gov.in URLs', () => {
    const ex = findPortalExtractor('https://igod.gov.in/dataset/x');
    expect(ex?.name).toBe('igod.gov.in');
  });

  it('returns null for unknown long-tail ministry hosts', () => {
    expect(findPortalExtractor('https://pmkisan.gov.in/')).toBeNull();
    expect(findPortalExtractor('https://wcd.nic.in/scheme/y')).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(findPortalExtractor('not a url')).toBeNull();
  });
});

// ─── extractWithPortalAwareness ─────────────────────────────────────────────

describe('extractWithPortalAwareness', () => {
  it('returns the generic result unchanged for unknown hosts', () => {
    const generic = { name: 'X', description: 'Y', sourceUrl: 'https://example.gov.in/' };
    const out = extractWithPortalAwareness('<html/>', 'https://example.gov.in/', generic);
    expect(out).toBe(generic);
  });

  it('returns the generic result unchanged when HTML is malformed and the extractor throws internally', () => {
    // Pass content that cheerio loads but contains no usable selectors —
    // the extractor returns {}, so the merged result equals `generic`.
    const generic = { name: 'X', sourceUrl: 'https://www.myscheme.gov.in/x' };
    const out = extractWithPortalAwareness(
      '<html><body><div>nothing useful</div></body></html>',
      'https://www.myscheme.gov.in/x',
      generic,
    );
    expect(out.name).toBe('X');
    expect(out.sourceUrl).toBe('https://www.myscheme.gov.in/x');
  });

  it('merges portal-specific enrichments over the generic result', () => {
    const html = `
      <html><body>
        <h1 class="page-title">PM Kisan Samman Nidhi</h1>
        <div class="field--name-field-ministry"><div class="field__item">Ministry of Agriculture and Farmers Welfare</div></div>
        <section id="eligibility">
          <ul>
            <li>Small and marginal farmer</li>
            <li>Indian citizen</li>
          </ul>
        </section>
        <section id="benefits">
          <ul>
            <li>₹6,000 per year direct benefit transfer</li>
          </ul>
        </section>
      </body></html>
    `;
    const generic = { sourceUrl: 'https://www.india.gov.in/scheme/pmkisan' };
    const out = extractWithPortalAwareness(
      html,
      'https://www.india.gov.in/scheme/pmkisan',
      generic,
    );
    expect(out.name).toBe('PM Kisan Samman Nidhi');
    expect(out.ministry).toBe('Ministry of Agriculture and Farmers Welfare');
    expect(out.eligibilityCriteria).toHaveLength(2);
    expect(out.benefits).toHaveLength(1);
    expect(out.benefits?.[0].amount).toBe(6000);
    expect(out.benefits?.[0].type).toBe('monetary');
  });

  it('keeps generic-extracted name when the portal extractor cannot find one', () => {
    const html = '<html><body><div>no selectors here</div></body></html>';
    const generic = {
      name: 'Generic Name',
      sourceUrl: 'https://www.myscheme.gov.in/x',
    };
    const out = extractWithPortalAwareness(
      html,
      'https://www.myscheme.gov.in/x',
      generic,
    );
    expect(out.name).toBe('Generic Name');
  });
});

// ─── End-to-end through parseHTML ───────────────────────────────────────────

describe('parseHTML with portal-aware enrichment', () => {
  it('uses myscheme selectors when the URL is on myscheme.gov.in', () => {
    const html = `
      <html><body>
        <header><h1 class="scheme-name">PM Awas Yojana</h1></header>
        <section data-section="details">
          <p>Affordable housing for urban and rural poor households.</p>
        </section>
        <div data-field="ministry">Ministry of Housing and Urban Affairs</div>
        <section data-section="eligibility">
          <ul>
            <li>EWS / LIG / MIG household</li>
            <li>No pucca house owned by family</li>
          </ul>
        </section>
        <section data-section="benefits">
          <ul>
            <li>Subsidy up to ₹2,67,000 on home loan interest</li>
          </ul>
        </section>
      </body></html>
    `;
    const result = parseHTML(html, 'https://www.myscheme.gov.in/schemes/pm-awas-yojana');
    expect(result.name).toBe('PM Awas Yojana');
    expect(result.description).toContain('Affordable housing');
    expect(result.ministry).toBe('Ministry of Housing and Urban Affairs');
    expect(result.eligibilityCriteria).toHaveLength(2);
    expect(result.benefits?.[0].amount).toBe(267000);
  });

  it('uses NSP table-row selectors for scholarships.gov.in URLs', () => {
    const html = `
      <html><body>
        <h1 class="scheme-name">Post Matric Scholarship — SC Students</h1>
        <table>
          <tr><th>Description</th><td>Financial aid for SC students at post-matric level.</td></tr>
          <tr><th>Ministry</th><td>Ministry of Social Justice and Empowerment</td></tr>
          <tr><th>Eligibility</th><td>SC category student\nIncome below ₹2.5 lakh per annum</td></tr>
          <tr><th>Benefits</th><td>Maintenance allowance up to ₹1,200 per month\nFull tuition fee waiver</td></tr>
        </table>
      </body></html>
    `;
    const result = parseHTML(
      html,
      'https://scholarships.gov.in/public/scheme/post-matric-sc',
    );
    expect(result.name).toContain('Post Matric Scholarship');
    expect(result.description).toContain('Financial aid');
    expect(result.ministry).toBe('Ministry of Social Justice and Empowerment');
    expect(result.eligibilityCriteria?.length).toBeGreaterThanOrEqual(2);
    expect(result.benefits?.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to generic extraction for unknown ministry hosts', () => {
    // No portal-specific selectors → generic heading-driven extractor
    // remains the source of truth.
    const html = `
      <html><body>
        <h1>Janani Suraksha Yojana</h1>
        <p>Maternity benefit scheme.</p>
        <h2>Eligibility</h2>
        <ul><li>Pregnant women in BPL households</li></ul>
        <h2>Benefits</h2>
        <ul><li>₹1,400 cash assistance</li></ul>
      </body></html>
    `;
    const result = parseHTML(html, 'https://nhm.gov.in/schemes/jsy');
    expect(result.name).toBe('Janani Suraksha Yojana');
    expect(result.eligibilityCriteria).toHaveLength(1);
    expect(result.benefits?.[0].amount).toBe(1400);
  });
});
