/**
 * Property-based tests for translation name preservation.
 *
 * **Property 18: Translation Preserves Scheme Names**
 * **Validates: Requirements 12.4**
 *
 * Property statement (from design.md):
 * "For any scheme and any target language, after translation the
 *  official scheme name SHALL remain identical to its original value
 *  (untranslated), while eligibility criteria, benefits, and application
 *  steps are translated into the target language."
 *
 * Strategy
 * --------
 * The property has two halves and we exercise both with a single
 * generator over `(scheme, targetLanguage)` pairs:
 *
 *   1.  Identifier preservation. After `translateScheme`, the scheme's
 *       official `name` must equal the source `name` byte-for-byte. The
 *       same is required for the other non-translatable identifying
 *       fields the policy lists (`id`, `ministry`, `sourceUrl`,
 *       `applicationUrl`, `category`, `state`, `benefitType`,
 *       `benefitAmount`, `applicationMode`, `deadline`, `trustScore`,
 *       `verified`, `discoveredAt`, `lastVerifiedAt`, `updatedAt`).
 *
 *   2.  Translatable-field pass-through. Every user-facing string
 *       (description, eligibilityCriteria[i].description,
 *       benefits[i].description, applicationSteps[i].action,
 *       applicationSteps[i].expectedOutcome) is handed to the configured
 *       translator and the translator's result is what surfaces in the
 *       translated scheme. We verify this with a *tagging* translator
 *       that returns `${lang}::${source}` for every non-empty input, so
 *       the post-translation value is a witness of "the translator was
 *       called with this exact source".
 *
 * Both halves must hold across the full Cartesian product of valid
 * schemes and the six supported locales (`en`, `hi`, `bn`, `ta`, `te`,
 * `mr`). For `en` the service short-circuits, so the pass-through
 * assertion expects the source value verbatim instead of a tagged
 * version.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  ApplicationStep,
  Benefit,
  DocumentRequirement,
  EligibilityCriterion,
  Scheme,
  SchemeCategory,
  SupportedLanguage,
} from '@bharat-benefits/shared';
import {
  TranslationService,
  type Translator,
} from './translation-service';

const NUM_RUNS = 200;

const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  'en',
  'hi',
  'bn',
  'ta',
  'te',
  'mr',
] as const;

// ─── Tagging translator (oracle) ────────────────────────────────────────────

const TAG_DELIM = '::';

/**
 * Translator that returns `${lang}${TAG_DELIM}${source}` for every
 * non-empty source string. The tagged output uniquely identifies both
 * the language the translator was asked for *and* the source string it
 * was handed, giving the tests a witness that the translator was
 * actually invoked on the expected field.
 */
const taggingTranslator: Translator = {
  async translate(text, targetLanguage) {
    if (text.length === 0) return '';
    return `${targetLanguage}${TAG_DELIM}${text}`;
  },
};

/** Expected post-translation value for a single source string. */
function expectedTranslation(
  source: string,
  targetLanguage: SupportedLanguage,
): string {
  if (targetLanguage === 'en') return source;
  if (source.length === 0) return source;
  return `${targetLanguage}${TAG_DELIM}${source}`;
}

// ─── Arbitraries ────────────────────────────────────────────────────────────

const arbLanguage: fc.Arbitrary<SupportedLanguage> =
  fc.constantFrom<SupportedLanguage>(...SUPPORTED_LANGUAGES);

const arbCategory: fc.Arbitrary<SchemeCategory> = fc.constantFrom<SchemeCategory>(
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
);

/**
 * Bounded Date arbitrary in the range ~1970 .. ~2100. Avoids the extreme
 * ends of the JS Date range so equality comparisons in the property are
 * well-defined.
 */
const arbBoundedDate: fc.Arbitrary<Date> = fc
  .integer({ min: 0, max: 4_102_444_800_000 })
  .map((ms) => new Date(ms));

/**
 * `EligibilityCriterion.value` is typed `unknown`. Constrain to a small
 * set of JSON-serialisable primitives — the property does not depend on
 * the concrete value, only that it is preserved.
 */
const arbCriterionValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

const arbCriterion: fc.Arbitrary<EligibilityCriterion> = fc.record({
  field: fc.string(),
  operator: fc.constantFrom<EligibilityCriterion['operator']>(
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'between',
  ),
  value: arbCriterionValue,
  description: fc.string(),
});

const arbBenefit: fc.Arbitrary<Benefit> = fc.record({
  type: fc.constantFrom<Benefit['type']>('monetary', 'non-monetary'),
  amount: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: null }),
  description: fc.string(),
});

const arbApplicationStep: fc.Arbitrary<ApplicationStep> = fc.record({
  stepNumber: fc.integer({ min: 1, max: 20 }),
  action: fc.string(),
  expectedOutcome: fc.string(),
});

const arbDocumentRequirement: fc.Arbitrary<DocumentRequirement> = fc.record({
  documentName: fc.string(),
  description: fc.string(),
  format: fc.string(),
  required: fc.boolean(),
});

/**
 * Arbitrary `Scheme`. Names are deliberately drawn from a small pool of
 * realistic official scheme names so the assertion that names are
 * preserved is meaningful — if the implementation accidentally
 * translated a name, a tagged output would not match any of these.
 */
const arbSchemeName: fc.Arbitrary<string> = fc.constantFrom(
  'Pradhan Mantri Kisan Samman Nidhi',
  'PM Mudra Yojana',
  'Ayushman Bharat',
  'Pradhan Mantri Awas Yojana',
  'Beti Bachao Beti Padhao',
  'Atal Pension Yojana',
  'PM Jan Dhan Yojana',
);

const arbScheme: fc.Arbitrary<Scheme> = fc.record({
  id: fc.uuid(),
  name: arbSchemeName,
  description: fc.string(),
  ministry: fc.string({ minLength: 1 }),
  state: fc.option(fc.string({ minLength: 1 }), { nil: null }),
  category: arbCategory,
  sourceUrl: fc.webUrl(),
  benefitType: fc.constantFrom<Scheme['benefitType']>('monetary', 'non-monetary'),
  benefitAmount: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: null }),
  deadline: fc.option(arbBoundedDate, { nil: null }),
  applicationMode: fc.constantFrom<Scheme['applicationMode']>(
    'online',
    'offline',
    'hybrid',
  ),
  applicationUrl: fc.option(fc.webUrl(), { nil: null }),
  eligibilityCriteria: fc.array(arbCriterion, { maxLength: 4 }),
  benefits: fc.array(arbBenefit, { maxLength: 4 }),
  applicationSteps: fc.option(fc.array(arbApplicationStep, { maxLength: 4 }), {
    nil: null,
  }),
  requiredDocuments: fc.option(fc.array(arbDocumentRequirement, { maxLength: 4 }), {
    nil: null,
  }),
  trustScore: fc.integer({ min: 0, max: 100 }),
  verified: fc.boolean(),
  discoveredAt: arbBoundedDate,
  lastVerifiedAt: arbBoundedDate,
  updatedAt: arbBoundedDate,
});

// ─── Property 18 ────────────────────────────────────────────────────────────

describe('Property 18: Translation Preserves Scheme Names', () => {
  // ── Validates: Requirements 12.4 ──

  it('preserves the official scheme name verbatim for any scheme and any target language', async () => {
    const service = new TranslationService({ translator: taggingTranslator });

    await fc.assert(
      fc.asyncProperty(arbScheme, arbLanguage, async (scheme, lang) => {
        const translated = await service.translateScheme(scheme, lang);
        // Core invariant: name is identical to the source even when the
        // translator has a translation registered for it.
        expect(translated.name).toBe(scheme.name);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('preserves identifying / structural fields untranslated for any scheme and any target language', async () => {
    const service = new TranslationService({ translator: taggingTranslator });

    await fc.assert(
      fc.asyncProperty(arbScheme, arbLanguage, async (scheme, lang) => {
        const translated = await service.translateScheme(scheme, lang);

        // Identifiers and URLs.
        expect(translated.id).toBe(scheme.id);
        expect(translated.ministry).toBe(scheme.ministry);
        expect(translated.sourceUrl).toBe(scheme.sourceUrl);
        expect(translated.applicationUrl).toBe(scheme.applicationUrl);
        // Classification / structural metadata.
        expect(translated.state).toBe(scheme.state);
        expect(translated.category).toBe(scheme.category);
        expect(translated.benefitType).toBe(scheme.benefitType);
        expect(translated.benefitAmount).toBe(scheme.benefitAmount);
        expect(translated.applicationMode).toBe(scheme.applicationMode);
        // Scores / flags.
        expect(translated.trustScore).toBe(scheme.trustScore);
        expect(translated.verified).toBe(scheme.verified);
        // Dates compared by epoch — Date instances are recreated on copy.
        expect(translated.deadline?.getTime() ?? null).toBe(
          scheme.deadline?.getTime() ?? null,
        );
        expect(translated.discoveredAt.getTime()).toBe(scheme.discoveredAt.getTime());
        expect(translated.lastVerifiedAt.getTime()).toBe(
          scheme.lastVerifiedAt.getTime(),
        );
        expect(translated.updatedAt.getTime()).toBe(scheme.updatedAt.getTime());
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('passes translatable fields through the translator for any scheme and any target language', async () => {
    const service = new TranslationService({ translator: taggingTranslator });

    await fc.assert(
      fc.asyncProperty(arbScheme, arbLanguage, async (scheme, lang) => {
        const translated = await service.translateScheme(scheme, lang);

        // Top-level description.
        expect(translated.description).toBe(
          expectedTranslation(scheme.description, lang),
        );

        // Eligibility criteria descriptions.
        expect(translated.eligibilityCriteria).toHaveLength(
          scheme.eligibilityCriteria.length,
        );
        for (let i = 0; i < scheme.eligibilityCriteria.length; i += 1) {
          const src = scheme.eligibilityCriteria[i];
          const out = translated.eligibilityCriteria[i];
          expect(out.description).toBe(expectedTranslation(src.description, lang));
          // Non-translatable sub-fields are preserved exactly.
          expect(out.field).toBe(src.field);
          expect(out.operator).toBe(src.operator);
          expect(out.value).toStrictEqual(src.value);
        }

        // Benefit descriptions.
        expect(translated.benefits).toHaveLength(scheme.benefits.length);
        for (let i = 0; i < scheme.benefits.length; i += 1) {
          const src = scheme.benefits[i];
          const out = translated.benefits[i];
          expect(out.description).toBe(expectedTranslation(src.description, lang));
          expect(out.type).toBe(src.type);
          expect(out.amount).toBe(src.amount);
        }

        // Application steps action / expectedOutcome.
        if (scheme.applicationSteps === null) {
          expect(translated.applicationSteps).toBeNull();
        } else {
          expect(translated.applicationSteps).not.toBeNull();
          expect(translated.applicationSteps).toHaveLength(
            scheme.applicationSteps.length,
          );
          for (let i = 0; i < scheme.applicationSteps.length; i += 1) {
            const src = scheme.applicationSteps[i];
            // Non-null because we just asserted length matches a non-null source.
            const out = translated.applicationSteps![i];
            expect(out.action).toBe(expectedTranslation(src.action, lang));
            expect(out.expectedOutcome).toBe(
              expectedTranslation(src.expectedOutcome, lang),
            );
            expect(out.stepNumber).toBe(src.stepNumber);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
