/**
 * HTTP routes for the Voice Assistant (Requirement 13).
 *
 * Exposes:
 *   - `POST /api/voice/query` — accepts a base64-encoded audio sample
 *     captured from the citizen's microphone, transcribes it, runs the
 *     query through the Scheme Assistant, and returns a synthesised
 *     audio response (Req 13.1, 13.2, 13.3).
 *
 * The route deliberately uses base64 JSON instead of multipart so the
 * backend does not have to take a runtime dependency on
 * `@fastify/multipart`. The browser captures the recording with
 * MediaRecorder, base64-encodes it, and posts the JSON body.
 *
 * The handler returns a discriminated response shape that mirrors
 * {@link VoiceQueryVerdict} so the frontend can map each outcome to a
 * different UX state:
 *   - `200 ok` — full success, audio + transcript + answer attached.
 *   - `200 low_confidence` — transcript was recognised but confidence
 *     was below 50%; the UI should ask the citizen to repeat (Req 13.5).
 *   - `200 fallback_text` — citizen has exhausted retries; the UI swaps
 *     to text input (Req 13.6).
 *   - `503 service_unavailable` — Azure STT/TTS is unreachable; the UI
 *     surfaces an error and offers text-based interaction (Req 13.7).
 *   - `400 bad_request` — malformed input (missing audio, bad language).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  TTS_AUDIO_MIME_TYPE,
  type ProcessVoiceQueryInput,
  type VoiceAssistantService,
  type VoiceQueryVerdict,
} from '../services/voice-assistant/voice-assistant';
import { MAX_AUDIO_BASE64_BYTES, VoiceQueryBodySchema } from '../schemas/voice.schemas';
import { parseOrReply } from '../lib/validation';

/**
 * Per-route rate limit. Voice queries hit Azure STT/TTS and Gemini, every
 * call costs money, and a malicious caller can DoS the spend cap. 30
 * requests per minute per IP is generous for a real citizen and tight
 * enough to bound damage.
 */
const VOICE_QUERY_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

export interface RegisterVoiceRoutesOptions {
  /**
   * Provides the {@link VoiceAssistantService} for the route. The factory
   * is invoked lazily so production wiring can defer Azure SDK loading
   * to first use, and tests can return a stub without standing up the
   * real service.
   */
  service: VoiceAssistantService | (() => VoiceAssistantService);
}

export function registerVoiceRoutes(
  app: FastifyInstance,
  options: RegisterVoiceRoutesOptions,
): void {
  const resolveService = (): VoiceAssistantService =>
    typeof options.service === 'function'
      ? (options.service as () => VoiceAssistantService)()
      : options.service;

  app.post(
    '/api/voice/query',
    { config: { rateLimit: VOICE_QUERY_RATE_LIMIT } },
    async (request: FastifyRequest, reply) => {
      const parsed = parseOrReply(VoiceQueryBodySchema, request.body, reply);
      if (!parsed) return reply;
      const { audio: audioBase64, language, sessionId, attempt } = parsed.data;

      // Length is also enforced by the schema, but we keep an explicit
      // 413 here so the caller gets the more specific status code rather
      // than the generic 400 the validator would return.
      if (audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
        return reply.code(413).send({
          error: 'PayloadTooLarge',
          message: 'audio payload exceeds the 5 MB limit',
        });
      }

      let audio: Buffer;
      try {
        audio = Buffer.from(audioBase64, 'base64');
      } catch (err) {
        request.log.warn({ err }, 'failed to decode audio payload');
        return reply.code(400).send({
          error: 'BadRequest',
          message: 'audio must be valid base64',
        });
      }
      if (audio.length === 0) {
        return reply.code(400).send({
          error: 'BadRequest',
          message: 'audio decoded to an empty buffer',
        });
      }

      const input: ProcessVoiceQueryInput = {
        audio,
        language,
        sessionId,
        attempt,
      };

      let verdict: VoiceQueryVerdict;
      try {
        verdict = await resolveService().processVoiceQuery(input);
      } catch (err) {
        request.log.error({ err }, 'voice query failed');
        return reply.code(500).send({
          error: 'InternalError',
          message: 'Voice query failed unexpectedly',
        });
      }

      return reply.code(statusCodeForVerdict(verdict)).send(serialiseVerdict(verdict));
    },
  );
}

// ─── Verdict serialisation ───────────────────────────────────────────────────

/**
 * Maps a verdict to an HTTP status code. We keep the logical outcomes on
 * `200` so the frontend can branch on `status` without parsing two
 * different error shapes — only Azure unavailability surfaces as `503`.
 */
function statusCodeForVerdict(verdict: VoiceQueryVerdict): number {
  if (verdict.status === 'service_unavailable') return 503;
  return 200;
}

/**
 * Translates the in-memory verdict to a JSON-friendly shape. Audio
 * buffers are base64-encoded so the browser can decode them with
 * `atob` + `Blob` and play them through the `<audio>` element.
 */
function serialiseVerdict(verdict: VoiceQueryVerdict): Record<string, unknown> {
  switch (verdict.status) {
    case 'ok':
      return {
        status: 'ok',
        transcript: verdict.transcript,
        confidence: verdict.confidence,
        language: verdict.language,
        answer: verdict.answer,
        sources: verdict.sources,
        audioBase64: verdict.audio.toString('base64'),
        audioMimeType: verdict.audioMimeType ?? TTS_AUDIO_MIME_TYPE,
        traceId: verdict.traceId,
      };
    case 'low_confidence':
      return {
        status: 'low_confidence',
        transcript: verdict.transcript,
        confidence: verdict.confidence,
        language: verdict.language,
        attempt: verdict.attempt,
        retriesRemaining: verdict.retriesRemaining,
      };
    case 'fallback_text':
      return {
        status: 'fallback_text',
        transcript: verdict.transcript,
        language: verdict.language,
        attemptsUsed: verdict.attemptsUsed,
        message: verdict.message,
      };
    case 'service_unavailable':
      return {
        status: 'service_unavailable',
        language: verdict.language,
        failedStage: verdict.failedStage,
        message: verdict.message,
      };
    default:
      return verdict as unknown as Record<string, unknown>;
  }
}
