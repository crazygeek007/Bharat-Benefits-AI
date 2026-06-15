/**
 * In-process API response time tracker (Requirement 17.1).
 *
 * Captures the duration of every HTTP request handled by the Fastify
 * instance and lets the admin dashboard read the average over a rolling
 * window — defaulting to 24 hours per Req 17.1.
 *
 * The implementation uses a fixed-size circular buffer so memory stays
 * bounded under any traffic load: once the buffer is full, the oldest
 * sample is overwritten. When computing the average we filter samples by
 * recorded timestamp so requests older than the requested window are
 * excluded automatically — a 24-hour quiet period therefore reports an
 * average derived only from samples within that window, not the entire
 * buffer.
 *
 * The tracker is a plain class with no external dependencies. The Fastify
 * hook in {@link registerApiMetricsMiddleware} wires it into the
 * `onResponse` lifecycle so every handled request is recorded.
 */

/** A single recorded response time observation. */
export interface ApiMetricsSample {
  /** Wall-clock timestamp the response completed (ms since epoch). */
  recordedAt: number;
  /** Response time in milliseconds. */
  durationMs: number;
}

/** Result of {@link ApiMetricsTracker.getAverageResponseTime}. */
export interface ApiMetricsSummary {
  averageMs: number;
  sampleCount: number;
  windowMs: number;
}

/** Default window for the admin dashboard view (Req 17.1 — last 24 hours). */
export const DEFAULT_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Default capacity of the in-memory ring buffer. */
export const DEFAULT_BUFFER_CAPACITY = 10_000;

/**
 * Fixed-capacity ring buffer of response time samples.
 *
 * Recording is O(1); summarising is O(n) over the buffer. Both
 * operations are safe to call concurrently because the underlying array
 * uses simple positional writes — no cross-call invariants need to hold
 * to keep the average within statistical noise.
 */
export class ApiMetricsTracker {
  private readonly capacity: number;
  private readonly samples: Array<ApiMetricsSample | undefined>;
  private writeIndex = 0;
  private size = 0;

  constructor(capacity: number = DEFAULT_BUFFER_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('ApiMetricsTracker capacity must be a positive integer');
    }
    this.capacity = capacity;
    this.samples = new Array<ApiMetricsSample | undefined>(capacity);
  }

  /**
   * Records a single response time observation.
   *
   * Negative durations are clamped to 0; non-finite values are dropped
   * (defensive — the Fastify hook computes the duration with
   * `process.hrtime.bigint()` so this should not happen in practice).
   */
  record(durationMs: number, recordedAt: number = Date.now()): void {
    if (!Number.isFinite(durationMs)) return;
    const sample: ApiMetricsSample = {
      recordedAt,
      durationMs: Math.max(0, durationMs),
    };
    this.samples[this.writeIndex] = sample;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  /**
   * Returns the average response time across samples recorded within
   * `windowMs` milliseconds before `now`. Returns `averageMs: 0` and
   * `sampleCount: 0` when the buffer is empty for the window — the
   * admin dashboard surfaces this as "No traffic in the last 24 hours".
   */
  getAverageResponseTime(
    windowMs: number = DEFAULT_METRICS_WINDOW_MS,
    now: number = Date.now(),
  ): ApiMetricsSummary {
    const cutoff = now - windowMs;
    let total = 0;
    let count = 0;
    for (let i = 0; i < this.size; i++) {
      const sample = this.samples[i];
      if (!sample) continue;
      if (sample.recordedAt < cutoff) continue;
      total += sample.durationMs;
      count += 1;
    }
    return {
      averageMs: count === 0 ? 0 : total / count,
      sampleCount: count,
      windowMs,
    };
  }

  /** Total samples currently held in the buffer. */
  get bufferSize(): number {
    return this.size;
  }

  /** Buffer capacity (samples beyond this are overwritten). */
  get bufferCapacity(): number {
    return this.capacity;
  }

  /** Empties the buffer — primarily used by tests. */
  reset(): void {
    for (let i = 0; i < this.capacity; i++) this.samples[i] = undefined;
    this.writeIndex = 0;
    this.size = 0;
  }
}

/**
 * Process-wide singleton used by the production wiring. Tests should
 * construct their own {@link ApiMetricsTracker} and inject it where
 * needed rather than reusing the singleton (state leaks across tests).
 */
export const apiMetricsTracker = new ApiMetricsTracker();
