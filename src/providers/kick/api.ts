import type { HttpClient } from '../../core/http';

export const KICK_API = 'https://api.kick.com/public/v1';
export const KICK_AUTH = 'https://id.kick.com/oauth';

/** Documented per-request limits, pinned here so the chunking is testable. */
export const KICK_CHANNELS_PER_REQUEST = 50;
export const KICK_LIVESTREAMS_PER_REQUEST = 100;

export interface KickChannel {
  id: number;
  slug: string;
  user_id: number;
  session_title?: string;
  channel_title?: string;
  is_banned?: boolean;
  /**
   * Kick nests the broadcaster's stream key here. It is deliberately absent from
   * {@link mapKickChannel}'s output and never read (task 8.4).
   */
  stream?: { type?: string; key?: string; livestream?: KickLivestream | null };
}

export interface KickLivestream {
  id: number;
  session_title: string;
  channel_title?: string;
  viewer_count: number;
  started_at?: string;
  language?: string;
  is_live: boolean;
  thumbnail?: { url?: string };
}

export interface KickLivestreamsResponse {
  data: Array<{ user_id: number; channel_id: number; livestream: KickLivestream | null }>;
  paging?: { cursor?: string; next_cursor?: string };
}

export interface KickChannelsResponse {
  data: KickChannel[];
  paging?: { cursor?: string };
}

/**
 * Maps a channel to our identity shape. Only the id, slug, and title are read, so
 * the embedded `stream.key` cannot be carried into application state even if
 * Kick adds fields to the payload.
 */
export const mapKickChannel = (
  channel: KickChannel,
  accountId: string,
): { channelId: string; displayName: string; accountId: string; title?: string } => ({
  channelId: String(channel.id),
  displayName: channel.slug,
  accountId,
  ...(channel.session_title ?? channel.channel_title ? { title: channel.session_title ?? channel.channel_title } : {}),
});

/** Splits ids into fixed-size chunks, dropping empty input. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new RangeError('chunk size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Resolves slugs to channel ids (task 8.2). The endpoint is keyed by slug but the
 * rest of the system keys on the numeric id, because a slug can be changed and
 * reused while an id is stable.
 */
export async function resolveSlugs(
  http: HttpClient,
  accessToken: string,
  slugs: string[],
): Promise<Map<string, KickChannel>> {
  const found = new Map<string, KickChannel>();
  for (const group of chunk(slugs, KICK_CHANNELS_PER_REQUEST)) {
    const url = new URL(`${KICK_API}/channels`);
    for (const slug of group) url.searchParams.append('slug', slug);

    const response = await http.get<KickChannelsResponse>(url.toString(), { accessToken });
    for (const channel of response.data ?? []) {
      found.set(channel.slug.toLowerCase(), channel);
    }
  }
  return found;
}

/**
 * Live status for a tracked set (task 8.3). The endpoint is keyed by user id and
 * caps at 100 ids per request, so a larger tracked set needs several calls.
 */
export async function fetchLivestreamsForUsers(
  http: HttpClient,
  accessToken: string,
  userIds: string[],
): Promise<KickLivestreamsResponse['data']> {
  const collected: KickLivestreamsResponse['data'] = [];
  const seen = new Set<string>();

  for (const group of chunk(userIds, KICK_LIVESTREAMS_PER_REQUEST)) {
    const url = new URL(`${KICK_API}/users/livestreams`);
    for (const id of group) url.searchParams.append('user_id', id);

    const response = await http.get<KickLivestreamsResponse>(url.toString(), { accessToken });
    for (const entry of response.data ?? []) {
      const key = String(entry.user_id);
      // A user id appears in only one chunk, but de-duplicating keeps the result
      // correct if a future endpoint ever returns overlapping pages.
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(entry);
    }
  }
  return collected;
}

export const kickPublicStreamUrl = (slug: string): string => `https://kick.com/${slug}`;
