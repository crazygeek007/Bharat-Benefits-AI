/**
 * Unit tests for the link extractor.
 *
 * Covers the contract the discovery crawler relies on: absolute URL
 * resolution, scheme filtering, fragment stripping, and dedup. The
 * domain allow-list and page classification are tested separately
 * because they're separate concerns by design.
 */

import { describe, expect, it } from 'vitest';
import { extractLinks, extractLinksWithText } from './link-extractor';

const BASE = 'https://example.gov.in/schemes/index';

describe('extractLinks', () => {
  it('returns [] for empty / malformed inputs', () => {
    expect(extractLinks('', '<html></html>')).toEqual([]);
    expect(extractLinks(BASE, '')).toEqual([]);
    expect(extractLinks('not a url', '<a href="/x">x</a>')).toEqual([]);
  });

  it('resolves relative paths against the base URL', () => {
    const html = `
      <a href="/a">A</a>
      <a href="./b">B</a>
      <a href="../c">C</a>
    `;
    expect(extractLinks(BASE, html)).toEqual([
      'https://example.gov.in/a',
      'https://example.gov.in/schemes/b',
      'https://example.gov.in/c',
    ]);
  });

  it('preserves absolute URLs verbatim (minus the fragment)', () => {
    const html = `
      <a href="https://other.gov.in/x">x</a>
      <a href="https://example.gov.in/y#section">y</a>
    `;
    expect(extractLinks(BASE, html)).toEqual([
      'https://other.gov.in/x',
      'https://example.gov.in/y',
    ]);
  });

  it('drops non-HTTP(S) schemes', () => {
    const html = `
      <a href="mailto:a@x">m</a>
      <a href="tel:+91999">t</a>
      <a href="javascript:void(0)">j</a>
      <a href="data:text/plain,hi">d</a>
      <a href="ftp://example.gov.in/x">f</a>
      <a href="/keep">keep</a>
    `;
    expect(extractLinks(BASE, html)).toEqual(['https://example.gov.in/keep']);
  });

  it('drops anchor-only fragments', () => {
    const html = `
      <a href="#section">jump</a>
      <a href="">empty</a>
      <a href="   ">whitespace</a>
    `;
    expect(extractLinks(BASE, html)).toEqual([]);
  });

  it('dedupes within a single page', () => {
    const html = `
      <a href="/same">A</a>
      <a href="/same">A again</a>
      <a href="https://example.gov.in/same">absolute form</a>
    `;
    expect(extractLinks(BASE, html)).toEqual(['https://example.gov.in/same']);
  });

  it('preserves document-order for distinct links', () => {
    const html = `
      <a href="/c">C</a>
      <a href="/a">A</a>
      <a href="/b">B</a>
    `;
    expect(extractLinks(BASE, html)).toEqual([
      'https://example.gov.in/c',
      'https://example.gov.in/a',
      'https://example.gov.in/b',
    ]);
  });

  it('survives malformed href attributes', () => {
    const html = `
      <a href=":::bad">x</a>
      <a href=" / ">spaces</a>
      <a>no href</a>
      <a href="/ok">ok</a>
    `;
    const result = extractLinks(BASE, html);
    expect(result).toContain('https://example.gov.in/ok');
    // ":::bad" parses to scheme-less garbage; bail rather than crashing.
    expect(result.every((u) => u.startsWith('https://'))).toBe(true);
  });
});

describe('extractLinksWithText', () => {
  it('returns the anchor text alongside each URL', () => {
    const html = `
      <a href="/a">Apply for PM Kisan</a>
      <a href="/b">  Eligibility  </a>
    `;
    expect(extractLinksWithText(BASE, html)).toEqual([
      { url: 'https://example.gov.in/a', text: 'Apply for PM Kisan' },
      { url: 'https://example.gov.in/b', text: 'Eligibility' },
    ]);
  });

  it('strips inner whitespace runs from anchor text', () => {
    const html = `<a href="/x">Click\n  here\t to apply</a>`;
    expect(extractLinksWithText(BASE, html)).toEqual([
      { url: 'https://example.gov.in/x', text: 'Click here to apply' },
    ]);
  });
});
