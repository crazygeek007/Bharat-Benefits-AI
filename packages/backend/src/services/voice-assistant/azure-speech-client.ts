/**
 * Azure Cognitive Services Speech adapter for the Voice Assistant.
 *
 * Production callers wrap this adapter to satisfy the {@link SpeechClient}
 * interface required by {@link VoiceAssistantService}. The adapter
 * lazily imports `microsoft-cognitiveservices-speech-sdk` so unit tests
 * (which inject a fake speech client) never need the SDK installed.
 *
 * The adapter targets a single Azure subscription configured via
 * environment variables — the citizen-facing locale and voice come from
 * the per-call `language` parameter.
 */

import {
  AZURE_LOCALE_BY_LANGUAGE,
  AZURE_VOICE_BY_LANGUAGE,
  SpeechServiceUnavailableError,
  type SpeechClient,
  type SpeechRecognitionResult,
} from './voice-assistant';
import type { SupportedLanguage } from '@bharat-benefits/shared';

/** Configuration required to construct the Azure speech client. */
export interface AzureSpeechClientConfig {
  /** Azure Speech subscription key. */
  subscriptionKey: string;
  /** Azure Speech region (e.g. `centralindia`). */
  region: string;
}

/**
 * Lazily resolves the Azure SDK module. Wrapped in a function so test
 * environments that don't install the SDK can still import the rest of
 * this file (e.g. for the type re-exports) without a require-time
 * crash.
 *
 * The return type is intentionally `any` — the SDK ships its own
 * runtime checks via the `ResultReason` enum we read off the imported
 * module, so we don't need TypeScript to validate the shape statically.
 * This also keeps `tsc --noEmit` working in environments that haven't
 * installed `microsoft-cognitiveservices-speech-sdk`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSdk(): Promise<any> {
  try {
    // Dynamic require avoids a static import the type-checker would
    // need to resolve at compile time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const mod = await import(
      /* @vite-ignore */ 'microsoft-cognitiveservices-speech-sdk' as string
    );
    return mod;
  } catch (err) {
    throw new SpeechServiceUnavailableError(
      'Azure Speech SDK is not installed; install `microsoft-cognitiveservices-speech-sdk` to enable the voice assistant',
      err,
    );
  }
}

/**
 * Build a {@link SpeechClient} backed by Azure Cognitive Services Speech.
 *
 * The returned object is safe to share across requests — each call to
 * `recognize` / `synthesize` constructs its own short-lived recognizer or
 * synthesizer instance so the adapter doesn't accumulate native handles.
 */
export function createAzureSpeechClient(
  config: AzureSpeechClientConfig,
): SpeechClient {
  if (!config.subscriptionKey) {
    throw new Error('createAzureSpeechClient: subscriptionKey is required');
  }
  if (!config.region) {
    throw new Error('createAzureSpeechClient: region is required');
  }

  return {
    async recognize(args: {
      audio: Buffer;
      language: SupportedLanguage;
      locale: string;
    }): Promise<SpeechRecognitionResult> {
      const sdk = await loadSdk();
      const speechConfig = sdk.SpeechConfig.fromSubscription(
        config.subscriptionKey,
        config.region,
      );
      speechConfig.speechRecognitionLanguage =
        args.locale ?? AZURE_LOCALE_BY_LANGUAGE[args.language];
      // Ask for detailed output so we can read the per-result confidence
      // off the JSON payload.
      speechConfig.outputFormat = sdk.OutputFormat.Detailed;

      const audioStream = sdk.AudioInputStream.createPushStream();
      audioStream.write(args.audio);
      audioStream.close();
      const audioConfig = sdk.AudioConfig.fromStreamInput(audioStream);
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      try {
        return await new Promise<SpeechRecognitionResult>((resolve, reject) => {
          recognizer.recognizeOnceAsync(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (result: any) => {
              try {
                if (result.reason === sdk.ResultReason.RecognizedSpeech) {
                  const detail = parseDetailedResult(result);
                  resolve({
                    recognized: true,
                    text: result.text ?? detail.text ?? '',
                    confidence: detail.confidence,
                    detectedLanguage: args.language,
                  });
                  return;
                }
                if (result.reason === sdk.ResultReason.NoMatch) {
                  resolve({ recognized: false, text: '', confidence: 0 });
                  return;
                }
                resolve({
                  recognized: false,
                  text: result.text ?? '',
                  confidence: 0,
                });
              } catch (err) {
                reject(err);
              }
            },
            (errorMessage: string) => {
              reject(
                new SpeechServiceUnavailableError(
                  `Azure STT error: ${errorMessage}`,
                ),
              );
            },
          );
        });
      } finally {
        recognizer.close();
      }
    },

    async synthesize(args: {
      text: string;
      language: SupportedLanguage;
      locale: string;
      voice: string;
    }): Promise<Buffer> {
      const sdk = await loadSdk();
      const speechConfig = sdk.SpeechConfig.fromSubscription(
        config.subscriptionKey,
        config.region,
      );
      speechConfig.speechSynthesisLanguage =
        args.locale ?? AZURE_LOCALE_BY_LANGUAGE[args.language];
      speechConfig.speechSynthesisVoiceName =
        args.voice ?? AZURE_VOICE_BY_LANGUAGE[args.language];
      // Match the MIME type advertised by the service (audio/mpeg).
      speechConfig.speechSynthesisOutputFormat =
        sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

      const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
      try {
        return await new Promise<Buffer>((resolve, reject) => {
          synthesizer.speakTextAsync(
            args.text,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (result: any) => {
              try {
                if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                  const audio = Buffer.from(result.audioData);
                  resolve(audio);
                  return;
                }
                reject(
                  new SpeechServiceUnavailableError(
                    `Azure TTS failed: ${result.errorDetails ?? 'unknown error'}`,
                  ),
                );
              } catch (err) {
                reject(err);
              }
            },
            (errorMessage: string) => {
              reject(
                new SpeechServiceUnavailableError(
                  `Azure TTS error: ${errorMessage}`,
                ),
              );
            },
          );
        });
      } finally {
        synthesizer.close();
      }
    },
  };
}

/**
 * Pulls the textual transcript and confidence out of an Azure detailed
 * recognition result. Detailed mode returns a JSON payload containing an
 * `NBest` list with per-hypothesis confidences in [0, 1]; we promote the
 * top-scoring hypothesis to [0, 100].
 */
function parseDetailedResult(result: {
  text: string;
  json?: string;
  properties?: { getProperty(name: string): string | undefined };
}): { text: string; confidence: number } {
  const fallback = { text: result.text ?? '', confidence: 0 };
  // The detailed payload is exposed either via `result.json` or via a
  // properties bag depending on the SDK version. We try both.
  const raw =
    typeof result.json === 'string' && result.json.length > 0
      ? result.json
      : result.properties?.getProperty(
          'SpeechServiceResponse_JsonResult',
        ) ?? null;
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as {
      DisplayText?: string;
      NBest?: Array<{ Confidence?: number; Display?: string }>;
    };
    const nbest = Array.isArray(parsed.NBest) ? parsed.NBest : [];
    let best = nbest[0];
    for (const hyp of nbest) {
      if (
        typeof hyp.Confidence === 'number' &&
        (best === undefined ||
          (best.Confidence ?? 0) < (hyp.Confidence ?? 0))
      ) {
        best = hyp;
      }
    }
    const conf = typeof best?.Confidence === 'number' ? best.Confidence : 0;
    return {
      text: best?.Display ?? parsed.DisplayText ?? result.text ?? '',
      confidence: Math.max(0, Math.min(100, Math.round(conf * 100))),
    };
  } catch {
    return fallback;
  }
}
