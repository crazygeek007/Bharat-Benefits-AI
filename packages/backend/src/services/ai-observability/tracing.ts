/**
 * OpenTelemetry-compatible distributed tracing for the AI pipeline.
 *
 * The shape of {@link Span} mirrors the OpenTelemetry SDK's `Span`
 * interface (`setAttribute` / `setStatus` / `recordException` / `end`)
 * so that production wiring can swap in `@opentelemetry/api` and
 * `@opentelemetry/sdk-node` without touching call sites.
 *
 * Why not import `@opentelemetry/api` directly?
 *   - The SDK is heavyweight to initialise (exporters, processors,
 *     resource detection) and we want hermetic, fast unit tests.
 *   - Adding a no-op tracer here keeps the production code path linear
 *     while letting us exercise the degraded-trace rule in tests.
 *
 * Validates: Requirements 21.5, 21.7.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { DEGRADED_TRACE_THRESHOLD_MS } from './constants';
import type { FinishedSpan } from './types';

/** Status outcome reported on a span. */
export type SpanStatus = 'ok' | 'error';

/** Lightweight span handle returned to instrumentation call sites. */
export interface Span {
  /** Unique identifier for this span. */
  readonly spanId: string;
  /** Trace identifier shared by every span in the same logical request. */
  readonly traceId: string;
  /** Parent span (when present). */
  readonly parentSpanId: string | null;
  /** Span name (e.g. `"scheme-assistant.answerQuery"`). */
  readonly name: string;
  /** Attach a key/value attribute. Mirrors OpenTelemetry semantics. */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Mark the span as failed; attaches the error message as an attribute. */
  setStatus(status: SpanStatus, message?: string): void;
  /** Convenience for `setStatus('error', err.message)`. */
  recordException(err: Error): void;
  /**
   * Finalise the span. Calling `end` more than once is a no-op so
   * callers can `end` from both happy and exception paths without
   * worrying about double-counting.
   */
  end(): FinishedSpan;
}

/** Sink invoked once per finished span. Tests inject a `vi.fn()`. */
export type SpanExporter = (span: FinishedSpan) => Promise<void> | void;

/**
 * Sink invoked when a finished span exceeds
 * {@link DEGRADED_TRACE_THRESHOLD_MS}. Production wiring routes this
 * to the same admin alerting channel used by {@link HelpfulnessMonitor}.
 *
 * Validates: Requirements 21.7.
 */
export type DegradedTraceSink = (span: FinishedSpan) => Promise<void> | void;

export interface TracerOptions {
  /** Override the degraded threshold (defaults to 10s). */
  degradedThresholdMs?: number;
  /** Inject a clock so tests can advance time deterministically. */
  now?: () => Date;
  /** Inject a UUID generator. Defaults to {@link randomUUID}. */
  generateTraceId?: () => string;
  /** Inject a span-id generator. Defaults to a 16-hex-char id. */
  generateSpanId?: () => string;
}

export class Tracer {
  private readonly degradedThresholdMs: number;
  private readonly now: () => Date;
  private readonly generateTraceId: () => string;
  private readonly generateSpanId: () => string;

  constructor(
    private readonly exporter: SpanExporter = async () => undefined,
    private readonly degradedSink: DegradedTraceSink = async () => undefined,
    options: TracerOptions = {},
  ) {
    this.degradedThresholdMs =
      options.degradedThresholdMs ?? DEGRADED_TRACE_THRESHOLD_MS;
    this.now = options.now ?? (() => new Date());
    this.generateTraceId = options.generateTraceId ?? (() => randomUUID());
    this.generateSpanId =
      options.generateSpanId ?? (() => randomBytes(8).toString('hex'));
  }

  /**
   * Start a new span. If `parent` is provided the new span inherits
   * its `traceId`, otherwise a new trace is opened.
   */
  startSpan(name: string, parent?: { traceId: string; spanId: string }): Span {
    const traceId = parent?.traceId ?? this.generateTraceId();
    const spanId = this.generateSpanId();
    const startedAt = this.now();
    const attributes: Record<string, string | number | boolean> = {};
    let status: SpanStatus = 'ok';
    let errorMessage: string | null = null;
    let ended = false;
    let finished: FinishedSpan | null = null;

    // We capture `this` into a local so the methods on the returned
    // `Span` object can call back into the tracer. Arrow functions
    // inherit `this` lexically but the returned object literal needs
    // method shorthand so we keep the alias and disable the rule.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const tracer = this;

    const span: Span = {
      spanId,
      traceId,
      parentSpanId: parent?.spanId ?? null,
      name,
      setAttribute(key, value) {
        attributes[key] = value;
      },
      setStatus(s, message) {
        status = s;
        if (typeof message === 'string') errorMessage = message;
      },
      recordException(err) {
        status = 'error';
        errorMessage = err.message ?? String(err);
      },
      end(): FinishedSpan {
        if (ended && finished) return finished;
        ended = true;
        const finishedAt = tracer.now();
        const durationMs = finishedAt.getTime() - startedAt.getTime();
        const degraded = durationMs > tracer.degradedThresholdMs;
        finished = {
          traceId,
          spanId,
          parentSpanId: parent?.spanId ?? null,
          name,
          startedAt,
          finishedAt,
          durationMs,
          attributes: { ...attributes },
          status,
          errorMessage,
          degraded,
        };
        // Fire-and-forget the exporter; if it throws we don't want to
        // abort the request that just finished.
        Promise.resolve(tracer.exporter(finished)).catch(() => undefined);
        if (degraded) {
          Promise.resolve(tracer.degradedSink(finished)).catch(() => undefined);
        }
        return finished;
      },
    };
    return span;
  }

  /**
   * Convenience wrapper that runs `fn` inside a span and ends it
   * automatically — including on exceptions, where the span is marked
   * `error` before being re-thrown.
   */
  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    parent?: { traceId: string; spanId: string },
  ): Promise<T> {
    const span = this.startSpan(name, parent);
    try {
      const out = await fn(span);
      span.end();
      return out;
    } catch (err) {
      if (err instanceof Error) {
        span.recordException(err);
      } else {
        span.setStatus('error', String(err));
      }
      span.end();
      throw err;
    }
  }
}

/**
 * Decide whether a recorded duration would flip a span into the
 * degraded bucket. Useful for synthesising the `degraded` flag on
 * {@link AIQueryLog} rows without going through {@link Tracer}.
 */
export function isDegradedDuration(
  durationMs: number,
  thresholdMs: number = DEGRADED_TRACE_THRESHOLD_MS,
): boolean {
  return durationMs > thresholdMs;
}
