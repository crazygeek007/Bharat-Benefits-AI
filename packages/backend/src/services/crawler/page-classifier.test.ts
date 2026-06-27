/**
 * Unit tests for the page classifier.
 *
 * Two stages tested in isolation, then the chained classifier as an
 * integration smoke test. Per-portal patterns get explicit coverage so
 * a future maintainer who tweaks `URL_PATTERN_RULES` sees immediately
 * which seed portals their change might affect.
 */

import { describe, expect, it } from 'vitest';
import {
  ChainedClassifier,
  HtmlSignalsClassifier,
  UrlPatternClassifier,
  createDefaultClassifier,
  type PageType,
} from './page-classifier';

// ─── UrlPatternClassifier ────────────────────────────────────────────────────

describe('UrlPatternClassifier', () => {
  const classifier = new UrlPatternClassifier();

  function expectClass(url: string, type: PageType) {
    const result = classifier.classify(url);
    expect(result.type).toBe(type);
  }

  it('returns ignore for empty / malformed / non-http URLs', () => {
    expect(classifier.classify('').type).toBe('ignore');
    expect(classifier.classify('not-a-url').type).toBe('ignore');
    expect(classifier.classify('javascript:void(0)').type).toBe('ignore');
    expect(classifier.classify('ftp://gov.in/x').type).toBe('ignore');
  });

  it('classifies boilerplate paths as ignore on any host', () => {
    expectClass('https://india.gov.in/about', 'ignore');
    expectClass('https://india.gov.in/contact', 'ignore');
    expectClass('https://india.gov.in/privacy', 'ignore');
    expectClass('https://india.gov.in/accessibility', 'ignore');
    expectClass('https://india.gov.in/sitemap', 'ignore');
    expectClass('https://india.gov.in/feedback', 'ignore');
    expectClass('https://india.gov.in/help/faq', 'ignore');
  });

  it('classifies non-document assets as ignore', () => {
    expectClass('https://india.gov.in/logo.png', 'ignore');
    expectClass('https://india.gov.in/styles.css', 'ignore');
    expectClass('https://india.gov.in/build.js', 'ignore');
    expectClass('https://india.gov.in/archive.zip', 'ignore');
  });

  it('treats PDFs and docs as unknown so downstream parser decides', () => {
    expect(classifier.classify('https://india.gov.in/scheme-2024.pdf').type).toBe('unknown');
    expect(classifier.classify('https://india.gov.in/notification.docx').type).toBe('unknown');
  });

  describe('myscheme.gov.in', () => {
    it('classifies /schemes/{slug} as scheme', () => {
      expectClass('https://www.myscheme.gov.in/schemes/pm-kisan', 'scheme');
      expectClass('https://myscheme.gov.in/schemes/scholarships-1', 'scheme');
      expectClass('https://myscheme.gov.in/schemes/abc/details', 'scheme');
    });

    it('classifies search / find-scheme / category as listing', () => {
      expectClass('https://www.myscheme.gov.in/search', 'listing');
      expectClass('https://www.myscheme.gov.in/find-scheme', 'listing');
      expectClass('https://www.myscheme.gov.in/category/employment', 'listing');
      expectClass('https://www.myscheme.gov.in/state/karnataka', 'listing');
    });
  });

  describe('india.gov.in', () => {
    it('classifies the spotlight listing index', () => {
      expectClass('https://www.india.gov.in/spotlight/schemes', 'listing');
      expectClass('https://india.gov.in/my-government/schemes', 'listing');
    });

    it('classifies content / spotlight-detail / scheme paths as scheme', () => {
      expectClass('https://www.india.gov.in/content/pm-awas', 'scheme');
      expectClass('https://india.gov.in/spotlight-detail/pmjjby', 'scheme');
    });

    it('classifies /services/details/<slug> as scheme (added Jun 27 after link-graph evidence)', () => {
      // Real URLs harvested from a live discovery run.
      expectClass(
        'https://www.india.gov.in/services/details/online-textbooks-of-national-council-of-educational-research-and-training',
        'scheme',
      );
      expectClass(
        'https://www.india.gov.in/services/details/national-career-service-for-job-seekers-and-employers',
        'scheme',
      );
    });

    it('classifies bare /services as a listing index', () => {
      expectClass('https://www.india.gov.in/services', 'listing');
      expectClass('https://www.india.gov.in/services/', 'listing');
    });
  });

  describe('scholarships.gov.in', () => {
    it('classifies public listings', () => {
      expectClass('https://scholarships.gov.in/public/list', 'listing');
      expectClass('https://scholarships.gov.in/state-schemes', 'listing');
    });

    it('classifies individual scheme paths', () => {
      expectClass('https://scholarships.gov.in/scheme/post-matric', 'scheme');
      expectClass('https://scholarships.gov.in/public/scheme/abc', 'scheme');
    });
  });

  describe('services.india.gov.in', () => {
    it('classifies /service/{slug} as scheme', () => {
      expectClass('https://services.india.gov.in/service/pds', 'scheme');
    });

    it('classifies category / browse / search as listing', () => {
      expectClass('https://services.india.gov.in/category/health', 'listing');
      expectClass('https://services.india.gov.in/browse', 'listing');
    });
  });

  describe('igod.gov.in', () => {
    it('classifies catalogue / dataset listings', () => {
      expectClass('https://igod.gov.in/dataset', 'listing');
      expectClass('https://igod.gov.in/catalogue', 'listing');
    });

    it('classifies navigation hubs (sector / leg / jud / organization) as listings', () => {
      // Real URLs harvested from a live discovery run on Jun 27.
      expectClass(
        'https://igod.gov.in/sector/GRNsIHQBsvhI6u6Q3tju/organizations',
        'listing',
      );
      expectClass('https://igod.gov.in/leg/categories', 'listing');
      expectClass('https://igod.gov.in/jud/categories', 'listing');
      expectClass('https://igod.gov.in/organization/new_additions', 'listing');
    });
  });

  it('classifies host-root pages as listings (homepages are entry points, not schemes)', () => {
    // Bare host with no path → homepage listing
    expectClass('https://somedept.gov.in/', 'listing');
    expectClass('https://somedept.gov.in/index.html', 'listing');
    expectClass('https://somedept.gov.in/home', 'listing');
    expectClass('https://somedept.gov.in/portal', 'listing');
  });

  it('returns unknown when no rule matches', () => {
    expect(classifier.classify('https://random.gov.in/some/page').type).toBe('unknown');
  });
});

// ─── HtmlSignalsClassifier ──────────────────────────────────────────────────

describe('HtmlSignalsClassifier', () => {
  const classifier = new HtmlSignalsClassifier();

  it('returns unknown when no HTML is supplied', () => {
    expect(classifier.classify('https://x.gov.in/y').type).toBe('unknown');
  });

  it('classifies a scheme-like page with multiple keyword hits', () => {
    const html = `
      <html><body>
        <h1>PM Kisan Samman Nidhi</h1>
        <h2>Eligibility</h2>
        <p>Small and marginal farmers.</p>
        <h2>Benefits</h2>
        <p>Rs. 6,000 per year.</p>
        <h2>How to apply</h2>
        <p>Documents required: Aadhaar, land record. Deadline: 31 March.</p>
      </body></html>
    `;
    const result = classifier.classify('https://x.gov.in/scheme', html);
    expect(result.type).toBe('scheme');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('classifies a high-link-density page with no scheme keywords as listing', () => {
    const links = Array.from({ length: 40 }, (_, i) => `<a href="/p/${i}">Link ${i}</a>`).join('\n');
    const html = `
      <html><body>
        <h1>All Schemes</h1>
        ${links}
      </body></html>
    `;
    const result = classifier.classify('https://x.gov.in/listing', html);
    expect(result.type).toBe('listing');
  });

  it('falls back to unknown for sparse pages without strong signals', () => {
    const html = `
      <html><body>
        <h1>Welcome</h1>
        <p>Some generic text.</p>
        <a href="/one">one</a>
      </body></html>
    `;
    expect(classifier.classify('https://x.gov.in/y', html).type).toBe('unknown');
  });
});

// ─── ChainedClassifier ──────────────────────────────────────────────────────

describe('ChainedClassifier', () => {
  const classifier = new ChainedClassifier();

  it('uses the URL stage when it produces a confident answer', () => {
    expect(classifier.classify('https://myscheme.gov.in/schemes/pm-kisan').type).toBe('scheme');
    // HTML stage is never consulted because URL stage already returned scheme.
    expect(
      classifier.classify('https://www.india.gov.in/spotlight/schemes', '<html></html>').type,
    ).toBe('listing');
  });

  it('falls through to HTML signals when URL stage returns unknown', () => {
    const url = 'https://random.gov.in/some/page';
    expect(classifier.classify(url).type).toBe('unknown');
    const html = `
      <html><body>
        <h2>Eligibility</h2>
        <p>Open to all.</p>
        <h2>Benefits</h2>
        <p>Free service.</p>
        <h2>How to apply</h2>
        <p>Visit office.</p>
      </body></html>
    `;
    expect(classifier.classify(url, html).type).toBe('scheme');
  });

  it('createDefaultClassifier returns a working chain', () => {
    const c = createDefaultClassifier();
    expect(c.classify('https://www.myscheme.gov.in/schemes/x').type).toBe('scheme');
  });
});
