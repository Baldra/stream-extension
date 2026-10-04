import { BACKOFF_BASE_MS, BACKOFF_MAX_MS } from './constants';
import { HttpError, retryAfterMs } from './http';

export type BackoffReason = 'rate_limited' | 'server_error' | 'network_error';

/** Classifies a failure for backoff purposes. Auth failures are not retried. */
export const classifyFailure = (error: unknown): BackoffReason | 'auth' | 'other' => {
  if (error instanceof HttpError) {
    if (error.status === 429) return 'rate_limited';
    if (error.status === 0) return 'network_error';
    if (error.status >= 500) return 'server_error';
  }
  return 'other';
};

export const isBackoffWorthy = (reason: BackoffReason | 'auth' | 'other'): reason is BackoffReason =>
  reason === 'rate_limited' || reason === 'server_error' || reason === 'network_error';

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Injected so the growth is deterministic under test. */
  jitter?: (attempt: number) => number;
}

/**
 * Increasing cooling-off per account, reset on success (task 9.6).
 *
 * A platform that is failing must not be hammered once per minute forever, but a
 * transient blip must recover quickly, so the first retry is short and each
 * subsequent one roughly doubles up to a ceiling.
 */
export class Backoff {
  readonly #attempts = new Map<string, { attempt: number; until: number }>();
  readonly #baseMs: number;
  readonly #maxMs: number;
  readonly #jitter: (attempt: number) => number;

  constructor(options: BackoffOptions = {}) {
    this.#baseMs = options.baseMs ?? BACKOFF_BASE_MS;
    this.#maxMs = options.maxMs ?? BACKOFF_MAX_MS;
    // Deterministic by default: a random jitter would make tests flaky.
    this.#jitter = options.jitter ?? (() => 1);
  }

  /** Milliseconds to wait before the next attempt, or 0 when not cooling off. */
  delayFor(key: string, now: number): number {
    const state = this.#attempts.get(key);
    if (!state) return 0;
    return Math.max(0, state.until - now);
  }

  isCoolingDown(key: string, now: number): boolean {
    return this.delayFor(key, now) > 0;
  }

  /** Records a failure and returns the new cooling-off interval. */
  fail(key: string, now: number, error?: unknown): number {
    const attempt = (this.#attempts.get(key)?.attempt ?? 0) + 1;
    // Retry-After wins over our own growth: the platform told us how long to wait.
    const hinted = error instanceof HttpError ? retryAfterMs(error) : undefined;
    const exponential = Math.min(this.#baseMs * 2 ** (attempt - 1), this.#maxMs) * this.#jitter(attempt);
    const delay = Math.max(hinted ?? 0, exponential);
    this.#attempts.set(key, { attempt, until: now + delay });
    return delay;
  }

  succeed(key: string): void {
    this.#attempts.delete(key);
  }

  attemptsFor(key: string): number {
    return this.#attempts.get(key)?.attempt ?? 0;
  }

  /** True once failures have persisted long enough to be worth surfacing. */
  isOngoingFailure(key: string, threshold = 3): boolean {
    return this.attemptsFor(key) >= threshold;
  }
}
