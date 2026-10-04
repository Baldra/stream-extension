import { describe, expect, it, vi } from 'vitest';
import {
  NotificationService,
  notificationIdFor,
  type NotificationApi,
  type NotificationContent,
} from '../src/core/notifications';
import { Repository } from '../src/core/repository';
import { createMemoryStore } from '../src/core/store';
import { createTestClock } from '../src/core/clock';
import type { WentLiveNotice } from '../src/core/detection';
import type { ProviderId } from '../src/core/provider';
import { redact, safeStringify } from '../src/core/redact';

const LABELS: Record<string, string> = { twitch: 'Twitch', kick: 'Kick' };

const notice = (overrides: Partial<WentLiveNotice> = {}): WentLiveNotice => ({
  providerId: 'twitch',
  accountId: 'a1',
  channelId: 'c1',
  displayName: 'alpha',
  title: 'Ranked grind',
  viewers: 42,
  streamUrl: 'https://www.twitch.tv/alpha',
  wentLiveAt: 1_700_000_000_000,
  ...overrides,
});

interface Harness {
  service: NotificationService;
  repository: Repository;
  api: NotificationApi & { created: Array<{ id: string; content: NotificationContent }>; cleared: string[] };
  clock: ReturnType<typeof createTestClock>;
}

function harness(
  options: {
    permission?: 'granted' | 'denied' | 'default';
    grantOnRequest?: boolean;
    createFails?: boolean;
    historyLimit?: number;
  } = {},
): Harness {
  const clock = createTestClock(1_000_000);
  const repository = new Repository(createMemoryStore(), options.historyLimit);
  const created: Array<{ id: string; content: NotificationContent }> = [];
  const cleared: string[] = [];

  const api: NotificationApi & { created: typeof created; cleared: string[] } = {
    created,
    cleared,
    permission: vi.fn().mockResolvedValue(options.permission ?? 'granted'),
    requestPermission: vi.fn().mockResolvedValue(options.grantOnRequest ? 'granted' : 'denied'),
    create: vi.fn(async (id: string, content: NotificationContent) => {
      if (options.createFails) return undefined;
      created.push({ id, content });
      return id;
    }),
    clear: vi.fn(async (id: string) => {
      cleared.push(id);
      return true;
    }),
  };

  const service = new NotificationService({
    repository,
    api,
    platformLabel: (providerId: ProviderId) => LABELS[providerId] ?? providerId,
  });

  return { service, repository, api, clock };
}

describe('notification content (task 10.1)', () => {
  it('names the channel, the platform, the title, and the category', async () => {
    const h = harness();
    await h.service.raise(notice(), 'Just Chatting');

    expect(h.api.created[0]?.content).toEqual({
      title: 'alpha is live on Twitch',
      message: 'Ranked grind — Just Chatting',
      contextMessage: 'Twitch',
    });
  });

  it('uses the platform thumbnail when one was supplied', async () => {
    const h = harness();
    await h.service.raise(notice({ thumbnailUrl: 'https://cdn.example/t.jpg' }));

    expect(h.api.created[0]?.content.iconUrl).toBe('https://cdn.example/t.jpg');
  });

  it('omits the thumbnail when the platform supplied none', async () => {
    const h = harness();
    await h.service.raise(notice());

    expect(h.api.created[0]?.content).not.toHaveProperty('iconUrl');
  });

  it('omits the category when the platform supplied none, keeping channel and platform', async () => {
    const h = harness();
    await h.service.raise(notice(), undefined);

    expect(h.api.created[0]?.content).toEqual({
      title: 'alpha is live on Twitch',
      message: 'Ranked grind',
      contextMessage: 'Twitch',
    });
  });

  it('falls back to a plain message when neither title nor category exist', async () => {
    const h = harness();
    await h.service.raise(notice({ title: '' }), undefined);

    expect(h.api.created[0]?.content.message).toBe('is live');
  });

  it('names the platform correctly for Kick too', async () => {
    const h = harness();
    await h.service.raise(
      notice({ providerId: 'kick', streamUrl: 'https://kick.com/alpha' }),
    );

    expect(h.api.created[0]?.content.title).toBe('alpha is live on Kick');
  });
});

describe('no credentials in a notification (task 10.3)', () => {
  it('renders only display fields, so no credential can be carried in', () => {
    const h = harness();
    const content = h.service.buildContent(notice(), 'Just Chatting');

    // The content is assembled from display data alone. That is the guarantee; the
    // redaction pass on the way out is the backstop, exercised below.
    expect(Object.values(content).join(' ')).not.toMatch(/token|secret/i);
  });

  it('strips a credential that reached the payload by some future field', () => {
    const h = harness();
    const hostile = {
      ...notice(),
      // A field a well-meaning future change might add.
      credentials: { accessToken: 'abcdefgh12345678', refreshToken: 'zyxwvu98765432' },
    } as unknown as WentLiveNotice;

    const content = JSON.parse(
      // The same scrub the service applies before handing content to the browser.
      safeStringify(redact(structuredClone(h.service.buildContent(hostile, 'Just Chatting')))),
    ) as NotificationContent;

    expect(JSON.stringify(content)).not.toMatch(/abcdefgh12345678|zyxwvu98765432/);
  });

  it('carries no field a credential could arrive in', async () => {
    const h = harness();
    await h.service.raise(notice(), 'Just Chatting');

    expect(Object.keys(h.api.created[0]?.content ?? {}).sort()).toEqual([
      'contextMessage',
      'message',
      'title',
    ]);
  });

  it('writes no credential into the recorded history', async () => {
    const h = harness();
    const hostile = {
      ...notice(),
      credentials: { accessToken: 'abcdefgh12345678', refreshToken: 'zyxwvu98765432' },
    } as unknown as WentLiveNotice;

    await h.service.raise(hostile);

    // The account's own tokens are persisted elsewhere by design; a history entry
    // is a user-facing review list and must hold none of them.
    const history = await h.repository.history();
    expect(JSON.stringify(history)).not.toMatch(/abcdefgh12345678|zyxwvu98765432/);
    expect(Object.keys(history[0]!).sort()).toEqual([
      'accountId',
      'channelId',
      'displayName',
      'entryId',
      'providerId',
      'streamUrl',
      'title',
      'wentLiveAt',
    ]);
  });
});

describe('one notification per newly-live event (tasks 10.2, 10.7)', () => {
  it('raises exactly one notification for one event', async () => {
    const h = harness();
    const result = await h.service.raise(notice());

    expect(result.raised).toBe(true);
    expect(h.api.create).toHaveBeenCalledTimes(1);
  });

  it('suppresses a repeated delivery of the same event', async () => {
    const h = harness();
    await h.service.raise(notice());
    const second = await h.service.raise(notice());

    expect(second).toMatchObject({ raised: false, reason: 'duplicate' });
    expect(h.api.create).toHaveBeenCalledTimes(1);
  });

  it('suppresses a duplicate after a worker restart', async () => {
    const store = createMemoryStore();
    const clock = createTestClock(1_000_000);

    const first = harness();
    // Share the storage a revived worker would read from.
    const firstRepository = new Repository(store);
    const firstService = new NotificationService({
      repository: firstRepository,
      api: first.api,
      platformLabel: (p) => LABELS[p] ?? p,
    });
    await firstService.raise(notice());

    const revived = new NotificationService({
      repository: new Repository(store),
      api: first.api,
      platformLabel: (p) => LABELS[p] ?? p,
    });
    const result = await revived.raise(notice());

    expect(result.raised).toBe(false);
    expect(first.api.create).toHaveBeenCalledTimes(1);
    expect(clock.now()).toBe(1_000_000);
  });

  it('notifies again for a new stream on the same channel', async () => {
    const h = harness();
    await h.service.raise(notice());
    const result = await h.service.raise(notice({ wentLiveAt: 1_700_000_999_999 }));

    expect(result.raised).toBe(true);
    expect(h.api.create).toHaveBeenCalledTimes(2);
  });

  it('asks for permission only once across repeats of the same event', async () => {
    const h = harness({ permission: 'default', grantOnRequest: true });
    await h.service.raise(notice());
    await h.service.raise(notice());
    await h.service.raise(notice());

    expect(h.api.requestPermission).toHaveBeenCalledTimes(1);
    expect(h.api.create).toHaveBeenCalledTimes(1);
  });

  it('retries a failed create instead of recording it as delivered', async () => {
    const h = harness({ createFails: true });
    const first = await h.service.raise(notice());
    expect(first).toMatchObject({ raised: false, reason: 'create_failed' });
    expect(await h.repository.history()).toEqual([]);

    (h.api.create as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => id);
    const second = await h.service.raise(notice());
    expect(second.raised).toBe(true);
  });

  it('records the channel, platform, and time of each raised notification', async () => {
    const h = harness();
    await h.service.raise(notice());

    const [entry] = await h.repository.history();
    expect(entry).toMatchObject({
      providerId: 'twitch',
      accountId: 'a1',
      channelId: 'c1',
      displayName: 'alpha',
      wentLiveAt: 1_700_000_000_000,
      streamUrl: 'https://www.twitch.tv/alpha',
    });
  });

  it('marks the live row as notified once shown', async () => {
    const store = createMemoryStore();
    const repository = new Repository(store);
    await repository.putAccount({
      accountId: 'a1',
      providerId: 'twitch',
      displayName: 'me',
      credentials: { accessToken: 't', expiresAt: 1 },
      requiresReconnection: false,
    });
    await repository.putChannel({
      providerId: 'twitch',
      providerChannelId: 'c1',
      handle: 'alpha',
      accountId: 'a1',
      trackedAt: 1,
      source: 'manual',
    });
    await repository.replaceLiveState('twitch', 'a1', [
      {
        providerId: 'twitch',
        accountId: 'a1',
        channelId: 'c1',
        title: 'Ranked grind',
        wentLiveAt: 1_700_000_000_000,
        notified: false,
      },
    ]);

    const api: NotificationApi = {
      permission: async () => 'granted',
      requestPermission: async () => 'denied',
      create: async (id) => id,
      clear: async () => true,
    };
    await new NotificationService({ repository, api, platformLabel: (p) => p }).raise(notice());

    expect((await repository.liveState('twitch', 'a1'))[0]?.notified).toBe(true);
  });

  it('bounds the recorded history, discarding the oldest entries', async () => {
    const h = harness({ historyLimit: 3 });
    for (let i = 0; i < 5; i += 1) {
      await h.service.raise(notice({ channelId: `c${i}`, wentLiveAt: 1_700_000_000_000 + i }));
    }

    const history = await h.repository.history();
    expect(history).toHaveLength(3);
    // Newest first: the two oldest were discarded.
    expect(history.map((e) => e.channelId)).toEqual(['c4', 'c3', 'c2']);
  });
});

describe('click-through (task 10.4)', () => {
  it('opens the canonical stream url and dismisses the notification', async () => {
    const h = harness();
    const { notificationId } = await h.service.raise(notice());

    const url = await h.service.handleClick(notificationId!);

    expect(url).toBe('https://www.twitch.tv/alpha');
    expect(h.api.cleared).toEqual([notificationId]);
  });

  it('still resolves the channel page after the stream ended', async () => {
    const h = harness();
    const { notificationId } = await h.service.raise(notice());
    // The stream ends; nothing about the recorded destination changes.
    await h.service.raise(notice({ wentLiveAt: 1_700_000_999_999, channelId: 'c1' }));

    expect(await h.service.handleClick(notificationId!)).toBe('https://www.twitch.tv/alpha');
  });

  it('raises no further notification merely because a click happened', async () => {
    const h = harness();
    const { notificationId } = await h.service.raise(notice());
    await h.service.handleClick(notificationId!);

    expect(h.api.create).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an unknown notification id', async () => {
    const h = harness();
    expect(await h.service.handleClick('not-a-real-notification')).toBeUndefined();
    expect(h.api.cleared).toEqual([]);
  });

  it('gives two accounts on one channel distinct notification ids', () => {
    const first = notificationIdFor(notice({ accountId: 'a1' }));
    const second = notificationIdFor(notice({ accountId: 'a2' }));

    expect(first).not.toBe(second);
  });
});

describe('permission and per-platform gating (tasks 10.5, 10.6)', () => {
  it('raises nothing and prompts when permission has not been granted', async () => {
    const h = harness({ permission: 'default', grantOnRequest: false });
    const result = await h.service.raise(notice());

    expect(result).toMatchObject({ raised: false, reason: 'no_permission', needsPermissionPrompt: true });
    expect(h.api.requestPermission).toHaveBeenCalled();
    expect(h.api.create).not.toHaveBeenCalled();
  });

  it('raises the notification when the user grants permission on the prompt', async () => {
    const h = harness({ permission: 'default', grantOnRequest: true });
    const result = await h.service.raise(notice());

    expect(result.raised).toBe(true);
    expect(h.api.create).toHaveBeenCalledTimes(1);
  });

  it('does not nag for permission when it was already denied', async () => {
    const h = harness({ permission: 'denied' });
    const result = await h.service.raise(notice());

    expect(result).toMatchObject({ raised: false, reason: 'no_permission', needsPermissionPrompt: false });
  });

  it('raises nothing for a platform the user disabled, without tracking being affected', async () => {
    const h = harness();
    await h.repository.setNotificationsEnabled('twitch', false);

    const result = await h.service.raise(notice());

    expect(result).toMatchObject({ raised: false, reason: 'disabled_for_provider' });
    expect(h.api.create).not.toHaveBeenCalled();
    // Not recording the notification is what allows a later re-enable to stay quiet
    // about this stream; the channel itself is untouched.
    expect(await h.repository.history()).toEqual([]);
  });

  it('keeps raising notifications for the other platform', async () => {
    const h = harness();
    await h.repository.setNotificationsEnabled('twitch', false);

    const result = await h.service.raise(notice({ providerId: 'kick' }));

    expect(result.raised).toBe(true);
  });

  it('has no catch-up path: re-enabling raises nothing on its own', async () => {
    const h = harness();
    await h.repository.setNotificationsEnabled('twitch', false);
    // An event arrives while disabled and is dropped, exactly as a muted channel
    // should be.
    expect(await h.service.raise(notice())).toMatchObject({ reason: 'disabled_for_provider' });

    await h.repository.setNotificationsEnabled('twitch', true);

    // Nothing replays it. Only a new event, which live detection raises when a
    // stream actually starts, can notify.
    expect(h.api.create).not.toHaveBeenCalled();
    const result = await h.service.raise(notice({ wentLiveAt: 1_700_002_000_000 }));
    expect(result.raised).toBe(true);
    expect(h.api.create).toHaveBeenCalledTimes(1);
  });

  it('defaults a newly added platform to enabled', async () => {
    const h = harness();
    expect(await h.repository.notificationsEnabledFor('kick')).toBe(true);
  });
});
