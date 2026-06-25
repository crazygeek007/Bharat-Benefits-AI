/**
 * Unit tests for the discovery orchestrator.
 *
 * Uses an in-memory fake fetcher, a stub classifier, and a fake
 * scheme processor so the loop logic is exercised end-to-end without
 * any HTTP or DB work. Every test pins one of the discovery contract
 * guarantees: seed validation, classifier dispatch, link harvesting,
 * domain gate on outbound links, frontier dedup, error isolation.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DiscoveryOrchestrator,
  type DiscoveryFetcher,
  type DomainValidator,
} from './discovery-orchestrator';
import type { ClassificationResult, PageClassifier, PageType } from './page-classifier';

// ─── Test doubles ────────────────────────────────────────────────────────────

function makeFakeFetcher(pages: Record<string, string>): DiscoveryFetcher {
  return {
    async fetch(url) {
      const html = pages[url];
      if (typeof html !== 'string') {
        throw new Error(`No fake page for ${url}`);
      }
      return { html, finalUrl: url };
    },
  };
}

function makeStaticClassifier(
  lookup: (url: string) => ClassificationResult,
): PageClassifier {
  return { classify: (url) => lookup(url) };
}

function alwaysAllowDomain(): DomainValidator {
  return () => true;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DiscoveryOrchestrator.run', () => {
  it('hands scheme-classified seeds straight to the processor without fetching', async () => {
    const processed: string[] = [];
    const fetcher = makeFakeFetcher({}); // no pages — fetcher must not be called
    const classifier = makeStaticClassifier(() => ({
      type: 'scheme',
      reason: 'pattern',
      confidence: 0.95,
    }));

    const orchestrator = new DiscoveryOrchestrator({
      fetcher,
      classifier,
      validateDomain: alwaysAllowDomain(),
      schemeProcessor: async (url) => {
        processed.push(url);
      },
    });

    const result = await orchestrator.run(['https://x.gov.in/scheme-a']);
    expect(processed).toEqual(['https://x.gov.in/scheme-a']);
    expect(result.schemesDiscovered).toBe(1);
    expect(result.pagesCrawled).toBe(1);
  });

  it('traverses a listing page and enqueues child links for re-classification', async () => {
    const pages: Record<string, string> = {
      'https://x.gov.in/listing': `
        <a href="/scheme-a">A</a>
        <a href="/scheme-b">B</a>
      `,
    };
    const processed: string[] = [];

    const classifier: PageClassifier = {
      classify(url) {
        if (url === 'https://x.gov.in/listing') {
          return { type: 'listing', reason: 'seed', confidence: 0.9 };
        }
        return { type: 'scheme', reason: 'child', confidence: 0.95 };
      },
    };

    const orchestrator = new DiscoveryOrchestrator({
      fetcher: makeFakeFetcher(pages),
      classifier,
      validateDomain: alwaysAllowDomain(),
      schemeProcessor: async (url) => {
        processed.push(url);
      },
    });

    const result = await orchestrator.run(['https://x.gov.in/listing']);
    expect(processed.sort()).toEqual([
      'https://x.gov.in/scheme-a',
      'https://x.gov.in/scheme-b',
    ]);
    expect(result.listingsTraversed).toBe(1);
    expect(result.schemesDiscovered).toBe(2);
  });

  it('rejects discovered URLs that fail the domain gate', async () => {
    const pages: Record<string, string> = {
      'https://x.gov.in/listing': `
        <a href="https://x.gov.in/inside">inside</a>
        <a href="https://malicious.com/outside">outside</a>
      `,
      'https://x.gov.in/inside': '<html></html>',
    };

    let classifyCalls = 0;
    const classifier: PageClassifier = {
      classify(url) {
        classifyCalls++;
        if (url === 'https://x.gov.in/listing') {
          return { type: 'listing', reason: 'seed', confidence: 0.9 };
        }
        return { type: 'scheme', reason: 'inside', confidence: 0.95 };
      },
    };

    const validate: DomainValidator = (url) =>
      new URL(url).hostname.endsWith('gov.in');

    const orchestrator = new DiscoveryOrchestrator({
      fetcher: makeFakeFetcher(pages),
      classifier,
      validateDomain: validate,
      schemeProcessor: async () => undefined,
    });

    const result = await orchestrator.run(['https://x.gov.in/listing']);
    expect(result.rejectedByDomain).toBe(1);
    expect(result.schemesDiscovered).toBe(1);
    // Listing URL is classified twice (pre-fetch URL stage + post-fetch
    // URL+HTML stage). The inside URL is classified once (URL stage
    // returns a confident 'scheme' so no fetch happens). The malicious
    // URL never enters the frontier, so the classifier never sees it.
    expect(classifyCalls).toBe(3);
  });

  it('drops URLs classified as ignore without fetching', async () => {
    const fetcher = makeFakeFetcher({});
    const classifier = makeStaticClassifier(() => ({
      type: 'ignore' as PageType,
      reason: 'boilerplate',
      confidence: 0.99,
    }));

    const processed: string[] = [];
    const orchestrator = new DiscoveryOrchestrator({
      fetcher,
      classifier,
      validateDomain: alwaysAllowDomain(),
      schemeProcessor: async (url) => {
        processed.push(url);
      },
    });

    const result = await orchestrator.run(['https://x.gov.in/about']);
    expect(processed).toEqual([]);
    expect(result.ignored).toBe(1);
    expect(result.pagesCrawled).toBe(0);
  });

  it('isolates errors so a single failure does not abort the run', async () => {
    const pages: Record<string, string> = {
      'https://x.gov.in/listing': '<a href="/a">A</a><a href="/b">B</a>',
    };
    const classifier: PageClassifier = {
      classify(url) {
        if (url === 'https://x.gov.in/listing') {
          return { type: 'listing', reason: 'seed', confidence: 0.9 };
        }
        return { type: 'scheme', reason: 'child', confidence: 0.95 };
      },
    };

    const processed: string[] = [];
    const orchestrator = new DiscoveryOrchestrator({
      fetcher: makeFakeFetcher(pages),
      classifier,
      validateDomain: alwaysAllowDomain(),
      schemeProcessor: async (url) => {
        if (url === 'https://x.gov.in/a') throw new Error('boom');
        processed.push(url);
      },
    });

    const result = await orchestrator.run(['https://x.gov.in/listing']);
    expect(processed).toEqual(['https://x.gov.in/b']);
    expect(result.failures).toBe(1);
    expect(result.schemesDiscovered).toBe(1);
  });

  it('falls through to HTML signals when the URL stage is unknown', async () => {
    const pages: Record<string, string> = {
      'https://x.gov.in/?id=1': '<html><body><h2>Eligibility</h2><h2>Benefits</h2><h2>How to apply</h2></body></html>',
    };

    // URL stage returns unknown; HTML stage will decide.
    const urlStage = vi.fn().mockReturnValue({
      type: 'unknown',
      reason: 'no-pattern',
      confidence: 0,
    });
    // The orchestrator calls classifier.classify twice per URL: once
    // pre-fetch (URL only), once post-fetch (URL + HTML). We mark the
    // post-fetch verdict as scheme.
    let nthCall = 0;
    const classifier: PageClassifier = {
      classify(url, html) {
        nthCall++;
        if (typeof html === 'string' && html.length > 0) {
          return { type: 'scheme', reason: 'html-keywords', confidence: 0.8 };
        }
        return urlStage(url) as ClassificationResult;
      },
    };

    const processed: string[] = [];
    const orchestrator = new DiscoveryOrchestrator({
      fetcher: makeFakeFetcher(pages),
      classifier,
      validateDomain: alwaysAllowDomain(),
      schemeProcessor: async (url) => {
        processed.push(url);
      },
    });

    const result = await orchestrator.run(['https://x.gov.in/?id=1']);
    expect(processed).toEqual(['https://x.gov.in/?id=1']);
    expect(result.schemesDiscovered).toBe(1);
    // URL stage called once, HTML stage called once.
    expect(nthCall).toBe(2);
  });

  it('respects depth limit by not enqueueing children past max depth', async () => {
    const pages: Record<string, string> = {
      'https://x.gov.in/L0': '<a href="/L1">L1</a>',
      'https://x.gov.in/L1': '<a href="/L2">L2</a>',
      'https://x.gov.in/L2': '<a href="/L3">L3</a>',
    };
    const classifier: PageClassifier = {
      classify(url) {
        // All pages are listings — depth limit must stop the cascade.
        if (url.includes('/L')) {
          return { type: 'listing', reason: 'all-listing', confidence: 0.9 };
        }
        return { type: 'unknown', reason: '', confidence: 0 };
      },
    };

    const orchestrator = new DiscoveryOrchestrator(
      {
        fetcher: makeFakeFetcher(pages),
        classifier,
        validateDomain: alwaysAllowDomain(),
        schemeProcessor: async () => undefined,
      },
      { maxDepth: 1 },
    );

    const result = await orchestrator.run(['https://x.gov.in/L0']);
    // Seed (L0, depth 0) + its child (L1, depth 1) get fetched. L2
    // would be depth 2 which exceeds maxDepth=1.
    expect(result.listingsTraversed).toBe(2);
    expect(result.frontier.rejectedDepthExceeded).toBeGreaterThan(0);
  });
});
