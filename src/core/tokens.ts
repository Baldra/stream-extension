import { TOKEN_RENEWAL_SKEW_MS } from './constants';
import type { AccountCredentials, ProviderId } from './provider';
import type { Clock } from './clock';

export class TokenRefreshError extends Error {
  constructor(
    readonly reason: 'invalid_grant' | 'temporarily_unavailable' | 'missing_scope',
    message: string,
  ) {
    super(message);
    this.name = 'TokenRefreshError';
  }
}

/** `missing_scope` is permanent; the user must reconnect and re-consent. */
export const isPermanentRefreshFailure = (error: TokenRefreshError): boolean =>
  error.reason === 'invalid_grant' || error.reason === 'missing_scope';

/**
 * Renews inside the pre-expiry window (task 5.4) and serialises per account, so
 * two poll paths that both notice an expiring token produce one refresh, not two
 * racing refreshes (one of which would invalidate the other's token on Twitch,
 * where refresh tokens rotate).
 */
export class TokenManager {
  /** In-flight refresh per account, so overlapping callers share one promise. */
  readonly #inFlight = new Map<string, Promise<AccountCredentials>>();

  constructor(private readonly clock: Clock) {}

  /** True once the token is inside the renewal window. */
  needsRenewal(credentials: AccountCredentials): boolean {
    return credentials.expiresAt - TOKEN_RENEWAL_SKEW_MS <= this.clock.now();
  }

  /**
   * Returns valid credentials, refreshing only when needed. Overlapping calls for
   * the same account collapse into a single refresh.
   */
  async ensureFresh(
    accountId: string,
    credentials: AccountCredentials,
    refresh: (current: AccountCredentials) => Promise<AccountCredentials>,
  ): Promise<AccountCredentials> {
    if (!this.needsRenewal(credentials)) return credentials;

    const existing = this.#inFlight.get(accountId);
    if (existing) return existing;

    const attempt = (async () => {
      try {
        return await refresh(credentials);
      } finally {
        this.#inFlight.delete(accountId);
      }
    })();
    this.#inFlight.set(accountId, attempt);
    return attempt;
  }

  get refreshing(): number {
    return this.#inFlight.size;
  }
}

/** Maps a broker token response onto stored credentials. */
export function toCredentials(
  response: {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    refresh_expires_in?: number;
  },
  clock: Clock,
): AccountCredentials {
  return {
    accessToken: response.access_token,
    expiresAt: clock.now() + response.expires_in * 1_000,
    ...(response.refresh_token ? { refreshToken: response.refresh_token } : {}),
    ...(response.refresh_expires_in
      ? { refreshTokenExpiresAt: clock.now() + response.refresh_expires_in * 1_000 }
      : {}),
  };
}

export const accountLockKey = (providerId: ProviderId, accountId: string): string =>
  `account:${providerId}:${accountId}`;
