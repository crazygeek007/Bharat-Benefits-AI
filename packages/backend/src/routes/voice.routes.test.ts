/**
 * HTTP route tests for the Voice Assistant endpoint
 * (`POST /api/voice/query`).
 *
 * Each test wires the route on a fresh Fastify instance with a stub
 * service so the assertions focus on:
 *   - Request validation (audio, language, sessionId, payload size).
 *   - Verdict-to-HTTP mapping (200 ok / low_confidence / fallback_text;
 *     503 service_unavailable; 500 on unexpected errors).
 *   - Audio is base64-encoded on the wire (Req 13.3).
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerVoiceRoutes } from './voice.routes';
import {
  TTS_AUDIO_MIME_TYPE,
  type ProcessVoiceQueryInput,
  type VoiceAssistantService,
  type VoiceQueryVerdict,
} from '../services/voice-assistant/voice-assistant';

interface ServiceStubOptions {
  verdict?: VoiceQueryVerdict;
  throwError?: Error;
  capture?: { input?: ProcessVoiceQueryInput };
}

function makeServiceStub(opts: ServiceStubOptions): VoiceAssistantService {
  return {
    async processVoiceQuery(input: ProcessVoiceQueryInput): Promise<VoiceQueryVerdict> {
      if (opts.capture) opts.capture.input = input;
      if (opts.throwError) throw opts.throwError;
      return (
        opts.verdict ?? {
          status: 'ok',
          transcript: '',
          confidence: 100,
          language: 'en',
          answer: 'noop',
          sources: [],
          audio: Buffer.alloc(0),
          audioMimeType: TTS_AUDIO_MIME_TYPE,
          traceId: 't',
        }
      );
    },
  } as unknown as VoiceAssistantService;
}

async function buildAppWithService(
  service: VoiceAssistantService,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerVoiceRoutes(app, { service });
  await app.ready();
  return app;
}

const AUDIO_BASE64 = Buffer.from('hello-world').toString('base64');

describe('POST /api/voice/query — input validation', () => {
  it('rejects missing audio', async () => {
    const app = await buildAppWithService(makeServiceStub({}));
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/query',
      payload: { language: 'en', sessionId: 's1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/audio is required/);
  });

  it('rejects missing language', async () => {
    const app = await buildAppWithService(makeServiceStub({}));
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/query',
      payload: { audio: AUDIO_BASE64, sessionId: 's1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/language/);
  });

  it('rejects unsupported languages', async () => {
    const app = await buildAppWithService(makeServiceStub({}));
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/query',
      payload: { audio: AUDIO_BASE64, language: 'fr', sessionId: 's1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing sessionId', async () => {
    const app = await buildAppWithService(makeServiceStub({}));
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/query',
      payload: { audio: AUDIO_BASE64, language: 'en' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/sessionId/);
  });

  it('rejects an audio payload that decodes to zero bytes', async () => {
    const app = await buildAppWithService(makeServiceStub({}));
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/query',
      payload: { audio: '   ', language: 'en', sessionId: 's1' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/voice/query — verdict serialisation', () => {
  it('serialises an `ok` verdict with base64 audio and 200 status', async () => {
    const audio = Buffer.from([10, 20, 30]);
    const app = await buildAppWithService(
      makeServiceStub({
        verdict: {
          status: 'ok',
          transcript: 'How do I apply?',
          confidence: 92,
          language: 'en',
          answer: 'Apply at pmkisan.gov.in.',
          sources: [
            {
              schemeId: 'scheme-1',
              schemeName: 'PM Kisan',
              sourceUrl: 'https://pmkisan.gov.in',
              lastUpdated: new Date('2025-01-15T00:00:00Z'),
            },
          ],
          audio,
          audioMimeType: TTS_AUDIO_MIME_TYPE,
          traceId: 'trace-1',
        },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/query',
      payload: { audio: AUDIO_BASE64, language: 'en', sessionId: 's1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.audioBase64).toBe(audio.toString('base64'));
    expect(body.audioMimeType).toBe(TTS_AUDIO_MIME_TYPE);
    expect(body.transcript).toBe('How do I apply?');
    expect(body.answer).toBe('Apply at pmkisan.gov.in.');
    expect(body.sources).toHaveLength(1);
  });

  it('returns 200 for `low_confidence` and includes retry info', async () => {
    const app = await buildAppWithService(
      makeServiceStub({
        verdict: {
          status: 'low_confidence',
          transcript: 'mumble',
          confidence: 30,
          language: 'hi',
          attempt: 2,
          retriesRemaining: 1,
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/query',
      payload: {
        audio: AUDIO_BASE64,
        language: 'hi',
        sessionId: 's1',
        attempt: 2,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('low_confidence');
    expect(body.attempt).toBe(2);
    expect(body.retriesRemaining).toBe(1);
  });

  it('returns 200 for `fallback_text` and includes the diagnostic message', async () => {
    const app = await buildAppWithService(
      makeServiceStub({
        verdict: {
          status: 'fallback_text',
          transcript: 'mumble',
          language: 'en',
          attemptsUsed: 3,
          message: 'fallback',
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/query',
      payload: { audio: AUDIO_BASE64, language: 'en', sessionId: 's1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('fallback_text');
    expect(body.attemptsUsed).toBe(3);
  });

  it('returns 503 for `service_unavailable`', async () => {
    const app = await buildAppWithService(
      makeServiceStub({
        verdict: {
          status: 'service_unavailable',
          language: 'en',
          failedStage: 'stt',
          message: 'down',
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/query',
      payload: { audio: AUDIO_BASE64, language: 'en', sessionId: 's1' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('service_unavailable');
  });

  it('returns 500 on unexpected service errors', async () => {
    const app = await buildAppWithService(
      makeServiceStub({ throwError: new Error('unexpected') }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/query',
      payload: { audio: AUDIO_BASE64, language: 'en', sessionId: 's1' },
    });
    expect(res.statusCode).toBe(500);
  });
});

describe('POST /api/voice/query — argument propagation', () => {
  it('decodes audio to a Buffer and forwards language + sessionId + attempt', async () => {
    const capture: { input?: ProcessVoiceQueryInput } = {};
    const app = await buildAppWithService(
      makeServiceStub({
        capture,
        verdict: {
          status: 'ok',
          transcript: '',
          confidence: 100,
          language: 'mr',
          answer: 'x',
          sources: [],
          audio: Buffer.from([1]),
          audioMimeType: TTS_AUDIO_MIME_TYPE,
          traceId: 't',
        },
      }),
    );
    const audioBuf = Buffer.from('citizen-audio-bytes');
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/query',
      payload: {
        audio: audioBuf.toString('base64'),
        language: 'mr',
        sessionId: 'sess-42',
        attempt: 2,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(capture.input).toBeDefined();
    expect(capture.input?.language).toBe('mr');
    expect(capture.input?.sessionId).toBe('sess-42');
    expect(capture.input?.attempt).toBe(2);
    expect(capture.input?.audio.equals(audioBuf)).toBe(true);
  });

  it('defaults attempt to 1 when omitted', async () => {
    const capture: { input?: ProcessVoiceQueryInput } = {};
    const app = await buildAppWithService(
      makeServiceStub({
        capture,
        verdict: {
          status: 'ok',
          transcript: '',
          confidence: 100,
          language: 'en',
          answer: 'x',
          sources: [],
          audio: Buffer.from([1]),
          audioMimeType: TTS_AUDIO_MIME_TYPE,
          traceId: 't',
        },
      }),
    );
    await app.inject({
      method: 'POST',
      url: '/api/voice/query',
      payload: { audio: AUDIO_BASE64, language: 'en', sessionId: 's1' },
    });
    expect(capture.input?.attempt).toBe(1);
  });
});
