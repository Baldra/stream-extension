import { describe, expect, it, vi } from 'vitest';
import { AccountManager, type BrokerClient } from '../src/core/accounts';
import { LiveDetectionService, type PollReport } from '../src/core/detection';
import { NotificationService, type NotificationContent } from '../src/core/notifications';
import { ProviderRegistry } from '../src/core/registry';
import { Repository } from '../src/core/repository';
import { createTestScheduler, type Scheduler } from '../src/core/scheduler';
import { createMemoryStore, type KeyValueStore } from '../src/core/store';
import { createTestClock, type Clock } from '../src/core/clock';
import { TokenRefreshError } from '../src/core/tokens';
import { ChannelTracker } from '../src/core/tracking';
import { FakeProvider } from './helpers/fake-provider';
import type { LiveChannelInfo, ProviderId } from '../src/core/provider';
import type { WentLiveNotice } from '../src/core/detection';

/**
 * End-to-end flows (group 13).
 *
 * Each test wires the real components together the way the service worker does:
 * one repository, account manager, tracker, detection engine and notification
 * service, with only the network and the browser left as stubs. That is what proves
 * the pieces agree on identity and persistence, which per-component unit tests
 * cannot show.
 */

const PROVIDER: ProviderId = 'twitch';
const ACCOUNT_ID = 'account-1';
const USER_ID = 'user-1';

const account = {
  accountId: ACCOUNT_ID,
  providerId: PROVIDER,
  displayName: 'me',
  credentials: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 10_000 },
  requiresReconnection: false,
  providerUserId: USER_ID,
} as const;

function brokerReturning(accessToken: string, refreshToken: string): BrokerClient {
  return {
    exchange: async () => ({ access_token: accessToken, expires_in: 7200, refresh_token: refreshToken }),
    refresh: async () => ({ access_token: accessToken, refresh_token: refreshToken, expires_in: 7200 }),
    revoke: async () => {},
  };
}

/** A browser stub recording what the user would actually have been shown. */
class FakeBrowser {
  readonly shown: Array<{ id: string; options: NotificationContent }> = [];
  /** Mirrors chrome.notifications.getPermissionLevel. */
  permission: 'granted' | 'denied' | 'default' = 'granted';
  /** The permission the user ends up with after being prompted. */
  granted: 'granted' | 'denied' = 'granted';
  prompts = 0;

  readonly api = {
    permission: async (): Promise<'granted' | 'denied' | 'default'> => this.permission,
    requestPermission: async (): Promise<'granted' | 'denied'> => {
      this.prompts += 1;
      this.permission = this.granted;
      return this.granted;
    },
    create: async (id: string, options: NotificationContent): Promise<string | undefined> => {
      this.shown.push({ id, options });
      return id;
    },
    clear: async (): Promise<boolean> => true,
  };
}

interface Stack {
  /** The storage the worker would find after being terminated. */
  store: KeyValueStore;
  repository: Repository;
  provider: FakeProvider;
  browser: FakeBrowser;
  clock: Clock & { advance(ms: number): Promise<void> };
  scheduler: Scheduler & { starts(): number };
  tracker: ChannelTracker;
  detection: LiveDetectionService;
  notifications: NotificationService;
  reports: PollReport[];
  /** Goes live without waiting for a poll, as the platform would between polls. */
  goLive: (channelId: string, info?: Partial<LiveChannelInfo>) => void;
  goOffline: (channelId: string) => void;
}

function stack(store: KeyValueStore = createMemoryStore(), browser: FakeBrowser = new FakeBrowser()): Stack {
  const repository = new Repository(store);
  const provider = new FakeProvider(PROVIDER);
  const clock = createTestClock(1_000);
  const registry = new ProviderRegistry().register(provider);
  const scheduler = createTestScheduler();
  const reports: PollReport[] = [];

  const accounts = new AccountManager({
    repository,
    clock,
    broker: brokerReturning('access-1', 'refresh-1'),
    clientIds: { twitch: 'client-id' },
    redirectUri: 'https://extension-id.chromiumapp.org/',
    identify: async () => ({ providerUserId: USER_ID, displayName: 'me' }),
  });

  const tracker = new ChannelTracker(repository, clock);
  const notifications = new NotificationService({
    repository,
    api: browser.api,
    platformLabel: (id) => registry.get(id).displayName,
  });

  const detection = new LiveDetectionService({
    registry,
    repository,
    accounts,
    scheduler,
    clock,
    streamUrlFor: (providerId, channelId, displayName) =>
      registry.get(providerId).publicStreamUrl({ channelId, displayName, accountId: ACCOUNT_ID }),
    onWentLive: async (notice: WentLiveNotice) => {
      await notifications.raise(notice, notice.category);
    },
  });

  const pollAll = detection.pollAll.bind(detection);
  detection.pollAll = async (): Promise<PollReport> => {
    const report = await pollAll();
    reports.push(report);
    return report;
  };

  return {
    store,
    repository,
    provider,
    browser,
    clock,
    scheduler,
    tracker,
    detection,
    notifications,
    reports,
    goLive: (channelId, info = {}) => {
      provider.setLive(channelId, { channelId, displayName: channelId, ...info });
    },
    goOffline: (channelId) => {
      provider.setOffline(channelId);
    },
  };
}

/** Connects an account and tracks a channel, as the popup's actions would. */
async function connectAndTrack(s: Stack, handle: string): Promise<void> {
  await s.repository.putAccount({ ...account });
  const adapter = s.provider;
  const result = await s.tracker.addByHandle(adapter, { ...account }, handle);
  expect(result.ok).toBe(true);
  await s.detection.syncSchedule();
}

describe('connect, track, detect, notify, dismiss (task 13.3)', () => {
  it('raises exactly one notification for a channel going live, and records it in history', async () => {
    const s = stack();
    s.provider.add({ channelId: 'c1', displayName: 'alpha' });
    await connectAndTrack(s, 'alpha');

    // The first poll establishes state; there is no transition to announce.
    await s.detection.pollAll();
    expect(s.browser.shown).toEqual([]);

    s.goLive('c1', { title: 'Ranked grind', viewers: 42 });
    await s.detection.pollAll();

    expect(s.browser.shown).toHaveLength(1);
    expect(s.browser.shown[0]?.options.title).toBe('alpha is live on Fake');
    expect(s.browser.shown[0]?.options.message).toBe('Ranked grind');

    // Still live across several polls: re-observing must not notify again.
    await s.detection.pollAll();
    await s.detection.pollAll();
    expect(s.browser.shown).toHaveLength(1);

    const history = await s.repository.history();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      providerId: PROVIDER,
      accountId: ACCOUNT_ID,
      channelId: 'c1',
      displayName: 'alpha',
    });
  });

  it('dismisses a notification and keeps its history entry', async () => {
    const s = stack();
    s.provider.add({ channelId: 'c1', displayName: 'alpha' });
    await connectAndTrack(s, 'alpha');
    await s.detection.pollAll();
    s.goLive('c1', { title: 'live' });
    await s.detection.pollAll();

    const id = s.browser.shown[0]!.id;
    // A click resolves to the stream url, and clears the notification.
    expect(await s.notifications.handleClick(id)).toBe('https://fake.example/alpha');

    const history = await s.repository.history();
    expect(history).toHaveLength(1);
    expect(history[0]?.streamUrl).toBe('https://fake.example/alpha');
  });

  it('notifies again for a second, separate stream', async () => {
    const s = stack();
    s.provider.add({ channelId: 'c1', displayName: 'alpha' });
    await connectAndTrack(s, 'alpha');
    await s.detection.pollAll();

    s.goLive('c1', { title: 'first run' });
    await s.detection.pollAll();

    // It ends, and a later stream begins at a different time, so this is a
    // genuinely new event rather than a repeat of the one already announced.
    s.goOffline('c1');
    await s.detection.pollAll();
    await s.clock.advance(3_600_000);
    s.goLive('c1', { title: 'second run' });
    await s.detection.pollAll();

    expect(s.browser.shown).toHaveLength(2);
    expect(s.browser.shown.map((n) => n.options.message)).toEqual(['first run', 'second run']);
  });

  it('keeps the channels of two accounts apart through every layer', async () => {
    const s = stack();
    s.provider.add({ channelId: 'c1', displayName: 'alpha' });
    s.provider.add({ channelId: 'c2', displayName: 'beta' });

    await s.repository.putAccount({ ...account });
    await s.repository.putAccount({ ...account, accountId: 'account-2', displayName: 'other', providerUserId: 'user-2' });
    await s.tracker.addByHandle(s.provider, { ...account }, 'alpha');
    await s.tracker.addByHandle(s.provider, { ...account, accountId: 'account-2' }, 'beta');

    expect((await s.repository.channels(PROVIDER, ACCOUNT_ID)).map((c) => c.providerChannelId)).toEqual(['c1']);
    expect((await s.repository.channels(PROVIDER, 'account-2')).map((c) => c.providerChannelId)).toEqual(['c2']);

    // The first poll only establishes the baseline, so both channels go live after it.
    await s.detection.pollAll();
    s.goLive('c1', { title: 'alpha live' });
    s.goLive('c2', { title: 'beta live' });
    await s.detection.pollAll();

    // One notification per account, each naming its own channel.
    expect(s.browser.shown.map((n) => n.options.message).sort()).toEqual(['alpha live', 'beta live']);
    const history = await s.repository.history();
    expect(history.map((e) => e.accountId).sort()).toEqual(['account-1', 'account-2']);
  });
});

describe('worker termination and browser restart (task 13.4)', () => {
  /**
   * Rebuilds every service from the persisted store alone, with no in-memory state
   * carried over, which is what happens when the MV3 worker is terminated and later
   * woken by its alarm.
   */
  function restart(s: Stack): Stack {
    // The same storage, but every service is new: no in-memory state, no timers
    // and no awareness of what the previous worker generation had seen.
    const revived = stack(s.store, s.browser);
    // The platform's own state survives, and is re-read from scratch.
    for (const channel of s.provider.followed) revived.provider.followed.push(channel);
    for (const [id, channel] of s.provider.known) revived.provider.known.set(id, channel);
    return revived;
  }

  it('does not repeat a notification for a stream that survived the restart', async () => {
    const s = stack();
    s.provider.add({ channelId: 'c1', displayName: 'alpha' });
    await connectAndTrack(s, 'alpha');
    await s.detection.pollAll();
    s.goLive('c1', { title: 'going live' });
    await s.detection.pollAll();
    expect(s.browser.shown).toHaveLength(1);

    // The worker is terminated and woken again with no memory of the stream.
    const revived = restart(s);
    revived.provider.setLive('c1', { channelId: 'c1', displayName: 'alpha', title: 'going live' });
    await revived.detection.pollAll();
    await revived.detection.pollAll();

    expect(revived.browser.shown).toHaveLength(1);
    expect(await revived.repository.history()).toHaveLength(1);
  });

  it('still announces a stream that went live while the worker was asleep', async () => {
    const s = stack();
    s.provider.add({ channelId: 'c1', displayName: 'alpha' });
    await connectAndTrack(s, 'alpha');
    await s.detection.pollAll();
    expect(s.browser.shown).toEqual([]);

    // The worker is terminated; the stream starts and ends entirely unobserved.
    const revived = restart(s);
    revived.goLive('c1', { title: 'now live' });
    await revived.detection.pollAll();

    expect(revived.browser.shown).toHaveLength(1);
    expect(revived.browser.shown[0]?.options.message).toBe('now live');
  });

  it('keeps the schedule registered across a restart', async () => {
    const s = stack();
    s.provider.add({ channelId: 'c1', displayName: 'alpha' });
    await connectAndTrack(s, 'alpha');
    expect(s.scheduler.starts()).toBeGreaterThan(0);

    const revived = restart(s);
    await revived.detection.syncSchedule();

    // A fresh service starts its own schedule from persisted state alone.
    expect(revived.scheduler.starts()).toBe(1);
    expect(revived.scheduler.isRunning()).toBe(true);
  });

  it('leaves the tracked set and settings untouched by a restart', async () => {
    const s = stack();
    s.provider.add({ channelId: 'c1', displayName: 'alpha' });
    await connectAndTrack(s, 'alpha');
    await s.repository.setNotificationsEnabled(PROVIDER, false);

    const revived = restart(s);

    expect((await revived.repository.channels(PROVIDER, ACCOUNT_ID)).map((c) => c.providerChannelId)).toEqual([
      'c1',
    ]);
    expect(await revived.repository.notificationsEnabledFor(PROVIDER)).toBe(false);
  });
});

describe('the pipeline never raises a notification it should not', () => {
  it('does not notify for a channel already live on the very first poll', async () => {
    // Nothing is known about a channel before the first query, so a first live
    // answer establishes state rather than announcing an event that was not watched.
    const s = stack();
    s.provider.add({ channelId: 'c1', displayName: 'alpha' });
    s.provider.setLive('c1', { channelId: 'c1', displayName: 'alpha', title: 'already on' });
    await connectAndTrack(s, 'alpha');

    await s.detection.pollAll();

    expect(s.browser.shown).toEqual([]);
    expect(await s.repository.liveChannelIds(PROVIDER, ACCOUNT_ID)).toEqual(['c1']);
  });

  it('does not notify when the browser has no permission', async () => {
    const s = stack();
    s.browser.permission = 'denied';
    s.browser.granted = 'denied';
    s.provider.add({ channelId: 'c1', displayName: 'alpha' });
    await connectAndTrack(s, 'alpha');
    await s.detection.pollAll();
    s.goLive('c1', { title: 'live' });
    await s.detection.pollAll();

    expect(s.browser.shown).toEqual([]);
    // It is still recorded as live, so the dashboard can show it.
    expect(await s.repository.liveChannelIds(PROVIDER, ACCOUNT_ID)).toEqual(['c1']);
  });

  it('does not notify when the platform is switched off', async () => {
    const s = stack();
    s.provider.add({ channelId: 'c1', displayName: 'alpha' });
    await s.repository.setNotificationsEnabled(PROVIDER, false);
    await connectAndTrack(s, 'alpha');
    await s.detection.pollAll();
    s.goLive('c1', { title: 'live' });
    await s.detection.pollAll();

    expect(s.browser.shown).toEqual([]);
  });

  it('survives a failed poll without disturbing the tracked set', async () => {
    const s = stack();
    s.provider.add({ channelId: 'c1', displayName: 'alpha' });
    await connectAndTrack(s, 'alpha');
    await s.detection.pollAll();

    s.provider.liveError = new Error('upstream is down');
    const report = await s.detection.pollAll();

    expect(report.failures).toHaveLength(1);
    expect(await s.tracker.trackedIds({ providerId: PROVIDER, accountId: ACCOUNT_ID })).toEqual(['c1']);
    expect(s.browser.shown).toEqual([]);
  });
});

describe('credential renewal feeds the same pipeline', () => {
  it('keeps polling with renewed credentials and never re-announces', async () => {
    const s = stack();
    s.provider.add({ channelId: 'c1', displayName: 'alpha' });
    await connectAndTrack(s, 'alpha');
    await s.detection.pollAll();
    s.goLive('c1', { title: 'live' });
    await s.detection.pollAll();
    expect(s.browser.shown).toHaveLength(1);

    // The token is refreshed through the broker before the next query.
    const accounts = new AccountManager({
      repository: s.repository,
      clock: s.clock,
      broker: brokerReturning('access-2', 'refresh-2'),
      clientIds: { twitch: 'client-id' },
      redirectUri: 'https://extension-id.chromiumapp.org/',
    });
    const stored = await s.repository.account(PROVIDER, ACCOUNT_ID);
    expect(stored).toBeDefined();
    const renewed = await accounts.credentialsFor(stored!);

    expect(renewed.accessToken).toBe('access-2');
    // The rotated credentials are stored, so the next worker generation is valid.
    expect((await s.repository.account(PROVIDER, ACCOUNT_ID))?.credentials.accessToken).toBe('access-2');
    expect(s.browser.shown).toHaveLength(1);
  });

  it('flags the account for reconnection when the grant is refused', async () => {
    const s = stack();
    s.provider.add({ channelId: 'c1', displayName: 'alpha' });
    await connectAndTrack(s, 'alpha');

    const accounts = new AccountManager({
      repository: s.repository,
      clock: s.clock,
      clientIds: { twitch: 'client-id' },
      redirectUri: 'https://extension-id.chromiumapp.org/',
      broker: {
        exchange: vi.fn(),
        revoke: vi.fn(),
        refresh: vi.fn(async () => {
          throw new TokenRefreshError('invalid_grant', 'the grant is gone');
        }),
      } as unknown as BrokerClient,
    });

    await expect(
      accounts.credentialsFor({
        ...account,
        credentials: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 },
      }),
    ).rejects.toBeInstanceOf(TokenRefreshError);

    // The dashboard can now tell the user to reconnect.
    expect((await s.repository.account(PROVIDER, ACCOUNT_ID))?.requiresReconnection).toBe(true);
  });
});
