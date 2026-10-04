import type {
  AuthStrategy,
  FollowedChannelPage,
  LiveChannelInfo,
  PollOutcome,
  PollWarning,
  ProviderAccount,
  ProviderAdapter,
  ProviderCapabilities,
  ResolvedChannel,
} from '../../src/core/provider';
import { UnsupportedCapabilityError } from '../../src/core/provider';

export interface FakeChannel {
  channelId: string;
  displayName: string;
  live?: LiveChannelInfo;
  /** Simulates a channel the platform no longer exposes at all. */
  missing?: boolean;
}

/**
 * A complete, platform-free provider used to prove the boundary (task 3.4).
 * It is typed with `satisfies ProviderAdapter`, which is the compile-time
 * conformance check task 3.1 asks for.
 */
export class FakeProvider implements ProviderAdapter {
  readonly displayName = 'Fake';
  readonly authStrategy: AuthStrategy = 'oauth';

  readonly capabilities: ProviderCapabilities = {
    followedChannels: true,
    followedStreams: true,
    manualChannelEntry: true,
    unofficialFollowImport: false,
    supportsMultipleAccounts: true,
    realtimeEvents: false,
  };

  /** Channels this provider "follows", in the order the listing would return them. */
  followed: FakeChannel[] = [];
  /** Channels looked up by id for live status; independent of the followed list. */
  readonly known = new Map<string, FakeChannel>();

  /** Channels removed by deleteOnRead, to model upstream disappearance. */
  readonly deleted: string[] = [];

  readonly calls = { listFollowed: 0, fetchLive: 0, resolveByHandle: 0 };

  /** Lets a test model a platform that has no followed-channel endpoint. */
  setCapabilities(overrides: Partial<ProviderCapabilities>): this {
    Object.assign(this.capabilities, overrides);
    return this;
  }

  pageSize: number | undefined;
  listError: Error | undefined;
  liveError: Error | undefined;
  liveWarnings: PollWarning[] = [];
  /** Ids the provider should pretend it does not recognise. */
  unknownIds: string[] = [];

  constructor(readonly id = 'fake') {}

  static create(id = 'fake'): FakeProvider {
    return new FakeProvider(id);
  }

  add(channel: FakeChannel): this {
    this.followed.push(channel);
    this.known.set(channel.channelId, channel);
    return this;
  }

  setLive(channelId: string, info: Partial<LiveChannelInfo> & Pick<LiveChannelInfo, 'channelId' | 'displayName'>): this {
    const channel = this.known.get(channelId) ?? { channelId, displayName: info.displayName };
    channel.live = { title: '', viewers: 0, ...info };
    this.known.set(channelId, channel);
    return this;
  }

  setOffline(channelId: string): this {
    const channel = this.known.get(channelId);
    if (channel) channel.live = undefined;
    return this;
  }

  /**
   * Stops listing a channel, modelling an upstream channel that was deleted.
   * Explicit rather than automatic, so a test can import it first and only then
   * make it disappear.
   */
  vanish(channelId: string): this {
    this.deleted.push(channelId);
    this.followed = this.followed.filter((c) => c.channelId !== channelId);
    return this;
  }

  publicStreamUrl(channel: ResolvedChannel): string {
    return `https://fake.example/${channel.displayName}`;
  }

  async listFollowedChannels(_account: ProviderAccount, cursor?: string): Promise<FollowedChannelPage> {
    this.calls.listFollowed += 1;
    if (this.listError) throw this.listError;
    if (!this.capabilities.followedChannels) {
      throw new UnsupportedCapabilityError(this.id, 'followedChannels');
    }

    const all = this.followed;
    if (this.pageSize === undefined) {
      return { channels: all.map((c) => this.toResolved(c, 'account-1')) };
    }

    const offset = Number(cursor ?? '0');
    const slice = all.slice(offset, offset + this.pageSize);
    const next = offset + this.pageSize;
    return {
      channels: slice.map((c) => this.toResolved(c, 'account-1')),
      ...(next < all.length ? { nextCursor: String(next) } : {}),
    };
  }

  /**
   * The fake resolves a name against its known channel list, which is enough to
   * exercise add-by-handle without a network call.
   */
  async resolveChannelByHandle(
    account: ProviderAccount,
    handle: string,
  ): Promise<ResolvedChannel | undefined> {
    this.calls.resolveByHandle += 1;
    const match = this.followed.find((c) => c.displayName.toLowerCase() === handle.toLowerCase());
    return match ? this.toResolved(match, account.accountId) : undefined;
  }

  async fetchLiveStatus(account: ProviderAccount, channelIds: string[]): Promise<PollOutcome> {
    this.calls.fetchLive += 1;
    if (this.liveError) throw this.liveError;

    const live: LiveChannelInfo[] = [];
    const warnings: PollWarning[] = [...this.liveWarnings];

    for (const id of channelIds) {
      if (this.unknownIds.includes(id)) {
        warnings.push({ channelId: id, reason: 'channel_missing', message: `no such channel: ${id}` });
        continue;
      }
      const channel = this.known.get(id);
      if (channel?.missing) {
        warnings.push({ channelId: id, reason: 'channel_missing', message: `channel is gone: ${id}` });
        continue;
      }
      if (channel?.live) live.push(channel.live);
    }

    return { providerId: this.id, accountId: account.accountId, live, wentOffline: [], warnings };
  }

  private toResolved(channel: FakeChannel, accountId: string): ResolvedChannel {
    return { channelId: channel.channelId, displayName: channel.displayName, accountId };
  }
}
