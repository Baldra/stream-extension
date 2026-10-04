import { describe, expect, it, vi } from 'vitest';
import { AccountManager, type BrokerClient } from '../src/core/accounts';
import { AuthSessionStore } from '../src/core/auth-session';
import { createTestClock } from '../src/core/clock';
import { Repository } from '../src/core/repository';
import { createMemoryStore } from '../src/core/store';
import { REQUIRED_SCOPES, buildAuthorizationUrl, scopesFor } from '../src/core/oauth';
import { createPkcePair } from '../src/core/pkce';
import { TOKEN_RENEWAL_SKEW_MS } from '../src/core/constants';
import { TokenManager, TokenRefreshError } from '../src/core/tokens';
import { AuthError } from '../src/core/provider';
import type { PersistedAccount } from '../src/core/state';

const CLIENT_IDS = { twitch: 'twitch-client-id', kick: 'kick-client-id' };
const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';

interface Harness {
  manager: AccountManager;
  repository: Repository;
  broker: BrokerClient;
  clock: ReturnType<typeof createTestClock>;
}

function harness(overrides: Partial<BrokerClient> = {}): Harness {
  const clock = createTestClock(1_000_000);
  const repository = new Repository(createMemoryStore());
  const broker: BrokerClient = {
    exchange: vi.fn().mockResolvedValue({ access_token: 'at-1', expires_in: 7_200, refresh_token: 'rt-1' }),
    refresh: vi.fn().mockResolvedValue({ access_token: 'at-2', expires_in: 7_200, refresh_token: 'rt-2' }),
    revoke: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const manager = new AccountManager({
    repository,
    broker,
    clock,
    clientIds: CLIENT_IDS,
    redirectUri: REDIRECT,
  });
  return { manager, repository, broker, clock };
}

const existing = (accountId: string, overrides: Partial<PersistedAccount> = {}): PersistedAccount => ({
  accountId,
  providerId: 'twitch',
  displayName: 'me',
  credentials: { accessToken: 'at', expiresAt: 1_000_000 + 3_600_000, refreshToken: 'rt' },
  requiresReconnection: false,
  ...overrides,
});

describe('authorization request (task 5.1)', () => {
  it('requests exactly the scopes the specs permit for Twitch', () => {
    expect(scopesFor('twitch')).toEqual(['user:read:follows']);
  });

  it('requests no scope for Kick, whose endpoints are public', () => {
    expect(scopesFor('kick')).toEqual([]);
  });

  it('requests no scope beyond the required set for any provider', () => {
    for (const provider of Object.keys(REQUIRED_SCOPES)) {
      const url = new URL(
        buildAuthorizationUrl({ providerId: provider, clientId: 'c', redirectUri: REDIRECT, state: 's' }),
      );
      const scope = url.searchParams.get('scope') ?? '';
      const requested = scope.split(' ').filter(Boolean);
      expect(requested.sort()).toEqual([...scopesFor(provider)].sort());
    }
  });

  it('builds a Twitch authorization request against the official endpoint', () => {
    const url = new URL(
      buildAuthorizationUrl({ providerId: 'twitch', clientId: 'cid', redirectUri: REDIRECT, state: 'st' }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('scope')).toBe('user:read:follows');
  });

  it('builds a Kick authorization request with an empty scope set', () => {
    const url = new URL(
      buildAuthorizationUrl({ providerId: 'kick', clientId: 'cid', redirectUri: REDIRECT, state: 'st' }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://id.kick.com/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('');
  });

  it('includes the PKCE challenge when one is supplied', () => {
    const url = new URL(
      buildAuthorizationUrl({
        providerId: 'kick',
        clientId: 'cid',
        redirectUri: REDIRECT,
        state: 'st',
        codeChallenge: 'chal',
        codeChallengeMethod: 'S256',
      }),
    );
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('never puts a client secret in an authorization URL', () => {
    const url = buildAuthorizationUrl({
      providerId: 'twitch',
      clientId: 'cid',
      redirectUri: REDIRECT,
      state: 'st',
    });
    expect(url.toLowerCase()).not.toContain('secret');
  });

  it('rejects an unknown provider', () => {
    expect(() =>
      buildAuthorizationUrl({ providerId: 'nope', clientId: 'c', redirectUri: REDIRECT, state: 's' }),
    ).toThrow(/no authorization endpoint/);
  });
});

describe('PKCE (task 5.3)', () => {
  it('generates a verifier and a matching S256 challenge', async () => {
    const pair = await createPkcePair();
    expect(pair.codeChallengeMethod).toBe('S256');
    expect(pair.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.codeVerifier.length).toBeLessThanOrEqual(128);
    expect(pair.codeChallenge).not.toBe(pair.codeVerifier);
  });

  it('generates a different verifier each time', async () => {
    const a = await createPkcePair();
    const b = await createPkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });

  it('sends the verifier to the broker and never a client secret', async () => {
    const { manager, broker } = harness();
    const { state } = await manager.beginConnect('kick');
    await manager.completeConnect({ state, code: 'auth-code' });

    const payload = (broker.exchange as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/secret/i);
    expect(payload.codeVerifier).toEqual(expect.any(String));
    expect(Object.keys(payload).sort()).toEqual(['code', 'codeVerifier', 'provider', 'redirectUri']);
  });
});

describe('authorization flow state binding (task 5.2)', () => {
  it('binds each attempt to fresh unguessable state', async () => {
    const store = new AuthSessionStore();
    const first = store.begin({ providerId: 'twitch', redirectUri: REDIRECT, startedAt: 0 });
    const second = store.begin({ providerId: 'twitch', redirectUri: REDIRECT, startedAt: 0 });
    expect(first.state).not.toBe(second.state);
    expect(first.state.length).toBeGreaterThanOrEqual(32);
  });

  it('connects nothing when the state is mismatched', async () => {
    const { manager, repository } = harness();
    await manager.beginConnect('twitch');
    const result = await manager.completeConnect({ state: 'attacker-supplied-state', code: 'c' });
    expect(result.ok).toBe(false);
    expect(await repository.accounts()).toEqual([]);
  });

  it('connects nothing when the state is absent', async () => {
    const { manager, repository } = harness();
    await manager.beginConnect('twitch');
    const result = await manager.completeConnect({ state: undefined, code: 'c' });
    expect(result.ok).toBe(false);
    expect(await repository.accounts()).toEqual([]);
    const nullState = await manager.completeConnect({ state: null, code: 'c' });
    expect(nullState.ok).toBe(false);
    expect(await repository.accounts()).toEqual([]);
  });

  it('never contacts the broker for a mismatched state', async () => {
    const { manager, broker } = harness();
    await manager.beginConnect('twitch');
    await manager.completeConnect({ state: 'wrong', code: 'c' });
    expect(broker.exchange).not.toHaveBeenCalled();
  });

  it('accepts a matching state exactly once, rejecting the replay', async () => {
    const { manager, repository } = harness();
    const { state } = await manager.beginConnect('twitch');

    expect((await manager.completeConnect({ state, code: 'c' })).ok).toBe(true);
    expect(await repository.accounts()).toHaveLength(1);

    const replay = await manager.completeConnect({ state, code: 'c' });
    expect(replay.ok).toBe(false);
    expect(await repository.accounts()).toHaveLength(1);
  });

  it('connects nothing when the platform returns no code', async () => {
    const { manager, repository, broker } = harness();
    const { state } = await manager.beginConnect('twitch');
    const result = await manager.completeConnect({ state });
    expect(result.ok).toBe(false);
    expect(broker.exchange).not.toHaveBeenCalled();
    expect(await repository.accounts()).toEqual([]);
  });

  it('does not leave a used attempt behind', async () => {
    const store = new AuthSessionStore();
    const attempt = store.begin({ providerId: 'twitch', redirectUri: REDIRECT, startedAt: 0 });
    expect(store.consume(attempt.state)).toBeDefined();
    expect(store.size).toBe(0);
    expect(store.consume(attempt.state)).toBeUndefined();
  });

  it('stores credentials with an absolute expiry from the injected clock', async () => {
    const { manager, repository, clock } = harness();
    const { state } = await manager.beginConnect('twitch');
    await manager.completeConnect({ state, code: 'c' });

    const account = (await repository.accounts())[0]!;
    expect(account.credentials.accessToken).toBe('at-1');
    expect(account.credentials.expiresAt).toBe(clock.now() + 7_200_000);
    expect(account.requiresReconnection).toBe(false);
  });

  it('surfaces a rejected exchange without persisting an account', async () => {
    const { manager, repository } = harness({
      exchange: vi.fn().mockRejectedValue(new Error('invalid_grant')),
    });
    const { state } = await manager.beginConnect('twitch');
    const result = await manager.completeConnect({ state, code: 'bad' });
    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/bad/);
    expect(await repository.accounts()).toEqual([]);
  });
});

describe('token renewal (task 5.4)', () => {
  it('does not renew a token comfortably outside the window', () => {
    const clock = createTestClock(0);
    const tokens = new TokenManager(clock);
    expect(tokens.needsRenewal({ accessToken: 'a', expiresAt: TOKEN_RENEWAL_SKEW_MS + 1 })).toBe(false);
  });

  it('renews once the token enters the pre-expiry window', () => {
    const clock = createTestClock(0);
    const tokens = new TokenManager(clock);
    expect(tokens.needsRenewal({ accessToken: 'a', expiresAt: TOKEN_RENEWAL_SKEW_MS })).toBe(true);
    expect(tokens.needsRenewal({ accessToken: 'a', expiresAt: TOKEN_RENEWAL_SKEW_MS - 1 })).toBe(true);
  });

  it('returns the same credentials when no renewal is needed', async () => {
    const clock = createTestClock(0);
    const tokens = new TokenManager(clock);
    const fresh = { accessToken: 'a', expiresAt: 10_000_000 };
    const refresh = vi.fn();
    expect(await tokens.ensureFresh('acct', fresh, refresh)).toBe(fresh);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('collapses overlapping renewals into one broker call', async () => {
    const clock = createTestClock(0);
    const tokens = new TokenManager(clock);
    const stale = { accessToken: 'old', expiresAt: 100, refreshToken: 'rt' };
    let resolveRefresh: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<{ accessToken: string; expiresAt: number }>((r) => {
          resolveRefresh = () => r({ accessToken: 'new', expiresAt: 9_000 });
        }),
    );

    const calls = Array.from({ length: 5 }, () => tokens.ensureFresh('acct', stale, refresh));
    resolveRefresh!();
    const results = await Promise.all(calls);

    // One refresh for the whole burst, and every caller sees the same token.
    expect(refresh).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result.accessToken).toBe('new');
  });

  it('keeps two accounts renewing independently', async () => {
    const clock = createTestClock(0);
    const tokens = new TokenManager(clock);
    const stale = { accessToken: 'old', expiresAt: 100, refreshToken: 'rt' };
    const refresh = vi.fn().mockResolvedValue({ accessToken: 'new', expiresAt: 9_000 });

    await Promise.all([
      tokens.ensureFresh('acct-1', stale, refresh),
      tokens.ensureFresh('acct-2', stale, refresh),
    ]);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed renewal, so a later attempt can retry', async () => {
    const clock = createTestClock(0);
    const tokens = new TokenManager(clock);
    const stale = { accessToken: 'old', expiresAt: 100, refreshToken: 'rt' };
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new TokenRefreshError('temporarily_unavailable', 'try later'))
      .mockResolvedValueOnce({ accessToken: 'new', expiresAt: 9_000 });

    await expect(tokens.ensureFresh('acct', stale, refresh)).rejects.toThrow();
    expect(tokens.refreshing).toBe(0);
    await expect(tokens.ensureFresh('acct', stale, refresh)).resolves.toMatchObject({ accessToken: 'new' });
  });

  it('renews an expiring account through the manager', async () => {
    const { manager, repository, broker, clock } = harness();
    const account = existing('a1', {
      credentials: { accessToken: 'old', expiresAt: clock.now() + 1_000, refreshToken: 'rt' },
    });
    await repository.putAccount(account);

    const credentials = await manager.credentialsFor(account);
    expect(credentials.accessToken).toBe('at-2');
    expect(credentials.expiresAt).toBe(clock.now() + 7_200_000);
    expect(broker.refresh).toHaveBeenCalledWith({ provider: 'twitch', refreshToken: 'rt' });
  });
});

describe('requiring reconnection (task 5.5)', () => {
  it('stops queries for an account whose renewal permanently failed', async () => {
    const refresh = vi.fn().mockRejectedValue(new TokenRefreshError('invalid_grant', 'refresh token revoked'));
    const { manager, repository, broker, clock } = harness({ refresh });
    const account = existing('a1', {
      credentials: { accessToken: 'old', expiresAt: clock.now() + 1_000, refreshToken: 'rt' },
    });
    await repository.putAccount(account);

    await expect(manager.credentialsFor(account)).rejects.toThrow(TokenRefreshError);
    expect(refresh).toHaveBeenCalledTimes(1);

    const stored = (await repository.accounts())[0]!;
    expect(stored.requiresReconnection).toBe(true);
    expect(stored.revokedUpstream).toBe(true);

    // Every later query refuses without touching the broker at all, so a
    // permanently-dead account cannot keep hammering the platform.
    await expect(manager.credentialsFor(stored)).rejects.toThrow(AuthError);
    await expect(manager.credentialsFor(stored)).rejects.toThrow(AuthError);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(broker.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not flag reconnection for a temporary failure', async () => {
    const { manager, repository, clock } = harness({
      refresh: vi.fn().mockRejectedValue(new TokenRefreshError('temporarily_unavailable', 'try later')),
    });
    const account = existing('a1', {
      credentials: { accessToken: 'old', expiresAt: clock.now() + 1_000, refreshToken: 'rt' },
    });
    await repository.putAccount(account);

    await expect(manager.credentialsFor(account)).rejects.toThrow();
    expect((await repository.accounts())[0]?.requiresReconnection).toBe(false);
  });

  it('exposes the user-visible signal as a list of affected accounts', async () => {
    const { manager, repository, clock } = harness();
    await repository.putAccount(existing('ok'));
    await repository.putAccount(existing('bad', { requiresReconnection: true, revokedUpstream: true }));

    const flagged = await manager.accountsNeedingReconnection('twitch');
    expect(flagged.map((a) => a.accountId)).toEqual(['bad']);
  });

  it('clears the flag once the account reconnects', async () => {
    const { manager, repository } = harness();
    const account = existing('bad', { requiresReconnection: true, revokedUpstream: true });
    await repository.putAccount(account);
    await manager.clearRequiresReconnection(account);
    expect((await repository.accounts())[0]?.requiresReconnection).toBe(false);
  });
});

describe('disconnect (task 5.6)', () => {
  it('revokes upstream and removes credentials, channels, and live state', async () => {
    const { manager, repository, broker } = harness();
    const account = existing('a1');
    await repository.putAccount(account);
    await repository.putChannel({
      providerId: 'twitch',
      providerChannelId: 'c1',
      handle: 'h1',
      accountId: 'a1',
      trackedAt: 1,
      source: 'manual',
    });
    await repository.replaceLiveState('twitch', 'a1', [
      { providerId: 'twitch', accountId: 'a1', channelId: 'c1', title: 't', wentLiveAt: 1, notified: false },
    ]);

    await manager.disconnect('twitch', 'a1');

    expect(broker.revoke).toHaveBeenCalledWith({ provider: 'twitch', accessToken: 'at' });
    expect(await repository.accounts()).toEqual([]);
    expect(await repository.channels()).toEqual([]);
    expect(await repository.liveState('twitch', 'a1')).toEqual([]);
    // The token is gone from storage, not merely marked stale.
    expect(await repository.serialize()).not.toContain('"at"');
  });

  it('leaves a sibling account untouched', async () => {
    const { manager, repository } = harness();
    await repository.putAccount(existing('a1'));
    await repository.putAccount(existing('a2'));
    for (const id of ['c1', 'c2']) {
      await repository.putChannel({
        providerId: 'twitch',
        providerChannelId: id,
        handle: `h-${id}`,
        accountId: id === 'c1' ? 'a1' : 'a2',
        trackedAt: 1,
        source: 'manual',
      });
    }

    await manager.disconnect('twitch', 'a1');

    expect((await repository.accounts()).map((a) => a.accountId)).toEqual(['a2']);
    expect((await repository.channels()).map((c) => c.providerChannelId)).toEqual(['c2']);
    const sibling = (await repository.accounts())[0]!;
    expect(sibling.credentials.accessToken).toBe('at');
  });

  it('still cleans up locally when revocation fails', async () => {
    const { manager, repository } = harness({
      revoke: vi.fn().mockRejectedValue(new Error('network down')),
    });
    await repository.putAccount(existing('a1'));
    await manager.disconnect('twitch', 'a1');
    expect(await repository.accounts()).toEqual([]);
  });

  it('is a no-op for an unknown account', async () => {
    const { manager, repository } = harness();
    await manager.disconnect('twitch', 'ghost');
    expect(await repository.accounts()).toEqual([]);
  });
});

describe('multi-account isolation for one provider (task 5.7)', () => {
  it('keeps two Twitch accounts with overlapping channel sets independent', async () => {
    const { manager, repository, clock, broker } = harness();
    const a1 = existing('acct-a', {
      displayName: 'first',
      credentials: { accessToken: 'token-a', expiresAt: clock.now() + 3_600_000, refreshToken: 'rt-a' },
    });
    const a2 = existing('acct-b', {
      displayName: 'second',
      credentials: { accessToken: 'token-b', expiresAt: clock.now() + 3_600_000, refreshToken: 'rt-b' },
    });
    await repository.putAccount(a1);
    await repository.putAccount(a2);

    // Overlapping channel set, tracked under different accounts.
    for (const channelId of ['shared', 'only-a', 'only-b']) {
      await repository.putChannel({
        providerId: 'twitch',
        providerChannelId: channelId,
        handle: channelId,
        accountId: channelId === 'only-b' ? 'acct-b' : 'acct-a',
        trackedAt: 1,
        source: 'follow_import',
      });
    }

    expect((await repository.channels('twitch', 'acct-a')).map((c) => c.providerChannelId)).toEqual([
      'shared',
      'only-a',
    ]);
    expect((await repository.channels('twitch', 'acct-b')).map((c) => c.providerChannelId)).toEqual(['only-b']);

    // Renewing one account's token does not touch the other's.
    await repository.putAccount({
      ...a1,
      credentials: { accessToken: 'token-a', expiresAt: clock.now() + 1_000, refreshToken: 'rt-a' },
    });
    const refreshed = await manager.credentialsFor((await repository.account('twitch', 'acct-a'))!);
    expect(refreshed.accessToken).toBe('at-2');
    expect(broker.refresh).toHaveBeenCalledWith({ provider: 'twitch', refreshToken: 'rt-a' });
    expect((await repository.account('twitch', 'acct-b'))?.credentials.accessToken).toBe('token-b');

    // Disconnecting one leaves the other fully functional.
    await manager.disconnect('twitch', 'acct-a');
    expect((await repository.accounts()).map((a) => a.accountId)).toEqual(['acct-b']);
    await expect(manager.credentialsFor(a2)).resolves.toMatchObject({ accessToken: 'token-b' });
  });

  it('scopes the reconnection signal to one account', async () => {
    const { manager, repository } = harness();
    await repository.putAccount(existing('a1'));
    await repository.putAccount(existing('a2', { requiresReconnection: true }));

    expect((await manager.accountsNeedingReconnection('twitch')).map((a) => a.accountId)).toEqual(['a2']);
    expect(await manager.accountsNeedingReconnection('kick')).toEqual([]);
  });
});

describe('stable account identity at connect time', () => {
  it('stores the platform user id the API needs in place of a login', async () => {
    const clock = createTestClock(1_000_000);
    const repository = new Repository(createMemoryStore());
    const manager = new AccountManager({
      repository,
      broker: {
        exchange: vi.fn().mockResolvedValue({ access_token: 'at-1', expires_in: 7_200, refresh_token: 'rt-1' }),
        refresh: vi.fn(),
        revoke: vi.fn(),
      },
      clock,
      clientIds: CLIENT_IDS,
      redirectUri: REDIRECT,
      identify: async () => ({ providerUserId: '12345', displayName: 'streamer' }),
    });

    const { state } = await manager.beginConnect('twitch');
    const result = await manager.completeConnect({ state, code: 'c' });

    expect(result.ok).toBe(true);
    const [stored] = await repository.accounts();
    expect(stored?.providerUserId).toBe('12345');
    expect(stored?.displayName).toBe('streamer');
    expect(stored?.accountId).toBe('12345');
  });

  it('never derives the account id from the access token', async () => {
    const { manager, repository } = harness();
    const { state } = await manager.beginConnect('twitch');
    await manager.completeConnect({ state, code: 'c' });

    const [stored] = await repository.accounts();
    // A token-derived id would rotate with the token and orphan the account's
    // channels, live state and history.
    expect(stored?.accountId).not.toContain('at-1');
    expect(stored?.accountId).not.toBe('twitch-at-1');
    expect(stored?.accountId).toMatch(/^twitch-[0-9a-f-]{36}$/);
  });

  it('keeps a granted token when identification fails', async () => {
    const clock = createTestClock(1_000_000);
    const repository = new Repository(createMemoryStore());
    const manager = new AccountManager({
      repository,
      broker: {
        exchange: vi.fn().mockResolvedValue({ access_token: 'at-1', expires_in: 7_200, refresh_token: 'rt-1' }),
        refresh: vi.fn(),
        revoke: vi.fn(),
      },
      clock,
      clientIds: CLIENT_IDS,
      redirectUri: REDIRECT,
      identify: async () => {
        throw new Error('userinfo unreachable');
      },
    });

    const { state } = await manager.beginConnect('twitch');
    const result = await manager.completeConnect({ state, code: 'c' });

    expect(result.ok).toBe(true);
    const [stored] = await repository.accounts();
    expect(stored?.credentials.accessToken).toBe('at-1');
    expect(stored?.providerUserId).toBeUndefined();
  });

  it('gives two connections of the same account distinct ids', async () => {
    const { manager, repository } = harness();
    const first = await manager.beginConnect('twitch');
    await manager.completeConnect({ state: first.state, code: 'c' });
    const second = await manager.beginConnect('twitch');
    await manager.completeConnect({ state: second.state, code: 'c' });

    const ids = (await repository.accounts()).map((a) => a.accountId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('renewed credentials are stored (task 9.7 depends on this)', () => {
  it('persists the renewed access and refresh tokens', async () => {
    const { manager, repository, clock } = harness();
    const account = {
      ...existing('a1'),
      credentials: { accessToken: 'at-1', expiresAt: clock.now() + 60_000, refreshToken: 'rt-1' },
    };
    await repository.putAccount(account);

    const credentials = await manager.credentialsFor(account);

    expect(credentials.accessToken).toBe('at-2');
    const [stored] = await repository.accounts();
    // Twitch invalidates the old refresh token on use, so losing it would end
    // renewal permanently after one cycle.
    expect(stored?.credentials.accessToken).toBe('at-2');
    expect(stored?.credentials.refreshToken).toBe('rt-2');
  });

  it('leaves stored credentials alone when no renewal was needed', async () => {
    const { manager, repository, clock, broker } = harness();
    const account = existing('a1', {
      credentials: { accessToken: 'at-1', expiresAt: clock.now() + 3_600_000, refreshToken: 'rt-1' },
    });
    await repository.putAccount(account);

    const credentials = await manager.credentialsFor(account);

    expect(credentials.accessToken).toBe('at-1');
    expect(broker.refresh).not.toHaveBeenCalled();
    const [stored] = await repository.accounts();
    expect(stored?.credentials).toEqual(account.credentials);
  });

  it('does not store credentials when renewal fails permanently', async () => {
    const { manager, repository, clock } = harness({
      refresh: vi.fn().mockRejectedValue(new TokenRefreshError('invalid_grant', 'revoked')),
    });
    const account = {
      ...existing('a1'),
      credentials: { accessToken: 'at-1', expiresAt: clock.now() + 60_000, refreshToken: 'rt-1' },
    };
    await repository.putAccount(account);

    await expect(manager.credentialsFor(account)).rejects.toThrow();

    const [stored] = await repository.accounts();
    expect(stored?.credentials.accessToken).toBe('at-1');
    expect(stored?.requiresReconnection).toBe(true);
  });
});
