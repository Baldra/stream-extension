import { FakeProvider } from './fake-provider';
import { createFixture } from './fixture-state';
import type { ProviderFixture } from './fixture';

/**
 * Presents the fake provider through the same {@link ProviderFixture} contract the
 * Twitch and Kick harnesses use, so the shared suite can drive all three.
 */
export function fakeFixture(): ProviderFixture & { provider: FakeProvider } {
  const provider = FakeProvider.create('fake');
  const base = createFixture(
    provider,
    {
      failPollOnce: (error) => {
        provider.liveError = error;
      },
      setPageSize: (size) => {
        provider.pageSize = size;
      },
      streamUrlFor: (_channelId, handle) => provider.publicStreamUrl({ channelId: '', displayName: handle, accountId: '' }),
    },
    {
      // The fake owns its own upstream state, so route the fixture controls at it.
      follow: (channelId, handle) => {
        provider.add({ channelId, displayName: handle });
      },
      setLive: (channelId, handle, info) => {
        provider.setLive(channelId, { channelId, displayName: handle, ...info });
      },
      setOffline: (channelId) => {
        provider.setOffline(channelId);
      },
    },
  );
  return { ...base, provider };
}
