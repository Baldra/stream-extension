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
import { UnsupportedCapabilityError } from '../../core/provider';
import { fetchLivestreamsForUsers, kickPublicStreamUrl, resolveSlugs } from './api';

export const KICK_CAPABILITIES: ProviderCapabilities = {
  // Kick publishes no followed-channel endpoint; manual add and the optional
  // unofficial importer are the substitutes (task 8.5).
  followedChannels: false,
  followedStreams: true,
  manualChannelEntry: true,
  unofficialFollowImport: true,
  supportsMultipleAccounts: true,
  // Kick Events are webhook-only, which an extension cannot receive.
  realtimeEvents: false,
};

export interface KickAdapterOptions {
  http: HttpClient;
  /**
   * Maps a tracked channel id to the numeric Kick user id, which the
   * livestreams endpoint is keyed by. Kick's channel id and user id differ.
   */
  resolveUserId: (account: ProviderAccount, channelId: string) => Promise<string> | string;
  /** Maps a tracked channel id to its current slug, for display and for lookups. */
  resolveSlug: (account: ProviderAccount, channelId: string) => Promise<string> | string;
}

export class KickAdapter extends BaseProviderAdapter {
  readonly id = 'kick';
  readonly displayName = 'Kick';
  readonly authStrategy = 'oauth' as const;
  readonly capabilities = KICK_CAPABILITIES;

  constructor(private readonly options: KickAdapterOptions) {
    super();
  }

  publicStreamUrl(channel: ResolvedChannel): string {
    return kickPublicStreamUrl(channel.displayName);
  }

  /** Kick has no official follow listing, so this always reports unsupported. */
  protected async fetchFollowedPage(): Promise<FollowedChannelPage> {
    throw new UnsupportedCapabilityError(this.id, 'followedChannels');
  }

  /**
   * Kick's public channels endpoint answers for a slug and returns the numeric user
   * id, which is what its livestream endpoint is keyed by. This is what makes
   * add-by-name work without any follow listing.
   */
  protected override async lookupChannel(
    account: ProviderAccount,
    handle: string,
  ): Promise<ResolvedChannel | undefined> {
    const found = await resolveSlugs(this.options.http, account.credentials.accessToken, [handle]);
    const channel = found.get(handle.toLowerCase());
    if (!channel) return undefined;
    return {
      channelId: String(channel.user_id),
      displayName: channel.slug,
      accountId: account.accountId,
    };
  }

  protected async fetchStatus(account: ProviderAccount, channelIds: string[]): Promise<PollOutcome> {
    if (channelIds.length === 0) {
      return { providerId: this.id, accountId: account.accountId, live: [], wentOffline: [], warnings: [] };
    }

    const userIdsByChannelId = new Map<string, string>();
    const slugsByChannelId = new Map<string, string>();
    await Promise.all(
      channelIds.map(async (channelId) => {
        const [userId, slug] = await Promise.all([
          this.options.resolveUserId(account, channelId),
          this.options.resolveSlug(account, channelId),
        ]);
        userIdsByChannelId.set(channelId, userId);
        slugsByChannelId.set(channelId, slug);
      }),
    );

    const userIds = [...userIdsByChannelId.values()];
    const entries = await fetchLivestreamsForUsers(
      this.options.http,
      account.credentials.accessToken,
      userIds,
    );

    const channelIdByUserId = new Map<string, string>();
    for (const [channelId, userId] of userIdsByChannelId) channelIdByUserId.set(userId, channelId);

    const live: LiveChannelInfo[] = [];
    for (const entry of entries) {
      const livestream = entry.livestream;
      // A null livestream means the channel is offline, which is not an error.
      if (!livestream || !livestream.is_live) continue;
      const channelId = channelIdByUserId.get(String(entry.user_id));
      if (!channelId) continue;

      live.push({
        channelId,
        displayName: slugsByChannelId.get(channelId) ?? String(entry.user_id),
        title: livestream.session_title ?? livestream.channel_title ?? '',
        viewers: livestream.viewer_count,
        ...(livestream.started_at && Number.isFinite(Date.parse(livestream.started_at))
          ? { startedAt: Date.parse(livestream.started_at) }
          : {}),
        ...(livestream.thumbnail?.url ? { thumbnailUrl: livestream.thumbnail.url } : {}),
      });
    }

    return { providerId: this.id, accountId: account.accountId, live, wentOffline: [], warnings: [] };
  }
}
