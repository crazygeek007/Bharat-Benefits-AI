'use client';

/**
 * Voice Assistant client component (Requirement 13).
 *
 * Captures audio from the citizen's microphone using `MediaRecorder`,
 * sends it to the backend `/api/voice/query` endpoint, and renders the
 * verdict that comes back:
 *
 *   - `ok`        → plays the synthesised audio response and shows the
 *                    transcript + textual answer (Req 13.3).
 *   - `low_confidence` → displays a "please repeat" prompt with the
 *                    remaining retry count (Req 13.5).
 *   - `fallback_text` → swaps the UI to a textarea so the citizen can
 *                    type their question instead (Req 13.6).
 *   - `service_unavailable` → shows an error banner and surfaces the
 *                    text fallback as a secondary input (Req 13.7).
 *
 * The component intentionally avoids any extra UI library so it can drop
 * into existing pages without new build dependencies. Styles are inline
 * and keep the same design language as the other components in this
 * package.
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { SupportedLanguage } from '@bharat-benefits/shared';
import {
  audioBase64ToBlobUrl,
  postVoiceQuery,
  type VoiceQueryResponse,
} from '../lib/voice-api';

export interface VoiceAssistantProps {
  /** Conversation/session id forwarded to the Scheme Assistant. */
  sessionId: string;
  /** Citizen's selected language (defaults to English). */
  language?: SupportedLanguage;
  /** Optional handler invoked after every verdict (analytics hook). */
  onVerdict?: (verdict: VoiceQueryResponse) => void;
  /** Callback invoked when the citizen sends a typed fallback question. */
  onTextSubmit?: (text: string) => Promise<void> | void;
}

/** Browser MIME type used for MediaRecorder; falls back to default if unsupported. */
const PREFERRED_RECORDER_MIME = 'audio/webm;codecs=opus';

/** Internal UI mode driven by the latest verdict / interaction. */
type Mode =
  | 'idle'
  | 'recording'
  | 'submitting'
  | 'success'
  | 'low_confidence'
  | 'fallback_text'
  | 'service_unavailable'
  | 'error';

const containerStyle: CSSProperties = {
  border: '1px solid #d0d7de',
  borderRadius: 8,
  padding: 16,
  background: '#fff',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minWidth: 280,
};

const buttonStyle: CSSProperties = {
  padding: '10px 16px',
  borderRadius: 6,
  border: 'none',
  fontSize: 15,
  cursor: 'pointer',
  background: '#0b5394',
  color: '#fff',
};

const stopButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: '#b00020',
};

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: '#9aa0a6',
  cursor: 'not-allowed',
};

const fallbackInputStyle: CSSProperties = {
  width: '100%',
  minHeight: 80,
  padding: 8,
  border: '1px solid #d0d7de',
  borderRadius: 4,
  fontSize: 15,
  resize: 'vertical',
};

const bannerStyle = (variant: 'info' | 'warn' | 'error'): CSSProperties => ({
  padding: 10,
  borderRadius: 4,
  fontSize: 14,
  border: '1px solid',
  borderColor:
    variant === 'error' ? '#b00020' : variant === 'warn' ? '#bf8700' : '#0b5394',
  background:
    variant === 'error' ? '#fdecea' : variant === 'warn' ? '#fff8e1' : '#e7f0fb',
  color: '#1a1a1a',
});

export function VoiceAssistant(props: VoiceAssistantProps): JSX.Element {
  const { sessionId, language = 'en', onVerdict, onTextSubmit } = props;

  const [mode, setMode] = useState<Mode>('idle');
  const [verdict, setVerdict] = useState<VoiceQueryResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(1);
  const [fallbackText, setFallbackText] = useState('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Revoke any previously created blob URL when a new verdict arrives or
  // the component unmounts to prevent leaks.
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetVerdictState(): void {
    setVerdict(null);
    setErrorMessage(null);
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
  }

  function teardownStream(): void {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
  }

  async function startRecording(): Promise<void> {
    resetVerdictState();
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      setErrorMessage(
        'Microphone access is not available in this browser. Please type your question instead.',
      );
      setMode('service_unavailable');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const options: MediaRecorderOptions =
        typeof MediaRecorder !== 'undefined' &&
        MediaRecorder.isTypeSupported &&
        MediaRecorder.isTypeSupported(PREFERRED_RECORDER_MIME)
          ? { mimeType: PREFERRED_RECORDER_MIME }
          : {};
      const recorder = new MediaRecorder(stream, options);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const mime = options.mimeType ?? recorder.mimeType ?? 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: mime });
        teardownStream();
        void submitRecording(blob);
      };
      recorder.start();
      recorderRef.current = recorder;
      setMode('recording');
    } catch (err) {
      teardownStream();
      setErrorMessage(
        err instanceof Error
          ? `Could not access the microphone: ${err.message}`
          : 'Could not access the microphone',
      );
      setMode('error');
    }
  }

  function stopRecording(): void {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    setMode('submitting');
  }

  async function submitRecording(blob: Blob): Promise<void> {
    if (blob.size === 0) {
      setErrorMessage(
        'No audio was captured. Please try again or type your question.',
      );
      setMode('error');
      return;
    }
    try {
      const response = await postVoiceQuery({
        audio: blob,
        language,
        sessionId,
        attempt,
      });
      setVerdict(response);
      onVerdict?.(response);
      handleVerdict(response);
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? `Voice request failed: ${err.message}`
          : 'Voice request failed',
      );
      setMode('error');
    }
  }

  function handleVerdict(v: VoiceQueryResponse): void {
    switch (v.status) {
      case 'ok': {
        const url = audioBase64ToBlobUrl(v.audioBase64, v.audioMimeType);
        setAudioUrl(url);
        setAttempt(1);
        setMode('success');
        return;
      }
      case 'low_confidence':
        setAttempt(v.attempt + 1);
        setMode('low_confidence');
        return;
      case 'fallback_text':
        setAttempt(1);
        setMode('fallback_text');
        if (v.transcript) setFallbackText(v.transcript);
        return;
      case 'service_unavailable':
        setAttempt(1);
        setMode('service_unavailable');
        return;
      default:
        setMode('error');
    }
  }

  async function handleFallbackSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const trimmed = fallbackText.trim();
    if (!trimmed || !onTextSubmit) return;
    await onTextSubmit(trimmed);
  }

  const isRecording = mode === 'recording';
  const isSubmitting = mode === 'submitting';

  return (
    <div style={containerStyle} role="region" aria-label="Voice assistant">
      <div>
        <strong>Voice Assistant</strong>
        <div style={{ fontSize: 12, color: '#586069' }}>
          Language: {language.toUpperCase()}
        </div>
      </div>

      <div>
        {!isRecording && !isSubmitting && (
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void startRecording()}
            aria-label="Start voice recording"
          >
            🎙 Start recording
          </button>
        )}
        {isRecording && (
          <button
            type="button"
            style={stopButtonStyle}
            onClick={stopRecording}
            aria-label="Stop voice recording"
          >
            ◼ Stop & send
          </button>
        )}
        {isSubmitting && (
          <button type="button" style={disabledButtonStyle} disabled>
            Processing…
          </button>
        )}
      </div>

      {mode === 'low_confidence' && verdict?.status === 'low_confidence' && (
        <div style={bannerStyle('warn')} role="status">
          I couldn&apos;t understand that clearly (confidence{' '}
          {Math.round(verdict.confidence)}%). Please try again — you have{' '}
          {verdict.retriesRemaining}{' '}
          {verdict.retriesRemaining === 1 ? 'retry' : 'retries'} left.
        </div>
      )}

      {mode === 'fallback_text' && verdict?.status === 'fallback_text' && (
        <div style={bannerStyle('warn')} role="status">
          {verdict.message}
        </div>
      )}

      {mode === 'service_unavailable' && (
        <div style={bannerStyle('error')} role="alert">
          The voice feature is temporarily unavailable. Please type your question
          below.
        </div>
      )}

      {mode === 'error' && errorMessage && (
        <div style={bannerStyle('error')} role="alert">
          {errorMessage}
        </div>
      )}

      {mode === 'success' && verdict?.status === 'ok' && (
        <div>
          <div style={{ fontSize: 13, color: '#586069', marginBottom: 6 }}>
            You said: <em>{verdict.transcript}</em>
          </div>
          {audioUrl && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <audio src={audioUrl} controls autoPlay aria-label="Assistant response audio" />
          )}
          <div style={{ marginTop: 8 }}>{verdict.answer}</div>
          {verdict.sources.length > 0 && (
            <ul style={{ marginTop: 8, paddingLeft: 18, fontSize: 13 }}>
              {verdict.sources.map((src) => (
                <li key={src.schemeId}>
                  <a href={src.sourceUrl} target="_blank" rel="noreferrer">
                    {src.schemeName}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(mode === 'fallback_text' || mode === 'service_unavailable') &&
        onTextSubmit && (
          <form onSubmit={(event) => void handleFallbackSubmit(event)}>
            <label htmlFor="voice-fallback-text" style={{ fontSize: 13 }}>
              Type your question
            </label>
            <textarea
              id="voice-fallback-text"
              style={fallbackInputStyle}
              value={fallbackText}
              onChange={(event) => setFallbackText(event.target.value)}
              aria-label="Fallback question text"
            />
            <button type="submit" style={{ ...buttonStyle, marginTop: 8 }}>
              Send question
            </button>
          </form>
        )}
    </div>
  );
}

export default VoiceAssistant;
