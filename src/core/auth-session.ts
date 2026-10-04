import { randomBase64Url } from './pkce';
import type { ProviderId } from './provider';

export interface PendingAuthAttempt {
  providerId: ProviderId;
  state: string;
  redirectUri: string;
  codeVerifier?: string;
  startedAt: number;
  /** Denormalised so a completed flow can be attributed without a second lookup. */
  accountHint?: string;
}

/**
 * Holds in-flight authorization attempts (task 5.2).
 *
 * Each attempt gets fresh, unguessable state, and `consume` is single-use: a
 * replayed callback URL cannot authorize a second time, and an attempt whose
 * state does not match is discarded without connecting anything.
 */
export class AuthSessionStore {
  readonly #byState = new Map<string, PendingAuthAttempt>();

  begin(input: Omit<PendingAuthAttempt, 'state'> & { state?: string }): PendingAuthAttempt {
    const attempt: PendingAuthAttempt = {
      ...input,
      // 32 random bytes: unguessable, and short enough to survive a redirect.
      state: randomBase64Url(32),
    };
    this.#byState.set(attempt.state, attempt);
    return attempt;
  }

  /**
   * Returns the attempt for a state and removes it, or undefined when the state
   * is unknown, already used, or absent.
   */
  consume(state: string | null | undefined): PendingAuthAttempt | undefined {
    if (!state) return undefined;
    const attempt = this.#byState.get(state);
    this.#byState.delete(state);
    return attempt;
  }

  get size(): number {
    return this.#byState.size;
  }

  clear(): void {
    this.#byState.clear();
  }
}
