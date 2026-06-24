/**
 * Modern AI assistant chat — Linear/ChatGPT-inspired interface.
 */

'use client';

import { useState, useRef, useEffect } from 'react';
import { useSession } from 'next-auth/react';

interface SourceCitation {
  schemeId: string;
  schemeName: string;
  sourceUrl: string;
  lastUpdated: string | null;
}

interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  sources?: SourceCitation[];
  traceId?: string;
}

const SUGGESTIONS = [
  'What is PM Kisan and how do I apply?',
  'Which schemes provide health insurance?',
  'What schemes are available for women entrepreneurs?',
  'How can a farmer get financial help?',
];

export default function AssistantPage() {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId] = useState(
    () => `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    setError(null);
    setMessages((m) => [...m, { role: 'user', content: trimmed }]);
    setInput('');
    setIsLoading(true);

    try {
      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';
      const res = await fetch(`${backendUrl}/api/assistant/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed, sessionId }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message || `Request failed (${res.status})`);
        setMessages((m) => [
          ...m,
          {
            role: 'assistant',
            content: `Sorry, I had trouble answering that. ${data.message || ''}`,
          },
        ]);
        return;
      }

      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content: data.answer,
          sources: data.sources,
          traceId: data.traceId,
        },
      ]);
    } catch {
      setError('Unable to reach the assistant. Please try again.');
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    send(input);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  const hasMessages = messages.length > 0;

  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={{
        maxWidth: 820,
        margin: '0 auto',
        padding: '32px 16px 0',
        minHeight: 'calc(100vh - 160px)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* HEADER ──────────────────────────────────────────────────── */}
      <div style={{ marginBottom: hasMessages ? 24 : 48, textAlign: hasMessages ? 'left' : 'center' }}>
        {!hasMessages && (
          <div
            aria-hidden="true"
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6, #d946ef)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: 26,
              fontWeight: 700,
              marginBottom: 24,
              boxShadow: '0 8px 24px rgba(99, 102, 241, 0.35)',
              animation: 'pulse-glow 3s ease-in-out infinite',
            }}
          >
            ✦
          </div>
        )}
        <h1
          style={{
            fontSize: hasMessages ? 22 : 'clamp(28px, 5vw, 40px)',
            margin: '0 0 8px',
            letterSpacing: '-0.03em',
            fontWeight: 700,
          }}
        >
          {hasMessages ? 'Scheme Assistant' : 'How can I help you today?'}
        </h1>
        {!hasMessages && (
          <p style={{ color: '#71717a', margin: 0, fontSize: 16 }}>
            Ask anything about Indian government welfare schemes.
          </p>
        )}
      </div>

      {/* SUGGESTIONS (initial state only) ────────────────────────── */}
      {!hasMessages && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 10,
            marginBottom: 32,
          }}
        >
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => send(s)}
              disabled={isLoading}
              style={{
                padding: '14px 16px',
                background: '#fff',
                border: '1px solid #e4e4e7',
                borderRadius: 12,
                textAlign: 'left',
                fontSize: 14,
                color: '#52525b',
                cursor: 'pointer',
                transition: 'all 0.2s',
                fontFamily: 'inherit',
                lineHeight: 1.4,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = '#6366f1';
                e.currentTarget.style.color = '#09090b';
                e.currentTarget.style.background = '#fafafa';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = '#e4e4e7';
                e.currentTarget.style.color = '#52525b';
                e.currentTarget.style.background = '#fff';
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* MESSAGES ───────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 24 }}>
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}

        {isLoading && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <Avatar speaker="assistant" />
            <div
              style={{
                padding: '14px 16px',
                background: '#fafafa',
                border: '1px solid #e4e4e7',
                borderRadius: 14,
                display: 'inline-flex',
                gap: 4,
              }}
            >
              <Dot delay="0s" />
              <Dot delay="0.15s" />
              <Dot delay="0.3s" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div
          role="alert"
          style={{
            margin: '12px 0',
            padding: '10px 14px',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            background: 'rgba(239, 68, 68, 0.05)',
            color: '#dc2626',
            borderRadius: 10,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {/* INPUT BAR ──────────────────────────────────────────────── */}
      <form
        onSubmit={handleSubmit}
        style={{
          position: 'sticky',
          bottom: 16,
          marginTop: 24,
          marginBottom: 16,
          padding: 6,
          background: 'rgba(255, 255, 255, 0.85)',
          backdropFilter: 'saturate(180%) blur(20px)',
          WebkitBackdropFilter: 'saturate(180%) blur(20px)',
          border: '1px solid #e4e4e7',
          borderRadius: 16,
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.06)',
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
        }}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about a scheme..."
          disabled={isLoading}
          rows={1}
          aria-label="Your question"
          style={{
            flex: 1,
            minHeight: 44,
            maxHeight: 200,
            padding: '12px 14px',
            border: 'none',
            background: 'transparent',
            fontSize: 15,
            color: '#09090b',
            resize: 'none',
            fontFamily: 'inherit',
            outline: 'none',
            boxShadow: 'none',
          }}
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          aria-label="Send message"
          style={{
            width: 40,
            height: 40,
            border: 'none',
            borderRadius: 10,
            background:
              isLoading || !input.trim()
                ? '#e4e4e7'
                : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            color: '#fff',
            cursor: isLoading || !input.trim() ? 'not-allowed' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            transition: 'all 0.2s',
            flexShrink: 0,
            boxShadow: isLoading || !input.trim() ? 'none' : '0 4px 12px rgba(99, 102, 241, 0.4)',
          }}
        >
          <span aria-hidden="true">↑</span>
        </button>
      </form>
    </main>
  );
}

/* ─── Components ───────────────────────────────────────────────────── */

function MessageBubble({ message }: { message: AssistantMessage }) {
  const isUser = message.role === 'user';
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        flexDirection: isUser ? 'row-reverse' : 'row',
        animation: 'fadeUp 0.3s var(--ease)',
      }}
    >
      <Avatar speaker={message.role} />
      <div style={{ maxWidth: '75%', minWidth: 0 }}>
        <div
          style={{
            padding: '12px 16px',
            background: isUser
              ? 'linear-gradient(135deg, #6366f1, #8b5cf6)'
              : '#fafafa',
            color: isUser ? '#fff' : '#09090b',
            border: isUser ? 'none' : '1px solid #e4e4e7',
            borderRadius: 14,
            fontSize: 15,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {message.content}
        </div>

        {message.sources && message.sources.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <p
              style={{
                margin: '0 0 8px',
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: '#71717a',
              }}
            >
              Sources
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {message.sources.map((s, j) => (
                <a
                  key={j}
                  href={s.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    background: '#fff',
                    border: '1px solid #e4e4e7',
                    borderRadius: 10,
                    fontSize: 13,
                    color: '#52525b',
                    textDecoration: 'none',
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = '#6366f1';
                    e.currentTarget.style.color = '#4338ca';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = '#e4e4e7';
                    e.currentTarget.style.color = '#52525b';
                  }}
                >
                  <span aria-hidden="true" style={{ fontSize: 11 }}>↗</span>
                  <span style={{ flex: 1, fontWeight: 500 }}>{s.schemeName}</span>
                  {s.lastUpdated && (
                    <span style={{ fontSize: 11, color: '#a1a1aa' }}>
                      {new Date(s.lastUpdated).toLocaleDateString()}
                    </span>
                  )}
                </a>
              ))}
            </div>
          </div>
        )}

        {!isUser && message.traceId && (
          <FeedbackWidget traceId={message.traceId} />
        )}
      </div>
    </div>
  );
}

function Avatar({ speaker }: { speaker: 'user' | 'assistant' }) {
  const isUser = speaker === 'user';
  return (
    <div
      aria-hidden="true"
      style={{
        width: 32,
        height: 32,
        borderRadius: 10,
        flexShrink: 0,
        background: isUser
          ? '#27272a'
          : 'linear-gradient(135deg, #6366f1, #8b5cf6, #d946ef)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 14,
        fontWeight: 700,
        boxShadow: isUser ? 'none' : '0 2px 8px rgba(99, 102, 241, 0.3)',
      }}
    >
      {isUser ? 'U' : '✦'}
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      style={{
        width: 6,
        height: 6,
        background: '#a1a1aa',
        borderRadius: '50%',
        display: 'inline-block',
        animation: `pulse-dot 1.4s infinite ease-in-out`,
        animationDelay: delay,
      }}
    />
  );
}

/**
 * Helpful / unhelpful rating widget shown under each assistant response
 * (Req 21.3). Posts to `POST /api/assistant/feedback` with the bearer
 * token from the active NextAuth session — the route requires auth.
 *
 * The widget collapses to a thank-you note after submission so the
 * citizen can't accidentally double-rate. We deliberately do NOT
 * render anything when the user is signed-out: feedback collection
 * relies on having a userId to attribute the rating to.
 */
function FeedbackWidget({ traceId }: { traceId: string }) {
  const { data: session, status } = useSession();
  const [submitted, setSubmitted] = useState<'helpful' | 'unhelpful' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status !== 'authenticated') return null;

  async function rate(rating: 'helpful' | 'unhelpful') {
    if (busy || submitted) return;
    setError(null);
    setBusy(true);
    try {
      const token = (session as unknown as { backendToken?: string })?.backendToken;
      if (!token) {
        setError('Sign in again to leave feedback.');
        return;
      }
      const backendUrl =
        process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';
      const res = await fetch(`${backendUrl}/api/assistant/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ traceId, rating }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || `Couldn't record rating (${res.status})`);
        return;
      }
      setSubmitted(rating);
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  if (submitted) {
    return (
      <p
        style={{
          margin: '10px 0 0',
          fontSize: 12,
          color: '#71717a',
        }}
      >
        Thanks for the feedback.
      </p>
    );
  }

  return (
    <div
      style={{
        marginTop: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12,
        color: '#71717a',
      }}
    >
      <span>Was this helpful?</span>
      <button
        type="button"
        aria-label="Rate this response helpful"
        disabled={busy}
        onClick={() => rate('helpful')}
        style={{
          padding: '4px 10px',
          background: '#fff',
          border: '1px solid #e4e4e7',
          borderRadius: 8,
          fontSize: 13,
          cursor: busy ? 'not-allowed' : 'pointer',
          color: '#15633a',
        }}
      >
        👍 Helpful
      </button>
      <button
        type="button"
        aria-label="Rate this response unhelpful"
        disabled={busy}
        onClick={() => rate('unhelpful')}
        style={{
          padding: '4px 10px',
          background: '#fff',
          border: '1px solid #e4e4e7',
          borderRadius: 8,
          fontSize: 13,
          cursor: busy ? 'not-allowed' : 'pointer',
          color: '#b1232b',
        }}
      >
        👎 Not helpful
      </button>
      {error && (
        <span role="alert" style={{ color: '#dc2626' }}>
          {error}
        </span>
      )}
    </div>
  );
}
