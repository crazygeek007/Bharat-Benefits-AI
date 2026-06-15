/**
 * Frontend client for the Voice Assistant endpoint
 * (`POST /api/voice/query`).
 *
 * Mirrors the discriminated verdict shape used by the backend so the UI
 * can switch on `status` to render success / retry / fallback / error
 * states (Req 13.5–13.7).
 */

import type { SourceCitation, SupportedLanguage } from '@bharat-benefits/shared';

function getBackendBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    process.env.BACKEND_URL ||
    'http://localhost:4000'
  );
}

/** Successful end-to-end voice exchange. */
export interface VoiceQuerySuccessResponse {
  status: 'ok';
  transcript: string;
  confidence: number;
  language: SupportedLanguage;
  answer: string;
  sources: SourceCitation[];
  audioBase64: string;
  audioMimeType: string;
  traceId: string;
}

export interface VoiceQueryLowConfidenceResponse {
  status: 'low_confidence';
  transcript: string;
  confidence: number;
  language: SupportedLanguage;
  attempt: number;
  retriesRemaining: number;
}

export interface VoiceQueryFallbackTextResponse {
  status: 'fallback_text';
  transcript: string;
  language: SupportedLanguage;
  attemptsUsed: number;
  message: string;
}

export interface VoiceQueryServiceUnavailableResponse {
  status: 'service_unavailable';
  language: SupportedLanguage;
  failedStage: 'stt' | 'tts';
  message: string;
}

export type VoiceQueryResponse =
  | VoiceQuerySuccessResponse
  | VoiceQueryLowConfidenceResponse
  | VoiceQueryFallbackTextResponse
  | VoiceQueryServiceUnavailableResponse;

export interface PostVoiceQueryArgs {
  audio: Blob;
  language: SupportedLanguage;
  sessionId: string;
  attempt?: number;
}

/**
 * Convert a Blob to a base64 string. Used to transport recorded audio
 * over the JSON API without standing up multipart on the backend.
 */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Avoid the 65,535-argument call limit by chunking.
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
}

/**
 * POSTs a captured audio blob to the backend voice endpoint and returns
 * the parsed verdict. Throws only on network errors — protocol-level
 * verdicts (low_confidence, fallback_text, service_unavailable) flow
 * through the discriminated union.
 */
export async function postVoiceQuery(
  args: PostVoiceQueryArgs,
): Promise<VoiceQueryResponse> {
  const audioBase64 = await blobToBase64(args.audio);
  const url = `${getBackendBaseUrl()}/api/voice/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio: audioBase64,
      language: args.language,
      sessionId: args.sessionId,
      attempt: args.attempt ?? 1,
    }),
  });

  // 503 (service_unavailable) carries a structured body; everything else
  // we treat as JSON too. A non-JSON 5xx surfaces as a synthesised
  // service-unavailable verdict so the UI degrades gracefully.
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (body && typeof body === 'object' && 'status' in (body as Record<string, unknown>)) {
    return body as VoiceQueryResponse;
  }

  if (!res.ok) {
    return {
      status: 'service_unavailable',
      language: args.language,
      failedStage: 'stt',
      message: `Voice service returned HTTP ${res.status}`,
    };
  }

  return {
    status: 'service_unavailable',
    language: args.language,
    failedStage: 'stt',
    message: 'Voice service returned an unexpected response',
  };
}

/** Decode a base64 audio payload to a playable Blob URL. */
export function audioBase64ToBlobUrl(
  base64: string,
  mimeType: string,
): string {
  const binary =
    typeof atob === 'function'
      ? atob(base64)
      : Buffer.from(base64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}
