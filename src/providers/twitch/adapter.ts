import type { HttpClient } from '../../core/http';
import { BaseProviderAdapter } from '../../core/adapter-base';
import type {
  FollowedChannelPage,
  LiveChannelInfo,
  PollOutcome,
  ProviderAccount,
  ProviderCapabilities,
  ResolvedChannel,
} from '../../core/provider';
import {
  TWITCH_API,
  fetchFollowedStreams,
  mapFollowedChannel,
  mapStream,
  publicStreamUrl,
  type HelixPage,
  type TwitchFollowedChannel,
} from './api';

export const TWITCH_CAPABILITIES: ProviderCapabilities = {
  followedChannels: true,
  followedStreams: true,
  manualChannelEntry: true,
  unofficialFollowImport: false,
  supportsMultipleAccounts: true,
  // Twitch offers EventSub over a websocket, but an MV3 service worker cannot
  // hold one open; design.md decision 2 settles on polling.
  realtimeEvents: false,
};

export interface TwitchAdapterOptions {
  http: HttpClient;
  /**
   * The account's Twitch user id, which Helix requires in place of a login. Held
   * alongside the token because it is not derivable from the access token.
   */
  resolveUserId: (account: ProviderAccount) => Promise<string> | string;
}

export class TwitchAdapter extends BaseProviderAdapter {
  readonly id = 'twitch';
  readonly displayName = 'Twitch';
  readonly authStrategy = 'oauth' as const;
  readonly capabilities = TWITCH_CAPABILITIES;

  constructor(private readonly options: TwitchAdapterOptions) {
    super();
  }

  publicStreamUrl(channel: ResolvedChannel): string {
    return publicStreamUrl(channel.displayName);
  }

  /**
   * Helix answers a login directly, so a name the user typed resolves without
   * walking the followed listing.
   */
  protected override async lookupChannel(
    account: ProviderAccount,
    handle: string,
  ): Promise<ResolvedChannel | undefined> {
    const url = new URL(`${TWITCH_API}/users`);
    url.searchParams.set('login', handle);

    const page = await this.options.http.get<HelixPage<{ id: string; login: string }>>(url.toString(), {
      accessToken: account.credentials.accessToken,
      clientId: this.options.http.clientId,
    });

    const user = page.data[0];
    if (!user) return undefined;
    return {
      channelId: user.id,
      displayName: user.login,
      accountId: account.accountId,
    };
  }

  /**
   * One page of the followed-channel listing. Cursor walking lives in the shared
   * `iterateFollowed`, so every paging provider behaves identically and the
   * exhaustion and loop guards are written once (task 7.2).
   */
  protected async fetchFollowedPage(
    account: ProviderAccount,
    cursor?: string,
  ): Promise<FollowedChannelPage> {
    const userId = await this.options.resolveUserId(account);

    const url = new URL(`${TWITCH_API}/channels/followed`);
    url.searchParams.set('user_id', userId);
    url.searchParams.set('first', '100');
    if (cursor) url.searchParams.set('after', cursor);

    const page = await this.options.http.get<HelixPage<TwitchFollowedChannel>>(url.toString(), {
      accessToken: account.credentials.accessToken,
      clientId: this.options.http.clientId,
    });

    const nextCursor = page.pagination?.cursor;
    return {
      channels: page.data.map((entry) => mapFollowedChannel(entry, account.accountId)),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  /** Live status from the followed-streams endpoint, paged past the 100 cap (task 7.3). */
  protected async fetchStatus(account: ProviderAccount, channelIds: string[]): Promise<PollOutcome> {
    const userId = await this.options.resolveUserId(account);
    const streams = await fetchFollowedStreams(
      { http: this.options.http, now: () => 0 },
      account.credentials.accessToken,
      userId,
      channelIds,
    );

    const live: LiveChannelInfo[] = streams
      // `type` is "live" or "archive"; an archive is a VOD, not a live stream.
      .filter((stream) => stream.type !== 'archive')
      .map((stream) => mapStream(stream) as LiveChannelInfo);

    return { providerId: this.id, accountId: account.accountId, live, wentOffline: [], warnings: [] };
  }
}
