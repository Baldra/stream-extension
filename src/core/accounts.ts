import { AuthSessionStore } from './auth-session';
import type { Clock } from './clock';
import type { Repository } from './repository';
import { buildAuthorizationUrl } from './oauth';
import { createPkcePair } from './pkce';
import {
  TokenManager,
  TokenRefreshError,
  isPermanentRefreshFailure,
  toCredentials,
} from './tokens';
import { AuthError, type AccountCredentials, type ProviderId } from './provider';
import type { PersistedAccount } from './state';

export interface BrokerClient {
  /** Exchanges an authorization code. Sends the PKCE verifier; never a secret. */
  exchange(input: {
    provider: ProviderId;
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<{ access_token: string; expires_in: number; refresh_token?: string; refresh_expires_in?: number }>;
  refresh(input: { provider: ProviderId; refreshToken: string }): Promise<unknown>;
  revoke(input: { provider: ProviderId; accessToken: string }): Promise<void>;
}

export interface AccountIdentity {
  /** The platform's own id for the user, e.g. Twitch's numeric user id. */
  providerUserId?: string;
  /** Login to show in the UI. */
  displayName?: string;
}

export interface AccountManagerDeps {
  repository: Repository;
  broker: BrokerClient;
  clock: Clock;
  clientIds: Record<string, string>;
  redirectUri: string;
  /**
   * Resolves the connected user after the exchange.
   *
   * Required because a token does not identify its owner to Helix, and because a
   * stable account id cannot be derived from a token that rotates on every renewal.
   */
  identify?: (providerId: ProviderId, credentials: AccountCredentials) => Promise<AccountIdentity>;
}

export interface ConnectResult {
  ok: boolean;
  account?: PersistedAccount;
  error?: string;
}

export class AccountManager {
  readonly sessions = new AuthSessionStore();
  readonly tokens: TokenManager;

  constructor(private readonly deps: AccountManagerDeps) {
    this.tokens = new TokenManager(deps.clock);
  }

  /** Step 1: build the URL to open and remember the attempt (task 5.2, 5.3). */
  async beginConnect(providerId: ProviderId, accountHint?: string): Promise<{ url: string; state: string }> {
    const clientId = this.deps.clientIds[providerId];
    if (!clientId) throw new Error(`no client id configured for ${providerId}`);

    const pkce = await createPkcePair();
    const attempt = this.sessions.begin({
      providerId,
      redirectUri: this.deps.redirectUri,
      codeVerifier: pkce.codeVerifier,
      startedAt: this.deps.clock.now(),
      ...(accountHint ? { accountHint } : {}),
    });

    const url = buildAuthorizationUrl({
      providerId,
      clientId,
      redirectUri: this.deps.redirectUri,
      state: attempt.state,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
    });
    return { url, state: attempt.state };
  }

  /**
   * Step 2: finish the flow. A missing or mismatched state connects nothing
   * (task 5.2) -- the attempt is simply not found and discarded.
   */
  async completeConnect(input: { state: string | null | undefined; code?: string }): Promise<ConnectResult> {
    const attempt = this.sessions.consume(input.state);
    if (!attempt) return { ok: false, error: 'authorization state did not match; nothing was connected' };
    if (!input.code) return { ok: false, error: 'no authorization code was returned' };

    let tokens: Awaited<ReturnType<BrokerClient['exchange']>>;
    try {
      tokens = await this.deps.broker.exchange({
        provider: attempt.providerId,
        code: input.code,
        redirectUri: attempt.redirectUri,
        // The verifier goes to the broker; the extension has no secret to send.
        ...(attempt.codeVerifier ? { codeVerifier: attempt.codeVerifier } : {}),
      });
    } catch {
      return { ok: false, error: 'the platform rejected the authorization code' };
    }

    const credentials = toCredentials(tokens, this.deps.clock);

    // Best effort: an identification failure must not discard a granted token, but
    // the account still needs a stable id, so a random one stands in.
    let identity: AccountIdentity = {};
    try {
      identity = (await this.deps.identify?.(attempt.providerId, credentials)) ?? {};
    } catch {
      identity = {};
    }

    const account: PersistedAccount = {
      // Never derived from the token: Twitch rotates it on every renewal, which
      // would orphan the account's channels and live state.
      accountId:
        attempt.accountHint ?? identity.providerUserId ?? `${attempt.providerId}-${crypto.randomUUID()}`,
      providerId: attempt.providerId,
      displayName: identity.displayName ?? attempt.accountHint ?? 'Connected account',
      credentials,
      requiresReconnection: false,
      ...(identity.providerUserId ? { providerUserId: identity.providerUserId } : {}),
    };

    await this.deps.repository.putAccount(account);
    return { ok: true, account };
  }

  /**
   * Returns usable credentials, renewing inside the window. A permanent failure
   * flips the account to requires-reconnection and the token is dropped, so no
   * further queries are attempted (task 5.5).
   */
  async credentialsFor(account: PersistedAccount): Promise<AccountCredentials> {
    if (account.requiresReconnection) {
      throw new AuthError(account.providerId, 'revoked');
    }

    try {
      const credentials = await this.tokens.ensureFresh(account.accountId, account.credentials, async (current) => {
        if (!current.refreshToken) throw new TokenRefreshError('invalid_grant', 'no refresh token stored');
        const response = (await this.deps.broker.refresh({
          provider: account.providerId,
          refreshToken: current.refreshToken,
        })) as { access_token: string; expires_in: number; refresh_token?: string; refresh_expires_in?: number };
        return toCredentials(response, this.deps.clock);
      });

      // Renewal rotates the access token, and on Twitch the refresh token too. If
      // the result were not stored, the next worker generation would present a
      // token the platform has already invalidated, and a refresh token that can
      // only be used once would be lost.
      if (credentials.accessToken !== account.credentials.accessToken) {
        await this.deps.repository.putAccount({ ...account, credentials });
      }
      return credentials;
    } catch (error) {
      if (error instanceof TokenRefreshError && isPermanentRefreshFailure(error)) {
        // An invalid_grant means the grant is gone upstream, so say so in the UI.
        await this.markRequiresReconnection(account, true);
      }
      throw error;
    }
  }

  async markRequiresReconnection(account: PersistedAccount, revokedUpstream = false): Promise<void> {
    await this.deps.repository.putAccount({
      ...account,
      requiresReconnection: true,
      ...(revokedUpstream ? { revokedUpstream } : {}),
    });
  }

  /**
   * Disconnects: revokes upstream if we can, then discards credentials and all
   * channels and live state for that account only (task 5.6).
   */
  async disconnect(providerId: ProviderId, accountId: string): Promise<void> {
    const account = await this.deps.repository.account(providerId, accountId);
    if (!account) return;

    // Best effort: a failure to revoke upstream must not block local cleanup,
    // or the user could be stuck unable to disconnect.
    try {
      await this.deps.broker.revoke({ provider: providerId, accessToken: account.credentials.accessToken });
    } catch {
      // Discarded locally regardless.
    }
    await this.deps.repository.removeAccount(providerId, accountId);
  }

  /** Reconnects a previously-failed account, clearing the reconnection flag. */
  async clearRequiresReconnection(account: PersistedAccount): Promise<void> {
    if (!account.requiresReconnection) return;
    await this.deps.repository.putAccount({
      ...account,
      requiresReconnection: false,
      revokedUpstream: false,
    });
  }

  /** Accounts the UI must surface as needing attention. */
  async accountsNeedingReconnection(providerId?: ProviderId): Promise<PersistedAccount[]> {
    const accounts = await this.deps.repository.accounts(providerId);
    return accounts.filter((a) => a.requiresReconnection);
  }
}
