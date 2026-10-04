import type { ResolvedChannel } from '../../core/provider';
import { UnofficialImportUnavailableError } from '../../core/unofficial-import';

export { UnofficialImportUnavailableError };

/**
 * The unofficial Kick follow import (group 12).
 *
 * Kick publishes no followed-channel API, and this talks to the website's own
 * private endpoint. That makes it unsupported by definition: it can break or
 * change without notice, and it must never be on the path that live detection
 * depends on. Three rules follow from that and are enforced here rather than in
 * each caller:
 *  - nothing is requested unless the user has explicitly enabled it;
 *  - any failure is reported as "unavailable" and leaves the tracked set alone;
 *  - a response that does not look the way it is documented to look is treated as
 *    a failure, not as an empty follow list.
 */

export const KICK_UNOFFICIAL_ORIGIN = 'https://kick.com';
export const KICK_UNOFFICIAL_FOLLOWING_PATH = '/api/v2/channels/following';

/** The only shape this integration accepts; anything else is a failure. */
interface UnofficialFollowingResponse {
  data?: Array<{
    channel?: { id?: unknown; slug?: unknown };
  }>;
}

export interface UnofficialImportDeps {
  /**
   * The website session cookie, which the endpoint requires because it is an
   * authenticated website route rather than a public API.
   */
  cookie: string | undefined;
  origin?: string;
  fetchImpl?: typeof fetch;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/**
 * Fetches the followed channels from Kick's undocumented endpoint.
 *
 * Throws {@link UnofficialImportUnavailableError} for every failure mode, so a
 * caller has no way to mistake a broken endpoint for an empty list.
 */
export async function fetchUnofficialFollows(
  accountId: string,
  deps: UnofficialImportDeps,
): Promise<ResolvedChannel[]> {
  const cookie = deps.cookie;
  if (!isNonEmptyString(cookie)) {
    throw new UnofficialImportUnavailableError(
      'permission_missing',
      'The unofficial import needs Kick access before it can run',
    );
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const origin = deps.origin ?? KICK_UNOFFICIAL_ORIGIN;
  const url = `${origin}${KICK_UNOFFICIAL_FOLLOWING_PATH}`;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        cookie,
        // The endpoint is versioned by header as well as path.
        'kick-api-version': '1',
      },
    });
  } catch {
    throw new UnofficialImportUnavailableError(
      'unavailable',
      'The unofficial Kick endpoint could not be reached',
    );
  }

  if (!response.ok) {
    throw new UnofficialImportUnavailableError(
      'unavailable',
      `The unofficial Kick endpoint answered ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new UnofficialImportUnavailableError(
      'unrecognized',
      'The unofficial Kick endpoint returned something other than JSON',
    );
  }

  const parsed = parseFollowing(body, accountId);
  if (!parsed) {
    throw new UnofficialImportUnavailableError(
      'unrecognized',
      'The unofficial Kick endpoint returned an unrecognized response',
    );
  }
  return parsed;
}

/**
 * Maps the response to channels, or returns undefined when the shape is not the
 * one this integration was written against.
 *
 * An unrecognised response is a failure on purpose: treating it as an empty list
 * would silently look like "you follow nobody" and could mislead a later import.
 */
function parseFollowing(body: unknown, accountId: string): ResolvedChannel[] | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const data = (body as UnofficialFollowingResponse).data;
  if (!Array.isArray(data)) return undefined;

  const channels: ResolvedChannel[] = [];
  for (const entry of data) {
    const channel = entry?.channel;
    if (!channel) return undefined;
    const channelId = channel.id;
    const slug = channel.slug;
    // One malformed entry makes the whole response unrecognised, because a partial
    // import would be indistinguishable from a smaller follow list.
    const id = typeof channelId === 'number' ? String(channelId) : channelId;
    if (!isNonEmptyString(id) || !isNonEmptyString(slug)) return undefined;
    channels.push({ channelId: id, displayName: slug, accountId });
  }
  return channels;
}
