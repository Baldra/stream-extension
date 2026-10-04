import type { LiveChannelInfo, ProviderAccount } from '../../src/core/provider';
import type { ProviderFixture } from './fixture';

export const FIXTURE_ACCOUNT: ProviderAccount = {
  accountId: 'fixture-account',
  providerId: 'unknown',
  displayName: 'tester',
  credentials: { accessToken: 'fixture-access-token', expiresAt: Number.MAX_SAFE_INTEGER },
};

/**
 * In-memory upstream data that any provider's test harness can render into
 * whatever shape that provider's endpoints expect. Keeping the state here rather
 * than in each provider's fixture means the fake, Twitch, and Kick harnesses all
 * manipulate upstream data the same way.
 */
export class UpstreamFixture {
  readonly followed = new Map<string, { handle: string; live?: LiveChannelInfo }>();

  follow(channelId: string, handle: string): void {
    const existing = this.followed.get(channelId);
    this.followed.set(channelId, { handle, live: existing?.live });
  }

  setLive(channelId: string, handle: string, info: Partial<LiveChannelInfo> = {}): void {
    const existing = this.followed.get(channelId);
    const resolvedHandle = existing?.handle ?? handle;
    this.followed.set(channelId, {
      handle: resolvedHandle,
      live: { channelId, displayName: resolvedHandle, title: '', viewers: 0, ...info },
    });
  }

  setOffline(channelId: string): void {
    const existing = this.followed.get(channelId);
    if (!existing) return;
    this.followed.set(channelId, { handle: existing.handle });
  }

  /** Removes the channel from upstream entirely, as a deletion would. */
  vanish(channelId: string): void {
    this.followed.delete(channelId);
  }

  ids(): string[] {
    return [...this.followed.keys()];
  }

  handleFor(channelId: string): string {
    return this.followed.get(channelId)?.handle ?? channelId;
  }

  handles(): Array<{ channelId: string; handle: string }> {
    return [...this.followed].map(([channelId, entry]) => ({ channelId, handle: entry.handle }));
  }

  liveEntries(): Array<{ channelId: string; handle: string; info: LiveChannelInfo }> {
    return [...this.followed]
      .filter(([, entry]) => entry.live)
      .map(([channelId, entry]) => ({ channelId, handle: entry.handle, info: entry.live! }));
  }
}

export interface FixtureControls {
  /** Makes the next live-status call fail, then clears itself. */
  failPollOnce(error: Error): void;
  setPageSize(size: number | undefined): void;
  streamUrlFor(channelId: string, handle: string): string;
}

/**
 * Assembles a {@link ProviderFixture} from an adapter plus mutable upstream state.
 * `account.providerId` is filled in from the adapter so the fixture is not tied to
 * a particular platform.
 */
export function createFixture(
  adapter: { id: string; publicStreamUrl: (c: { channelId: string; displayName: string; accountId: string }) => string },
  controls: FixtureControls,
  overrides: Partial<ProviderFixture> = {},
): ProviderFixture {
  const upstream = new UpstreamFixture();
  return {
    adapter: adapter as ProviderFixture['adapter'],
    account: { ...FIXTURE_ACCOUNT, providerId: adapter.id },
    follow: (channelId, handle) => upstream.follow(channelId, handle),
    setLive: (channelId, handle, info) => upstream.setLive(channelId, handle, info),
    setOffline: (channelId) => upstream.setOffline(channelId),
    failPoll: (error) => controls.failPollOnce(error),
    setPageSize: (size) => controls.setPageSize(size),
    streamUrlFor: (channelId, handle) => controls.streamUrlFor(channelId, handle),
    ...overrides,
  };
}
