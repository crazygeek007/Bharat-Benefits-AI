/**
 * Unit tests for TranslationService.
 *
 * Validates: Requirements 12.2, 12.4, 12.5.
 *
 * Covers:
 *   - Official scheme name is preserved untranslated for every target locale.
 *   - Citizen-facing fields (description, eligibility criteria, benefits,
 *     application steps, required documents) are translated when the
 *     translator has an entry for them.
 *   - Missing translations fall back to English and the field path is
 *     recorded in `translation.fallbackFields` so the UI can show the
 *     12.5 notice.
 *   - English target short-circuits without invoking the translator.
 *   - A complete translator outage (every lookup returns null / throws)
 *     yields the source scheme with `available = false`.
 */

import { describe, it, expect } from 'vitest';
import type { Scheme, SupportedLanguage } from '@bharat-benefits/shared';
import {
  DictionaryTranslator,
  TranslationService,
  createDictionaryTranslationService,
  noopTranslator,
  type Translator,
} from './translation-service';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeScheme(overrides: Partial<Scheme> = {}): Scheme {
  return {
    id: 'sch-1',
    name: 'Pradhan Mantri Kisan Samman Nidhi',
    description: 'Income support for farmer families',
    ministry: 'Ministry of Agriculture',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://pmkisan.gov.in',
    benefitType: 'monetary',
    benefitAmount: 6000,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: 'https://pmkisan.gov.in/apply',
    eligibilityCriteria: [
      {
        field: 'occupation',
        operator: 'eq',
        value: 'Farmer',
        description: 'Applicant must be a farmer',
      },
      {
        field: 'land_holding',
        operator: 'lte',
        value: 2,
        description: 'Land holding up to 2 hectares',
      },
    ],
    benefits: [
      {
        type: 'monetary',
        amount: 6000,
        description: 'Three instalments of two thousand rupees per year',
      },
    ],
    applicationSteps: [
      {
        stepNumber: 1,
        action: 'Visit the official website',
        expectedOutcome: 'Registration form opens',
      },
    ],
    requiredDocuments: [
      {
        documentName: 'Aadhaar Card',
        description: 'Identity proof',
        format: 'PDF',
        required: true,
      },
    ],
    trustScore: 95,
    verified: true,
    discoveredAt: new Date('2024-01-01'),
    lastVerifiedAt: new Date('2024-06-01'),
    updatedAt: new Date('2024-06-01'),
    ...overrides,
  };
}

const HINDI_DICT: Record<string, string> = {
  'Income support for farmer families': 'किसान परिवारों के लिए आय सहायता',
  'Applicant must be a farmer': 'आवेदक किसान होना चाहिए',
  'Land holding up to 2 hectares': '2 हेक्टेयर तक भूमि धारण',
  'Three instalments of two thousand rupees per year':
    'प्रति वर्ष दो हजार रुपये की तीन किस्तें',
  'Visit the official website': 'आधिकारिक वेबसाइट पर जाएं',
  'Registration form opens': 'पंजीकरण फॉर्म खुलता है',
  'Aadhaar Card': 'आधार कार्ड',
  'Identity proof': 'पहचान प्रमाण',
};

// ─── translateString ────────────────────────────────────────────────────────

describe('TranslationService.translateString', () => {
  it('returns text unchanged for English target', async () => {
    const service = createDictionaryTranslationService({ hi: HINDI_DICT });
    const result = await service.translateString('Hello', 'en');
    expect(result).toEqual({ text: 'Hello', available: true });
  });

  it('returns the translated text when available', async () => {
    const service = createDictionaryTranslationService({ hi: HINDI_DICT });
    const result = await service.translateString(
      'Income support for farmer families',
      'hi',
    );
    expect(result.available).toBe(true);
    expect(result.text).toBe('किसान परिवारों के लिए आय सहायता');
  });

  it('falls back to source text when translation missing', async () => {
    const service = createDictionaryTranslationService({ hi: HINDI_DICT });
    const result = await service.translateString('No entry exists', 'hi');
    expect(result.available).toBe(false);
    expect(result.text).toBe('No entry exists');
  });

  it('returns source text with available=false when translator throws', async () => {
    const throwing: Translator = {
      async translate(): Promise<string | null> {
        throw new Error('upstream-down');
      },
    };
    const service = new TranslationService({ translator: throwing });
    const result = await service.translateString('hello', 'hi');
    expect(result.available).toBe(false);
    expect(result.text).toBe('hello');
  });
});

// ─── translateScheme — name preservation (Req 12.4) ─────────────────────────

describe('TranslationService.translateScheme — name preservation', () => {
  const NON_ENGLISH_LOCALES: SupportedLanguage[] = ['hi', 'bn', 'ta', 'te', 'mr'];

  it.each(NON_ENGLISH_LOCALES)(
    'preserves official scheme name verbatim for locale %s',
    async (locale) => {
      const dict = new DictionaryTranslator()
        .set(locale, 'Pradhan Mantri Kisan Samman Nidhi', 'WRONG: should not translate');
      const service = new TranslationService({ translator: dict });
      const original = makeScheme();
      const translated = await service.translateScheme(original, locale);
      // Name must remain the original even when a translation exists in the
      // dictionary — the policy is to never translate official names.
      expect(translated.name).toBe('Pradhan Mantri Kisan Samman Nidhi');
    },
  );

  it('preserves identifying / structural fields untranslated', async () => {
    const service = createDictionaryTranslationService({ hi: HINDI_DICT });
    const original = makeScheme();
    const translated = await service.translateScheme(original, 'hi');
    expect(translated.id).toBe(original.id);
    expect(translated.name).toBe(original.name);
    expect(translated.ministry).toBe(original.ministry);
    expect(translated.sourceUrl).toBe(original.sourceUrl);
    expect(translated.applicationUrl).toBe(original.applicationUrl);
    expect(translated.category).toBe(original.category);
    expect(translated.state).toBe(original.state);
    expect(translated.benefitType).toBe(original.benefitType);
    expect(translated.benefitAmount).toBe(original.benefitAmount);
    expect(translated.applicationMode).toBe(original.applicationMode);
  });
});

// ─── translateScheme — content translation ──────────────────────────────────

describe('TranslationService.translateScheme — content translation', () => {
  it('translates description, eligibility, benefits, steps, documents', async () => {
    const service = createDictionaryTranslationService({ hi: HINDI_DICT });
    const translated = await service.translateScheme(makeScheme(), 'hi');

    expect(translated.description).toBe('किसान परिवारों के लिए आय सहायता');
    expect(translated.eligibilityCriteria[0].description).toBe(
      'आवेदक किसान होना चाहिए',
    );
    expect(translated.eligibilityCriteria[1].description).toBe(
      '2 हेक्टेयर तक भूमि धारण',
    );
    expect(translated.benefits[0].description).toBe(
      'प्रति वर्ष दो हजार रुपये की तीन किस्तें',
    );
    expect(translated.applicationSteps?.[0].action).toBe(
      'आधिकारिक वेबसाइट पर जाएं',
    );
    expect(translated.applicationSteps?.[0].expectedOutcome).toBe(
      'पंजीकरण फॉर्म खुलता है',
    );
    expect(translated.requiredDocuments?.[0].documentName).toBe('आधार कार्ड');
    expect(translated.requiredDocuments?.[0].description).toBe('पहचान प्रमाण');
  });

  it('preserves non-translatable fields on translated criteria/benefits/etc.', async () => {
    const service = createDictionaryTranslationService({ hi: HINDI_DICT });
    const original = makeScheme();
    const translated = await service.translateScheme(original, 'hi');

    expect(translated.eligibilityCriteria[0].field).toBe('occupation');
    expect(translated.eligibilityCriteria[0].operator).toBe('eq');
    expect(translated.eligibilityCriteria[0].value).toBe('Farmer');
    expect(translated.benefits[0].type).toBe('monetary');
    expect(translated.benefits[0].amount).toBe(6000);
    expect(translated.applicationSteps?.[0].stepNumber).toBe(1);
    expect(translated.requiredDocuments?.[0].format).toBe('PDF');
    expect(translated.requiredDocuments?.[0].required).toBe(true);
  });

  it('records translated and fallback fields fully when all entries hit', async () => {
    const service = createDictionaryTranslationService({ hi: HINDI_DICT });
    const translated = await service.translateScheme(makeScheme(), 'hi');
    expect(translated.translation.targetLanguage).toBe('hi');
    expect(translated.translation.fallbackFields).toEqual([]);
    expect(translated.translation.fullyTranslated).toBe(true);
    expect(translated.translation.available).toBe(true);
    // Spot-check: every translated field should be present in the manifest.
    expect(translated.translation.translatedFields).toContain('description');
    expect(translated.translation.translatedFields).toContain(
      'eligibilityCriteria[0].description',
    );
    expect(translated.translation.translatedFields).toContain(
      'requiredDocuments[0].documentName',
    );
  });
});

// ─── translateScheme — fallback behaviour (Req 12.5) ────────────────────────

describe('TranslationService.translateScheme — English fallback', () => {
  it('falls back per field with the English source value retained', async () => {
    // Dictionary has only the description entry — every other field falls back.
    const partial = new DictionaryTranslator({
      hi: { 'Income support for farmer families': 'किसान परिवारों के लिए आय सहायता' },
    });
    const service = new TranslationService({ translator: partial });
    const translated = await service.translateScheme(makeScheme(), 'hi');

    expect(translated.description).toBe('किसान परिवारों के लिए आय सहायता');
    // Untranslated entries retain English source values.
    expect(translated.eligibilityCriteria[0].description).toBe(
      'Applicant must be a farmer',
    );
    expect(translated.benefits[0].description).toBe(
      'Three instalments of two thousand rupees per year',
    );
    expect(translated.applicationSteps?.[0].action).toBe(
      'Visit the official website',
    );
    expect(translated.requiredDocuments?.[0].documentName).toBe('Aadhaar Card');
    // Fallback manifest should list every untranslated field path.
    expect(translated.translation.fallbackFields).toEqual(
      expect.arrayContaining([
        'eligibilityCriteria[0].description',
        'eligibilityCriteria[1].description',
        'benefits[0].description',
        'applicationSteps[0].action',
        'applicationSteps[0].expectedOutcome',
        'requiredDocuments[0].documentName',
        'requiredDocuments[0].description',
      ]),
    );
    expect(translated.translation.fullyTranslated).toBe(false);
    // At least one lookup succeeded → service was reachable.
    expect(translated.translation.available).toBe(true);
  });

  it('reports available=false when every translation lookup fails', async () => {
    const service = new TranslationService({ translator: noopTranslator });
    const translated = await service.translateScheme(makeScheme(), 'hi');
    expect(translated.translation.available).toBe(false);
    expect(translated.translation.fullyTranslated).toBe(false);
    expect(translated.translation.translatedFields).toEqual([]);
    // Citizen still sees the English content (Req 12.5).
    expect(translated.description).toBe('Income support for farmer families');
    expect(translated.name).toBe('Pradhan Mantri Kisan Samman Nidhi');
  });
});

// ─── translateScheme — English target short-circuit ─────────────────────────

describe('TranslationService.translateScheme — English target', () => {
  it('returns the source scheme unchanged for target=en', async () => {
    let called = 0;
    const counting: Translator = {
      async translate(text) {
        called += 1;
        return text;
      },
    };
    const service = new TranslationService({ translator: counting });
    const original = makeScheme();
    const translated = await service.translateScheme(original, 'en');
    expect(called).toBe(0);
    expect(translated.description).toBe(original.description);
    expect(translated.eligibilityCriteria).toEqual(original.eligibilityCriteria);
    expect(translated.translation.targetLanguage).toBe('en');
    expect(translated.translation.fallbackFields).toEqual([]);
    expect(translated.translation.translatedFields).toEqual([]);
    expect(translated.translation.available).toBe(true);
    expect(translated.translation.fullyTranslated).toBe(true);
  });
});

// ─── translateScheme — schemes without optional fields ──────────────────────

describe('TranslationService.translateScheme — minimal schemes', () => {
  it('handles schemes with null applicationSteps and requiredDocuments', async () => {
    const service = createDictionaryTranslationService({ hi: HINDI_DICT });
    const minimal = makeScheme({
      applicationSteps: null,
      requiredDocuments: null,
    });
    const translated = await service.translateScheme(minimal, 'hi');
    expect(translated.applicationSteps).toBeNull();
    expect(translated.requiredDocuments).toBeNull();
    expect(translated.description).toBe('किसान परिवारों के लिए आय सहायता');
  });

  it('handles empty arrays without recording any field translations', async () => {
    const service = createDictionaryTranslationService({ hi: HINDI_DICT });
    const empty = makeScheme({
      eligibilityCriteria: [],
      benefits: [],
      applicationSteps: [],
      requiredDocuments: [],
      description: '',
    });
    const translated = await service.translateScheme(empty, 'hi');
    expect(translated.translation.fallbackFields).toEqual([]);
    expect(translated.translation.translatedFields).toEqual([]);
  });
});
