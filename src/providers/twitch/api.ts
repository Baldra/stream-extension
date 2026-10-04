import type { HttpClient } from '../../core/http';

export const TWITCH_API = 'https://api.twitch.tv/helix';
export const TWITCH_AUTH = 'https://id.twitch.tv/oauth2';

export interface TwitchFollowedChannel {
  broadcaster_id: string;
  broadcaster_login: string;
  broadcaster_name: string;
}

export interface TwitchFollowedStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  title: string;
  viewer_count: number;
  started_at: string;
  thumbnail_url: string;
  type: string;
  /** Game or category being played. Absent on some streams. */
  game_name?: string | null;
}

export interface HelixPage<T> {
  data: T[];
  pagination?: { cursor?: string };
}

export const TWITCH_SCOPES = ['user:read:follows'];

/**
 * Maps a followed channel to our identity shape. The stable id is
 * `broadcaster_id`; `broadcaster_login` is display-only and can be reused by a
 * different channel after a rename, so it must never be the identity.
 */
export const mapFollowedChannel = (
  entry: TwitchFollowedChannel,
  accountId: string,
): { channelId: string; displayName: string; accountId: string } => ({
  channelId: entry.broadcaster_id,
  displayName: entry.broadcaster_login,
  accountId,
});

/**
 * Maps a live stream to our shape. The raw Twitch object is deliberately not
 * carried through: it has no credential fields today, but passing only what the
 * dashboard needs means a future field cannot leak in by accident.
 */
export const mapStream = (stream: TwitchFollowedStream): {
  channelId: string;
  displayName: string;
  title: string;
  viewers: number;
  startedAt?: number;
  thumbnailUrl?: string;
  category?: string;
} => ({
  channelId: stream.user_id,
  displayName: stream.user_login,
  title: stream.title,
  viewers: stream.viewer_count,
  // An unparseable started_at is dropped rather than turned into NaN.
  ...(Number.isFinite(Date.parse(stream.started_at))
    ? { startedAt: Date.parse(stream.started_at) }
    : {}),
  ...(stream.thumbnail_url ? { thumbnailUrl: stream.thumbnail_url } : {}),
  // A null or empty game_name is a stream with no category, not a category named
  // "null", so it is dropped rather than forwarded.
  ...(stream.game_name ? { category: stream.game_name } : {}),
});

export interface TwitchAdapterDeps {
  http: HttpClient;
  now: () => number;
}

/**
 * Calls `GET /channels/followed`, following the cursor to exhaustion (task 7.2).
 * The user id is the account's own, which is why the scope is user:read:follows.
 */
export async function* listFollowedChannels(
  deps: TwitchAdapterDeps,
  accessToken: string,
  userId: string,
): AsyncGenerator<{ channelId: string; displayName: string; accountId: string }, void, void> {
  let cursor: string | undefined;
  const seenPages = new Set<string>();

  for (;;) {
    const url = new URL(`${TWITCH_API}/channels/followed`);
    url.searchParams.set('user_id', userId);
    url.searchParams.set('first', '100');
    if (cursor) url.searchParams.set('after', cursor);

    const page = await deps.http.get<HelixPage<TwitchFollowedChannel>>(url.toString(), {
      accessToken,
      clientId: deps.http.clientId,
    });

    const signature = JSON.stringify([page.data.map((c) => c.broadcaster_id), page.pagination?.cursor ?? null]);
    if (seenPages.has(signature)) return;
    seenPages.add(signature);

    for (const entry of page.data) yield mapFollowedChannel(entry, userId);
    cursor = page.pagination?.cursor;
    if (!cursor) return;
  }
}

/**
 * Calls `GET /streams/followed` (task 7.3). The page cap is 100, so an account with
 * more live followed channels needs several requests; each returns the *complete*
 * live set from the start, so overlapping pages are de-duplicated by channel id
 * rather than concatenated.
 */
export async function fetchFollowedStreams(
  deps: TwitchAdapterDeps,
  accessToken: string,
  userId: string,
  requestedChannelIds: string[],
): Promise<TwitchFollowedStream[]> {
  const wanted = new Set(requestedChannelIds);
  const byChannel = new Map<string, TwitchFollowedStream>();
  let cursor: string | undefined;
  const seenPages = new Set<string>();
  let emptyPage = 0;

  for (;;) {
    const url = new URL(`${TWITCH_API}/streams/followed`);
    url.searchParams.set('user_id', userId);
    url.searchParams.set('first', '100');
    if (cursor) url.searchParams.set('after', cursor);

    const page = await deps.http.get<HelixPage<TwitchFollowedStream>>(url.toString(), {
      accessToken,
      clientId: deps.http.clientId,
    });

    const signature = JSON.stringify([page.data.map((s) => s.id), page.pagination?.cursor ?? null]);
    if (seenPages.has(signature)) break;
    seenPages.add(signature);

    for (const stream of page.data) {
      // Only channels the user actually tracks are of interest.
      if (wanted.size > 0 && !wanted.has(stream.user_id)) continue;
      byChannel.set(stream.user_id, stream);
    }

    // Helix paginates the *live* set, which shrinks as streams end, so an empty
    // page can legitimately still carry a cursor. Two empty pages in a row means
    // the listing is done.
    if (page.data.length === 0) {
      emptyPage += 1;
      if (emptyPage >= 2) break;
    } else {
      emptyPage = 0;
    }

    cursor = page.pagination?.cursor;
    if (!cursor) break;
  }

  return [...byChannel.values()];
}

export const publicStreamUrl = (login: string): string => `https://www.twitch.tv/${login}`;
