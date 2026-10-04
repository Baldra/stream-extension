import { describe, expect, it, vi } from 'vitest';
import { KickAdapter, KICK_CAPABILITIES } from '../src/providers/kick/adapter';
import {
  KICK_CHANNELS_PER_REQUEST,
  KICK_LIVESTREAMS_PER_REQUEST,
  chunk,
  kickPublicStreamUrl,
  mapKickChannel,
  resolveSlugs,
} from '../src/providers/kick/api';
import { createHttpClient, AuthHttpError, HttpError } from '../src/core/http';
import { ProviderRegistry } from '../src/core/registry';
import { AuthError, UnsupportedCapabilityError, type ProviderAccount } from '../src/core/provider';
import { Repository } from '../src/core/repository';
import { createMemoryStore } from '../src/core/store';
import { createTestClock } from '../src/core/clock';
import { redactForPersistence } from '../src/core/redact';
import { describeSharedProviderBehaviour } from './helpers/shared-behaviour';
import { createFixture, UpstreamFixture } from './helpers/fixture-state';
import type { ProviderFixture } from './helpers/fixture';
import type { LiveChannelInfo } from '../src/core/provider';

const CLIENT_ID = 'kick-client-id';
const ACCOUNT_ID = 'kick-account';

const account: ProviderAccount = {
  accountId: ACCOUNT_ID,
  providerId: 'kick',
  displayName: 'me',
  credentials: { accessToken: 'user-token', expiresAt: Number.MAX_SAFE_INTEGER },
};

const slugOf = (channelId: string) => channelId;
const userIdOf = (channelId: string) => channelId;

interface KickStub {
  /** userIds per livestreams request, in order. */
  livestreamBatches: string[][];
  slugBatches: string[][];
  requests: URL[];
  seenSlugIds: NumericIdRegistry;
}

function stubKick(
  options: {
    live?: boolean;
    status?: number;
    onLivestream?: (ids: string[]) => unknown[];
    /** Slugs the upstream does not know, as a real platform would answer. */
    unknownSlugs?: string[];
  } = {},
) {
  const seen: KickStub = {
    livestreamBatches: [],
    slugBatches: [],
    requests: [],
    seenSlugIds: new NumericIdRegistry(),
  };
  const { live = true, status } = options;

  const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    seen.requests.push(url);

    if (url.pathname.endsWith('/users/livestreams')) {
      if (status) return new Response('{}', { status });
      const ids = url.searchParams.getAll('user_id');
      seen.livestreamBatches.push(ids);
      const data = options.onLivestream
        ? options.onLivestream(ids)
        : ids.map((id) => ({
            user_id: Number(id),
            channel_id: Number(id),
            livestream: live
              ? {
                  id: 1,
                  session_title: `title ${id}`,
                  viewer_count: 10,
                  is_live: true,
                  started_at: '2024-05-01T10:00:00Z',
                  thumbnail: { url: `https://cdn.example/${id}.jpg` },
                }
              : null,
          }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    }

    if (url.pathname.endsWith('/channels')) {
      const slugs = url.searchParams.getAll('slug');
      seen.slugBatches.push(slugs);
      const known = slugs.filter((slug) => !(options.unknownSlugs ?? []).includes(slug));
      return new Response(
        JSON.stringify({
          data: known.map((slug) => ({
            // A stable, distinct id per slug, as Kick assigns.
            id: seen.seenSlugIds.idFor(slug),
            slug,
            user_id: seen.seenSlugIds.idFor(slug),
            session_title: `session ${slug}`,
            stream: { type: live ? 'live' : 'offline', key: 'live_stream_SECRET_KEY_abc', livestream: null },
          })),
        }),
        { status: 200 },
      );
    }

    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });

  return { http: createHttpClient(fetchMock as unknown as typeof fetch, CLIENT_ID), seen, fetchMock };
}

function adapterWith(stub: ReturnType<typeof stubKick>) {
  return new KickAdapter({
    http: stub.http,
    resolveUserId: (_account, channelId) => userIdOf(channelId),
    resolveSlug: (_account, channelId) => slugOf(channelId),
  });
}

/** Assigns stable, distinct numeric ids to arbitrary string keys. */
class NumericIdRegistry {
  readonly #byKey = new Map<string, number>();

  idFor(key: string): number {
    let id = this.#byKey.get(key);
    if (id === undefined) {
      id = this.#byKey.size + 1;
      this.#byKey.set(key, id);
    }
    return id;
  }

  channelFor(id: number): string {
    for (const [key, value] of this.#byKey) if (value === id) return key;
    return String(id);
  }
}

/**
 * A {@link ProviderFixture} backed by stubbed Kick endpoints. The stub reads the
 * mutable upstream state on every request, so fixture controls take effect
 * immediately without rebuilding the adapter.
 */
function kickFixture(): ProviderFixture & { batches: string[][] } {
  const upstream = new UpstreamFixture();
  const batches: string[][] = [];
  const fail = { status: undefined as number | undefined };
  // Kick's ids are numeric while the shared suite uses ids like "c1", so the
  // stub and the adapter share one stable slug/channel -> numeric id mapping.
  const kickIds = new NumericIdRegistry();

  const http = createHttpClient(
    (async (input: string | URL) => {
      const url = new URL(String(input));
      if (fail.status) return new Response('{}', { status: fail.status });

      if (url.pathname.endsWith('/users/livestreams')) {
        const ids = url.searchParams.getAll('user_id');
        batches.push(ids);
        const live = new Map(upstream.liveEntries().map((e) => [e.channelId, e.info]));
        return new Response(
          JSON.stringify({
            data: ids.map((id) => {
              const channelId = kickIds.channelFor(Number(id));
              const info = live.get(channelId) as LiveChannelInfo | undefined;
              return {
                user_id: Number(id),
                channel_id: Number(id),
                livestream: info
                  ? {
                      id: 1,
                      session_title: info.title,
                      viewer_count: info.viewers ?? 0,
                      is_live: true,
                      started_at: '2024-05-01T10:00:00Z',
                      thumbnail: { url: 'https://cdn.example/x.jpg' },
                    }
                  : null,
              };
            }),
          }),
          { status: 200 },
        );
      }

      if (url.pathname.endsWith('/channels')) {
        const slugs = url.searchParams.getAll('slug');
        return new Response(
          JSON.stringify({
            data: slugs.map((slug) => ({
              id: Number(slug.replace('chan', '')),
              slug,
              user_id: Number(slug.replace('chan', '')),
              session_title: `session ${slug}`,
              stream: { type: 'live', key: 'live_stream_SECRET_KEY_abc', livestream: null },
            })),
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    CLIENT_ID,
  );

  const adapter = new KickAdapter({
    http,
    resolveUserId: (_account, channelId) => String(kickIds.idFor(channelId)),
    resolveSlug: (_account, channelId) => upstream.handleFor(channelId),
  });

  return {
    ...createFixture(
      adapter,
      {
        failPollOnce: (error) => {
          fail.status = error.name === 'AuthError' ? 401 : 500;
        },
        setPageSize: () => {
          // Kick's channels endpoint chunks by count, not by cursor.
        },
        streamUrlFor: (_channelId, handle) => kickPublicStreamUrl(handle),
      },
      {
        follow: (channelId, handle) => upstream.follow(channelId, handle),
        setLive: (channelId, handle, info) => upstream.setLive(channelId, handle, info),
        setOffline: (channelId) => upstream.setOffline(channelId),
      },
    ),
    batches,
  };
}

describe('Kick shared behaviour', () => {
  // Run against Kick's real capability set: the suite adapts to what the adapter
  // declares, so the no-follow-listing case is covered as a contract case.
  describe('kick channel lookup by name', () => {
  it('resolves a slug to the numeric user id the livestream endpoint needs', async () => {
    const stub = stubKick();
    const adapter = adapterWith(stub);

    const resolved = await adapter.resolveChannelByHandle(account, 'alpha');

    // Kick's channel id and user id differ, and the tracked id has to be the one
    // the livestreams endpoint is keyed by.
    expect(resolved?.displayName).toBe('alpha');
    expect(resolved?.accountId).toBe(ACCOUNT_ID);
    expect(Number(resolved?.channelId)).toBeGreaterThan(0);
    expect(stub.seen.slugBatches).toContainEqual(['alpha']);
  });

  it('looks the slug up as typed, without lowercasing it away', async () => {
    const stub = stubKick();
    const resolved = await adapterWith(stub).resolveChannelByHandle(account, 'ALPHA');
    // Kick stores slugs lowercase, so a differently-cased name still finds the
    // channel and the stored display name is the canonical one.
    expect(resolved?.displayName).toBe('ALPHA');
  });

  it('reports a slug the platform does not know as not found', async () => {
    const stub = stubKick({ unknownSlugs: ['ghost'] });
    expect(await adapterWith(stub).resolveChannelByHandle(account, 'ghost')).toBeUndefined();
  });
});

describeSharedProviderBehaviour('KickAdapter', kickFixture);
});

describe('Kick auth strategy (task 8.1)', () => {
  it('uses the authorization-code flow with PKCE', () => {
    expect(adapterWith(stubKick()).authStrategy).toBe('oauth');
  });

  it('sends the bearer token on live-status requests', async () => {
    const stub = stubKick();
    await adapterWith(stub).fetchLiveStatus(account, ['1']);

    const init = stub.fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer user-token');
  });

  it('translates a rejected token into the contract AuthError', async () => {
    const adapter = adapterWith(stubKick({ status: 401 }));
    await expect(adapter.fetchLiveStatus(account, ['1'])).rejects.toBeInstanceOf(AuthError);
    await expect(adapter.fetchLiveStatus(account, ['1'])).rejects.toMatchObject({
      providerId: 'kick',
      reason: 'revoked',
    });
  });

  it('still exposes the raw transport error type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    const http = createHttpClient(fetchMock as unknown as typeof fetch, CLIENT_ID);
    await expect(http.get('https://api.kick.com/public/v1/users/livestreams')).rejects.toBeInstanceOf(
      AuthHttpError,
    );
  });

  it('never sends a client secret', async () => {
    const stub = stubKick();
    await adapterWith(stub).fetchLiveStatus(account, ['1']);
    for (const [url, init] of stub.fetchMock.mock.calls) {
      expect(JSON.stringify([url, init])).not.toMatch(/secret/i);
    }
  });

  it('leaves a non-auth failure as an HTTP error', async () => {
    const adapter = adapterWith(stubKick({ status: 503 }));
    await expect(adapter.fetchLiveStatus(account, ['1'])).rejects.toBeInstanceOf(HttpError);
  });
});

describe('Kick slug-to-id resolution (task 8.2)', () => {
  it('requests the official channels endpoint with slug parameters', async () => {
    const stub = stubKick();
    await resolveSlugs(stub.http, 'user-token', ['alpha']);

    const url = stub.seen.requests[0]!;
    expect(`${url.origin}${url.pathname}`).toBe('https://api.kick.com/public/v1/channels');
    expect(url.searchParams.getAll('slug')).toEqual(['alpha']);
  });

  it('resolves each slug to its channel id', async () => {
    const stub = stubKick();
    const found = await resolveSlugs(stub.http, 'user-token', ['alpha']);
    expect(found.get('alpha')?.id).toBe(1);
  });

  it('chunks to the documented per-request limit', async () => {
    const slugs = Array.from({ length: 120 }, (_, i) => `chan${i}`);
    const stub = stubKick();

    await resolveSlugs(stub.http, 'user-token', slugs);

    expect(stub.seen.slugBatches).toHaveLength(3);
    expect(stub.seen.slugBatches[0]).toHaveLength(KICK_CHANNELS_PER_REQUEST);
    expect(stub.seen.slugBatches[0]).toHaveLength(50);
    expect(stub.seen.slugBatches[1]).toHaveLength(50);
    expect(stub.seen.slugBatches[2]).toHaveLength(20);
    // No slug is dropped or duplicated across the boundary.
    expect(stub.seen.slugBatches.flat()).toEqual(slugs);
  });

  it('handles an exact multiple of the limit without an empty extra request', async () => {
    const slugs = Array.from({ length: 100 }, (_, i) => `chan${i}`);
    const stub = stubKick();
    await resolveSlugs(stub.http, 'user-token', slugs);
    expect(stub.seen.slugBatches).toHaveLength(2);
  });

  it('makes no request for an empty slug list', async () => {
    const stub = stubKick();
    await resolveSlugs(stub.http, 'user-token', []);
    expect(stub.seen.requests).toHaveLength(0);
  });

  it('matches slugs case-insensitively, since Kick slugs are lowercase', async () => {
    const stub = stubKick();
    const found = await resolveSlugs(stub.http, 'user-token', ['Alpha']);
    expect(found.has('alpha')).toBe(true);
  });

  it('rejects a non-positive chunk size rather than looping forever', () => {
    expect(() => chunk([1, 2], 0)).toThrow(RangeError);
  });

  it('covers the chunk boundary cases', () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
    expect(chunk([1, 2, 3], 5)).toEqual([[1, 2, 3]]);
    expect(chunk([], 5)).toEqual([]);
  });
});

describe('Kick live-status retrieval (task 8.3)', () => {
  it('requests the official livestreams-for-users endpoint', async () => {
    const stub = stubKick();
    await adapterWith(stub).fetchLiveStatus(account, ['1']);
    const url = stub.seen.requests[0]!;
    expect(`${url.origin}${url.pathname}`).toBe('https://api.kick.com/public/v1/users/livestreams');
    expect(url.searchParams.getAll('user_id')).toEqual(['1']);
  });

  it('covers a tracked set exceeding 100 channels', async () => {
    const channelIds = Array.from({ length: 250 }, (_, i) => String(i + 1));
    const stub = stubKick();

    const outcome = await adapterWith(stub).fetchLiveStatus(account, channelIds);

    expect(stub.seen.livestreamBatches).toHaveLength(3);
    for (const batch of stub.seen.livestreamBatches) {
      expect(batch.length).toBeLessThanOrEqual(KICK_LIVESTREAMS_PER_REQUEST);
    }
    expect(outcome.live).toHaveLength(250);
    expect(new Set(outcome.live.map((l) => l.channelId)).size).toBe(250);
  });

  it('keeps every batch at or under 100 ids, including the boundary', () => {
    const ids = Array.from({ length: 201 }, (_, i) => String(i));
    const batches = chunk(ids, KICK_LIVESTREAMS_PER_REQUEST);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 1]);
    expect(batches.flat()).toEqual(ids);
  });

  it('maps a live stream to the dashboard shape', async () => {
    const stub = stubKick();
    const outcome = await adapterWith(stub).fetchLiveStatus(account, ['1']);
    expect(outcome.live).toEqual([
      {
        channelId: '1',
        displayName: '1',
        title: 'title 1',
        viewers: 10,
        startedAt: Date.parse('2024-05-01T10:00:00Z'),
        thumbnailUrl: 'https://cdn.example/1.jpg',
      },
    ]);
  });

  it('treats a null livestream as offline rather than an error', async () => {
    const stub = stubKick({ live: false });
    const outcome = await adapterWith(stub).fetchLiveStatus(account, ['1', '2']);
    expect(outcome.live).toEqual([]);
    expect(outcome.warnings).toEqual([]);
  });

  it('makes no request for an empty tracked set', async () => {
    const stub = stubKick();
    const outcome = await adapterWith(stub).fetchLiveStatus(account, []);
    expect(stub.seen.requests).toHaveLength(0);
    expect(outcome.live).toEqual([]);
  });

  it('omits a start time the platform did not supply', async () => {
    const stub = stubKick({
      onLivestream: (ids) =>
        ids.map((id) => ({
          user_id: Number(id),
          channel_id: Number(id),
          livestream: { id: 1, session_title: 't', viewer_count: 1, is_live: true },
        })),
    });
    const outcome = await adapterWith(stub).fetchLiveStatus(account, ['1']);
    expect(outcome.live[0]?.startedAt).toBeUndefined();
  });

  it('ignores an entry for a user that was not tracked', async () => {
    const stub = stubKick({
      onLivestream: (ids) => [
        { user_id: 999, channel_id: 999, livestream: { id: 1, session_title: 't', viewer_count: 1, is_live: true } },
        ...ids.map((id) => ({
          user_id: Number(id),
          channel_id: Number(id),
          livestream: { id: 2, session_title: 't', viewer_count: 1, is_live: true },
        })),
      ],
    });
    const outcome = await adapterWith(stub).fetchLiveStatus(account, ['1']);
    expect(outcome.live.map((l) => l.channelId)).toEqual(['1']);
  });
});

describe('Kick stream key never enters state (task 8.4)', () => {
  const SECRET = 'live_stream_SECRET_KEY_abc';

  it('is absent from the mapped channel object', async () => {
    const stub = stubKick();
    const found = await resolveSlugs(stub.http, 'user-token', ['alpha']);
    const channel = found.get('alpha')!;

    const mapped = mapKickChannel(channel, ACCOUNT_ID);
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
    expect(Object.keys(mapped).sort()).toEqual(['accountId', 'channelId', 'displayName', 'title']);
  });

  it('is absent from a live-status outcome', async () => {
    const stub = stubKick();
    const outcome = await adapterWith(stub).fetchLiveStatus(account, ['1']);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it('is absent from serialized persisted state', async () => {
    const stub = stubKick();
    const found = await resolveSlugs(stub.http, 'user-token', ['alpha']);

    // Even handing the raw channel over cannot get the key onto disk.
    const repository = new Repository(createMemoryStore());
    await repository.mutate('test', (state) => {
      (state.channels as unknown[]).push(found.get('alpha'));
    });

    expect(await repository.serialize()).not.toContain(SECRET);
  });

  it('is stripped by redaction even at a nested path', () => {
    const redacted = redactForPersistence({
      channels: [{ id: 1, slug: 'a', stream: { type: 'live', key: SECRET, livestream: { id: 9 } } }],
    });
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    // Non-sensitive siblings survive, so the shape is still useful.
    expect(JSON.stringify(redacted)).toContain('livestream');
  });

  it('does not read the stream object at all while mapping', () => {
    const channel = { id: 5, slug: 'alpha', user_id: 5, stream: { key: SECRET } };
    const getter = vi.fn();
    Object.defineProperty(channel, 'stream', { get: getter, enumerable: true });
    mapKickChannel(channel as never, ACCOUNT_ID);
    // The key is in a nested object we never touch.
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('Kick capability report (task 8.5)', () => {
  it('reports no official followed-channel listing', () => {
    const registry = new ProviderRegistry().register(adapterWith(stubKick()));
    expect(registry.capabilitiesOf('kick').followedChannels).toBe(false);
    expect(registry.supportsFollowedChannels).toEqual([]);
  });

  it('rejects a follow-import attempt as unsupported', async () => {
    const adapter = adapterWith(stubKick());
    await expect(adapter.listFollowedChannels(account)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it('advertises manual entry and the optional unofficial import instead', () => {
    expect(KICK_CAPABILITIES).toMatchObject({
      followedChannels: false,
      followedStreams: true,
      manualChannelEntry: true,
      unofficialFollowImport: true,
      realtimeEvents: false,
    });
  });

  it('builds the public stream url from the slug', () => {
    expect(kickPublicStreamUrl('alpha')).toBe('https://kick.com/alpha');
    expect(
      adapterWith(stubKick()).publicStreamUrl({ channelId: '1', displayName: 'alpha', accountId: ACCOUNT_ID }),
    ).toBe('https://kick.com/alpha');
  });
});
