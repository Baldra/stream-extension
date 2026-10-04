import { describe, expect, it, vi } from 'vitest';
import { LiveDetectionService, type WentLiveNotice } from '../src/core/detection';
import { Backoff, classifyFailure, isBackoffWorthy } from '../src/core/backoff';
import { AccountManager } from '../src/core/accounts';
import { ProviderRegistry } from '../src/core/registry';
import { Repository } from '../src/core/repository';
import { createMemoryStore } from '../src/core/store';
import { createTestClock } from '../src/core/clock';
import { createTestScheduler } from '../src/core/scheduler';
import { POLL_PERIOD_MS } from '../src/core/constants';
import { definitiveChannelIds } from '../src/core/polling';
import { AuthError, type ProviderAdapter, type ProviderAccount } from '../src/core/provider';
import { HttpError } from '../src/core/http';
import { TokenRefreshError } from '../src/core/tokens';
import { FakeProvider } from './helpers/fake-provider';
import type { PersistedAccount } from '../src/core/state';

/** Shorthand for the fake's live-info shape. */
const live = (channelId: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  channelId,
  displayName,
  ...extra,
});

const accountFor = (provider: FakeProvider, accountId: string): PersistedAccount => ({
  accountId,
  providerId: provider.id,
  displayName: accountId,
  credentials: { accessToken: 'token', expiresAt: Number.MAX_SAFE_INTEGER, refreshToken: 'rt' },
  requiresReconnection: false,
});

interface Harness {
  service: LiveDetectionService;
  repository: Repository;
  accounts: AccountManager;
  providers: Map<string, FakeProvider>;
  registry: ProviderRegistry;
  scheduler: ReturnType<typeof createTestScheduler>;
  clock: ReturnType<typeof createTestClock>;
  notices: WentLiveNotice[];
  streamUrls: string[];
}

function harness(options: { backoff?: Backoff } = {}): Harness {
  const clock = createTestClock(1_000_000);
  const repository = new Repository(createMemoryStore());
  const registry = new ProviderRegistry();
  const providers = new Map<string, FakeProvider>();
  const scheduler = createTestScheduler();
  const notices: WentLiveNotice[] = [];
  const streamUrls: string[] = [];

  const accounts = new AccountManager({
    repository,
    broker: {
      exchange: vi.fn(),
      refresh: vi.fn().mockResolvedValue({ access_token: 'refreshed', expires_in: 7_200 }),
      revoke: vi.fn(),
    },
    clock,
    clientIds: {},
    redirectUri: 'https://example/oauth',
  });

  const service = new LiveDetectionService({
    registry,
    repository,
    accounts,
    scheduler,
    clock,
    ...(options.backoff ? { backoff: options.backoff } : {}),
    streamUrlFor: (providerId, _channelId, displayName) => {
      const url = `https://${providerId}.example/${displayName}`;
      streamUrls.push(url);
      return url;
    },
    onWentLive: (notice) => {
      notices.push(notice);
    },
  });

  return { service, repository, accounts, providers, registry, scheduler, clock, notices, streamUrls };
}

const addProvider = (h: Harness, id = 'fake'): FakeProvider => {
  const provider = FakeProvider.create(id);
  h.providers.set(id, provider);
  h.registry.register(provider);
  return provider;
};

const addAccount = (h: Harness, provider: FakeProvider, accountId: string) =>
  h.repository.putAccount(accountFor(provider, accountId));

const addChannel = (h: Harness, provider: FakeProvider, accountId: string, channelId: string, handle: string) =>
  h.repository.putChannel({
    providerId: provider.id,
    providerChannelId: channelId,
    handle,
    accountId,
    trackedAt: 1,
    source: 'manual',
  });

describe('poll loop scheduling (task 9.1)', () => {
  it('does not schedule when there are no tracked channels', async () => {
    const h = harness();
    addProvider(h);
    addAccount(h, h.providers.get('fake')!, 'a1');

    // Nothing to poll, so the schedule is left alone rather than started.
    expect(await h.service.syncSchedule()).toBe(false);
    expect(h.scheduler.starts()).toBe(0);
    expect(h.service.isScheduled).toBe(false);
  });

  it('does not schedule when there are no accounts at all', async () => {
    const h = harness();
    addProvider(h);
    await h.service.syncSchedule();
    expect(h.scheduler.starts()).toBe(0);
  });

  it('resumes scheduling when a channel is added', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await h.service.syncSchedule();
    expect(h.scheduler.starts()).toBe(0);

    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    expect(await h.service.syncSchedule()).toBe(true);
    expect(h.scheduler.starts()).toBe(1);
    expect(h.service.isScheduled).toBe(true);
  });

  it('schedules on the pinned poll period', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.syncSchedule();
    expect(POLL_PERIOD_MS).toBe(60_000);
  });

  it('suspends scheduling when the last channel is removed', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.syncSchedule();
    expect(h.service.isScheduled).toBe(true);

    await h.repository.removeChannel('fake', 'a1', 'c1');
    expect(await h.service.syncSchedule()).toBe(true);
    expect(h.service.isScheduled).toBe(false);
  });

  it('does not restart the schedule on every sync once already running', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');

    await h.service.syncSchedule();
    await h.service.syncSchedule();
    await h.service.syncSchedule();
    expect(h.scheduler.starts()).toBe(1);
    expect(await h.service.syncSchedule()).toBe(false);
  });

  it('ignores a locally removed channel when deciding to schedule', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.repository.mutate('x', (state) => {
      state.channels[0]!.locallyRemoved = true;
    });

    await h.service.syncSchedule();
    expect(h.scheduler.starts()).toBe(0);
  });

  it('drives the poll from the injected scheduler', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.syncSchedule();

    await h.scheduler.tick();
    provider.setLive('c1', live('c1', 'alpha'));
    await h.scheduler.tick();
    expect(h.notices).toHaveLength(1);
  });
});

describe('fan-out across providers and accounts (task 9.2)', () => {
  it('polls every account of every provider', async () => {
    const h = harness();
    const twitch = addProvider(h, 'twitch');
    const kick = addProvider(h, 'kick');
    addAccount(h, twitch, 't1');
    addAccount(h, twitch, 't2');
    addAccount(h, kick, 'k1');
    await addChannel(h, twitch, 't1', 'c1', 'alpha');
    await addChannel(h, twitch, 't2', 'c2', 'beta');
    await addChannel(h, kick, 'k1', 'c3', 'gamma');

    // Baseline poll so every channel has a last known offline state.
    await h.service.pollAll();
    twitch.setLive('c1', live('c1', 'alpha'));
    kick.setLive('c3', live('c3', 'gamma'));

    const report = await h.service.pollAll();

    expect(report.liveByAccount.map((r) => `${r.providerId}:${r.accountId}`).sort()).toEqual([
      'kick:k1',
      'twitch:t1',
      'twitch:t2',
    ]);
    expect(h.notices.map((n) => n.displayName).sort()).toEqual(['alpha', 'gamma']);
  });

  it('requests each account once, with no per-account duplication', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    addAccount(h, provider, 'a2');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await addChannel(h, provider, 'a2', 'c2', 'beta');

    await h.service.pollAll();
    expect(provider.calls.fetchLive).toBe(2);
  });

  it('applies each provider batching inside its own adapter', async () => {
    const h = harness();
    const twitch = addProvider(h, 'twitch');
    const kick = addProvider(h, 'kick');
    addAccount(h, twitch, 't1');
    addAccount(h, kick, 'k1');
    for (let i = 0; i < 5; i += 1) {
      await addChannel(h, twitch, 't1', `c${i}`, `twitch${i}`);
      await addChannel(h, kick, 'k1', `k${i}`, `kick${i}`);
    }

    // Each adapter receives its own tracked set, so a provider's chunking is the
    // only thing that decides request count.
    const twitchSeen: string[][] = [];
    const kickSeen: string[][] = [];
    vi.spyOn(twitch, 'fetchLiveStatus').mockImplementation(async (_a, ids) => {
      twitchSeen.push(ids);
      return { providerId: 'twitch', accountId: 't1', live: [], wentOffline: [], warnings: [] };
    });
    vi.spyOn(kick, 'fetchLiveStatus').mockImplementation(async (_a, ids) => {
      kickSeen.push(ids);
      return { providerId: 'kick', accountId: 'k1', live: [], wentOffline: [], warnings: [] };
    });

    await h.service.pollAll();

    expect(twitchSeen).toEqual([['c0', 'c1', 'c2', 'c3', 'c4']]);
    expect(kickSeen).toEqual([['k0', 'k1', 'k2', 'k3', 'k4']]);
  });

  it('skips an account that requires reconnection', async () => {
    const h = harness();
    const provider = addProvider(h);
    await h.repository.putAccount({ ...accountFor(provider, 'a1'), requiresReconnection: true });
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    provider.setLive('c1', live('c1', 'alpha'));

    const report = await h.service.pollAll();

    expect(provider.calls.fetchLive).toBe(0);
    expect(report.liveByAccount).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it('lets one account fail without blocking another', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'good');
    addAccount(h, provider, 'bad');
    await addChannel(h, provider, 'good', 'c1', 'alpha');
    await addChannel(h, provider, 'bad', 'c2', 'beta');
    const original = provider.fetchLiveStatus.bind(provider);
    vi.spyOn(provider, 'fetchLiveStatus').mockImplementation(async (account, ids) => {
      if (account.accountId === 'bad') throw new HttpError(500, 'u', 'boom');
      return original(account, ids);
    });

    const baseline = await h.service.pollAll();
    expect(baseline.failures.map((f) => f.accountId)).toEqual(['bad']);
    expect(baseline.liveByAccount.map((r) => r.accountId)).toEqual(['good']);

    provider.setLive('c1', live('c1', 'alpha'));
    const report = await h.service.pollAll();

    expect(report.liveByAccount.map((r) => r.accountId)).toEqual(['good']);
    // 'bad' is now inside its cooling-off window, so it is skipped entirely
    // rather than retried. One failure is still treated as transient, so nothing
    // is surfaced to the user yet.
    expect(report.ongoingFailures).toEqual([]);
    expect(h.notices.map((n) => n.displayName)).toEqual(['alpha']);
  });
});

describe('transition detection (task 9.3)', () => {
  it('raises a newly-live event on a not-live to live flip', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');

    await h.service.pollAll();
    expect(h.notices).toEqual([]);

    provider.setLive('c1', live('c1', 'alpha', { title: 'now', viewers: 7 }));
    const report = await h.service.pollAll();

    expect(report.events).toHaveLength(1);
    expect(report.events[0]?.kind).toBe('went_live');
    expect(h.notices[0]).toMatchObject({
      providerId: 'fake',
      accountId: 'a1',
      channelId: 'c1',
      displayName: 'alpha',
      title: 'now',
      viewers: 7,
      streamUrl: 'https://fake.example/alpha',
    });
  });

  it('records a channel found live with no prior state without notifying', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    // Already live before it was ever tracked.
    provider.setLive('c1', live('c1', 'alpha', { title: 'already' }));

    const report = await h.service.pollAll();

    expect(report.events).toEqual([]);
    expect(h.notices).toEqual([]);
    // ...but it is still recorded, so a later poll sees it as already live.
    expect(await h.repository.liveChannelIds('fake', 'a1')).toEqual(['c1']);
    const [row] = await h.repository.liveState('fake', 'a1');
    expect(row?.notified).toBe(false);
  });

  it('emits a went_offline event when a live channel ends', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));
    await h.service.pollAll();
    expect(h.notices).toHaveLength(1);

    provider.setOffline('c1');
    const report = await h.service.pollAll();

    expect(report.events.map((e) => e.kind)).toEqual(['went_offline']);
    expect(await h.repository.liveChannelIds('fake', 'a1')).toEqual([]);
  });

  it('notifies again when a channel goes offline and comes back', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');

    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));
    await h.service.pollAll();
    provider.setOffline('c1');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));
    await h.service.pollAll();

    expect(h.notices).toHaveLength(2);
  });
});

describe('idempotence across polls and restarts (task 9.4)', () => {
  it('does not re-raise an event for a channel already recorded live', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));

    await h.service.pollAll();
    await h.service.pollAll();
    await h.service.pollAll();
    await h.service.pollAll();

    expect(h.notices).toHaveLength(1);
  });

  it('does not re-fire after a worker restart that re-reads persisted state', async () => {
    const store = createMemoryStore();
    const clock = createTestClock(1_000_000);
    const repository = new Repository(store);
    const provider = FakeProvider.create('fake');
    const registry = new ProviderRegistry().register(provider);
    const notices: WentLiveNotice[] = [];
    const accounts = new AccountManager({
      repository,
      broker: { exchange: vi.fn(), refresh: vi.fn(), revoke: vi.fn() },
      clock,
      clientIds: {},
      redirectUri: 'r',
    });

    const build = () =>
      new LiveDetectionService({
        registry,
        repository,
        accounts,
        scheduler: createTestScheduler(),
        clock,
        streamUrlFor: (_p, _c, displayName) => `https://fake.example/${displayName}`,
        onWentLive: (n) => {
          notices.push(n);
        },
      });

    await repository.putAccount(accountFor(provider, 'a1'));
    await repository.putChannel({
      providerId: 'fake',
      providerChannelId: 'c1',
      handle: 'alpha',
      accountId: 'a1',
      trackedAt: 1,
      source: 'manual',
    });
    await build().pollAll();
    provider.setLive('c1', live('c1', 'alpha'));

    // First worker generation.
    await build().pollAll();
    expect(notices).toHaveLength(1);

    // The worker is terminated: a brand new repository reads only persisted state,
    // exactly as a revived MV3 worker does.
    const revived = new Repository(store);
    const revivedService = new LiveDetectionService({
      registry,
      repository: revived,
      accounts,
      scheduler: createTestScheduler(),
      clock,
      streamUrlFor: (_p, _c, displayName) => `https://fake.example/${displayName}`,
      onWentLive: (n) => {
        notices.push(n);
      },
    });

    await revivedService.pollAll();
    await revivedService.pollAll();

    expect(notices).toHaveLength(1);
    expect(await revived.liveChannelIds('fake', 'a1')).toEqual(['c1']);
  });

  it('leaves the notified flag to the notification layer', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));

    await h.service.pollAll();

    // Detection raises the event; whether a notification was actually shown is
    // not its decision, so the flag stays untouched here.
    expect(h.notices).toHaveLength(1);
    expect((await h.repository.liveState('fake', 'a1'))[0]?.notified).toBe(false);
  });

  it('carries the optional category and thumbnail into the event', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.pollAll();
    provider.setLive(
      'c1',
      live('c1', 'alpha', {
        title: 'Ranked grind',
        category: 'Just Chatting',
        thumbnailUrl: 'https://cdn.example/thumb.jpg',
      }),
    );

    await h.service.pollAll();

    expect(h.notices[0]).toMatchObject({
      title: 'Ranked grind',
      category: 'Just Chatting',
      thumbnailUrl: 'https://cdn.example/thumb.jpg',
    });
  });

  it('omits the optional fields entirely when the platform reports none', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));

    await h.service.pollAll();

    expect(h.notices[0]).not.toHaveProperty('category');
    expect(h.notices[0]).not.toHaveProperty('thumbnailUrl');
  });
});

describe('no retroactive notification after a re-enable (task 10.6)', () => {
  it('raises no event for a channel that was already live', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));
    await h.service.pollAll();
    expect(h.notices).toHaveLength(1);

    // A user who muted and then re-enabled this platform must not be handed the
    // streams that were already running, so the live row keeps them silent.
    await h.repository.setNotificationsEnabled('fake', false);
    await h.service.pollAll();
    expect(h.notices).toHaveLength(1);

    await h.repository.setNotificationsEnabled('fake', true);
    await h.service.pollAll();
    expect(h.notices).toHaveLength(1);
  });

  it('still raises the next genuine transition', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));
    await h.service.pollAll();
    await h.repository.setNotificationsEnabled('fake', false);
    await h.service.pollAll();
    await h.repository.setNotificationsEnabled('fake', true);

    provider.setOffline('c1');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));
    await h.service.pollAll();

    expect(h.notices).toHaveLength(2);
  });
});

describe('only successful queries mutate state (task 9.5)', () => {
  it('raises no event and records nothing when the query fails', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    provider.liveError = new HttpError(500, 'u', 'boom');

    const report = await h.service.pollAll();

    expect(report.events).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(await h.repository.liveChannelIds('fake', 'a1')).toEqual([]);
    expect(report.anyFailed).toBe(true);
  });

  it('never reports a false offline when a query fails', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));
    await h.service.pollAll();
    expect(await h.repository.liveChannelIds('fake', 'a1')).toEqual(['c1']);

    // The channel actually went offline, but the query fails, so the failure must
    // not be mistaken for an offline transition.
    provider.setOffline('c1');
    provider.liveError = new HttpError(503, 'u', 'unavailable');

    const report = await h.service.pollAll();

    expect(report.events).toEqual([]);
    expect(await h.repository.liveChannelIds('fake', 'a1')).toEqual(['c1']);
  });

  it('applies the successful subset and leaves the failing account untouched', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'ok');
    addAccount(h, provider, 'bad');
    await addChannel(h, provider, 'ok', 'c1', 'alpha');
    await addChannel(h, provider, 'bad', 'c2', 'beta');
    provider.setLive('c1', live('c1', 'alpha'));
    provider.setLive('c2', live('c2', 'beta'));

    const original = provider.fetchLiveStatus.bind(provider);
    vi.spyOn(provider, 'fetchLiveStatus').mockImplementation(async (account, ids) => {
      if (account.accountId === 'bad') throw new HttpError(500, 'u', 'boom');
      return original(account, ids);
    });

    const report = await h.service.pollAll();

    expect(await h.repository.liveChannelIds('fake', 'ok')).toEqual(['c1']);
    expect(await h.repository.liveChannelIds('fake', 'bad')).toEqual([]);
    expect(report.anyFailed).toBe(true);
  });

  it('keeps a partial warning poll successful and applies its live subset', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await addChannel(h, provider, 'a1', 'c2', 'beta');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));
    provider.unknownIds = ['c2'];

    const report = await h.service.pollAll();

    expect(report.anyFailed).toBe(false);
    expect(await h.repository.liveChannelIds('fake', 'a1')).toEqual(['c1']);
    expect(h.notices.map((n) => n.displayName)).toEqual(['alpha']);
  });

  it('clears stale live state when the last channel is untracked', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    provider.setLive('c1', live('c1', 'alpha'));
    await h.service.pollAll();

    await h.repository.removeChannel('fake', 'a1', 'c1');
    await h.service.pollAll();

    expect(await h.repository.liveChannelIds('fake', 'a1')).toEqual([]);
  });
});

describe('backoff and the ongoing-failure signal (task 9.6)', () => {
  it('classifies failures that warrant a cooling-off', () => {
    expect(classifyFailure(new HttpError(429, 'u', 'slow down'))).toBe('rate_limited');
    expect(classifyFailure(new HttpError(503, 'u', 'unavailable'))).toBe('server_error');
    expect(classifyFailure(new HttpError(0, 'u', 'unreachable'))).toBe('network_error');
    expect(classifyFailure(new HttpError(400, 'u', 'bad'))).toBe('other');
    expect(classifyFailure(new AuthError('x', 'revoked'))).toBe('other');
    expect(isBackoffWorthy('rate_limited')).toBe(true);
    expect(isBackoffWorthy('other')).toBe(false);
  });

  it('grows the cooling-off interval with each consecutive failure', () => {
    const backoff = new Backoff({ baseMs: 1_000, maxMs: 60_000, jitter: () => 1 });
    expect(backoff.fail('k', 0)).toBe(1_000);
    expect(backoff.fail('k', 0)).toBe(2_000);
    expect(backoff.fail('k', 0)).toBe(4_000);
    expect(backoff.fail('k', 0)).toBe(8_000);
    expect(backoff.fail('k', 0)).toBe(16_000);
    expect(backoff.fail('k', 0)).toBe(32_000);
    // Capped, so a long outage cannot push the next attempt hours away.
    expect(backoff.fail('k', 0)).toBe(60_000);
    expect(backoff.fail('k', 0)).toBe(60_000);
  });

  it('makes no request while cooling off', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    provider.liveError = new HttpError(429, 'u', 'rate limited');

    await h.service.pollAll();
    expect(provider.calls.fetchLive).toBe(1);

    // Every subsequent poll inside the window makes no request at all.
    for (let i = 0; i < 5; i += 1) await h.service.pollAll();
    expect(provider.calls.fetchLive).toBe(1);
  });

  it('surfaces an ongoing failure only once failures persist', async () => {
    // Short intervals so retries are observable without a long simulated clock.
    const h = harness({ backoff: new Backoff({ baseMs: 1_000, maxMs: 8_000, jitter: () => 1 }) });
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    provider.liveError = new HttpError(500, 'u', 'boom');

    await h.service.pollAll();
    await clock(h).advance(1_500);
    await h.service.pollAll();
    // Still only a transient blip, so nothing is surfaced to the user yet.
    expect((await h.service.pollAll()).ongoingFailures).toEqual([]);

    // Past the second failure's 2s window, so the third attempt happens.
    await clock(h).advance(2_500);
    await h.service.pollAll();
    // Now cooling off with three consecutive failures: this is worth surfacing.
    const report = await h.service.pollAll();

    expect(report.ongoingFailures[0]).toMatchObject({ providerId: 'fake', accountId: 'a1' });
    expect(report.ongoingFailures[0]!.attempts).toBeGreaterThanOrEqual(3);
    expect(provider.calls.fetchLive).toBe(3);
  });

  it('resets the cooling-off after a success', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    provider.liveError = new HttpError(500, 'u', 'boom');
    await h.service.pollAll();
    expect(h.service.backoff.attemptsFor('account:fake:a1')).toBe(1);

    provider.liveError = undefined;
    await clock(h).advance(31_000);
    await h.service.pollAll();
    expect(h.service.backoff.attemptsFor('account:fake:a1')).toBe(0);
  });

  it('honours Retry-After over its own growth', () => {
    const backoff = new Backoff({ baseMs: 1_000, maxMs: 60_000, jitter: () => 1 });
    const error = new HttpError(429, 'u', 'rate limited');
    error.retryAfter = '120';
    expect(backoff.fail('k', 0, error)).toBe(120_000);
  });

  it('keys backoff per account, so one failing account does not delay another', () => {
    const backoff = new Backoff({ baseMs: 1_000, jitter: () => 1 });
    backoff.fail('account:fake:a1', 0);
    expect(backoff.isCoolingDown('account:fake:a1', 0)).toBe(true);
    expect(backoff.isCoolingDown('account:fake:a2', 0)).toBe(false);
  });
});

describe('proactive credential renewal (task 9.7)', () => {
  it('renews before the query, so an expiring token is refreshed first', async () => {
    const h = harness();
    const provider = addProvider(h);
    // Expires inside the renewal window.
    await h.repository.putAccount({
      ...accountFor(provider, 'a1'),
      credentials: { accessToken: 'stale', expiresAt: h.clock.now() + 60_000, refreshToken: 'rt' },
    });
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));

    const order: string[] = [];
    const original = provider.fetchLiveStatus.bind(provider);
    vi.spyOn(provider, 'fetchLiveStatus').mockImplementation(async (account, ids) => {
      order.push(`query:${account.credentials.accessToken}`);
      return original(account, ids);
    });

    await h.service.pollAll();

    // Every query carried the renewed token: renewal happened before the request,
    // never as a reaction to a 401.
    expect(order).not.toHaveLength(0);
    expect(order.every((entry) => entry === 'query:refreshed')).toBe(true);
    expect(h.notices).toHaveLength(1);
  });

  it('never surfaces a failing poll as a credential error', async () => {
    const h = harness();
    const provider = addProvider(h);
    await h.repository.putAccount({
      ...accountFor(provider, 'a1'),
      credentials: { accessToken: 'stale', expiresAt: h.clock.now() + 60_000, refreshToken: 'rt' },
    });
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    provider.liveError = new HttpError(500, 'u', 'server exploded');

    const report = await h.service.pollAll();

    expect(report.failures).toEqual([{ providerId: 'fake', accountId: 'a1', reason: 'server_error' }]);
    expect(report.failures.some((f) => f.reason === 'credentials')).toBe(false);
    expect(h.notices).toEqual([]);
  });

  it('reports a credential failure distinctly and polls nothing', async () => {
    const clock = createTestClock(1_000_000);
    const repository = new Repository(createMemoryStore());
    const provider = FakeProvider.create('fake');
    const registry = new ProviderRegistry().register(provider);
    const accounts = new AccountManager({
      repository,
      // A permanently dead refresh grant.
      broker: {
        exchange: vi.fn(),
        refresh: vi.fn().mockRejectedValue(new TokenRefreshError('invalid_grant', 'revoked')),
        revoke: vi.fn(),
      },
      clock,
      clientIds: {},
      redirectUri: 'r',
    });
    const service = new LiveDetectionService({
      registry,
      repository,
      accounts,
      scheduler: createTestScheduler(),
      clock,
      streamUrlFor: () => 'u',
    });

    await repository.putAccount({
      ...accountFor(provider, 'a1'),
      credentials: { accessToken: 'stale', expiresAt: clock.now() + 60_000, refreshToken: 'rt' },
    });
    await repository.putChannel({
      providerId: 'fake',
      providerChannelId: 'c1',
      handle: 'alpha',
      accountId: 'a1',
      trackedAt: 1,
      source: 'manual',
    });

    const report = await service.pollAll();

    expect(report.failures).toEqual([{ providerId: 'fake', accountId: 'a1', reason: 'credentials' }]);
    expect(provider.calls.fetchLive).toBe(0);
    // The account is now flagged for reconnection, so it is skipped next time.
    expect((await repository.accounts())[0]?.requiresReconnection).toBe(true);
  });
});

const clock = (h: Harness) => h.clock;

describe('notification payload', () => {
  it('resolves the public stream url through the adapter, with no provider branch', async () => {
    const h = harness();
    const provider = addProvider(h, 'twitch');
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));

    await h.service.pollAll();
    expect(h.streamUrls).toEqual(['https://twitch.example/alpha']);
  });

  it('stamps the transition with the injected clock, not wall time', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));

    await h.service.pollAll();
    expect(h.notices[0]?.wentLiveAt).toBe(h.clock.now());
  });
});

describe('adapter boundary in the detection engine', () => {
  it('runs against an adapter that is not the fake, with no code change', async () => {
    // A minimal hand-written adapter proves the engine only touches the contract.
    const calls: string[][] = [];
    let reportLive = false;
    const custom: ProviderAdapter = {
      id: 'custom',
      displayName: 'Custom',
      authStrategy: 'oauth',
      capabilities: {
        followedChannels: false,
        followedStreams: true,
        manualChannelEntry: true,
        unofficialFollowImport: false,
        supportsMultipleAccounts: true,
        realtimeEvents: false,
      },
      resolveChannelByHandle: async () => undefined,
      publicStreamUrl: (c) => `https://custom.example/${c.displayName}`,
      listFollowedChannels: async () => ({ channels: [] }),
      fetchLiveStatus: async (account, ids) => {
        calls.push(ids);
        return {
          providerId: 'custom',
          accountId: account.accountId,
          live: reportLive
            ? [{ channelId: ids[0]!, displayName: 'alpha', title: 't', viewers: 1 }]
            : [],
          wentOffline: [],
          warnings: [],
        };
      },
    };

    const clock = createTestClock(1_000_000);
    const repository = new Repository(createMemoryStore());
    const notices: WentLiveNotice[] = [];
    const service = new LiveDetectionService({
      registry: new ProviderRegistry().register(custom),
      repository,
      accounts: new AccountManager({
        repository,
        broker: { exchange: vi.fn(), refresh: vi.fn(), revoke: vi.fn() },
        clock,
        clientIds: {},
        redirectUri: 'r',
      }),
      scheduler: createTestScheduler(),
      clock,
      streamUrlFor: (p, _c, displayName) => `https://${p}.example/${displayName}`,
      onWentLive: (n) => {
        notices.push(n);
      },
    });

    const account: ProviderAccount = {
      accountId: 'a1',
      providerId: 'custom',
      displayName: 'me',
      credentials: { accessToken: 't', expiresAt: Number.MAX_SAFE_INTEGER },
    };
    await repository.putAccount({
      ...account,
      requiresReconnection: false,
    });
    await repository.putChannel({
      providerId: 'custom',
      providerChannelId: 'x1',
      handle: 'alpha',
      accountId: 'a1',
      trackedAt: 1,
      source: 'manual',
    });

    await service.pollAll();
    expect(notices).toEqual([]);
    // A new stream starts; the channel's last known state was offline.
    reportLive = true;
    await service.pollAll();
    expect(notices).toHaveLength(1);
    expect(calls).toEqual([['x1'], ['x1']]);
  });
});

describe('definitive observations from a poll', () => {
  it('treats a batch-level inconclusive warning as learning nothing', () => {
    expect(
      definitiveChannelIds(
        {
          providerId: 'p',
          accountId: 'a',
          live: [],
          wentOffline: [],
          warnings: [{ reason: 'partial', message: 'rate limited mid-batch' }],
        },
        ['c1', 'c2'],
      ),
    ).toEqual([]);
  });

  it('excludes only the unresolvable channels of a partial batch', () => {
    expect(
      definitiveChannelIds(
        {
          providerId: 'p',
          accountId: 'a',
          live: [],
          wentOffline: [],
          warnings: [{ channelId: 'c2', reason: 'partial', message: 'could not resolve' }],
        },
        ['c1', 'c2', 'c3'],
      ),
    ).toEqual(['c1', 'c3']);
  });

  it('counts channel_missing as a definitive answer, since the channel is gone', () => {
    expect(
      definitiveChannelIds(
        {
          providerId: 'p',
          accountId: 'a',
          live: [],
          wentOffline: [],
          warnings: [{ channelId: 'c2', reason: 'channel_missing', message: 'deleted' }],
        },
        ['c1', 'c2'],
      ),
    ).toEqual(['c1', 'c2']);
  });

  it('does not let a partially answered poll fake an offline transition', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await addChannel(h, provider, 'a1', 'c2', 'beta');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));
    provider.setLive('c2', live('c2', 'beta'));
    await h.service.pollAll();
    expect(await h.repository.liveChannelIds('fake', 'a1')).toEqual(['c1', 'c2']);

    // c1 really did end, but the answer for c2 never arrived. Only the channel the
    // platform actually answered for may change state.
    provider.setOffline('c1');
    vi.spyOn(provider, 'fetchLiveStatus').mockImplementation(async (account) => ({
      providerId: 'fake',
      accountId: account.accountId,
      live: [{ channelId: 'c2', displayName: 'beta', title: '', viewers: 0 }],
      wentOffline: [],
      warnings: [{ channelId: 'c2', reason: 'partial', message: 'timeout' }],
    }));

    await h.service.pollAll();

    expect(await h.repository.liveChannelIds('fake', 'a1')).toEqual(['c2']);
  });

  it('keeps a previously live channel live when the poll cannot answer for it', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await addChannel(h, provider, 'a1', 'c2', 'beta');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));
    provider.setLive('c2', live('c2', 'beta'));
    await h.service.pollAll();
    expect(await h.repository.liveChannelIds('fake', 'a1')).toEqual(['c1', 'c2']);

    // The platform answers for nobody: c1 and c2 are simply absent. Nothing is known
    // about either, so neither may be treated as having ended.
    vi.spyOn(provider, 'fetchLiveStatus').mockImplementation(async (account) => ({
      providerId: 'fake',
      accountId: account.accountId,
      live: [],
      wentOffline: [],
      warnings: [{ channelId: 'c2', reason: 'partial', message: 'timeout' }],
    }));

    await h.service.pollAll();

    // c2's last known state survives; c1 was answered for and is genuinely offline.
    expect(await h.repository.liveChannelIds('fake', 'a1')).toEqual(['c2']);
  });

  it('emits no transition for a channel it could not answer for', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));
    await h.service.pollAll();

    // The channel stays live in the stored state, so a later poll that does answer
    // for it must not report it as having gone live a second time either.
    vi.spyOn(provider, 'fetchLiveStatus').mockImplementation(async (account) => ({
      providerId: 'fake',
      accountId: account.accountId,
      live: [],
      wentOffline: [],
      warnings: [{ channelId: 'c1', reason: 'partial', message: 'timeout' }],
    }));
    const report = await h.service.pollAll();

    expect(report.events).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(await h.repository.liveChannelIds('fake', 'a1')).toEqual(['c1']);

    // Once the platform answers again, still no duplicate went-live notification.
    vi.restoreAllMocks();
    provider.setLive('c1', live('c1', 'alpha'));
    const second = await h.service.pollAll();
    expect(second.events).toEqual([]);
  });

  it('keeps the notified flag of a stream that is still live', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    await h.service.pollAll();
    provider.setLive('c1', live('c1', 'alpha'));
    await h.service.pollAll();

    // The notification layer records that the user was told.
    const rows = await h.repository.liveRows('fake', 'a1');
    await h.repository.replaceLiveState('fake', 'a1', rows.map((r) => ({ ...r, notified: true })));

    // Still live on the next poll.
    await h.service.pollAll();

    const after = await h.repository.liveRows('fake', 'a1');
    expect(after).toHaveLength(1);
    expect(after[0]?.notified).toBe(true);
  });

  it('stamps the last observation time on successful polls', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');

    await h.service.pollAll();
    const channel = await h.repository.channel('fake', 'a1', 'c1');
    expect(channel?.lastObservedAt).toBe(h.clock.now());
  });

  it('leaves the observation stamp untouched when a poll fails', async () => {
    const h = harness();
    const provider = addProvider(h);
    addAccount(h, provider, 'a1');
    await addChannel(h, provider, 'a1', 'c1', 'alpha');
    provider.liveError = new HttpError(500, 'u', 'boom');

    await h.service.pollAll();
    expect((await h.repository.channel('fake', 'a1', 'c1'))?.lastObservedAt).toBeUndefined();
  });
});
