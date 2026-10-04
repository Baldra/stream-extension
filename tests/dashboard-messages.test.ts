import { describe, expect, it, vi } from 'vitest';
import {
  buildPopupViewState,
  handleDashboardRequest,
  isDashboardRequest,
  platformMetadata,
  registerMessageApi,
  type MessageApiDeps,
} from '../src/background/messages';
import { Repository } from '../src/core/repository';
import { createMemoryStore } from '../src/core/store';
import { createTestClock } from '../src/core/clock';
import { ProviderRegistry } from '../src/core/registry';
import { TwitchAdapter } from '../src/providers/twitch/adapter';
import { KickAdapter } from '../src/providers/kick/adapter';
import type { PersistedAccount, PersistedChannel } from '../src/core/state';
import type { Clock } from '../src/core/clock';
import { ChannelTracker } from '../src/core/tracking';

const http = {
  clientId: 'test',
  get: async () => ({}) as never,
  post: async () => ({}) as never,
};
const twitch = new TwitchAdapter({ http, resolveUserId: () => '1' });
const kick = new KickAdapter({
  http,
  resolveUserId: (_a, c) => c,
  resolveSlug: (_a, c) => c,
});

const account = (overrides: Partial<PersistedAccount> = {}): PersistedAccount => ({
  accountId: 't1',
  providerId: 'twitch',
  displayName: 'streamer',
  credentials: { accessToken: 't', expiresAt: 1 },
  requiresReconnection: false,
  ...overrides,
});

const channel = (overrides: Partial<PersistedChannel> = {}): PersistedChannel => ({
  providerId: 'twitch',
  providerChannelId: 'c1',
  handle: 'alpha',
  accountId: 't1',
  trackedAt: 1,
  source: 'manual',
  ...overrides,
});

function deps(overrides: Partial<MessageApiDeps> = {}): MessageApiDeps & { repository: Repository } {
  const clock: Clock = createTestClock(1_000_000);
  const repository = new Repository(createMemoryStore());
  const registry = new ProviderRegistry().register(twitch).register(kick);
  return {
    repository,
    registry,
    clock,
    accounts: { disconnect: vi.fn(async () => {}) } as never,
    tracker: {
      addByHandle: vi.fn(async () => ({ ok: true, alreadyTracked: false })),
      remove: vi.fn(async () => {}),
      importFollowed: vi.fn(async () => ({ added: [], skippedLocallyRemoved: [], updated: [] })),
    } as never,
    detection: { syncSchedule: vi.fn(async () => true) } as never,
    notificationPermission: vi.fn(async () => 'granted' as const),
    setUnofficialImportPermissions: vi.fn(async () => true),
    kickCookie: vi.fn(async () => 'session=abc'),
    connectAccount: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('view state', () => {
  it('returns the dashboard with platform metadata as plain data', async () => {
    const d = deps();
    await d.repository.putAccount(account());

    const state = await buildPopupViewState(d);

    expect(state.dashboard.accounts).toHaveLength(1);
    // Plain data only, because it crosses a JSON message channel.
    expect(JSON.parse(JSON.stringify(state.platforms ?? state.dashboard))).toBeTruthy();
    expect(platformMetadata(d)).toEqual([
      expect.objectContaining({ id: 'twitch', displayName: 'Twitch' }),
      expect.objectContaining({ id: 'kick', displayName: 'Kick' }),
    ]);
    expect(platformMetadata(d)[0]).not.toHaveProperty('publicStreamUrl');
  });

  it('reports notification permission and per-platform switches', async () => {
    const d = deps({ notificationPermission: vi.fn(async () => 'denied' as const) });
    await d.repository.setNotificationsEnabled('twitch', false);

    const state = await buildPopupViewState(d);

    expect(state.notificationsGranted).toBe(false);
    expect(state.notificationsEnabledFor).toEqual(['kick']);
  });

  it('never triggers a poll', async () => {
    const d = deps();
    await buildPopupViewState(d);
    expect(d.detection.syncSchedule).not.toHaveBeenCalled();
  });
});

describe('account actions', () => {
  it('connects a new account through the worker', async () => {
    const d = deps();
    const result = await handleDashboardRequest({ kind: 'connect', providerId: 'twitch' }, d);
    expect(result).toEqual({ ok: true });
    expect(d.connectAccount).toHaveBeenCalledWith('twitch', undefined);
    expect(d.detection.syncSchedule).toHaveBeenCalled();
  });

  it('reconnects an existing account by its id', async () => {
    const d = deps();
    await handleDashboardRequest({ kind: 'connect', providerId: 'twitch', accountId: 't1' }, d);
    expect(d.connectAccount).toHaveBeenCalledWith('twitch', 't1');
  });

  it('reports a failed authorization without throwing', async () => {
    const d = deps({
      connectAccount: vi.fn(async () => {
        throw new Error('The user closed the window');
      }),
    });
    const result = await handleDashboardRequest({ kind: 'connect', providerId: 'twitch' }, d);
    expect(result).toEqual({ ok: false, error: 'The user closed the window' });
  });

  it('disconnects an account', async () => {
    const d = deps();
    // A real disconnect path, so the account really leaves the document.
    const disconnect = vi.fn(async (providerId: 'twitch', accountId: string) => {
      await d.repository.removeAccount(providerId, accountId);
    });
    d.accounts = { disconnect } as never;
    await d.repository.putAccount(account());

    const result = await handleDashboardRequest(
      { kind: 'disconnect', providerId: 'twitch', accountId: 't1' },
      d,
    );

    expect(result).toEqual({ ok: true });
    expect(disconnect).toHaveBeenCalledWith('twitch', 't1');
    expect(await d.repository.accounts()).toEqual([]);
    // No channels left means the schedule no longer needs to run.
    expect(d.detection.syncSchedule).toHaveBeenCalled();
  });

  it('refuses to act on an account that is already gone', async () => {
    const d = deps();
    const result = await handleDashboardRequest(
      { kind: 'disconnect', providerId: 'twitch', accountId: 'missing' },
      d,
    );
    expect(result).toEqual({ ok: false, error: 'That account is no longer connected' });
    expect(d.accounts.disconnect).not.toHaveBeenCalled();
  });
});

describe('channel actions are account-scoped', () => {
  it('adds a channel to the named account only', async () => {
    const d = deps();
    await d.repository.putAccount(account());
    await d.repository.putAccount(account({ accountId: 't2', displayName: 'other' }));

    await handleDashboardRequest(
      { kind: 'add-channel', providerId: 'twitch', accountId: 't2', handle: 'beta' },
      d,
    );

    const args = (d.tracker.addByHandle as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(args[1]).toMatchObject({ accountId: 't2' });
    expect(args[2]).toBe('beta');
    // The other account is untouched.
    expect((await d.repository.channels('twitch', 't1')).length).toBe(0);
  });

  it('explains an unknown handle', async () => {
    const d = deps({
      tracker: {
        addByHandle: vi.fn(async () => ({ ok: false, reason: 'unknown_handle' })),
      } as never,
    });
    await d.repository.putAccount(account());

    const result = await handleDashboardRequest(
      { kind: 'add-channel', providerId: 'twitch', accountId: 't1', handle: 'nope' },
      d,
    );

    expect(result).toEqual({
      ok: false,
      error: 'No channel with that name was found on this platform',
    });
  });

  it('removes a channel from the named account only', async () => {
    const d = deps();
    // A real tracker, so the removal is observed in the stored document.
    d.tracker = new ChannelTracker(d.repository, d.clock) as never;
    await d.repository.putAccount(account());
    await d.repository.putAccount(account({ accountId: 't2' }));
    await d.repository.putChannel(channel());
    await d.repository.putChannel(channel({ accountId: 't2', providerChannelId: 'c2' }));

    await handleDashboardRequest(
      { kind: 'remove-channel', providerId: 'twitch', accountId: 't1', channelId: 'c1' },
      d,
    );

    expect((await d.repository.channels('twitch', 't1')).length).toBe(0);
    expect((await d.repository.channels('twitch', 't2')).length).toBe(1);
  });

  it('imports follows for the named account', async () => {
    const d = deps();
    await d.repository.putAccount(account());

    await handleDashboardRequest(
      { kind: 'import-follows', providerId: 'twitch', accountId: 't1' },
      d,
    );

    const args = (d.tracker.importFollowed as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(args[1]).toMatchObject({ accountId: 't1' });
  });

  it('refuses a notification change for a missing account context', async () => {
    const d = deps();
    const result = await handleDashboardRequest(
      { kind: 'add-channel', providerId: 'twitch', accountId: 'gone', handle: 'x' },
      d,
    );
    expect(result.ok).toBe(false);
  });
});

describe('notification settings', () => {
  it('persists a per-platform switch', async () => {
    const d = deps();
    const result = await handleDashboardRequest(
      { kind: 'set-notifications', providerId: 'twitch', enabled: false },
      d,
    );

    expect(result).toEqual({ ok: true });
    expect(await d.repository.notificationsEnabledFor('twitch')).toBe(false);
    expect(await d.repository.notificationsEnabledFor('kick')).toBe(true);
  });
});

describe('the unofficial import route', () => {
  it('requests the optional permissions before turning it on', async () => {
    const d = deps();
    const result = await handleDashboardRequest({ kind: 'set-unofficial-import', enabled: true }, d);

    expect(result).toEqual({ ok: true });
    expect(d.setUnofficialImportPermissions).toHaveBeenCalledWith(true);
    expect(await d.repository.unofficialFollowImportEnabled()).toBe(true);
  });

  it('leaves it off when the user refuses the permissions', async () => {
    const d = deps({ setUnofficialImportPermissions: vi.fn(async () => false) });
    await handleDashboardRequest({ kind: 'set-unofficial-import', enabled: true }, d);
    expect(await d.repository.unofficialFollowImportEnabled()).toBe(false);
  });

  it('drops the permissions when it is turned off', async () => {
    const d = deps();
    await handleDashboardRequest({ kind: 'set-unofficial-import', enabled: true }, d);
    await handleDashboardRequest({ kind: 'set-unofficial-import', enabled: false }, d);

    expect(await d.repository.unofficialFollowImportEnabled()).toBe(false);
  });

  it('makes no request while it is off', async () => {
    const d = deps();
    await d.repository.putAccount({
      accountId: 'k1',
      providerId: 'kick',
      displayName: 'k',
      credentials: { accessToken: 't', expiresAt: 1 },
      requiresReconnection: false,
    });
    d.tracker = new ChannelTracker(d.repository, d.clock) as never;

    const result = await handleDashboardRequest(
      { kind: 'unofficial-import', providerId: 'kick', accountId: 'k1' },
      d,
    );

    expect(result).toEqual({ ok: false, error: 'The unofficial follow import is turned off' });
    expect(d.kickCookie).not.toHaveBeenCalled();
  });

  it('reports an unavailable endpoint as a no-change failure', async () => {
    const d = deps({ kickCookie: vi.fn(async () => undefined) });
    await d.repository.setUnofficialFollowImportEnabled(true);
    await d.repository.putAccount({
      accountId: 'k1',
      providerId: 'kick',
      displayName: 'k',
      credentials: { accessToken: 't', expiresAt: 1 },
      requiresReconnection: false,
    });
    d.tracker = new ChannelTracker(d.repository, d.clock) as never;

    const result = await handleDashboardRequest(
      { kind: 'unofficial-import', providerId: 'kick', accountId: 'k1' },
      d,
    );

    expect(result).toEqual({
      ok: false,
      error: 'The unofficial follow import needs Kick access before it can run',
    });
    expect(await d.repository.channels('kick', 'k1')).toEqual([]);
  });

  it('refuses it for a platform that needs no unofficial import', async () => {
    const d = deps();
    await d.repository.setUnofficialFollowImportEnabled(true);
    await d.repository.putAccount(account());

    const result = await handleDashboardRequest(
      { kind: 'unofficial-import', providerId: 'twitch', accountId: 't1' },
      d,
    );

    expect(result).toEqual({ ok: false, error: 'This platform needs no unofficial import' });
  });
});

describe('message routing', () => {
  /**
   * Registers the real listener and sends one request through it, so an assertion
   * covers the response the browser would actually deliver to the popup.
   */
  function register(request: unknown, d: MessageApiDeps): Promise<unknown> {
    const listeners: Array<(r: unknown, s: unknown, respond: (v: unknown) => void) => boolean | void> = [];
    registerMessageApi(
      {
        runtime: { onMessage: { addListener: (l) => listeners.push(l) } },
        storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
      },
      d,
    );
    return new Promise<unknown>((resolve) => {
      // A recognised request must keep the channel open.
      expect(listeners[0]?.(request, {}, resolve)).toBe(true);
    });
  }

  it('only answers its own messages', () => {
    expect(isDashboardRequest({ kind: 'dashboard-state' })).toBe(true);
    expect(isDashboardRequest({ kind: 'connect', providerId: 'twitch' })).toBe(true);
    expect(isDashboardRequest({ kind: 'something-else' })).toBe(false);
    expect(isDashboardRequest(null)).toBe(false);
    expect(isDashboardRequest('dashboard-state')).toBe(false);
  });

  it('responds asynchronously and keeps the channel open', async () => {
    const d = deps();
    const listeners: Array<(r: unknown, s: unknown, respond: (v: unknown) => void) => boolean | void> =
      [];
    registerMessageApi(
      {
        runtime: { onMessage: { addListener: (l) => listeners.push(l) } },
        storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
      },
      d,
    );

    const respond = vi.fn();
    const kept = listeners[0]?.({ kind: 'connect', providerId: 'twitch' }, {}, respond);

    expect(kept).toBe(true);
    expect(respond).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: true }));
  });

  it('answers a dashboard read with a view state, not the action envelope', async () => {
    // The popup's load() consumes this directly. Answering with { ok: true } left the
    // real popup stuck on "Loading...", because the envelope is truthy and the
    // resulting render throws.
    const d = deps();
    await d.repository.putAccount(account());
    const response = await register({ kind: 'dashboard-state' }, d);

    expect(response).not.toMatchObject({ ok: true });
    expect((response as { dashboard?: unknown }).dashboard).toBeDefined();
    expect((response as { platforms?: unknown }).platforms).toEqual(platformMetadata(d));
  });

  it('answers a platform-metadata read with the platform summaries', async () => {
    const d = deps();
    const response = await register({ kind: 'platform-metadata' }, d);

    expect(response).toEqual(platformMetadata(d));
    expect(response).not.toMatchObject({ ok: true });
  });

  it('refuses to serve a read through the action router', async () => {
    // Guards against a future edit routing reads back through handleDashboardRequest,
    // which is what made the popup show nothing at all.
    const result = await handleDashboardRequest({ kind: 'dashboard-state' }, deps());
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('must be answered') });
  });

  it('reports a failed read instead of leaving the popup waiting', async () => {
    const d = deps();
    // A repository that cannot be read at all, as a revoked storage area would be.
    // A read that threw without answering would leave the popup on "Loading...".
    vi.spyOn(d.repository, 'accounts').mockRejectedValue(new Error('storage is gone'));

    await expect(register({ kind: 'dashboard-state' }, d)).resolves.toMatchObject({
      ok: false,
      error: 'storage is gone',
    });
  });

  it('ignores messages from elsewhere in the extension', async () => {
    const d = deps();
    const listeners: Array<(r: unknown, s: unknown, respond: (v: unknown) => void) => boolean | void> =
      [];
    registerMessageApi(
      {
        runtime: { onMessage: { addListener: (l) => listeners.push(l) } },
        storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
      },
      d,
    );

    const respond = vi.fn();
    expect(listeners[0]?.({ kind: 'some-other-feature' }, {}, respond)).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
  });
});
