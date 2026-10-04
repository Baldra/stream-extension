import type {
  LiveChannelInfo,
  ProviderAccount,
  ProviderAdapter,
} from '../../src/core/provider';
import { AuthError } from '../../src/core/provider';

/**
 * The only surface the shared suite is allowed to use. It is expressed in terms
 * of the provider contract plus a way to control the upstream data, so the same
 * suite can drive the fake provider, Twitch, and Kick with no branching.
 *
 * This indirection is the point of task 3.4: an earlier version of the suite
 * called `FakeProvider.add`/`setLive` directly, which meant it could only ever
 * run against the fake.
 */
export interface ProviderFixture {
  adapter: ProviderAdapter;
  account: ProviderAccount;

  /** Makes a channel visible in the followed listing. */
  follow(channelId: string, handle: string): void;
  /** Reports the channel as live. */
  setLive(channelId: string, handle: string, info?: Partial<LiveChannelInfo>): void;
  /** Reports the channel as offline. */
  setOffline(channelId: string): void;
  /** Makes the next live-status poll fail with the given error. */
  failPoll(error: Error): void;
  /** Forces a page size so pagination can be exercised. */
  setPageSize(size: number | undefined): void;
  /** The public stream url for a handle, via the adapter contract. */
  streamUrlFor(channelId: string, handle: string): string;
}

export type FixtureBuilder = () => ProviderFixture;

export const authFailure = (providerId: string): AuthError =>
  new AuthError(providerId, 'revoked');
