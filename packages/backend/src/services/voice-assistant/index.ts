/**
 * Voice Assistant module barrel.
 *
 * Re-exports the service, the Azure adapter, and a small factory used by
 * production wiring to construct the {@link VoiceAssistantService} with
 * Azure-backed STT/TTS. Tests should import the symbols they need
 * directly from `./voice-assistant` so the Azure adapter is never loaded.
 */

export {
  AZURE_LOCALE_BY_LANGUAGE,
  AZURE_VOICE_BY_LANGUAGE,
  MAX_VOICE_RETRIES,
  MIN_CONFIDENCE_PERCENT,
  SpeechServiceUnavailableError,
  TTS_AUDIO_MIME_TYPE,
  VoiceAssistantService,
} from './voice-assistant';
export type {
  ProcessVoiceQueryInput,
  SchemeAssistantLike,
  SpeechClient,
  SpeechRecognitionResult,
  VoiceAssistantDeps,
  VoiceAssistantOptions,
  VoiceQueryFallbackText,
  VoiceQueryLowConfidence,
  VoiceQueryServiceUnavailable,
  VoiceQuerySuccess,
  VoiceQueryVerdict,
} from './voice-assistant';
export { createAzureSpeechClient } from './azure-speech-client';
export type { AzureSpeechClientConfig } from './azure-speech-client';

import { VoiceAssistantService, type SchemeAssistantLike } from './voice-assistant';
import {
  createAzureSpeechClient,
  type AzureSpeechClientConfig,
} from './azure-speech-client';

/**
 * Builds a production {@link VoiceAssistantService} backed by Azure
 * Cognitive Services Speech. Pulls credentials from `AZURE_SPEECH_KEY` /
 * `AZURE_SPEECH_REGION` unless overrides are supplied — useful for the
 * Fastify wiring in `app.ts`.
 *
 * Throws if the credentials are missing so production deployments fail
 * loudly rather than silently routing every voice query to a dead
 * service.
 */
export function createVoiceAssistantService(args: {
  schemeAssistant: SchemeAssistantLike;
  config?: Partial<AzureSpeechClientConfig>;
}): VoiceAssistantService {
  const subscriptionKey =
    args.config?.subscriptionKey ?? process.env.AZURE_SPEECH_KEY ?? '';
  const region = args.config?.region ?? process.env.AZURE_SPEECH_REGION ?? '';

  if (!subscriptionKey || !region) {
    throw new Error(
      'createVoiceAssistantService: AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must be configured',
    );
  }

  const speechClient = createAzureSpeechClient({ subscriptionKey, region });
  return new VoiceAssistantService({
    speechClient,
    schemeAssistant: args.schemeAssistant,
  });
}
