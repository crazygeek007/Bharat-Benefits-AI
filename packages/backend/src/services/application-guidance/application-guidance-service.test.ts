/**
 * Unit tests for ApplicationGuidanceService.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5.
 *
 * Covers:
 *   - normalizeApplicationMode handles the three modes plus unknown input.
 *   - normalizeApplicationSteps re-numbers steps and drops empty entries.
 *   - extractCommonMistakesFromDescription parses bulleted/labelled blocks.
 *   - extractOfficeAddresses parses labelled office sections and
 *     "Office: …" / "Address: …" lines.
 *   - getCategoryFallbackMistakes returns ≥3 entries for every supported
 *     SchemeCategory (Req 9.3).
 *   - buildCommonMistakes always returns ≥3 entries, dedupes case- and
 *     whitespace-insensitively, and prefers scheme-specific entries.
 *   - getGuidance shapes the response from a fake Prisma row, drives the
 *     stub HTTP probe, and obeys the probePortal=false override.
 *   - getGuidance returns officeAddresses=null for online schemes and an
 *     array for offline/hybrid schemes.
 *   - getGuidance throws SchemeNotFoundError when the row is missing.
 *   - checkPortalAccessible delegates to the injected probe and validates
 *     timeoutMs (Req 9.5).
 */

import { describe, it, expect, vi } from 'vitest';
import type { SchemeCategory } from '@bharat-benefits/shared';
import {
  ApplicationGuidanceService,
  DEFAULT_PORTAL_PROBE_TIMEOUT_MS,
  MIN_COMMON_MISTAKES,
  SchemeNotFoundError,
  buildCommonMistakes,
  extractCommonMistakesFromDescription,
  extractOfficeAddresses,
  getCategoryFallbackMistakes,
  normalizeApplicationMode,
  normalizeApplicationSteps,
  type ApplicationGuidancePrisma,
  type HttpProbe,
  type SchemeRow,
} from './application-guidance-service';

// ─── Test helpers ────────────────────────────────────────────────────────────

function row(overrides: Partial<SchemeRow> = {}): SchemeRow {
  // Spread last so explicit `null` overrides win over the defaults — using
  // `??` here would coerce a deliberate `null` (e.g. for offline schemes
  // with no portal URL) back to the default value.
  return {
    id: 'scheme-1',
    name: 'Test Scheme',
    description: null,
    category: 'Agriculture',
    applicationMode: 'online',
    applicationUrl: 'https://portal.gov.in/apply',
    applicationSteps: null,
    sourceUrl: 'https://example.gov.in/scheme-1',
    ...overrides,
  };
}

function fakeDb(
  rowsById: Record<string, SchemeRow | null> = {},
): ApplicationGuidancePrisma {
  return {
    scheme: {
      async findUnique({ where }) {
        return rowsById[where.id] ?? null;
      },
    },
  };
}

function stubProbe(
  responder:
    | boolean
    | ((url: string, timeoutMs: number) => Promise<boolean> | boolean),
): HttpProbe & { calls: Array<{ url: string; timeoutMs: number }> } {
  const calls: Array<{ url: string; timeoutMs: number }> = [];
  const probe: HttpProbe & { calls: typeof calls } = {
    calls,
    async probe(url, timeoutMs) {
      calls.push({ url, timeoutMs });
      if (typeof responder === 'function') {
        return await responder(url, timeoutMs);
      }
      return responder;
    },
  };
  return probe;
}

// ─── normalizeApplicationMode ────────────────────────────────────────────────

describe('normalizeApplicationMode', () => {
  it('returns online/offline/hybrid for the three canonical values', () => {
    expect(normalizeApplicationMode('online')).toBe('online');
    expect(normalizeApplicationMode('offline')).toBe('offline');
    expect(normalizeApplicationMode('hybrid')).toBe('hybrid');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(normalizeApplicationMode('  Offline ')).toBe('offline');
    expect(normalizeApplicationMode('HYBRID')).toBe('hybrid');
  });

  it('defaults to online for null / undefined / unknown values', () => {
    expect(normalizeApplicationMode(null)).toBe('online');
    expect(normalizeApplicationMode(undefined)).toBe('online');
    expect(normalizeApplicationMode('')).toBe('online');
    expect(normalizeApplicationMode('postal')).toBe('online');
  });
});

// ─── normalizeApplicationSteps ───────────────────────────────────────────────

describe('normalizeApplicationSteps', () => {
  it('returns an empty array when the value is not an array', () => {
    expect(normalizeApplicationSteps(null)).toEqual([]);
    expect(normalizeApplicationSteps(undefined)).toEqual([]);
    expect(normalizeApplicationSteps('not an array')).toEqual([]);
    expect(normalizeApplicationSteps({ action: 'x' })).toEqual([]);
  });

  it('renumbers steps starting at 1 (Req 9.1)', () => {
    const out = normalizeApplicationSteps([
      { stepNumber: 7, action: 'Visit portal', expectedOutcome: 'Login page' },
      { stepNumber: 99, action: 'Fill form', expectedOutcome: 'Form submitted' },
    ]);

    expect(out).toEqual([
      { stepNumber: 1, action: 'Visit portal', expectedOutcome: 'Login page' },
      { stepNumber: 2, action: 'Fill form', expectedOutcome: 'Form submitted' },
    ]);
  });

  it('drops entries with missing or whitespace-only action', () => {
    const out = normalizeApplicationSteps([
      { action: '   ', expectedOutcome: 'x' },
      { action: 'Real step', expectedOutcome: 'OK' },
      { stepNumber: 3 }, // no action
      null,
      'string entry',
    ]);

    expect(out).toEqual([
      { stepNumber: 1, action: 'Real step', expectedOutcome: 'OK' },
    ]);
  });

  it('substitutes empty string when expectedOutcome is missing', () => {
    const out = normalizeApplicationSteps([{ action: 'Step 1' }]);
    expect(out[0]?.expectedOutcome).toBe('');
  });
});

// ─── extractCommonMistakesFromDescription ────────────────────────────────────

describe('extractCommonMistakesFromDescription', () => {
  it('returns [] when no labelled section is present', () => {
    expect(extractCommonMistakesFromDescription(null)).toEqual([]);
    expect(extractCommonMistakesFromDescription('')).toEqual([]);
    expect(
      extractCommonMistakesFromDescription('A general scheme description.'),
    ).toEqual([]);
  });

  it('extracts a "Common Mistakes:" bulleted section', () => {
    const desc = [
      'About the scheme.',
      '',
      'Common Mistakes:',
      '- Forgetting Aadhaar',
      '- Wrong bank account',
      '* Missing the deadline',
      '',
      'Other Section:',
      'Other content.',
    ].join('\n');

    expect(extractCommonMistakesFromDescription(desc)).toEqual([
      'Forgetting Aadhaar',
      'Wrong bank account',
      'Missing the deadline',
    ]);
  });

  it('extracts a numbered "Mistakes to Avoid:" section', () => {
    const desc = [
      'Mistakes to Avoid:',
      '1. First mistake',
      '2) Second mistake',
      '3. Third mistake',
    ].join('\n');

    expect(extractCommonMistakesFromDescription(desc)).toEqual([
      'First mistake',
      'Second mistake',
      'Third mistake',
    ]);
  });

  it('is case-insensitive on the heading', () => {
    const desc = ['common mistakes:', '- Lowercase mistake heading'].join('\n');
    expect(extractCommonMistakesFromDescription(desc)).toEqual([
      'Lowercase mistake heading',
    ]);
  });
});

// ─── extractOfficeAddresses ──────────────────────────────────────────────────

describe('extractOfficeAddresses', () => {
  it('returns [] for missing / empty description', () => {
    expect(extractOfficeAddresses(null)).toEqual([]);
    expect(extractOfficeAddresses('')).toEqual([]);
  });

  it('extracts a labelled "Office Address:" bulleted block', () => {
    const desc = [
      'Apply offline at the following:',
      '',
      'Office Addresses:',
      '- Block Development Office, Pune, MH',
      '- Tehsildar Office, Nashik, MH',
      '',
      'Documents:',
      '- Aadhaar',
    ].join('\n');

    expect(extractOfficeAddresses(desc)).toEqual([
      'Block Development Office, Pune, MH',
      'Tehsildar Office, Nashik, MH',
    ]);
  });

  it('extracts a "Where to Apply:" section', () => {
    const desc = [
      'Where to Apply:',
      '1. District Collector Office, Bhopal, MP',
      '2. Sub-Divisional Office, Sehore, MP',
    ].join('\n');

    expect(extractOfficeAddresses(desc)).toEqual([
      'District Collector Office, Bhopal, MP',
      'Sub-Divisional Office, Sehore, MP',
    ]);
  });

  it('falls back to lines beginning with "Office:" / "Address:" when no heading is present', () => {
    const desc = [
      'Some prose describing the scheme.',
      'Office: Block Office, Sangli, MH',
      'Address: Tehsildar Office, Pune, MH',
    ].join('\n');

    expect(extractOfficeAddresses(desc)).toEqual([
      'Block Office, Sangli, MH',
      'Tehsildar Office, Pune, MH',
    ]);
  });

  it('returns [] when nothing matches', () => {
    expect(extractOfficeAddresses('No address details published here.')).toEqual(
      [],
    );
  });
});

// ─── getCategoryFallbackMistakes ─────────────────────────────────────────────

describe('getCategoryFallbackMistakes', () => {
  const categories: SchemeCategory[] = [
    'Education',
    'Agriculture',
    'Healthcare',
    'Women',
    'Employment',
    'Skill Development',
    'Housing',
    'Startups',
    'MSME',
    'Pension',
    'Scholarships',
    'Financial Assistance',
  ];

  it.each(categories)(
    'returns at least 3 mistakes for category %s (Req 9.3)',
    (category) => {
      const list = getCategoryFallbackMistakes(category);
      expect(list.length).toBeGreaterThanOrEqual(MIN_COMMON_MISTAKES);
      for (const m of list) {
        expect(m).toBeTypeOf('string');
        expect(m.length).toBeGreaterThan(0);
      }
    },
  );

  it('returns the generic list for null / unknown category', () => {
    const generic = getCategoryFallbackMistakes(null);
    expect(generic.length).toBeGreaterThanOrEqual(MIN_COMMON_MISTAKES);
    expect(getCategoryFallbackMistakes('Not A Real Category')).toEqual(generic);
  });
});

// ─── buildCommonMistakes ─────────────────────────────────────────────────────

describe('buildCommonMistakes', () => {
  it('always returns at least 3 entries (Req 9.3)', () => {
    expect(buildCommonMistakes(null, null).length).toBeGreaterThanOrEqual(
      MIN_COMMON_MISTAKES,
    );
    expect(
      buildCommonMistakes('Some prose without a mistakes section.', 'Agriculture')
        .length,
    ).toBeGreaterThanOrEqual(MIN_COMMON_MISTAKES);
    expect(buildCommonMistakes('', 'NotACategory').length).toBeGreaterThanOrEqual(
      MIN_COMMON_MISTAKES,
    );
  });

  it('places scheme-specific mistakes ahead of category fallbacks', () => {
    const desc = [
      'Common Mistakes:',
      '- Specific mistake A',
      '- Specific mistake B',
      '- Specific mistake C',
    ].join('\n');

    const out = buildCommonMistakes(desc, 'Agriculture');
    expect(out.slice(0, 3)).toEqual([
      'Specific mistake A',
      'Specific mistake B',
      'Specific mistake C',
    ]);
  });

  it('tops up from the category fallback when fewer than 3 scheme-specific mistakes are extracted', () => {
    const desc = ['Common Mistakes:', '- The single specific mistake'].join('\n');

    const out = buildCommonMistakes(desc, 'Agriculture');
    expect(out.length).toBeGreaterThanOrEqual(MIN_COMMON_MISTAKES);
    expect(out[0]).toBe('The single specific mistake');
    // Subsequent entries come from the Agriculture fallback list.
    const agriFallback = getCategoryFallbackMistakes('Agriculture');
    expect(out.slice(1)).toEqual(
      agriFallback.slice(0, MIN_COMMON_MISTAKES - 1),
    );
  });

  it('deduplicates entries case- and whitespace-insensitively', () => {
    const desc = [
      'Common Mistakes:',
      '- Forgetting Aadhaar',
      '- forgetting   aadhaar',
      '- Wrong bank account',
      '- Missing deadline',
    ].join('\n');

    const out = buildCommonMistakes(desc, 'Agriculture');
    // The duplicate "forgetting aadhaar" should not appear twice.
    const lowered = out.map((m) => m.toLowerCase().replace(/\s+/g, ' '));
    const seen = new Set<string>();
    for (const entry of lowered) {
      expect(seen.has(entry)).toBe(false);
      seen.add(entry);
    }
  });
});

// ─── ApplicationGuidanceService.getGuidance ──────────────────────────────────

describe('ApplicationGuidanceService.getGuidance', () => {
  it('throws TypeError on empty schemeId', async () => {
    const svc = new ApplicationGuidanceService(fakeDb(), stubProbe(true));
    await expect(svc.getGuidance('')).rejects.toThrow(TypeError);
  });

  it('throws SchemeNotFoundError when the scheme does not exist', async () => {
    const svc = new ApplicationGuidanceService(fakeDb({}), stubProbe(true));
    await expect(svc.getGuidance('missing')).rejects.toBeInstanceOf(
      SchemeNotFoundError,
    );
  });

  it('returns shaped guidance with steps, mistakes, mode, URL and portal probe (Req 9.1, 9.2, 9.3, 9.4, 9.5)', async () => {
    const desc = [
      'PM-KISAN provides income support to farmers.',
      '',
      'Common Mistakes:',
      '- Wrong land record',
      '- Aadhaar not seeded',
      '- Bank account in spouse name only',
    ].join('\n');

    const r = row({
      id: 'pm-kisan',
      description: desc,
      category: 'Agriculture',
      applicationMode: 'online',
      applicationUrl: 'https://pmkisan.gov.in/apply',
      applicationSteps: [
        { stepNumber: 1, action: 'Visit portal', expectedOutcome: 'Login page' },
        {
          stepNumber: 2,
          action: 'Fill form',
          expectedOutcome: 'Acknowledgement number issued',
        },
      ],
    });
    const probe = stubProbe(true);
    const svc = new ApplicationGuidanceService(fakeDb({ 'pm-kisan': r }), probe);

    const guidance = await svc.getGuidance('pm-kisan');

    expect(guidance.mode).toBe('online');
    expect(guidance.applicationUrl).toBe('https://pmkisan.gov.in/apply');
    expect(guidance.steps).toEqual([
      { stepNumber: 1, action: 'Visit portal', expectedOutcome: 'Login page' },
      {
        stepNumber: 2,
        action: 'Fill form',
        expectedOutcome: 'Acknowledgement number issued',
      },
    ]);
    expect(guidance.commonMistakes.length).toBeGreaterThanOrEqual(
      MIN_COMMON_MISTAKES,
    );
    expect(guidance.commonMistakes.slice(0, 3)).toEqual([
      'Wrong land record',
      'Aadhaar not seeded',
      'Bank account in spouse name only',
    ]);
    expect(guidance.officeAddresses).toBeNull();
    expect(guidance.portalAccessible).toBe(true);
    expect(probe.calls).toEqual([
      { url: 'https://pmkisan.gov.in/apply', timeoutMs: DEFAULT_PORTAL_PROBE_TIMEOUT_MS },
    ]);
  });

  it('returns office addresses for offline schemes (Req 9.4)', async () => {
    const desc = [
      'Apply offline at the local office.',
      '',
      'Office Addresses:',
      '- Block Development Office, Pune, MH',
      '- Tehsildar Office, Nashik, MH',
    ].join('\n');

    const r = row({
      id: 'offline-1',
      description: desc,
      applicationMode: 'offline',
      applicationUrl: null,
    });
    const probe = stubProbe(true);
    const svc = new ApplicationGuidanceService(
      fakeDb({ 'offline-1': r }),
      probe,
    );

    const guidance = await svc.getGuidance('offline-1');

    expect(guidance.mode).toBe('offline');
    expect(guidance.applicationUrl).toBeNull();
    expect(guidance.officeAddresses).toEqual([
      'Block Development Office, Pune, MH',
      'Tehsildar Office, Nashik, MH',
    ]);
    // Probe must NOT be called when there is no application URL.
    expect(probe.calls).toEqual([]);
    expect(guidance.portalAccessible).toBeNull();
  });

  it('returns office addresses for hybrid schemes and probes the portal', async () => {
    const desc = [
      'Apply online or visit:',
      '',
      'Office Addresses:',
      '- District Collector Office, Bhopal, MP',
    ].join('\n');

    const r = row({
      id: 'hybrid-1',
      description: desc,
      applicationMode: 'hybrid',
      applicationUrl: 'https://portal.mp.gov.in/apply',
    });
    const probe = stubProbe(false);
    const svc = new ApplicationGuidanceService(fakeDb({ 'hybrid-1': r }), probe);

    const guidance = await svc.getGuidance('hybrid-1');

    expect(guidance.mode).toBe('hybrid');
    expect(guidance.officeAddresses).toEqual([
      'District Collector Office, Bhopal, MP',
    ]);
    expect(guidance.portalAccessible).toBe(false);
    expect(probe.calls).toHaveLength(1);
  });

  it('returns officeAddresses=null when offline scheme has no parseable office data (Req 9.4 graceful handling)', async () => {
    const r = row({
      id: 'offline-noaddr',
      description: 'Apply offline. No address provided.',
      applicationMode: 'offline',
      applicationUrl: null,
    });
    const svc = new ApplicationGuidanceService(
      fakeDb({ 'offline-noaddr': r }),
      stubProbe(true),
    );

    const guidance = await svc.getGuidance('offline-noaddr');

    expect(guidance.mode).toBe('offline');
    expect(guidance.officeAddresses).toBeNull();
  });

  it('skips the probe when probePortal=false and reports portalAccessible=null', async () => {
    const r = row({ id: 's1' });
    const probe = stubProbe(true);
    const svc = new ApplicationGuidanceService(fakeDb({ s1: r }), probe);

    const guidance = await svc.getGuidance('s1', { probePortal: false });

    expect(guidance.portalAccessible).toBeNull();
    expect(probe.calls).toEqual([]);
  });

  it('respects per-call probeTimeoutMs override', async () => {
    const r = row({ id: 's1' });
    const probe = stubProbe(true);
    const svc = new ApplicationGuidanceService(fakeDb({ s1: r }), probe);

    await svc.getGuidance('s1', { probeTimeoutMs: 5000 });

    expect(probe.calls).toEqual([
      { url: r.applicationUrl, timeoutMs: 5000 },
    ]);
  });

  it('falls back to category mistakes when description has no mistakes section', async () => {
    const r = row({
      id: 's1',
      description: 'A short description with no labelled mistakes.',
      category: 'Healthcare',
    });
    const svc = new ApplicationGuidanceService(
      fakeDb({ s1: r }),
      stubProbe(true),
    );

    const guidance = await svc.getGuidance('s1');

    expect(guidance.commonMistakes.length).toBeGreaterThanOrEqual(
      MIN_COMMON_MISTAKES,
    );
    const expected = getCategoryFallbackMistakes('Healthcare').slice(
      0,
      MIN_COMMON_MISTAKES,
    );
    expect(guidance.commonMistakes.slice(0, MIN_COMMON_MISTAKES)).toEqual(
      expected,
    );
  });

  it('handles a portal probe that throws by surfacing portalAccessible=false', async () => {
    const r = row({ id: 's1' });
    const probe: HttpProbe = {
      probe: vi.fn().mockResolvedValue(false),
    };
    const svc = new ApplicationGuidanceService(fakeDb({ s1: r }), probe);

    const guidance = await svc.getGuidance('s1');

    expect(guidance.portalAccessible).toBe(false);
    expect(probe.probe).toHaveBeenCalledWith(
      r.applicationUrl,
      DEFAULT_PORTAL_PROBE_TIMEOUT_MS,
    );
  });
});

// ─── ApplicationGuidanceService.checkPortalAccessible ────────────────────────

describe('ApplicationGuidanceService.checkPortalAccessible', () => {
  it('delegates to the injected probe and returns its result (Req 9.5)', async () => {
    const probe = stubProbe(true);
    const svc = new ApplicationGuidanceService(fakeDb(), probe);

    expect(
      await svc.checkPortalAccessible('https://portal.gov.in/apply', 1000),
    ).toBe(true);
    expect(probe.calls).toEqual([
      { url: 'https://portal.gov.in/apply', timeoutMs: 1000 },
    ]);
  });

  it('uses the default 30 000 ms timeout when none is supplied (Req 9.5)', async () => {
    const probe = stubProbe(true);
    const svc = new ApplicationGuidanceService(fakeDb(), probe);

    await svc.checkPortalAccessible('https://portal.gov.in/apply');

    expect(probe.calls[0]?.timeoutMs).toBe(DEFAULT_PORTAL_PROBE_TIMEOUT_MS);
  });

  it('returns false when the probe rejects', async () => {
    const probe: HttpProbe = {
      probe: vi.fn().mockResolvedValue(false),
    };
    const svc = new ApplicationGuidanceService(fakeDb(), probe);

    expect(
      await svc.checkPortalAccessible('https://portal.gov.in/apply', 1000),
    ).toBe(false);
  });

  it('rejects non-positive or non-finite timeoutMs', async () => {
    const svc = new ApplicationGuidanceService(fakeDb(), stubProbe(true));

    await expect(
      svc.checkPortalAccessible('https://portal.gov.in/apply', 0),
    ).rejects.toThrow(RangeError);
    await expect(
      svc.checkPortalAccessible('https://portal.gov.in/apply', -1),
    ).rejects.toThrow(RangeError);
    await expect(
      svc.checkPortalAccessible(
        'https://portal.gov.in/apply',
        Number.POSITIVE_INFINITY,
      ),
    ).rejects.toThrow(RangeError);
  });
});
