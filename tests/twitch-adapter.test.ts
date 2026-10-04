import { describe, expect, it, vi } from 'vitest';
import { TwitchAdapter, TWITCH_CAPABILITIES } from '../src/providers/twitch/adapter';
import { mapFollowedChannel, mapStream, publicStreamUrl } from '../src/providers/twitch/api';
import { createHttpClient, AuthHttpError, HttpError } from '../src/core/http';
import { ChannelTracker, iterateFollowed } from '../src/core/tracking';
import { ProviderRegistry } from '../src/core/registry';
import { Repository } from '../src/core/repository';
import { createMemoryStore } from '../src/core/store';
import { createTestClock } from '../src/core/clock';
import { describeSharedProviderBehaviour } from './helpers/shared-behaviour';
import type { ProviderFixture } from './helpers/fixture';
import { createFixture, UpstreamFixture } from './helpers/fixture-state';
import { AuthError, type LiveChannelInfo, type ProviderAccount } from '../src/core/provider';

const CLIENT_ID = 'twitch-client-id';
const USER_ID = 'user-1';

const account: ProviderAccount = {
  accountId: 'twitch-account',
  providerId: 'twitch',
  displayName: 'me',
  credentials: { accessToken: 'user-token', expiresAt: Number.MAX_SAFE_INTEGER },
};

interface StubRoute {
  match: (url: URL) => boolean;
  respond: (url: URL) => { body: unknown; status?: number };
}

/** Records every request URL so pagination can be asserted precisely. */
function stubHttp(routes: StubRoute[]) {
  const seen: URL[] = [];
  const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(url);
    const route = routes.find((r) => r.match(url));
    if (!route) return new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 });
    const { body, status = 200 } = route.respond(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { http: createHttpClient(fetchMock as unknown as typeof fetch, CLIENT_ID), seen, fetchMock };
}

const isFollowedChannels = (url: URL) => url.pathname.endsWith('/channels/followed');
const isFollowedStreams = (url: URL) => url.pathname.endsWith('/streams/followed');

const followedStream = (userId: string, login: string, extra: Record<string, unknown> = {}) => ({
  id: `stream-${userId}`,
  user_id: userId,
  user_login: login,
  user_name: login.toUpperCase(),
  title: `playing ${login}`,
  viewer_count: 42,
  started_at: '2024-05-01T10:00:00Z',
  thumbnail_url: `https://static-cdn.example/${userId}.jpg`,
  type: 'live',
  ...extra,
});

function adapterWith(routes: StubRoute[]) {
  const stub = stubHttp(routes);
  const adapter = new TwitchAdapter({ http: stub.http, resolveUserId: () => USER_ID });
  return { adapter, ...stub };
}

const followedChannel = (id: string, login: string) => ({
  broadcaster_id: id,
  broadcaster_login: login,
  broadcaster_name: login.toUpperCase(),
});

const liveStream = (channelId: string, handle: string, info: LiveChannelInfo) => ({
  ...followedStream(channelId, handle, {
    title: info.title ?? `playing ${handle}`,
    viewer_count: info.viewers ?? 1,
  }),
});

function helixRoutes(state: UpstreamFixture, page: { size: number | undefined }, fail: { status?: number }): StubRoute[] {
  return [
    {
      match: isFollowedChannels,
      respond: (url) => {
        if (fail.status) return { body: {}, status: fail.status };
        const all = state.handles();
        if (page.size === undefined) {
          return { body: { data: all.map(({ channelId, handle }) => followedChannel(channelId, handle)), pagination: {} } };
        }
        const offset = Number(url.searchParams.get('after') ?? 0);
        const slice = all.slice(offset, offset + page.size);
        const next = offset + page.size;
        return {
          body: {
            data: slice.map(({ channelId, handle }) => followedChannel(channelId, handle)),
            pagination: next < all.length ? { cursor: String(next) } : {},
          },
        };
      },
    },
    {
      match: isFollowedStreams,
      respond: () => {
        // A real auth failure arrives as an HTTP 401, which the adapter base
        // translates into the contract's AuthError.
        if (fail.status) return { body: {}, status: fail.status };
        return {
          body: {
            data: state.liveEntries().map(({ channelId, handle, info }) => liveStream(channelId, handle, info)),
            pagination: {},
          },
        };
      },
    },
  ];
}

/** A {@link ProviderFixture} backed by stubbed Helix endpoints. */
function twitchFixture(): ProviderFixture & { upstream: UpstreamFixture } {
  const upstream = new UpstreamFixture();
  const page = { size: undefined as number | undefined };
  const fail = { status: undefined as number | undefined };
  const { adapter } = adapterWith(helixRoutes(upstream, page, fail));

  const base = createFixture(
    adapter,
    {
      failPollOnce: (error) => {
        fail.status = error.name === 'AuthError' ? 401 : 500;
      },
      setPageSize: (size) => {
        page.size = size;
      },
      streamUrlFor: (_channelId, handle) =>
        adapter.publicStreamUrl({ channelId: '', displayName: handle, accountId: '' }),
    },
    {
      follow: (channelId, handle) => upstream.follow(channelId, handle),
      setLive: (channelId, handle, info) => upstream.setLive(channelId, handle, info),
      setOffline: (channelId) => upstream.setOffline(channelId),
    },
  );
  return { ...base, upstream };
}

describe('Twitch shared behaviour', () => {
  describe('twitch channel lookup by name', () => {
  const isUsers = (url: URL) => url.pathname.endsWith('/users');

  it('resolves a login to the numeric user id Helix is keyed by', async () => {
    const stub = stubHttp([
      {
        match: isUsers,
        respond: () => ({ body: { data: [{ id: '9001', login: 'alpha' }], pagination: {} } }),
      },
    ]);
    const adapter = new TwitchAdapter({ http: stub.http, resolveUserId: () => USER_ID });

    const resolved = await adapter.resolveChannelByHandle(account, 'alpha');

    expect(resolved).toEqual({
      channelId: '9001',
      displayName: 'alpha',
      accountId: account.accountId,
    });
    // A direct lookup must not fall back to paging the followed listing.
    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0]?.searchParams.get('login')).toBe('alpha');
  });

  it('reports a login Twitch does not know as not found', async () => {
    const stub = stubHttp([{ match: isUsers, respond: () => ({ body: { data: [], pagination: {} } }) }]);
    const adapter = new TwitchAdapter({ http: stub.http, resolveUserId: () => USER_ID });

    expect(await adapter.resolveChannelByHandle(account, 'ghost')).toBeUndefined();
  });

  it('sends the user token, because a lookup needs the same scope as polling', async () => {
    const stub = stubHttp([
      { match: isUsers, respond: () => ({ body: { data: [{ id: '1', login: 'alpha' }] } }) },
    ]);
    await new TwitchAdapter({ http: stub.http, resolveUserId: () => USER_ID }).resolveChannelByHandle(
      account,
      'alpha',
    );

    const init = stub.fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: 'Bearer user-token' });
  });

  it('surfaces a 401 as AuthError', async () => {
    const stub = stubHttp([{ match: isUsers, respond: () => ({ body: {}, status: 401 }) }]);
    const adapter = new TwitchAdapter({ http: stub.http, resolveUserId: () => USER_ID });

    await expect(adapter.resolveChannelByHandle(account, 'alpha')).rejects.toBeInstanceOf(AuthError);
  });
});

describeSharedProviderBehaviour('TwitchAdapter', twitchFixture);
});

describe('Twitch auth strategy (task 7.1)', () => {
  it('uses the broker-backed authorization-code flow', () => {
    expect(adapterWith([]).adapter.authStrategy).toBe('oauth');
  });

  it('sends the account access token and client id on every request', async () => {
    const { adapter, fetchMock } = adapterWith([
      { match: isFollowedStreams, respond: () => ({ body: { data: [] } }) },
    ]);

    await adapter.fetchLiveStatus(account, ['c1']);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer user-token');
    expect(headers['client-id']).toBe(CLIENT_ID);
  });

  it('resolves the account user id required by Helix', async () => {
    const resolveUserId = vi.fn().mockResolvedValue('user-42');
    const stub = stubHttp([{ match: isFollowedStreams, respond: () => ({ body: { data: [] } }) }]);
    const adapter = new TwitchAdapter({ http: stub.http, resolveUserId });

    await adapter.fetchLiveStatus(account, ['c1']);

    expect(resolveUserId).toHaveBeenCalledWith(account);
    expect(stub.seen[0]?.searchParams.get('user_id')).toBe('user-42');
  });

  it('surfaces a rejected token as the contract AuthError, not a transport error', async () => {
    const { adapter } = adapterWith([
      { match: isFollowedStreams, respond: () => ({ body: {}, status: 401 }) },
    ]);
    // Translated by the adapter base so the account layer can require
    // reconnection without knowing a transport produced the failure.
    await expect(adapter.fetchLiveStatus(account, ['c1'])).rejects.toBeInstanceOf(AuthError);
    await expect(adapter.fetchLiveStatus(account, ['c1'])).rejects.toMatchObject({
      providerId: 'twitch',
      reason: 'revoked',
    });
  });

  it('translates a 403 the same way as a 401', async () => {
    const { adapter } = adapterWith([
      { match: isFollowedStreams, respond: () => ({ body: {}, status: 403 }) },
    ]);
    await expect(adapter.fetchLiveStatus(account, ['c1'])).rejects.toBeInstanceOf(AuthError);
  });

  it('leaves a non-auth platform failure as an HTTP error', async () => {
    const { adapter } = adapterWith([
      { match: isFollowedStreams, respond: () => ({ body: {}, status: 503 }) },
    ]);
    await expect(adapter.fetchLiveStatus(account, ['c1'])).rejects.toBeInstanceOf(HttpError);
    await expect(adapter.fetchLiveStatus(account, ['c1'])).rejects.not.toBeInstanceOf(AuthError);
  });

  it('exposes the raw transport error type for callers that need it', async () => {
    // The transport layer still distinguishes 401 so non-provider callers can.
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    const http = createHttpClient(fetchMock as unknown as typeof fetch, CLIENT_ID);
    await expect(http.get('https://api.twitch.tv/helix/streams/followed')).rejects.toBeInstanceOf(
      AuthHttpError,
    );
  });

  it('never puts a client secret in a request', async () => {
    const { adapter, fetchMock } = adapterWith([
      { match: isFollowedStreams, respond: () => ({ body: { data: [] } }) },
    ]);
    await adapter.fetchLiveStatus(account, ['c1']);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(JSON.stringify([url, init])).not.toMatch(/secret/i);
    }
  });

  it('reports a platform failure as a typed HTTP error carrying the status', async () => {
    const { adapter } = adapterWith([
      { match: isFollowedStreams, respond: () => ({ body: {}, status: 500 }) },
    ]);
    await expect(adapter.fetchLiveStatus(account, ['c1'])).rejects.toMatchObject({ status: 500 });
  });

  it('exposes a Retry-After so the backoff can respect it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
    );
    const adapter = new TwitchAdapter({
      http: createHttpClient(fetchMock as unknown as typeof fetch, CLIENT_ID),
      resolveUserId: () => USER_ID,
    });
    await expect(adapter.fetchLiveStatus(account, ['c1'])).rejects.toMatchObject({ status: 429 });
  });
});

describe('Twitch followed-channel listing (task 7.2)', () => {
  it('requests the official endpoint with the account user id', async () => {
    const { adapter, seen } = adapterWith([
      { match: isFollowedChannels, respond: () => ({ body: { data: [followedChannel('c1', 'alpha')] } }) },
    ]);
    await adapter.listFollowedChannels(account);

    const url = seen[0]!;
    expect(`${url.origin}${url.pathname}`).toBe('https://api.twitch.tv/helix/channels/followed');
    expect(url.searchParams.get('user_id')).toBe(USER_ID);
  });

  it('returns one page with its cursor', async () => {
    const { adapter } = adapterWith([
      {
        match: isFollowedChannels,
        respond: () => ({
          body: { data: [followedChannel('c1', 'alpha')], pagination: { cursor: 'cur-2' } },
        }),
      },
    ]);

    const page = await adapter.listFollowedChannels(account);
    expect(page.channels.map((c) => c.channelId)).toEqual(['c1']);
    expect(page.nextCursor).toBe('cur-2');
  });

  it('omits the cursor on the final page', async () => {
    const { adapter } = adapterWith([
      { match: isFollowedChannels, respond: () => ({ body: { data: [followedChannel('c1', 'alpha')] } }) },
    ]);
    expect((await adapter.listFollowedChannels(account)).nextCursor).toBeUndefined();
  });

  it('uses the broadcaster id as identity and the login for display', async () => {
    const mapped = mapFollowedChannel(followedChannel('999', 'alpha'), 'a1');
    expect(mapped).toEqual({ channelId: '999', displayName: 'alpha', accountId: 'a1' });
  });

  it('fully pages a listing that needs more than one page', async () => {
    // 250 followed channels at 100 per page: three requests, with the last
    // carrying the tail and no cursor.
    const all = Array.from({ length: 250 }, (_, i) =>
      followedChannel(`c${String(i).padStart(3, '0')}`, `chan${i}`),
    );
    const { adapter, seen } = adapterWith([
      {
        match: isFollowedChannels,
        respond: (url) => {
          const after = url.searchParams.get('after');
          const offset = after ? Number(after.replace('cur-', '')) : 0;
          const page = all.slice(offset, offset + 100);
          const next = offset + 100;
          return {
            body: {
              data: page,
              pagination: next < all.length ? { cursor: `cur-${next}` } : {},
            },
          };
        },
      },
    ]);

    const collected: string[] = [];
    for await (const channel of iterateFollowed(adapter, account)) collected.push(channel.channelId);

    expect(collected).toHaveLength(250);
    expect(new Set(collected).size).toBe(250);
    expect(collected[0]).toBe('c000');
    expect(collected[249]).toBe('c249');
    expect(seen).toHaveLength(3);
    expect(seen[1]?.searchParams.get('after')).toBe('cur-100');
    expect(seen[2]?.searchParams.get('after')).toBe('cur-200');
  });

  it('imports a followed set larger than one page end to end', async () => {
    const all = Array.from({ length: 150 }, (_, i) =>
      followedChannel(`c${i}`, `chan${i}`),
    );
    const { adapter } = adapterWith([
      {
        match: isFollowedChannels,
        respond: (url) => {
          const offset = url.searchParams.get('after') ? 100 : 0;
          const next = offset + 100;
          return {
            body: {
              data: all.slice(offset, offset + 100),
              pagination: next < all.length ? { cursor: `cur-${next}` } : {},
            },
          };
        },
      },
    ]);

    const repository = new Repository(createMemoryStore());
    const tracker = new ChannelTracker(repository, createTestClock(0));
    const summary = await tracker.importFollowed(adapter, account);

    expect(summary.added).toHaveLength(150);
    expect(await repository.channels('twitch', account.accountId)).toHaveLength(150);
  });

  it('handles a followed list that is completely empty', async () => {
    const { adapter } = adapterWith([{ match: isFollowedChannels, respond: () => ({ body: { data: [] } }) }]);
    const page = await adapter.listFollowedChannels(account);
    expect(page.channels).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('declares follow-listing support so the registry lets the UI offer import', () => {
    const { adapter } = adapterWith([]);
    const registry = new ProviderRegistry().register(adapter);
    expect(registry.supportsFollowedChannels).toEqual(['twitch']);
    expect(() => registry.requireCapability('twitch', 'followedChannels')).not.toThrow();
  });
});

describe('Twitch live-status retrieval (task 7.3)', () => {
  it('requests the official followed-streams endpoint', async () => {
    const { adapter, seen } = adapterWith([{ match: isFollowedStreams, respond: () => ({ body: { data: [] } }) }]);
    await adapter.fetchLiveStatus(account, ['c1']);
    expect(`${seen[0]!.origin}${seen[0]!.pathname}`).toBe('https://api.twitch.tv/helix/streams/followed');
    expect(seen[0]?.searchParams.get('user_id')).toBe(USER_ID);
  });

  it('maps a live stream to the dashboard shape', async () => {
    const { adapter } = adapterWith([
      { match: isFollowedStreams, respond: () => ({ body: { data: [followedStream('c1', 'alpha')] } }) },
    ]);

    const outcome = await adapter.fetchLiveStatus(account, ['c1']);

    expect(outcome.live).toEqual([
      {
        channelId: 'c1',
        displayName: 'alpha',
        title: 'playing alpha',
        viewers: 42,
        startedAt: Date.parse('2024-05-01T10:00:00Z'),
        thumbnailUrl: 'https://static-cdn.example/c1.jpg',
      },
    ]);
  });

  it('covers an account with more than 100 live followed channels', async () => {
    // 250 followed channels, all live: the 100-per-page cap needs three requests
    // and every channel must still be reported exactly once.
    const all = Array.from({ length: 250 }, (_, i) => followedStream(`c${i}`, `chan${i}`));
    const { adapter, seen } = adapterWith([
      {
        match: isFollowedStreams,
        respond: (url) => {
          const after = url.searchParams.get('after');
          const offset = after ? Number(after.replace('cur-', '')) : 0;
          const page = all.slice(offset, offset + 100);
          const next = offset + 100;
          return {
            body: {
              data: page,
              pagination: next < all.length ? { cursor: `cur-${next}` } : {},
            },
          };
        },
      },
    ]);

    const outcome = await adapter.fetchLiveStatus(account, all.map((s) => s.user_id));

    expect(seen).toHaveLength(3);
    expect(outcome.live).toHaveLength(250);
    expect(new Set(outcome.live.map((l) => l.channelId)).size).toBe(250);
    expect(outcome.live.map((l) => l.channelId)).toContain('c249');
  });

  it('de-duplicates a channel appearing on more than one page', async () => {
    const { adapter } = adapterWith([
      {
        match: isFollowedStreams,
        respond: (url) => {
          // The second page repeats a stream from the first, as Helix can when
          // the live set shifts mid-pagination.
          if (url.searchParams.get('after')) {
            return { body: { data: [followedStream('c1', 'alpha')], pagination: {} } };
          }
          return {
            body: { data: [followedStream('c1', 'alpha')], pagination: { cursor: 'cur-2' } },
          };
        },
      },
    ]);

    const outcome = await adapter.fetchLiveStatus(account, ['c1']);
    expect(outcome.live).toHaveLength(1);
  });

  it('excludes a channel the user tracks but Twitch does not report live', async () => {
    const { adapter } = adapterWith([
      { match: isFollowedStreams, respond: () => ({ body: { data: [followedStream('c1', 'alpha')] } }) },
    ]);
    const outcome = await adapter.fetchLiveStatus(account, ['c1', 'c2', 'c3']);
    expect(outcome.live.map((l) => l.channelId)).toEqual(['c1']);
  });

  it('ignores an archive, which is a VOD rather than a live stream', async () => {
    const { adapter } = adapterWith([
      {
        match: isFollowedStreams,
        respond: () => ({ body: { data: [followedStream('c1', 'alpha', { type: 'archive' })] } }),
      },
    ]);
    expect((await adapter.fetchLiveStatus(account, ['c1'])).live).toEqual([]);
  });

  it('terminates when the live set shrinks to an empty page with a cursor', async () => {
    let calls = 0;
    const { adapter, seen } = adapterWith([
      {
        match: isFollowedStreams,
        respond: () => {
          calls += 1;
          // Empty page that still advertises a cursor: legitimate while streams
          // end mid-walk, but it must not loop forever.
          return { body: { data: [], pagination: { cursor: `cur-${calls}` } } };
        },
      },
    ]);

    const outcome = await adapter.fetchLiveStatus(account, ['c1']);
    expect(outcome.live).toEqual([]);
    expect(seen.length).toBeLessThanOrEqual(3);
  });

  it('drops an unparseable started_at rather than persisting NaN', () => {
    const mapped = mapStream(followedStream('c1', 'alpha', { started_at: 'not-a-date' }));
    expect(mapped.startedAt).toBeUndefined();
    expect(Number.isNaN(mapped.startedAt as unknown as number)).toBe(false);
  });

  it('reports no warnings for a clean poll', async () => {
    const { adapter } = adapterWith([{ match: isFollowedStreams, respond: () => ({ body: { data: [] } }) }]);
    expect((await adapter.fetchLiveStatus(account, ['c1'])).warnings).toEqual([]);
  });
});

describe('Twitch public URL and metadata mapping (task 7.4)', () => {
  it('builds the public stream url from the login', () => {
    expect(publicStreamUrl('alpha')).toBe('https://www.twitch.tv/alpha');
  });

  it('exposes no credential-bearing field in the mapped shape', () => {
    const mapped = mapStream({
      ...followedStream('c1', 'alpha'),
      // A future Helix field must not appear in our mapped output.
      ...({ access_token: 'leak', client_secret: 'leak', oauth_token: 'leak' } as Record<string, unknown>),
    });

    expect(Object.keys(mapped).sort()).toEqual([
      'channelId',
      'displayName',
      'startedAt',
      'thumbnailUrl',
      'title',
      'viewers',
    ]);
    expect(JSON.stringify(mapped)).not.toMatch(/leak|secret|token/);
  });

  it('excludes credential fields from the followed-channel mapping', () => {
    const mapped = mapFollowedChannel(
      { ...followedChannel('c1', 'alpha'), client_secret: 'leak' } as never,
      'a1',
    );
    expect(Object.keys(mapped).sort()).toEqual(['accountId', 'channelId', 'displayName']);
  });

  it('returns a usable url through the adapter contract', () => {
    const { adapter } = adapterWith([]);
    expect(
      adapter.publicStreamUrl({ channelId: 'c1', displayName: 'alpha', accountId: 'a1' }),
    ).toBe('https://www.twitch.tv/alpha');
  });

  it('declares polling-only capabilities with no unofficial import', () => {
    expect(TWITCH_CAPABILITIES).toEqual({
      followedChannels: true,
      followedStreams: true,
      manualChannelEntry: true,
      unofficialFollowImport: false,
      supportsMultipleAccounts: true,
      realtimeEvents: false,
    });
  });

  it('turns a network failure into a typed HTTP error rather than leaking a TypeError', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const adapter = new TwitchAdapter({
      http: createHttpClient(fetchMock as unknown as typeof fetch, CLIENT_ID),
      resolveUserId: () => USER_ID,
    });
    await expect(adapter.fetchLiveStatus(account, ['c1'])).rejects.toBeInstanceOf(HttpError);
  });
});
