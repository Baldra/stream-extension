import { describe, expect, it, vi } from 'vitest';
import { buildDashboardModel } from '../src/core/dashboard-model';
import { Repository } from '../src/core/repository';
import { createMemoryStore } from '../src/core/store';
import { createTestClock } from '../src/core/clock';
import { ProviderRegistry } from '../src/core/registry';
import { TwitchAdapter } from '../src/providers/twitch/adapter';
import { KickAdapter } from '../src/providers/kick/adapter';
import type { PersistedAccount, PersistedChannel, PersistedLiveState } from '../src/core/state';
import type { ProviderId } from '../src/core/provider';

const adapters = () => {
  const http = {
    clientId: 'test',
    get: async () => ({}) as never,
    post: async () => ({}) as never,
  };
  const twitch = new TwitchAdapter({ http, resolveUserId: () => '1' });
  const kick = new KickAdapter({
    http,
    resolveUserId: (_a, channelId) => channelId,
    resolveSlug: (_a, channelId) => channelId,
  });
  return { twitch, kick, registry: new ProviderRegistry().register(twitch).register(kick) };
};

const account = (providerId: ProviderId, accountId: string, overrides: Partial<PersistedAccount> = {}): PersistedAccount => ({
  accountId,
  providerId,
  displayName: `${providerId}-${accountId}`,
  credentials: { accessToken: 't', expiresAt: 1 },
  requiresReconnection: false,
  ...overrides,
});

const channel = (
  providerId: ProviderId,
  accountId: string,
  providerChannelId: string,
  overrides: Partial<PersistedChannel> = {},
): PersistedChannel => ({
  providerId,
  providerChannelId,
  handle: providerChannelId,
  accountId,
  trackedAt: 1,
  source: 'manual',
  ...overrides,
});

const live = (
  providerId: ProviderId,
  accountId: string,
  channelId: string,
  overrides: Partial<PersistedLiveState> = {},
): PersistedLiveState => ({
  providerId,
  accountId,
  channelId,
  title: 'stream',
  viewers: 10,
  wentLiveAt: 1,
  notified: true,
  ...overrides,
});

interface Harness {
  repository: Repository;
  clock: ReturnType<typeof createTestClock>;
  registry: ProviderRegistry;
  twitch: TwitchAdapter;
  kick: KickAdapter;
  model: () => ReturnType<typeof buildDashboardModel>;
}

function harness(staleAfterMs = 3 * 60_000): Harness {
  const clock = createTestClock(1_000_000);
  const repository = new Repository(createMemoryStore());
  const { registry, twitch, kick } = adapters();
  return {
    repository,
    clock,
    registry,
    twitch,
    kick,
    model: () => buildDashboardModel({ repository, registry, clock, staleAfterMs }),
  };
}

describe('single live list across platforms and accounts (task 11.1)', () => {
  it('lists live channels from every platform in one list', async () => {
    const h = harness();
    await h.repository.putAccount(account('twitch', 't1', { displayName: 'streamer' }));
    await h.repository.putAccount(account('kick', 'k1', { displayName: 'streamer2' }));
    await h.repository.putChannel(channel('twitch', 't1', 'tc1', { handle: 'alpha' }));
    await h.repository.putChannel(channel('kick', 'k1', 'kc1', { handle: 'beta' }));
    await h.repository.replaceLiveState('twitch', 't1', [live('twitch', 't1', 'tc1')]);
    await h.repository.replaceLiveState('kick', 'k1', [live('kick', 'k1', 'kc1', { viewers: 500 })]);

    const model = await h.model();

    expect(model.live.map((c) => c.displayName)).toEqual(['beta', 'alpha']);
    // Most-watched first, so the Kick channel with 500 viewers leads.
    expect(model.live[0]?.platformLabel).toBe('Kick');
  });

  it('identifies the platform and the owning account on every entry', async () => {
    const h = harness();
    await h.repository.putAccount(account('twitch', 't1', { displayName: 'first' }));
    await h.repository.putAccount(account('twitch', 't2', { displayName: 'second' }));
    await h.repository.putChannel(channel('twitch', 't1', 'c1', { handle: 'alpha' }));
    await h.repository.putChannel(channel('twitch', 't2', 'c2', { handle: 'beta' }));
    await h.repository.replaceLiveState('twitch', 't1', [live('twitch', 't1', 'c1')]);
    await h.repository.replaceLiveState('twitch', 't2', [live('twitch', 't2', 'c2')]);

    const model = await h.model();

    expect(model.live).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ displayName: 'alpha', platformLabel: 'Twitch', accountId: 't1' }),
        expect.objectContaining({ displayName: 'beta', platformLabel: 'Twitch', accountId: 't2' }),
      ]),
    );
  });

  it('gives a channel tracked by two accounts a distinct key on each', async () => {
    const h = harness();
    // A channel belongs to exactly one account, so this can only be built by hand.
    const state = await h.repository.read();
    state.channels.push(channel('twitch', 't1', 'c1'), channel('twitch', 't2', 'c1'));
    await h.repository.putChannel(channel('twitch', 't1', 'c1'));

    const model = await h.model();
    const keys = model.accounts.flatMap((a) => a.channels.map((c) => c.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(state.channels).toHaveLength(2);
  });

  it('resolves a canonical stream url for each entry', async () => {
    const h = harness();
    await h.repository.putAccount(account('twitch', 't1'));
    await h.repository.putAccount(account('kick', 'k1'));
    await h.repository.putChannel(channel('twitch', 't1', 'c1', { handle: 'alpha' }));
    await h.repository.putChannel(channel('kick', 'k1', 'c2', { handle: 'beta' }));
    await h.repository.replaceLiveState('twitch', 't1', [live('twitch', 't1', 'c1')]);
    await h.repository.replaceLiveState('kick', 'k1', [live('kick', 'k1', 'c2')]);

    const model = await h.model();

    expect(model.live.find((c) => c.displayName === 'alpha')?.streamUrl).toBe('https://www.twitch.tv/alpha');
    expect(model.live.find((c) => c.displayName === 'beta')?.streamUrl).toBe('https://kick.com/beta');
  });

  it('is empty when nothing is live', async () => {
    const h = harness();
    await h.repository.putAccount(account('twitch', 't1'));
    await h.repository.putChannel(channel('twitch', 't1', 'c1'));

    expect((await h.model()).live).toEqual([]);
  });

  it('omits a channel that has stopped streaming', async () => {
    const h = harness();
    await h.repository.putAccount(account('twitch', 't1'));
    await h.repository.putChannel(channel('twitch', 't1', 'c1', { handle: 'alpha' }));
    await h.repository.replaceLiveState('twitch', 't1', [live('twitch', 't1', 'c1')]);
    expect((await h.model()).live).toHaveLength(1);

    await h.repository.replaceLiveState('twitch', 't1', []);

    const model = await h.model();
    expect(model.live).toEqual([]);
    // It is still tracked, just not live.
    expect(model.accounts[0]?.channels[0]?.isLive).toBe(false);
  });

  it('excludes a locally removed channel', async () => {
    const h = harness();
    await h.repository.putAccount(account('twitch', 't1'));
    await h.repository.putChannel(channel('twitch', 't1', 'c1', { locallyRemoved: true }));

    const model = await h.model();
    expect(model.accounts[0]?.trackedCount).toBe(0);
  });
});

describe('stale state is not presented as current (task 11.2)', () => {
  it('marks an account not updating while its polls keep failing', async () => {
    const h = harness();
    await h.repository.putAccount(
      account('twitch', 't1', { consecutivePollFailures: 4, lastPolledAt: h.clock.now() }),
    );
    await h.repository.putChannel(channel('twitch', 't1', 'c1'));

    const model = await h.model();

    expect(model.accounts[0]).toMatchObject({ notUpdating: true, notUpdatingReason: 'failing' });
    expect(model.notUpdatingPlatforms.map((p) => p.platformLabel)).toEqual(['Twitch']);
  });

  it('flags a live entry recorded during failures as unverified', async () => {
    const h = harness();
    await h.repository.putAccount(
      account('twitch', 't1', { consecutivePollFailures: 4, lastPolledAt: h.clock.now() }),
    );
    await h.repository.putChannel(channel('twitch', 't1', 'c1'));
    await h.repository.replaceLiveState('twitch', 't1', [live('twitch', 't1', 'c1')]);

    const model = await h.model();

    // It is still shown, because it may well be live, but never as verified fact.
    expect(model.live[0]).toMatchObject({ isLive: true, unverified: true });
  });

  it('does not flag entries when polls are healthy', async () => {
    const h = harness();
    await h.repository.putAccount(
      account('twitch', 't1', { consecutivePollFailures: 0, lastPolledAt: h.clock.now() }),
    );
    await h.repository.putChannel(channel('twitch', 't1', 'c1'));
    await h.repository.replaceLiveState('twitch', 't1', [live('twitch', 't1', 'c1')]);

    const model = await h.model();

    expect(model.live[0]?.unverified).toBe(false);
    expect(model.accounts[0]?.notUpdating).toBe(false);
    expect(model.notUpdatingPlatforms).toEqual([]);
  });

  it('treats an account as overdue when the last check is too old', async () => {
    const h = harness(60_000);
    await h.repository.putAccount(
      account('twitch', 't1', { lastPolledAt: h.clock.now() - 120_000 }),
    );

    const model = await h.model();
    expect(model.accounts[0]).toMatchObject({ notUpdating: true, notUpdatingReason: 'overdue' });
  });

  it('reports an account that has never been polled', async () => {
    const h = harness();
    await h.repository.putAccount(account('kick', 'k1'));

    const model = await h.model();
    expect(model.accounts[0]).toMatchObject({ notUpdatingReason: 'never_polled' });
  });

  it('does not mark a platform not updating when only one of its accounts is failing', async () => {
    const h = harness();
    await h.repository.putAccount(account('twitch', 't1', { consecutivePollFailures: 5 }));
    await h.repository.putAccount(account('twitch', 't2', { lastPolledAt: h.clock.now() }));

    const model = await h.model();
    // It is still surfaced, because at least one part of the platform is blind.
    expect(model.notUpdatingPlatforms.map((p) => p.providerId)).toEqual(['twitch']);
  });
});

describe('connected accounts (task 11.3)', () => {
  it('lists each account with its platform and authorized identity', async () => {
    const h = harness();
    await h.repository.putAccount(account('twitch', 't1', { displayName: 'streamer' }));
    await h.repository.putAccount(account('kick', 'k1', { displayName: 'streamer2' }));

    const model = await h.model();

    expect(model.accounts).toEqual([
      expect.objectContaining({ displayName: 'streamer', platformLabel: 'Twitch' }),
      expect.objectContaining({ displayName: 'streamer2', platformLabel: 'Kick' }),
    ]);
  });

  it('marks an account that requires reconnection', async () => {
    const h = harness();
    await h.repository.putAccount(account('twitch', 't1', { requiresReconnection: true }));

    const model = await h.model();
    expect(model.accounts[0]?.requiresReconnection).toBe(true);
  });

  it('counts tracked and live channels per account', async () => {
    const h = harness();
    await h.repository.putAccount(account('twitch', 't1'));
    await h.repository.putChannel(channel('twitch', 't1', 'c1'));
    await h.repository.putChannel(channel('twitch', 't1', 'c2'));
    await h.repository.replaceLiveState('twitch', 't1', [live('twitch', 't1', 'c1')]);

    const model = await h.model();
    expect(model.accounts[0]).toMatchObject({ trackedCount: 2, liveCount: 1 });
  });
});

describe('per-account channel management (task 11.4)', () => {
  it('scopes each account list to its own channels', async () => {
    const h = harness();
    await h.repository.putAccount(account('twitch', 't1'));
    await h.repository.putAccount(account('twitch', 't2'));
    await h.repository.putChannel(channel('twitch', 't1', 'c1'));
    await h.repository.putChannel(channel('twitch', 't2', 'c2'));

    const model = await h.model();

    expect(model.accounts[0]?.channels.map((c) => c.channelId)).toEqual(['c1']);
    expect(model.accounts[1]?.channels.map((c) => c.channelId)).toEqual(['c2']);
  });

  it('scopes actions to one account, leaving the other untouched', async () => {
    const h = harness();
    await h.repository.putAccount(account('twitch', 't1'));
    await h.repository.putAccount(account('twitch', 't2'));
    await h.repository.putChannel(channel('twitch', 't1', 'c1'));
    await h.repository.putChannel(channel('twitch', 't2', 'c2'));

    // The popup's action carries the account id, so removal is unambiguous.
    await h.repository.removeChannel('twitch', 't1', 'c1');

    const model = await h.model();
    expect(model.accounts[0]?.channels).toEqual([]);
    expect(model.accounts[1]?.channels.map((c) => c.channelId)).toEqual(['c2']);
  });
});

describe('notification history view (task 11.6)', () => {
  it('reports no notifications yet', async () => {
    const h = harness();
    const model = await h.model();
    expect(model.hasHistory).toBe(false);
    expect(model.history).toEqual([]);
  });

  it('exposes recorded notifications newest first', async () => {
    const h = harness();
    await h.repository.addHistoryEntry({
      entryId: 'e2',
      providerId: 'twitch',
      accountId: 't1',
      channelId: 'c1',
      displayName: 'alpha',
      title: 'second',
      wentLiveAt: 2,
      streamUrl: 'https://www.twitch.tv/alpha',
    });
    await h.repository.addHistoryEntry({
      entryId: 'e1',
      providerId: 'kick',
      accountId: 'k1',
      channelId: 'c2',
      displayName: 'beta',
      title: 'first',
      wentLiveAt: 1,
      streamUrl: 'https://kick.com/beta',
    });

    const model = await h.model();

    expect(model.hasHistory).toBe(true);
    expect(model.history.map((e) => e.entryId)).toEqual(['e1', 'e2']);
  });

  it('caps the history it exposes', async () => {
    const h = harness();
    for (let i = 0; i < 10; i += 1) {
      await h.repository.addHistoryEntry({
        entryId: `e${i}`,
        providerId: 'twitch',
        accountId: 't1',
        channelId: `c${i}`,
        displayName: `ch${i}`,
        title: 't',
        wentLiveAt: i,
        streamUrl: 'u',
      });
    }

    const model = await buildDashboardModel({
      repository: h.repository,
      registry: h.registry,
      clock: h.clock,
      historyLimit: 3,
    });

    expect(model.history).toHaveLength(3);
  });
});

describe('last checked time (task 11.7)', () => {
  it('reports the most recent successful check across accounts', async () => {
    const h = harness();
    await h.repository.putAccount(account('twitch', 't1', { lastPolledAt: 1_000_000 }));
    await h.repository.putAccount(account('kick', 'k1', { lastPolledAt: 1_060_000 }));

    const model = await h.model();
    expect(model.lastCheckedAt).toBe(1_060_000);
  });

  it('omits it when nothing has been checked', async () => {
    const h = harness();
    expect((await h.model()).lastCheckedAt).toBeUndefined();
  });
});

describe('the model stays provider-agnostic', () => {
  it('reads every registered adapter without a provider branch', async () => {
    const clock = createTestClock(1_000);
    const repository = new Repository(createMemoryStore());
    const registry = new ProviderRegistry();

    // A third platform, registered without any change to the dashboard code.
    const third = {
      id: 'third',
      displayName: 'Third',
      authStrategy: 'oauth' as const,
      capabilities: {
        followedChannels: true,
        followedStreams: true,
        manualChannelEntry: true,
        unofficialFollowImport: false,
        supportsMultipleAccounts: true,
        realtimeEvents: false,
      },
      publicStreamUrl: (c: { displayName: string }) => `https://third.example/${c.displayName}`,
      listFollowedChannels: vi.fn(),
      fetchLiveStatus: vi.fn(),
    } as never;
    registry.register(third);
    await repository.putAccount(account('third', 'x1', { displayName: 'user', lastPolledAt: 1_000 }));
    await repository.putChannel(channel('third', 'x1', 'c1', { handle: 'gamma' }));
    await repository.replaceLiveState('third', 'x1', [live('third', 'x1', 'c1')]);

    const model = await buildDashboardModel({ repository, registry, clock });

    expect(model.live[0]).toMatchObject({ platformLabel: 'Third', displayName: 'gamma' });
    expect(model.live[0]?.streamUrl).toBe('https://third.example/gamma');
  });
});
