/**
 * Translation Service.
 *
 * Translates scheme content for citizen-facing display while preserving the
 * official Scheme name in its original language (Requirement 12.4). When a
 * translation is unavailable for a particular field the service falls back
 * to the English source value and records the field name in
 * `translation.fallbackFields` so the frontend can render the
 * "translation unavailable" notice required by Requirement 12.5.
 *
 * The service exposes a {@link Translator} abstraction so the production
 * adapter (Azure Translator / Google Cloud Translation per the design
 * document) can be swapped in for an in-memory dictionary during tests
 * without touching the call sites.
 *
 * Field policy:
 *   - PRESERVED (untranslated): `name`, `ministry`, `sourceUrl`,
 *     `applicationUrl`, `category`, `state`, identifiers, dates, scores.
 *   - TRANSLATED: `description`, `eligibilityCriteria[].description`,
 *     `benefits[].description`, `applicationSteps[].action`,
 *     `applicationSteps[].expectedOutcome`,
 *     `requiredDocuments[].documentName`,
 *     `requiredDocuments[].description`.
 *
 * When `targetLanguage === 'en'` the service short-circuits and returns the
 * scheme unchanged with `translation.fallbackFields` empty — English is
 * canonical so there is nothing to fall back from.
 */

import type {
  ApplicationStep,
  Benefit,
  DocumentRequirement,
  EligibilityCriterion,
  Scheme,
  SupportedLanguage,
} from '@bharat-benefits/shared';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Result of a single translation lookup.
 *
 *   - `text` is the translated string (or the original if no translation).
 *   - `available` is `false` when the translator could not produce a
 *     translation for the supplied source string in the target language.
 */
export interface TranslationLookup {
  text: string;
  available: boolean;
}

/**
 * Translator abstraction.
 *
 * Implementations may be backed by a managed translation API (Azure /
 * Google Cloud), a static dictionary, or a no-op for English. The
 * service treats `null` results as "translation unavailable".
 */
export interface Translator {
  translate(
    text: string,
    targetLanguage: SupportedLanguage,
  ): Promise<string | null>;
}

/**
 * Translated scheme returned to callers.
 *
 * Keeps the original `Scheme` shape — translations are written in place on
 * the field the citizen reads — and adds a `translation` envelope that
 * documents which fields were translated and which fell back to English.
 */
export interface TranslatedScheme extends Scheme {
  translation: TranslationMetadata;
}

/**
 * Per-scheme translation bookkeeping. The frontend uses
 * {@link fallbackFields} to render the visible "translation unavailable"
 * notice (Requirement 12.5).
 */
export interface TranslationMetadata {
  /** Locale this scheme has been translated to. */
  targetLanguage: SupportedLanguage;
  /** Fields that were translated successfully in {@link targetLanguage}. */
  translatedFields: string[];
  /** Fields where translation was unavailable; English value retained. */
  fallbackFields: string[];
  /**
   * Whether the underlying translator was reachable for at least one
   * lookup. `false` indicates a service outage — the UI should display a
   * scheme-wide notice in addition to per-field fallbacks.
   */
  available: boolean;
  /** True when at least one user-facing string was translated. */
  fullyTranslated: boolean;
}

// ─── Field paths preserved untranslated ──────────────────────────────────────

/**
 * Field paths that are NEVER translated (Requirement 12.4).
 *
 * Exported as a frozen list so tests and downstream consumers can verify
 * the policy without re-deriving it.
 */
export const PRESERVED_SCHEME_FIELDS: readonly string[] = Object.freeze([
  'id',
  'name',
  'ministry',
  'state',
  'category',
  'sourceUrl',
  'applicationUrl',
  'benefitType',
  'benefitAmount',
  'deadline',
  'applicationMode',
  'trustScore',
  'verified',
  'discoveredAt',
  'lastVerifiedAt',
  'updatedAt',
]);

// ─── Service ─────────────────────────────────────────────────────────────────

export interface TranslationServiceDeps {
  translator: Translator;
}

/**
 * Stateless translation service. Construct once per request lifecycle
 * with the configured translator.
 */
export class TranslationService {
  private readonly translator: Translator;

  constructor(deps: TranslationServiceDeps) {
    this.translator = deps.translator;
  }

  /**
   * Translates a single string. Returns `{ text, available }`. When the
   * translator returns `null` or throws, the caller receives the original
   * source string with `available = false`.
   */
  async translateString(
    text: string,
    targetLanguage: SupportedLanguage,
  ): Promise<TranslationLookup> {
    if (targetLanguage === 'en') return { text, available: true };
    if (text.length === 0) return { text, available: true };
    let translated: string | null = null;
    try {
      translated = await this.translator.translate(text, targetLanguage);
    } catch {
      translated = null;
    }
    if (translated === null || translated.length === 0) {
      return { text, available: false };
    }
    return { text: translated, available: true };
  }

  /**
   * Translates a scheme into the supplied target language.
   *
   * - The official `name` is preserved verbatim (Requirement 12.4).
   * - Each user-facing field is translated independently so a missing
   *   translation for one field does not prevent others from being
   *   translated.
   * - English target short-circuits to the source scheme.
   */
  async translateScheme(
    scheme: Scheme,
    targetLanguage: SupportedLanguage,
  ): Promise<TranslatedScheme> {
    if (targetLanguage === 'en') {
      return {
        ...scheme,
        translation: {
          targetLanguage,
          translatedFields: [],
          fallbackFields: [],
          available: true,
          fullyTranslated: true,
        },
      };
    }

    const translatedFields: string[] = [];
    const fallbackFields: string[] = [];
    let anySuccess = false;
    let anyAttempt = false;

    const record = async (
      fieldPath: string,
      source: string,
    ): Promise<string> => {
      // Empty strings carry no user-facing content to translate. Return
      // the empty string and DON'T record the field on either side of
      // the manifest — there's nothing to translate or fall back from.
      if (source.length === 0) return source;
      anyAttempt = true;
      const lookup = await this.translateString(source, targetLanguage);
      if (lookup.available) {
        translatedFields.push(fieldPath);
        anySuccess = true;
      } else {
        fallbackFields.push(fieldPath);
      }
      return lookup.text;
    };

    const description = await record('description', scheme.description);

    const eligibilityCriteria = await this.translateCriteria(
      scheme.eligibilityCriteria,
      targetLanguage,
      translatedFields,
      fallbackFields,
      (success) => {
        anyAttempt = true;
        if (success) anySuccess = true;
      },
    );

    const benefits = await this.translateBenefits(
      scheme.benefits,
      targetLanguage,
      translatedFields,
      fallbackFields,
      (success) => {
        anyAttempt = true;
        if (success) anySuccess = true;
      },
    );

    const applicationSteps = scheme.applicationSteps
      ? await this.translateApplicationSteps(
          scheme.applicationSteps,
          targetLanguage,
          translatedFields,
          fallbackFields,
          (success) => {
            anyAttempt = true;
            if (success) anySuccess = true;
          },
        )
      : null;

    const requiredDocuments = scheme.requiredDocuments
      ? await this.translateDocuments(
          scheme.requiredDocuments,
          targetLanguage,
          translatedFields,
          fallbackFields,
          (success) => {
            anyAttempt = true;
            if (success) anySuccess = true;
          },
        )
      : null;

    return {
      ...scheme,
      // `name` deliberately copied through unchanged — Requirement 12.4.
      name: scheme.name,
      description,
      eligibilityCriteria,
      benefits,
      applicationSteps,
      requiredDocuments,
      translation: {
        targetLanguage,
        translatedFields,
        fallbackFields,
        // Service is "available" when at least one lookup succeeded, OR
        // when no lookups were attempted (e.g. all fields empty).
        available: !anyAttempt || anySuccess,
        fullyTranslated: fallbackFields.length === 0,
      },
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async translateCriteria(
    criteria: EligibilityCriterion[],
    targetLanguage: SupportedLanguage,
    translatedFields: string[],
    fallbackFields: string[],
    onAttempt: (success: boolean) => void,
  ): Promise<EligibilityCriterion[]> {
    const out: EligibilityCriterion[] = [];
    for (let i = 0; i < criteria.length; i += 1) {
      const c = criteria[i];
      if (c.description.length === 0) {
        out.push({ ...c });
        continue;
      }
      const lookup = await this.translateString(c.description, targetLanguage);
      onAttempt(lookup.available);
      const fieldPath = `eligibilityCriteria[${i}].description`;
      if (lookup.available) translatedFields.push(fieldPath);
      else fallbackFields.push(fieldPath);
      out.push({ ...c, description: lookup.text });
    }
    return out;
  }

  private async translateBenefits(
    benefits: Benefit[],
    targetLanguage: SupportedLanguage,
    translatedFields: string[],
    fallbackFields: string[],
    onAttempt: (success: boolean) => void,
  ): Promise<Benefit[]> {
    const out: Benefit[] = [];
    for (let i = 0; i < benefits.length; i += 1) {
      const b = benefits[i];
      if (b.description.length === 0) {
        out.push({ ...b });
        continue;
      }
      const lookup = await this.translateString(b.description, targetLanguage);
      onAttempt(lookup.available);
      const fieldPath = `benefits[${i}].description`;
      if (lookup.available) translatedFields.push(fieldPath);
      else fallbackFields.push(fieldPath);
      out.push({ ...b, description: lookup.text });
    }
    return out;
  }

  private async translateApplicationSteps(
    steps: ApplicationStep[],
    targetLanguage: SupportedLanguage,
    translatedFields: string[],
    fallbackFields: string[],
    onAttempt: (success: boolean) => void,
  ): Promise<ApplicationStep[]> {
    const out: ApplicationStep[] = [];
    for (let i = 0; i < steps.length; i += 1) {
      const s = steps[i];
      let action = s.action;
      if (s.action.length > 0) {
        const actionLookup = await this.translateString(s.action, targetLanguage);
        onAttempt(actionLookup.available);
        const actionField = `applicationSteps[${i}].action`;
        if (actionLookup.available) translatedFields.push(actionField);
        else fallbackFields.push(actionField);
        action = actionLookup.text;
      }

      let expectedOutcome = s.expectedOutcome;
      if (s.expectedOutcome.length > 0) {
        const outcomeLookup = await this.translateString(
          s.expectedOutcome,
          targetLanguage,
        );
        onAttempt(outcomeLookup.available);
        const outcomeField = `applicationSteps[${i}].expectedOutcome`;
        if (outcomeLookup.available) translatedFields.push(outcomeField);
        else fallbackFields.push(outcomeField);
        expectedOutcome = outcomeLookup.text;
      }

      out.push({ ...s, action, expectedOutcome });
    }
    return out;
  }

  private async translateDocuments(
    documents: DocumentRequirement[],
    targetLanguage: SupportedLanguage,
    translatedFields: string[],
    fallbackFields: string[],
    onAttempt: (success: boolean) => void,
  ): Promise<DocumentRequirement[]> {
    const out: DocumentRequirement[] = [];
    for (let i = 0; i < documents.length; i += 1) {
      const d = documents[i];
      let documentName = d.documentName;
      if (d.documentName.length > 0) {
        const nameLookup = await this.translateString(
          d.documentName,
          targetLanguage,
        );
        onAttempt(nameLookup.available);
        const nameField = `requiredDocuments[${i}].documentName`;
        if (nameLookup.available) translatedFields.push(nameField);
        else fallbackFields.push(nameField);
        documentName = nameLookup.text;
      }

      let description = d.description;
      if (d.description.length > 0) {
        const descLookup = await this.translateString(d.description, targetLanguage);
        onAttempt(descLookup.available);
        const descField = `requiredDocuments[${i}].description`;
        if (descLookup.available) translatedFields.push(descField);
        else fallbackFields.push(descField);
        description = descLookup.text;
      }

      out.push({ ...d, documentName, description });
    }
    return out;
  }
}

// ─── Built-in translators ────────────────────────────────────────────────────

/**
 * Dictionary-backed translator. Useful for unit tests and as a content
 * cache layered in front of a remote translation API. Lookups are exact
 * — callers should normalise whitespace before insertion if they want
 * permissive matching.
 */
export class DictionaryTranslator implements Translator {
  private readonly dict: Map<string, Map<string, string>>;

  constructor(
    entries: Partial<
      Record<SupportedLanguage, Record<string, string>>
    > = {},
  ) {
    this.dict = new Map();
    for (const [lang, mapping] of Object.entries(entries)) {
      if (!mapping) continue;
      this.dict.set(lang, new Map(Object.entries(mapping)));
    }
  }

  async translate(
    text: string,
    targetLanguage: SupportedLanguage,
  ): Promise<string | null> {
    const langMap = this.dict.get(targetLanguage);
    if (!langMap) return null;
    return langMap.get(text) ?? null;
  }

  /**
   * Adds or overwrites a translation entry. Returns the same instance for
   * fluent test setup.
   */
  set(
    targetLanguage: SupportedLanguage,
    source: string,
    translation: string,
  ): this {
    let langMap = this.dict.get(targetLanguage);
    if (!langMap) {
      langMap = new Map();
      this.dict.set(targetLanguage, langMap);
    }
    langMap.set(source, translation);
    return this;
  }
}

/**
 * No-op translator that always returns `null`. Used when the service is
 * configured with no backend — the result is that every field falls back
 * to English, which is the documented behaviour for translation outages
 * (Requirement 12.5).
 */
export const noopTranslator: Translator = {
  async translate(): Promise<string | null> {
    return null;
  },
};

// ─── Convenience factory ─────────────────────────────────────────────────────

/**
 * Creates a {@link TranslationService} backed by an in-memory dictionary.
 * Convenient for tests and for seeding a small static glossary.
 */
export function createDictionaryTranslationService(
  entries: Partial<Record<SupportedLanguage, Record<string, string>>> = {},
): TranslationService {
  return new TranslationService({
    translator: new DictionaryTranslator(entries),
  });
}
