/**
 * Unit tests for the {@link VoiceAssistantService}.
 *
 * Coverage:
 *   - speechToText returns an STTResult with normalised confidence and
 *     surfaces empty / no-match audio safely (Req 13.1).
 *   - textToSpeech returns audio bytes and rejects empty input (Req 13.2).
 *   - processVoiceQuery yields `ok` end-to-end on a high-confidence
 *     transcription, including Scheme Assistant + TTS calls (Req 13.3).
 *   - Confidence below 50% yields `low_confidence` while retries remain
 *     (Req 13.5).
 *   - The 3rd consecutive low-confidence attempt yields `fallback_text`
 *     (Req 13.6).
 *   - Azure unavailability (STT or TTS) yields `service_unavailable`
 *     (Req 13.7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AssistantResponse, SourceCitation } from '@bharat-benefits/shared';

import {
  AZURE_LOCALE_BY_LANGUAGE,
  AZURE_VOICE_BY_LANGUAGE,
  MAX_VOICE_RETRIES,
  MIN_CONFIDENCE_PERCENT,
  SpeechServiceUnavailableError,
  TTS_AUDIO_MIME_TYPE,
  VoiceAssistantService,
  type SchemeAssistantLike,
  type SpeechClient,
  type SpeechRecognitionResult,
} from './voice-assistant';

// ─── Fakes ───────────────────────────────────────────────────────────────────

type FakeSpeechClient = SpeechClient & {
  recognize: ReturnType<typeof vi.fn>;
  synthesize: ReturnType<typeof vi.fn>;
};

function makeSpeechClient(
  recognizeImpl: (args: {
    audio: Buffer;
    language: string;
    locale: string;
  }) => Promise<SpeechRecognitionResult> = async () => ({
    recognized: true,
    text: 'How do I apply for PM Kisan?',
    confidence: 92,
  }),
  synthesizeImpl: (args: {
    text: string;
    language: string;
    locale: string;
    voice: string;
  }) => Promise<Buffer> = async () => Buffer.from([0x49, 0x44, 0x33, 0x04]),
): FakeSpeechClient {
  const client = {
    recognize: vi.fn(recognizeImpl),
    synthesize: vi.fn(synthesizeImpl),
  };
  return client as unknown as FakeSpeechClient;
}

type FakeSchemeAssistant = SchemeAssistantLike & {
  answerQuery: ReturnType<typeof vi.fn>;
};

function makeSchemeAssistant(
  response: Partial<AssistantResponse> = {},
): FakeSchemeAssistant {
  const sources: SourceCitation[] =
    response.sources ?? [
      {
        schemeId: 'scheme-1',
        schemeName: 'PM Kisan Samman Nidhi',
        sourceUrl: 'https://pmkisan.gov.in',
        lastUpdated: new Date('2025-01-15T00:00:00Z'),
      },
    ];
  const fullResponse: AssistantResponse = {
    answer:
      response.answer ?? 'PM Kisan provides INR 6,000 yearly to eligible farmers.',
    sources,
    language: response.language ?? 'en',
    traceId: response.traceId ?? 'trace-1',
  };
  const fake = {
    answerQuery: vi.fn(async () => fullResponse),
  };
  return fake as unknown as FakeSchemeAssistant;
}

const AUDIO = Buffer.from('audio-bytes');

// ─── speechToText ────────────────────────────────────────────────────────────

describe('VoiceAssistantService.speechToText', () => {
  it('returns the normalised STTResult for a successful recognition', async () => {
    const speechClient = makeSpeechClient();
    const service = new VoiceAssistantService({
      speechClient,
      schemeAssistant: makeSchemeAssistant(),
    });

    const result = await service.speechToText(AUDIO, 'hi');

    expect(result.text).toBe('How do I apply for PM Kisan?');
    expect(result.confidence).toBe(92);
    expect(result.language).toBe('hi');
    expect(speechClient.recognize).toHaveBeenCalledWith({
      audio: AUDIO,
      language: 'hi',
      locale: AZURE_LOCALE_BY_LANGUAGE.hi,
    });
  });

  it('clamps out-of-range confidence to [0, 100]', async () => {
    const speechClient = makeSpeechClient(async () => ({
      recognized: true,
      text: 'something',
      confidence: 250, // buggy adapter
    }));
    const service = new VoiceAssistantService({
      speechClient,
      schemeAssistant: makeSchemeAssistant(),
    });
    const result = await service.speechToText(AUDIO, 'en');
    expect(result.confidence).toBe(100);
  });

  it('returns confidence 0 when the recognizer reports no match', async () => {
    const speechClient = makeSpeechClient(async () => ({
      recognized: false,
      text: '',
      confidence: 0,
    }));
    const service = new VoiceAssistantService({
      speechClient,
      schemeAssistant: makeSchemeAssistant(),
    });
    const result = await service.speechToText(AUDIO, 'en');
    expect(result.confidence).toBe(0);
    expect(result.text).toBe('');
  });

  it('rejects empty audio buffers', async () => {
    const service = new VoiceAssistantService({
      speechClient: makeSpeechClient(),
      schemeAssistant: makeSchemeAssistant(),
    });
    await expect(service.speechToText(Buffer.alloc(0), 'en')).rejects.toThrow(
      /non-empty Buffer/,
    );
  });

  it('wraps SDK errors as SpeechServiceUnavailableError', async () => {
    const speechClient = makeSpeechClient(async () => {
      throw new Error('network down');
    });
    const service = new VoiceAssistantService({
      speechClient,
      schemeAssistant: makeSchemeAssistant(),
    });
    await expect(service.speechToText(AUDIO, 'en')).rejects.toBeInstanceOf(
      SpeechServiceUnavailableError,
    );
  });
});

// ─── textToSpeech ────────────────────────────────────────────────────────────

describe('VoiceAssistantService.textToSpeech', () => {
  it('returns synthesised audio bytes and forwards locale + voice', async () => {
    const audio = Buffer.from([1, 2, 3, 4, 5]);
    const speechClient = makeSpeechClient(undefined, async () => audio);
    const service = new VoiceAssistantService({
      speechClient,
      schemeAssistant: makeSchemeAssistant(),
    });
    const result = await service.textToSpeech('hello', 'ta');
    expect(result.equals(audio)).toBe(true);
    expect(speechClient.synthesize).toHaveBeenCalledWith({
      text: 'hello',
      language: 'ta',
      locale: AZURE_LOCALE_BY_LANGUAGE.ta,
      voice: AZURE_VOICE_BY_LANGUAGE.ta,
    });
  });

  it('rejects empty text', async () => {
    const service = new VoiceAssistantService({
      speechClient: makeSpeechClient(),
      schemeAssistant: makeSchemeAssistant(),
    });
    await expect(service.textToSpeech('', 'en')).rejects.toThrow(/non-empty/);
    await expect(service.textToSpeech('   ', 'en')).rejects.toThrow(/non-empty/);
  });

  it('treats an empty TTS buffer as service unavailable', async () => {
    const service = new VoiceAssistantService({
      speechClient: makeSpeechClient(undefined, async () => Buffer.alloc(0)),
      schemeAssistant: makeSchemeAssistant(),
    });
    await expect(service.textToSpeech('hi', 'en')).rejects.toBeInstanceOf(
      SpeechServiceUnavailableError,
    );
  });
});

// ─── processVoiceQuery ───────────────────────────────────────────────────────

describe('VoiceAssistantService.processVoiceQuery', () => {
  let speechClient: FakeSpeechClient;
  let schemeAssistant: FakeSchemeAssistant;
  let service: VoiceAssistantService;

  beforeEach(() => {
    speechClient = makeSpeechClient(
      async () => ({ recognized: true, text: 'How do I apply?', confidence: 92 }),
      async () => Buffer.from([1, 2, 3]),
    );
    schemeAssistant = makeSchemeAssistant({ answer: 'Apply on pmkisan.gov.in.' });
    service = new VoiceAssistantService({ speechClient, schemeAssistant });
  });

  it('returns an `ok` verdict on a high-confidence end-to-end run', async () => {
    const verdict = await service.processVoiceQuery({
      audio: AUDIO,
      language: 'en',
      sessionId: 'session-1',
    });

    expect(verdict.status).toBe('ok');
    if (verdict.status !== 'ok') return;
    expect(verdict.transcript).toBe('How do I apply?');
    expect(verdict.confidence).toBe(92);
    expect(verdict.answer).toBe('Apply on pmkisan.gov.in.');
    expect(verdict.audio.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(verdict.audioMimeType).toBe(TTS_AUDIO_MIME_TYPE);
    expect(verdict.traceId).toBe('trace-1');
    expect(verdict.sources).toHaveLength(1);

    // Pipeline ordering: STT → assistant → TTS
    expect(speechClient.recognize).toHaveBeenCalledTimes(1);
    expect(schemeAssistant.answerQuery).toHaveBeenCalledTimes(1);
    expect(schemeAssistant.answerQuery).toHaveBeenCalledWith(
      'How do I apply?',
      'session-1',
      'en',
    );
    expect(speechClient.synthesize).toHaveBeenCalledTimes(1);
    expect(speechClient.synthesize.mock.calls[0]![0].text).toBe(
      'Apply on pmkisan.gov.in.',
    );
  });

  it('returns `low_confidence` when STT confidence is below the threshold and retries remain', async () => {
    speechClient.recognize.mockImplementationOnce(async () => ({
      recognized: true,
      text: 'mumble',
      confidence: MIN_CONFIDENCE_PERCENT - 10,
    }));
    const verdict = await service.processVoiceQuery({
      audio: AUDIO,
      language: 'en',
      sessionId: 'session-1',
      attempt: 1,
    });

    expect(verdict.status).toBe('low_confidence');
    if (verdict.status !== 'low_confidence') return;
    expect(verdict.confidence).toBe(MIN_CONFIDENCE_PERCENT - 10);
    expect(verdict.attempt).toBe(1);
    expect(verdict.retriesRemaining).toBe(MAX_VOICE_RETRIES - 1);
    // Did not call the assistant or TTS — short-circuited at the gate.
    expect(schemeAssistant.answerQuery).not.toHaveBeenCalled();
    expect(speechClient.synthesize).not.toHaveBeenCalled();
  });

  it('returns `fallback_text` after the max retries on persistent low confidence', async () => {
    speechClient.recognize.mockImplementation(async () => ({
      recognized: true,
      text: 'mumble',
      confidence: 10,
    }));
    const verdict = await service.processVoiceQuery({
      audio: AUDIO,
      language: 'en',
      sessionId: 'session-1',
      attempt: MAX_VOICE_RETRIES,
    });

    expect(verdict.status).toBe('fallback_text');
    if (verdict.status !== 'fallback_text') return;
    expect(verdict.attemptsUsed).toBe(MAX_VOICE_RETRIES);
    expect(verdict.transcript).toBe('mumble');
    expect(schemeAssistant.answerQuery).not.toHaveBeenCalled();
    expect(speechClient.synthesize).not.toHaveBeenCalled();
  });

  it('clamps oversized attempt counters to MAX_VOICE_RETRIES', async () => {
    speechClient.recognize.mockImplementation(async () => ({
      recognized: true,
      text: '',
      confidence: 5,
    }));
    const verdict = await service.processVoiceQuery({
      audio: AUDIO,
      language: 'en',
      sessionId: 'session-1',
      attempt: 99,
    });
    expect(verdict.status).toBe('fallback_text');
  });

  it('returns `service_unavailable` when STT throws', async () => {
    speechClient.recognize.mockImplementation(async () => {
      throw new SpeechServiceUnavailableError('boom');
    });
    const verdict = await service.processVoiceQuery({
      audio: AUDIO,
      language: 'hi',
      sessionId: 'session-1',
    });
    expect(verdict.status).toBe('service_unavailable');
    if (verdict.status !== 'service_unavailable') return;
    expect(verdict.failedStage).toBe('stt');
    expect(verdict.language).toBe('hi');
    expect(schemeAssistant.answerQuery).not.toHaveBeenCalled();
  });

  it('returns `service_unavailable` when TTS throws', async () => {
    speechClient.synthesize.mockImplementation(async () => {
      throw new SpeechServiceUnavailableError('tts down');
    });
    const verdict = await service.processVoiceQuery({
      audio: AUDIO,
      language: 'en',
      sessionId: 'session-1',
    });
    expect(verdict.status).toBe('service_unavailable');
    if (verdict.status !== 'service_unavailable') return;
    expect(verdict.failedStage).toBe('tts');
    expect(schemeAssistant.answerQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects empty session ids', async () => {
    await expect(
      service.processVoiceQuery({
        audio: AUDIO,
        language: 'en',
        sessionId: '',
      }),
    ).rejects.toThrow(/sessionId/);
  });
});

// ─── Constructor guards ──────────────────────────────────────────────────────

describe('VoiceAssistantService construction', () => {
  it('rejects missing speechClient', () => {
    expect(
      () =>
        new VoiceAssistantService({
          speechClient: undefined as unknown as SpeechClient,
          schemeAssistant: makeSchemeAssistant(),
        }),
    ).toThrow(/speechClient/);
  });

  it('rejects missing schemeAssistant', () => {
    expect(
      () =>
        new VoiceAssistantService({
          speechClient: makeSpeechClient(),
          schemeAssistant: undefined as unknown as SchemeAssistantLike,
        }),
    ).toThrow(/schemeAssistant/);
  });
});
