import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../src/core/registry';
import { buildDashboardModel } from '../src/core/dashboard-model';
import { Platforms, renderDashboard } from '../src/popup/view';
import { describeSharedProviderBehaviour } from './helpers/shared-behaviour';
import { createFixture, UpstreamFixture } from './helpers/fixture-state';
import type { ProviderFixture } from './helpers/fixture';
import type { AuthStrategy, ProviderAdapter, ProviderCapabilities, ResolvedChannel } from '../src/core/provider';

/**
 * Task 13.5: the guide must actually work.
 *
 * This file follows `docs/setup.md` rather than testing it. A third adapter is
 * written from the documented snippet alone, run through the documented
 * shared-behaviour suite, and then registered the documented way. If the guide
 * drifts from the code, this stops compiling or stops passing.
 */

/**
 * Step 1 of the guide: the adapter, as the guide spells it out.
 *
 * The only additions are the two closures over the faked upstream that any real
 * adapter would close over its own HTTP routes.
 */
/**
 * The faked upstream the adapter reads. A real adapter closes over its route table;
 * here the fixture swaps the backing data per test, exactly as the Twitch and Kick
 * fixtures do by constructing a fresh upstream inside their builder.
 */
let upstream = new UpstreamFixture();
let failWith: Error | undefined;
/** Page size the faked endpoint honours, so pagination can be exercised. */
const page = { size: undefined as number | undefined };

const documentedAdapter = {
  id: 'myplatform',
  displayName: 'MyPlatform',
  authStrategy: 'oauth' as AuthStrategy,
  capabilities: {
    followedChannels: true,
    followedStreams: true,
    manualChannelEntry: true,
    unofficialFollowImport: false,
    supportsMultipleAccounts: true,
    realtimeEvents: false,
  } satisfies ProviderCapabilities,
  publicStreamUrl: (channel: ResolvedChannel) => `https://myplatform.example/${channel.displayName}`,

  async listFollowedChannels(account, cursor) {
    // A real endpoint answers one page at a time; `nextCursor` undefined means the
    // listing is exhausted, and the tracker keeps asking until it says so.
    const all = upstream.handles().map(({ channelId, handle }) => ({
      channelId,
      displayName: handle,
      accountId: account.accountId,
    }));
    const size = page.size ?? all.length;
    const start = cursor ? Number(cursor) : 0;
    const channels = all.slice(start, start + size);
    const next = start + size;
    return { channels, ...(next < all.length ? { nextCursor: String(next) } : {}) };
  },
  async resolveChannelByHandle(account, handle) {
    const found = upstream.handles().find((entry) => entry.handle === handle);
    return found ? { channelId: found.channelId, displayName: found.handle, accountId: account.accountId } : undefined;
  },
  async fetchLiveStatus(account, channelIds) {
    if (failWith) {
      const error = failWith;
      failWith = undefined;
      throw error;
    }
    const live = upstream
      .liveEntries()
      .filter((entry) => channelIds.includes(entry.channelId))
      .map((entry) => entry.info);
    const wentOffline = channelIds.filter((id) => !live.some((info) => info.channelId === id));
    return { providerId: 'myplatform', accountId: account.accountId, live, wentOffline, warnings: [] };
  },
} satisfies ProviderAdapter;

/** Step 5 of the guide: the shared behaviour suite over a fixture. */
function documentedFixture(): ProviderFixture {
  // A fresh upstream per test, so one test's channels cannot leak into the next.
  upstream = new UpstreamFixture();
  failWith = undefined;
  page.size = undefined;
  return createFixture(
    documentedAdapter,
    {
      failPollOnce: (error) => {
        failWith = error;
      },
      setPageSize: (size) => {
        page.size = size;
      },
      streamUrlFor: (channelId, handle) =>
        documentedAdapter.publicStreamUrl({ channelId, displayName: handle, accountId: '' }),
    },
    {
      follow: (channelId, handle) => upstream.follow(channelId, handle),
      setLive: (channelId, handle, info) => upstream.setLive(channelId, handle, info),
      setOffline: (channelId) => upstream.setOffline(channelId),
    },
  );
}

describeSharedProviderBehaviour('MyPlatformAdapter', documentedFixture);

describe('adding a provider touches no core code (task 13.5)', () => {
  it('is discoverable purely through registration', () => {
    // Step 4: one registration is the whole integration.
    const registry = new ProviderRegistry().register(documentedAdapter);

    expect(registry.ids).toEqual(['myplatform']);
    expect(registry.get('myplatform').displayName).toBe('MyPlatform');
  });

  it('is detected, notified and rendered without changes to detection or the popup', async () => {
    const registry = new ProviderRegistry().register(documentedAdapter);
    const { LiveDetectionService } = await import('../src/core/detection');
    const { NotificationService } = await import('../src/core/notifications');
    const { createTestScheduler } = await import('../src/core/scheduler');
    const { createTestClock } = await import('../src/core/clock');
    const { createMemoryStore } = await import('../src/core/store');
    const { Repository } = await import('../src/core/repository');
    const { ChannelTracker } = await import('../src/core/tracking');
    const { AccountManager } = await import('../src/core/accounts');

    const repository = new Repository(createMemoryStore());
    const clock = createTestClock(1_000);
    const shown: string[] = [];
    const account = {
      accountId: 'a1',
      providerId: 'myplatform',
      displayName: 'me',
      credentials: { accessToken: 't', refreshToken: 'r', expiresAt: 10_000 },
      requiresReconnection: false,
    };

    const accounts = new AccountManager({
      repository,
      clock,
      clientIds: {},
      redirectUri: 'https://id.chromiumapp.org/',
      broker: {
        exchange: async () => ({ access_token: 't', expires_in: 7200 }),
        refresh: async () => ({ access_token: 't', refresh_token: 'r', expires_in: 7200 }),
        revoke: async () => {},
      },
    });
    const notifications = new NotificationService({
      repository,
      api: {
        permission: async () => 'granted',
        requestPermission: async () => 'granted',
        create: async (id) => {
          shown.push(id);
          return id;
        },
        clear: async () => true,
      },
      platformLabel: (id) => registry.get(id).displayName,
    });
    const detection = new LiveDetectionService({
      registry,
      repository,
      accounts,
      scheduler: createTestScheduler(),
      clock,
      streamUrlFor: (providerId, channelId, displayName) =>
        registry.get(providerId).publicStreamUrl({ channelId, displayName, accountId: 'a1' }),
      onWentLive: async (notice) => {
        await notifications.raise(notice, notice.category);
      },
    });

    await repository.putAccount(account);
    upstream.follow('m1', 'gamma');
    const tracker = new ChannelTracker(repository, clock);
    expect((await tracker.addByHandle(documentedAdapter, account, 'gamma')).ok).toBe(true);

    // The documented `pollAccount` contract: baseline, then a transition.
    await detection.pollAll();
    upstream.setLive('m1', 'gamma', { title: 'new game' });
    await detection.pollAll();

    expect(shown).toHaveLength(1);
    expect(await repository.liveChannelIds('myplatform', 'a1')).toEqual(['m1']);

    // And the popup renders it from the adapter's own metadata.
    const model = await buildDashboardModel({ repository, registry, clock });
    const html = renderDashboard(model, {
      now: 1_000,
      // The popup needs only serializable metadata, which the worker's
      // buildPopupViewState derives from the same registry.
      registry: new Platforms(
        registry.all().map((adapter) => ({
          id: adapter.id,
          displayName: adapter.displayName,
          capabilities: adapter.capabilities,
        })),
      ),
      unofficialImportEnabled: false,
      notificationsGranted: true,
      notificationsEnabledFor: (providerId) => providerId === 'myplatform',
    });

    expect(html).toContain('MyPlatform');
    expect(html).toContain('gamma');
    expect(html).toContain('https://myplatform.example/gamma');
  });
});
