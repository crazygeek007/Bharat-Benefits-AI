/**
 * Voice Assistant Service — speech-to-text and text-to-speech in the
 * 6 supported Indian languages (Requirement 13).
 *
 * Pipeline (Req 13.1–13.7):
 *   1. Convert citizen audio to text via Azure Cognitive Services Speech
 *      (Req 13.1) and emit a {@link STTResult} with confidence + language.
 *   2. When confidence is below the {@link MIN_CONFIDENCE_PERCENT}
 *      threshold, return a "request repeat" verdict so the caller can
 *      prompt the citizen again. After {@link MAX_VOICE_RETRIES}
 *      consecutive low-confidence attempts the verdict flips to
 *      "fall back to text" (Req 13.5, 13.6).
 *   3. On a high-confidence transcript, route the text through the
 *      {@link SchemeAssistant} to produce an {@link AssistantResponse}
 *      (Req 13.3).
 *   4. Synthesize the response answer back into audio via TTS in the
 *      citizen's selected language (Req 13.2) and surface both the
 *      transcribed text and the generated audio in the verdict.
 *   5. When either Azure service is unavailable, return a
 *      "service unavailable" verdict so the caller can fall back to
 *      text-based interaction (Req 13.7).
 *
 * The service intentionally accepts the speech client and the scheme
 * assistant via dependency injection so unit tests can stub both without
 * pulling in the Azure SDK or hitting the network.
 */

import type {
  AssistantResponse,
  STTResult,
  SourceCitation,
  SupportedLanguage,
} from '@bharat-benefits/shared';

// ─── Constants (tuned to Requirement 13) ─────────────────────────────────────

/**
 * Minimum recognition confidence (percentage) required to accept a
 * transcribed query. Below this threshold the citizen is asked to
 * repeat the question (Req 13.5).
 */
export const MIN_CONFIDENCE_PERCENT = 50;

/**
 * Maximum number of consecutive low-confidence attempts the assistant
 * will tolerate before falling back to text input (Req 13.5, 13.6).
 *
 * "Up to 3 retries" in the requirement means 3 retry attempts after the
 * first failure — i.e. the citizen has at most 3 attempts in total
 * before the system gives up. We use the simpler reading: at most
 * `MAX_VOICE_RETRIES` attempts in a single voice session, then fall
 * back to text.
 */
export const MAX_VOICE_RETRIES = 3;

/**
 * Per-language ISO codes used by Azure Cognitive Services Speech. These
 * map our `SupportedLanguage` codes onto BCP-47 locales for both STT and
 * TTS calls (Req 13.1, 13.2).
 */
export const AZURE_LOCALE_BY_LANGUAGE: Readonly<Record<SupportedLanguage, string>> = {
  en: 'en-IN',
  hi: 'hi-IN',
  bn: 'bn-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  mr: 'mr-IN',
};

/**
 * Default neural voice used for TTS per language. The Azure neural voice
 * catalog ships female voices for every Indian locale we target; using a
 * single voice per language keeps the audio response consistent.
 */
export const AZURE_VOICE_BY_LANGUAGE: Readonly<Record<SupportedLanguage, string>> = {
  en: 'en-IN-NeerjaNeural',
  hi: 'hi-IN-SwaraNeural',
  bn: 'bn-IN-TanishaaNeural',
  ta: 'ta-IN-PallaviNeural',
  te: 'te-IN-ShrutiNeural',
  mr: 'mr-IN-AarohiNeural',
};

/** Audio MIME type of the synthesized TTS output (mono 16 kHz MP3). */
export const TTS_AUDIO_MIME_TYPE = 'audio/mpeg';

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Raised by the underlying speech client when the Azure service is
 * unreachable or returns a 5xx response. The service surfaces this as a
 * "service unavailable" verdict (Req 13.7) rather than crashing.
 */
export class SpeechServiceUnavailableError extends Error {
  constructor(
    message: string,
    /** Original cause from the Azure SDK, retained for log diagnostics. */
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SpeechServiceUnavailableError';
  }
}

// ─── Speech client interface ─────────────────────────────────────────────────

/**
 * Minimal speech client surface used by the voice assistant.
 *
 * The production adapter wraps `microsoft-cognitiveservices-speech-sdk`
 * and is constructed lazily so test environments never need the SDK.
 * Tests inject a fake conforming to this shape.
 */
export interface SpeechClient {
  /** Recognises speech in `audio` and returns the transcription metadata. */
  recognize(args: {
    audio: Buffer;
    language: SupportedLanguage;
    locale: string;
  }): Promise<SpeechRecognitionResult>;

  /** Synthesises `text` to audio in the citizen's selected language. */
  synthesize(args: {
    text: string;
    language: SupportedLanguage;
    locale: string;
    voice: string;
  }): Promise<Buffer>;
}

/**
 * Result returned by {@link SpeechClient.recognize}.
 *
 * `confidence` is normalised to the percentage range [0, 100] regardless
 * of whether the underlying SDK reports it on [0, 1] or [0, 100] —
 * adapters are responsible for normalisation.
 *
 * `recognized` is `false` when the SDK could not produce any transcript
 * (silence, noise, unsupported audio). The service treats that as a
 * confidence-zero result so the same "ask the citizen to repeat" branch
 * fires.
 */
export interface SpeechRecognitionResult {
  recognized: boolean;
  text: string;
  /** Confidence in [0, 100]. */
  confidence: number;
  /**
   * Optional language reported by the SDK. When omitted the service
   * falls back to the `language` requested by the caller.
   */
  detectedLanguage?: SupportedLanguage;
}

// ─── Scheme assistant surface ────────────────────────────────────────────────

/**
 * The slice of {@link SchemeAssistant} the voice service depends on. We
 * narrow to a single method so tests can pass a stub without standing up
 * the full RAG stack.
 */
export interface SchemeAssistantLike {
  answerQuery(
    query: string,
    sessionId: string,
    language?: SupportedLanguage,
  ): Promise<AssistantResponse>;
}

// ─── Verdict shape returned to callers ───────────────────────────────────────

/**
 * Per-call verdict returned by {@link VoiceAssistantService.processVoiceQuery}.
 *
 * The service flattens the four request outcomes from Req 13.5–13.7 into
 * a discriminated union so HTTP handlers can map each case to a
 * predictable response shape.
 */
export type VoiceQueryVerdict =
  | VoiceQuerySuccess
  | VoiceQueryLowConfidence
  | VoiceQueryFallbackText
  | VoiceQueryServiceUnavailable;

/** Successful end-to-end voice exchange. */
export interface VoiceQuerySuccess {
  status: 'ok';
  /** Transcribed text the assistant answered. */
  transcript: string;
  /** Recognition confidence in [0, 100]. */
  confidence: number;
  /** Language the response was generated in. */
  language: SupportedLanguage;
  /** Plain-text answer (mirrors {@link AssistantResponse.answer}). */
  answer: string;
  /** Cited sources from the RAG response. */
  sources: SourceCitation[];
  /** Audio bytes synthesised from `answer`. */
  audio: Buffer;
  /** Audio MIME type — currently a fixed {@link TTS_AUDIO_MIME_TYPE}. */
  audioMimeType: string;
  /** Distributed-trace id propagated from the assistant. */
  traceId: string;
}

/**
 * Recognition confidence was below the threshold but the citizen still
 * has retries available. The handler should prompt for another voice
 * sample.
 */
export interface VoiceQueryLowConfidence {
  status: 'low_confidence';
  /** Best-effort transcript (may be empty). */
  transcript: string;
  /** The actual confidence reported by the SDK, in [0, 100]. */
  confidence: number;
  /** Language the citizen requested (echoed for the UI prompt). */
  language: SupportedLanguage;
  /**
   * 1-indexed attempt count this verdict represents — i.e. how many
   * times the citizen has attempted voice input including the current
   * one. Useful for the UI to render "Attempt 2 of 3".
   */
  attempt: number;
  /**
   * Number of retry attempts the citizen still has remaining. Equals
   * `MAX_VOICE_RETRIES - attempt`.
   */
  retriesRemaining: number;
}

/** Citizen has exhausted retries — the UI should swap to text input. */
export interface VoiceQueryFallbackText {
  status: 'fallback_text';
  /** Last transcript captured, surfaced so the UI can pre-fill the textbox. */
  transcript: string;
  language: SupportedLanguage;
  /** Total attempts used; always equals {@link MAX_VOICE_RETRIES}. */
  attemptsUsed: number;
  /** Localisable diagnostic message for the UI. */
  message: string;
}

/**
 * One of the Azure services was unavailable. The UI should render an
 * error banner and offer text-based interaction (Req 13.7).
 */
export interface VoiceQueryServiceUnavailable {
  status: 'service_unavailable';
  language: SupportedLanguage;
  /** Which leg of the pipeline failed — surfaced for log triage. */
  failedStage: 'stt' | 'tts';
  message: string;
}

// ─── Service options ─────────────────────────────────────────────────────────

export interface VoiceAssistantDeps {
  /** Speech recognition + synthesis adapter (Azure in production). */
  speechClient: SpeechClient;
  /** Scheme assistant used to answer the transcribed query. */
  schemeAssistant: SchemeAssistantLike;
}

export interface VoiceAssistantOptions {
  /** Override the minimum confidence threshold (defaults to 50%). */
  minConfidence?: number;
  /** Override the maximum retry count (defaults to 3). */
  maxRetries?: number;
}

/** Input accepted by {@link VoiceAssistantService.processVoiceQuery}. */
export interface ProcessVoiceQueryInput {
  /** Raw audio bytes captured from the citizen's microphone. */
  audio: Buffer;
  /** Citizen's selected language (defaults to `en` upstream). */
  language: SupportedLanguage;
  /** Conversation/session id forwarded to the scheme assistant. */
  sessionId: string;
  /**
   * 1-indexed attempt counter maintained by the caller across retries.
   * The first call passes `attempt=1`; the UI re-submits with
   * `attempt=2`, `attempt=3` after each `low_confidence` verdict.
   */
  attempt?: number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class VoiceAssistantService {
  private readonly speechClient: SpeechClient;
  private readonly schemeAssistant: SchemeAssistantLike;
  private readonly minConfidence: number;
  private readonly maxRetries: number;

  constructor(deps: VoiceAssistantDeps, options: VoiceAssistantOptions = {}) {
    if (!deps.speechClient) {
      throw new Error('VoiceAssistantService: speechClient dependency is required');
    }
    if (!deps.schemeAssistant) {
      throw new Error(
        'VoiceAssistantService: schemeAssistant dependency is required',
      );
    }
    this.speechClient = deps.speechClient;
    this.schemeAssistant = deps.schemeAssistant;
    this.minConfidence = options.minConfidence ?? MIN_CONFIDENCE_PERCENT;
    this.maxRetries = options.maxRetries ?? MAX_VOICE_RETRIES;
  }

  /**
   * Convert audio to text in the supplied language (Req 13.1).
   *
   * Confidence is returned in the [0, 100] range so callers can compare
   * it directly against the {@link MIN_CONFIDENCE_PERCENT} threshold.
   * When Azure cannot recognise any speech the result is normalised to
   * `{ recognized: false, confidence: 0, text: '' }`.
   */
  async speechToText(
    audio: Buffer,
    language: SupportedLanguage,
  ): Promise<STTResult> {
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      throw new Error('speechToText: audio must be a non-empty Buffer');
    }
    const locale = AZURE_LOCALE_BY_LANGUAGE[language];
    if (!locale) {
      throw new Error(`speechToText: unsupported language "${language}"`);
    }

    let result: SpeechRecognitionResult;
    try {
      result = await this.speechClient.recognize({ audio, language, locale });
    } catch (err) {
      throw new SpeechServiceUnavailableError(
        'Azure speech-to-text service is unavailable',
        err,
      );
    }

    const confidence = clampConfidence(result.confidence);
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    const detected = isSupportedLanguage(result.detectedLanguage)
      ? (result.detectedLanguage as SupportedLanguage)
      : language;

    return {
      text,
      confidence,
      language: detected,
    };
  }

  /**
   * Convert text to speech audio in the supplied language (Req 13.2).
   *
   * Returns the raw audio bytes so the route layer can stream them or
   * base64-encode them as appropriate. Throws
   * {@link SpeechServiceUnavailableError} when the underlying service
   * fails so the caller can return a "service unavailable" verdict.
   */
  async textToSpeech(
    text: string,
    language: SupportedLanguage,
  ): Promise<Buffer> {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('textToSpeech: text must be a non-empty string');
    }
    const locale = AZURE_LOCALE_BY_LANGUAGE[language];
    const voice = AZURE_VOICE_BY_LANGUAGE[language];
    if (!locale || !voice) {
      throw new Error(`textToSpeech: unsupported language "${language}"`);
    }

    try {
      const audio = await this.speechClient.synthesize({
        text,
        language,
        locale,
        voice,
      });
      if (!Buffer.isBuffer(audio) || audio.length === 0) {
        throw new SpeechServiceUnavailableError(
          'Azure text-to-speech returned empty audio',
        );
      }
      return audio;
    } catch (err) {
      if (err instanceof SpeechServiceUnavailableError) throw err;
      throw new SpeechServiceUnavailableError(
        'Azure text-to-speech service is unavailable',
        err,
      );
    }
  }

  /**
   * End-to-end voice exchange: STT → SchemeAssistant → TTS (Req 13.3).
   *
   * Returns a discriminated {@link VoiceQueryVerdict} covering every
   * outcome required by Req 13.5–13.7:
   *   - `ok`: success, audio + transcript + answer attached.
   *   - `low_confidence`: confidence below threshold but retries remain.
   *   - `fallback_text`: retries exhausted; UI should swap to text.
   *   - `service_unavailable`: Azure unavailable; UI shows error banner.
   */
  async processVoiceQuery(input: ProcessVoiceQueryInput): Promise<VoiceQueryVerdict> {
    const { audio, language, sessionId } = input;
    const attempt = sanitiseAttempt(input.attempt, this.maxRetries);

    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new Error('processVoiceQuery: sessionId must be a non-empty string');
    }

    // ── Stage 1: STT ────────────────────────────────────────────────────────
    let stt: STTResult;
    try {
      stt = await this.speechToText(audio, language);
    } catch (err) {
      if (err instanceof SpeechServiceUnavailableError) {
        return {
          status: 'service_unavailable',
          language,
          failedStage: 'stt',
          message:
            'The voice service is temporarily unavailable. Please type your question instead.',
        };
      }
      throw err;
    }

    // ── Confidence gate ────────────────────────────────────────────────────
    if (stt.confidence < this.minConfidence) {
      // Last allowed attempt? Fall back to text input (Req 13.6).
      if (attempt >= this.maxRetries) {
        return {
          status: 'fallback_text',
          transcript: stt.text,
          language,
          attemptsUsed: this.maxRetries,
          message:
            "I couldn't understand the audio after several tries. Please type your question instead.",
        };
      }
      return {
        status: 'low_confidence',
        transcript: stt.text,
        confidence: stt.confidence,
        language,
        attempt,
        retriesRemaining: this.maxRetries - attempt,
      };
    }

    // ── Stage 2: Scheme assistant ──────────────────────────────────────────
    const assistantResponse = await this.schemeAssistant.answerQuery(
      stt.text,
      sessionId,
      language,
    );

    // ── Stage 3: TTS ───────────────────────────────────────────────────────
    let audioOut: Buffer;
    try {
      audioOut = await this.textToSpeech(assistantResponse.answer, language);
    } catch (err) {
      if (err instanceof SpeechServiceUnavailableError) {
        return {
          status: 'service_unavailable',
          language,
          failedStage: 'tts',
          message:
            'The voice service is temporarily unavailable. Please type your question instead.',
        };
      }
      throw err;
    }

    return {
      status: 'ok',
      transcript: stt.text,
      confidence: stt.confidence,
      language,
      answer: assistantResponse.answer,
      sources: assistantResponse.sources,
      audio: audioOut,
      audioMimeType: TTS_AUDIO_MIME_TYPE,
      traceId: assistantResponse.traceId,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set([
  'en',
  'hi',
  'bn',
  'ta',
  'te',
  'mr',
]);

function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && SUPPORTED_LANGUAGES.has(value);
}

/**
 * Normalises confidence to the [0, 100] range. Some Azure responses
 * report on [0, 1] (a probability) — the adapter SHOULD normalise but we
 * defensively clamp here as well so the threshold check is always
 * meaningful.
 */
function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  // Adapters MUST return 0–100. If a buggy adapter returns 0–1 we get
  // pinned to <=1 which is below the 50 threshold — the citizen will be
  // asked to repeat, which is the safer failure mode.
  if (value > 100) return 100;
  return value;
}

function sanitiseAttempt(value: unknown, maxRetries: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > maxRetries) return maxRetries;
  return n;
}
