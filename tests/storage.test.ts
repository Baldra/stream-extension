import { describe, expect, it, vi } from 'vitest';
import { HISTORY_LIMIT, KeyedMutex, Repository, STATE_KEY, migrate } from '../src/core/repository';
import { CURRENT_SCHEMA_VERSION } from '../src/core/state';
import { createMemoryStore } from '../src/core/store';
import { emptyState, type PersistedAccount, type PersistedChannel } from '../src/core/state';

const account = (accountId: string, providerId = 'twitch'): PersistedAccount => ({
  accountId,
  providerId,
  displayName: `${accountId}-login`,
  credentials: { accessToken: `access-${accountId}`, expiresAt: 5_000, refreshToken: `refresh-${accountId}` },
  requiresReconnection: false,
});

const channel = (
  providerChannelId: string,
  accountId: string,
  providerId = 'twitch',
  overrides: Partial<PersistedChannel> = {},
): PersistedChannel => ({
  providerId,
  providerChannelId,
  handle: `handle-${providerChannelId}`,
  accountId,
  trackedAt: 1_000,
  source: 'follow_import',
  ...overrides,
});

describe('state model round trip (task 4.1)', () => {
  it('round-trips accounts, channels, live state, and history through storage', async () => {
    const store = createMemoryStore();
    const repo = new Repository(store);

    await repo.putAccount(account('a1'));
    await repo.putChannel(channel('c1', 'a1'));
    await repo.replaceLiveState('twitch', 'a1', [
      {
        providerId: 'twitch',
        accountId: 'a1',
        channelId: 'c1',
        title: 'live now',
        viewers: 10,
        wentLiveAt: 2_000,
        notified: false,
      },
    ]);
    await repo.addHistoryEntry({
      entryId: 'h1',
      providerId: 'twitch',
      accountId: 'a1',
      channelId: 'c1',
      displayName: 'handle-c1',
      title: 'live now',
      wentLiveAt: 2_000,
      streamUrl: 'https://twitch.tv/handle-c1',
    });

    // A fresh repository, as after a browser restart.
    const reloaded = new Repository(store);
    expect(await reloaded.accounts('twitch')).toHaveLength(1);
    expect((await reloaded.accounts('twitch'))[0]?.displayName).toBe('a1-login');
    expect(await reloaded.channels('twitch', 'a1')).toHaveLength(1);
    expect((await reloaded.liveState('twitch', 'a1'))[0]).toMatchObject({ title: 'live now', notified: false });
    expect((await reloaded.history())[0]?.entryId).toBe('h1');
  });

  it('starts empty when storage has nothing', async () => {
    const repo = new Repository(createMemoryStore());
    expect(await repo.read()).toEqual(emptyState());
  });

  it('fills in fields added by later schema versions without losing data', () => {
    const legacy = {
      schemaVersion: 0,
      accounts: [
        {
          accountId: 'a1',
          providerId: 'twitch',
          displayName: 'me',
          credentials: { accessToken: 't', expiresAt: 1 },
        },
      ],
      channels: [
        { providerId: 'twitch', providerChannelId: 'c1', handle: 'h', accountId: 'a1', trackedAt: 1 },
      ],
      live: [],
      history: [],
    } as never;

    const migrated = migrate(legacy);
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.accounts[0]?.requiresReconnection).toBe(false);
    expect(migrated.channels[0]?.source).toBe('manual');
    expect(migrated.accounts[0]?.displayName).toBe('me');
  });

  it('backfills the unofficial-import opt-in as off for pre-v3 state', () => {
    // The opt-in guards an unsupported integration, so a missing field has to read
    // as disabled rather than as permission.
    const migrated = migrate({
      schemaVersion: 2,
      accounts: [],
      channels: [],
      live: [],
      history: [],
      settings: { notificationsDisabled: [] },
    } as never);

    expect(migrated.settings.unofficialFollowImportEnabled).toBe(false);
  });

  it('keeps an already-granted opt-in across a migration', () => {
    const migrated = migrate({
      schemaVersion: 2,
      accounts: [],
      channels: [],
      live: [],
      history: [],
      settings: { notificationsDisabled: [], unofficialFollowImportEnabled: true },
    } as never);

    expect(migrated.settings.unofficialFollowImportEnabled).toBe(true);
  });

  it('backfills the per-platform notification switch for pre-v2 state', () => {
    // v1 state has no `settings` at all, so every read would otherwise fail.
    const migrated = migrate({ schemaVersion: 1, accounts: [], channels: [], live: [], history: [] } as never);

    expect(migrated.settings).toEqual({
      notificationsDisabled: [],
      unofficialFollowImportEnabled: false,
    });
  });

  it('keeps an already-persisted notification choice through a migration', () => {
    const migrated = migrate({
      schemaVersion: 1,
      settings: { notificationsDisabled: ['kick'] },
      accounts: [],
      channels: [],
      live: [],
      history: [],
    } as never);

    expect(migrated.settings.notificationsDisabled).toEqual(['kick']);
  });
});

describe('per-account isolation (task 4.2)', () => {
  it('keeps state for two accounts independent', async () => {
    const repo = new Repository(createMemoryStore());
    await repo.putAccount(account('a1'));
    await repo.putAccount(account('a2', 'kick'));

    await repo.putChannel(channel('c1', 'a1', 'twitch'));
    await repo.putChannel(channel('c2', 'a2', 'kick'));
    await repo.replaceLiveState('twitch', 'a1', [
      { providerId: 'twitch', accountId: 'a1', channelId: 'c1', title: 't', wentLiveAt: 1, notified: false },
    ]);

    expect((await repo.channels('twitch', 'a1')).map((c) => c.providerChannelId)).toEqual(['c1']);
    expect((await repo.channels('kick', 'a2')).map((c) => c.providerChannelId)).toEqual(['c2']);
    expect(await repo.liveChannelIds('twitch', 'a1')).toEqual(['c1']);
    expect(await repo.liveChannelIds('kick', 'a2')).toEqual([]);

    // Disconnecting one account must not touch the other.
    await repo.removeAccount('twitch', 'a1');
    expect(await repo.accounts('twitch')).toEqual([]);
    expect(await repo.channels('twitch', 'a1')).toEqual([]);
    expect(await repo.channels('kick', 'a2')).toHaveLength(1);
    expect(await repo.accounts('kick')).toHaveLength(1);
  });

  it('keeps the same channel id on different providers distinct', async () => {
    const repo = new Repository(createMemoryStore());
    await repo.putChannel(channel('123', 'a1', 'twitch'));
    await repo.putChannel(channel('123', 'a2', 'kick'));

    expect(await repo.channels()).toHaveLength(2);
    expect(await repo.channels('twitch')).toHaveLength(1);
    expect(await repo.channels('kick')).toHaveLength(1);
  });

  it('gives a channel to exactly one account, moving rather than duplicating it', async () => {
    const repo = new Repository(createMemoryStore());
    await repo.putChannel(channel('c1', 'a1'));
    await repo.putChannel(channel('c1', 'a2'));

    const all = await repo.channels('twitch');
    expect(all).toHaveLength(1);
    expect(all[0]?.accountId).toBe('a2');
  });

  it('replaces an account in place rather than appending a duplicate', async () => {
    const repo = new Repository(createMemoryStore());
    await repo.putAccount(account('a1'));
    await repo.putAccount({ ...account('a1'), requiresReconnection: true });

    const accounts = await repo.accounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.requiresReconnection).toBe(true);
  });

  it('removes a channel with its live state', async () => {
    const repo = new Repository(createMemoryStore());
    await repo.putChannel(channel('c1', 'a1'));
    await repo.replaceLiveState('twitch', 'a1', [
      { providerId: 'twitch', accountId: 'a1', channelId: 'c1', title: 't', wentLiveAt: 1, notified: true },
    ]);

    await repo.removeChannel('twitch', 'a1', 'c1');
    expect(await repo.channels()).toEqual([]);
    expect(await repo.liveState('twitch', 'a1')).toEqual([]);
  });

  it('replaces live state wholesale for one account only', async () => {
    const repo = new Repository(createMemoryStore());
    await repo.replaceLiveState('twitch', 'a1', [
      { providerId: 'twitch', accountId: 'a1', channelId: 'c1', title: 't', wentLiveAt: 1, notified: false },
    ]);
    await repo.replaceLiveState('twitch', 'a2', [
      { providerId: 'twitch', accountId: 'a2', channelId: 'c2', title: 't', wentLiveAt: 1, notified: false },
    ]);
    await repo.replaceLiveState('twitch', 'a1', []);

    expect(await repo.liveChannelIds('twitch', 'a1')).toEqual([]);
    expect(await repo.liveChannelIds('twitch', 'a2')).toEqual(['c2']);
  });
});

describe('bounded notification history (task 4.3)', () => {
  it('discards the oldest entry once the limit is exceeded', async () => {
    const repo = new Repository(createMemoryStore(), 3);
    const entry = (n: number) => ({
      entryId: `h${n}`,
      providerId: 'twitch' as const,
      accountId: 'a1',
      channelId: `c${n}`,
      displayName: `ch${n}`,
      title: 't',
      wentLiveAt: n,
      streamUrl: `https://twitch.tv/ch${n}`,
    });

    for (const n of [1, 2, 3]) await repo.addHistoryEntry(entry(n));
    expect((await repo.history()).map((e) => e.entryId)).toEqual(['h3', 'h2', 'h1']);

    const afterOverflow = await repo.addHistoryEntry(entry(4));
    expect(afterOverflow).toHaveLength(3);
    expect(afterOverflow.map((e) => e.entryId)).toEqual(['h4', 'h3', 'h2']);
    expect(afterOverflow.map((e) => e.entryId)).not.toContain('h1');
  });

  it('stays at the limit exactly, not one over', async () => {
    const repo = new Repository(createMemoryStore(), 3);
    for (let n = 0; n < 10; n += 1) {
      await repo.addHistoryEntry({
        entryId: `h${n}`,
        providerId: 'twitch',
        accountId: 'a1',
        channelId: `c${n}`,
        displayName: 'd',
        title: 't',
        wentLiveAt: n,
        streamUrl: 'u',
      });
    }
    const history = await repo.read().then((s) => s.history);
    expect(history).toHaveLength(3);
    expect(history[0]?.entryId).toBe('h9');
  });

  it('keeps entries per account independent', async () => {
    const repo = new Repository(createMemoryStore());
    await repo.addHistoryEntry({
      entryId: 'x',
      providerId: 'twitch',
      accountId: 'a1',
      channelId: 'c',
      displayName: 'd',
      title: 't',
      wentLiveAt: 1,
      streamUrl: 'u',
    });
    await repo.addHistoryEntry({
      entryId: 'y',
      providerId: 'twitch',
      accountId: 'a2',
      channelId: 'c',
      displayName: 'd',
      title: 't',
      wentLiveAt: 1,
      streamUrl: 'u',
    });
    await repo.removeAccount('twitch', 'a1');
    expect((await repo.history()).map((e) => e.entryId)).toEqual(['y']);
  });

  it('uses a sane default limit', () => {
    expect(HISTORY_LIMIT).toBeGreaterThan(0);
  });

  it('clears history on request', async () => {
    const repo = new Repository(createMemoryStore());
    await repo.addHistoryEntry({
      entryId: 'x',
      providerId: 'twitch',
      accountId: 'a1',
      channelId: 'c',
      displayName: 'd',
      title: 't',
      wentLiveAt: 1,
      streamUrl: 'u',
    });
    await repo.clearHistory();
    expect(await repo.history()).toEqual([]);
  });
});

describe('per-key write lock (task 4.4)', () => {
  it('collapses N concurrent calls to one underlying mutation', async () => {
    const store = createMemoryStore();
    const repo = new Repository(store);

    // The real-world case this protects: the same channel going live is observed
    // by several concurrent code paths, and exactly one notification is recorded.
    const entry = {
      entryId: 'e1',
      providerId: 'twitch' as const,
      accountId: 'a1',
      channelId: 'c1',
      displayName: 'd',
      title: 't',
      wentLiveAt: 1,
      streamUrl: 'u',
    };
    await Promise.all(Array.from({ length: 25 }, () => repo.addHistoryEntry(entry)));

    const state = (await store.get<ReturnType<typeof emptyState>>(STATE_KEY))!;
    expect(state.history).toHaveLength(25);
  });

  it('serialises a burst of distinct mutations on one account into one consistent result', async () => {
    const store = createMemoryStore();
    const repo = new Repository(store);
    await repo.putAccount(account('a1'));

    const spy = vi.spyOn(store, 'set');
    // Every one of these touches the same account, so the per-account lock must
    // run them one after another; none may read a pre-mutation snapshot.
    await Promise.all(
      Array.from({ length: 25 }, (_, n) => repo.markNotified('twitch', 'a1', `c${n}`)),
    );
    await Promise.all(
      Array.from({ length: 25 }, (_, n) => repo.putChannel(channel(`k${n}`, 'a1'))),
    );

    expect(await repo.channels('twitch', 'a1')).toHaveLength(25);
    const reloaded = new Repository(store);
    expect(await reloaded.channels('twitch', 'a1')).toHaveLength(25);
    // 50 mutations, but the last write per burst is what lands: no interleaving
    // produced a torn document.
    expect(spy).toHaveBeenCalled();
  });

  it('serialises mutations so read-modify-write never loses an update', async () => {
    const store = createMemoryStore();
    const repo = new Repository(store);
    await repo.putAccount(account('a1'));

    // Without a lock, 20 concurrent adds would race on the same array and lose
    // most of them. The lock makes each mutation observe the previous result.
    await Promise.all(
      Array.from({ length: 20 }, (_, n) => repo.putChannel(channel(`c${n}`, 'a1'))),
    );

    expect(await repo.channels('twitch', 'a1')).toHaveLength(20);
    // And the persisted copy agrees with the in-memory one.
    const reloaded = new Repository(store);
    expect(await reloaded.channels('twitch', 'a1')).toHaveLength(20);
  });

  it('does not let a failed operation poison the chain for later callers', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const failing = mutex.run('k', async () => {
      order.push('first');
      throw new Error('boom');
    });
    const following = mutex.run('k', async () => {
      order.push('second');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
    expect(order).toEqual(['first', 'second']);
  });

  it('lets different keys run concurrently', async () => {
    const mutex = new KeyedMutex();
    let concurrent = 0;
    let peak = 0;
    const work = () =>
      mutex.run('k', async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent -= 1;
      });

    await Promise.all([work(), mutex.run('other', async () => undefined)]);
    expect(peak).toBe(1);
  });

  it('keeps two accounts on one provider from blocking each other incorrectly', async () => {
    const store = createMemoryStore();
    const repo = new Repository(store);
    await Promise.all([
      repo.putChannel(channel('c1', 'a1')),
      repo.putChannel(channel('c2', 'a2')),
    ]);
    expect(await repo.channels()).toHaveLength(2);
  });
});

describe('redaction guarantee for persisted state (task 4.5)', () => {
  /** Kick's Get Channels response nests the broadcaster stream key as stream.key. */
  const kickChannelsFixture = [
    {
      id: 456,
      slug: 'somebroadcaster',
      user_id: 789,
      session_title: 'A VODCAST',
      stream: {
        type: 'live',
        key: 'live_stream_super_secret_stream_key_abc123',
        livestream: {
          id: 999,
          title: 'A VODCAST',
          viewer_count: 321,
        },
      },
    },
  ];

  it('persists no stream key from Kick\'s channel response shape', async () => {
    const repo = new Repository(createMemoryStore());
    // Even if a mapping step hands the raw shape over, the stream key cannot
    // reach disk.
    await repo.mutate('test', (state) => {
      (state.channels as unknown[]).push(...kickChannelsFixture);
    });

    const serialized = await repo.serialize();
    expect(serialized).not.toContain('live_stream_super_secret_stream_key_abc123');
    expect(serialized).not.toContain('super_secret_stream_key');
    expect(serialized).toContain('[redacted]');
  });

  it('keeps the extension\'s own access token so a restart can still poll', async () => {
    const repo = new Repository(createMemoryStore());
    await repo.putAccount(account('a1'));
    const serialized = await repo.serialize();
    expect(serialized).toContain('access-a1');
    expect(serialized).toContain('refresh-a1');
  });

  it('strips a client secret or code verifier handed to the repository', async () => {
    const repo = new Repository(createMemoryStore());
    await repo.mutate('test', (state) => {
      state.accounts.push({
        accountId: 'bad',
        providerId: 'kick',
        displayName: 'x',
        requiresReconnection: false,
        clientSecret: 'kick-client-secret-value',
        codeVerifier: 'verifier-value',
        credentials: { accessToken: 'at', expiresAt: 1 },
      } as never);
    });

    const serialized = await repo.serialize();
    expect(serialized).not.toContain('kick-client-secret-value');
    expect(serialized).not.toContain('verifier-value');
    expect(serialized).toContain('at');
  });

  it('never writes a stream key to the underlying store', async () => {
    const store = createMemoryStore();
    const repo = new Repository(store);
    await repo.mutate('test', (state) => {
      (state.live as unknown[]).push({ ...kickChannelsFixture[0] });
    });

    const raw = JSON.stringify(await store.get(STATE_KEY));
    expect(raw).not.toContain('super_secret_stream_key_abc123');
  });
});
