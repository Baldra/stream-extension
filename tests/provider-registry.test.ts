import { describe, expect, it } from 'vitest';
import { FakeProvider } from './helpers/fake-provider';
import { fakeFixture } from './helpers/fake-fixture';
import { describeSharedProviderBehaviour } from './helpers/shared-behaviour';
import { ProviderRegistry, DuplicateProviderError, UnknownProviderError } from '../src/core/registry';
import { UnsupportedCapabilityError, type ProviderAccount } from '../src/core/provider';

const accountFor = (provider: FakeProvider, accountId = 'account-1'): ProviderAccount => ({
  accountId,
  providerId: provider.id,
  displayName: 'tester',
  credentials: { accessToken: 'token', expiresAt: 1_000 },
});

describeSharedProviderBehaviour('FakeProvider', fakeFixture);

describe('fake provider specifics', () => {
  it('reports a vanished channel as a warning rather than a failed poll', async () => {
    const f = fakeFixture();
    f.provider.add({ channelId: 'c1', displayName: 'alpha', missing: true });

    const outcome = await f.provider.fetchLiveStatus(f.account, ['c1']);
    expect(outcome.live).toEqual([]);
    expect(outcome.warnings).toEqual([
      { channelId: 'c1', reason: 'channel_missing', message: 'channel is gone: c1' },
    ]);
  });

  it('reports an unrecognised id as a warning', async () => {
    const f = fakeFixture();
    f.provider.unknownIds = ['ghost'];
    const outcome = await f.provider.fetchLiveStatus(f.account, ['ghost']);
    expect(outcome.warnings[0]).toMatchObject({ channelId: 'ghost', reason: 'channel_missing' });
  });

  it('propagates a listing failure to the caller', async () => {
    const f = fakeFixture();
    f.provider.listError = new Error('listing failed');
    await expect(f.provider.listFollowedChannels(f.account)).rejects.toThrow('listing failed');
  });
});

describe('provider registry identity (task 3.2)', () => {
  it('rejects a duplicate identifier and leaves the original usable', () => {
    const first = FakeProvider.create('twitch');
    const second = FakeProvider.create('twitch');
    const registry = new ProviderRegistry().register(first);

    expect(() => registry.register(second)).toThrow(DuplicateProviderError);
    expect(registry.get('twitch')).toBe(first);
    expect(registry.ids).toEqual(['twitch']);
  });

  it('allows an explicit replace, which is what a dev hot reload needs', () => {
    const first = FakeProvider.create('twitch');
    const second = FakeProvider.create('twitch');
    const registry = new ProviderRegistry().register(first).replace(second);
    expect(registry.get('twitch')).toBe(second);
  });

  it('keeps different provider ids independent', () => {
    const a = FakeProvider.create('alpha');
    const b = FakeProvider.create('beta');
    const registry = new ProviderRegistry().register(a).register(b);
    expect(registry.get('alpha')).toBe(a);
    expect(registry.get('beta')).toBe(b);
    expect(() => registry.register(FakeProvider.create('alpha'))).toThrow(DuplicateProviderError);
  });

  it('throws a typed error for an unknown provider', () => {
    const registry = new ProviderRegistry();
    expect(registry.has('ghost')).toBe(false);
    expect(() => registry.get('ghost')).toThrow(UnknownProviderError);
  });
});

describe('capability discovery (task 3.3)', () => {
  it('reports a provider without followed-channel listing as unsupported', () => {
    const noFollows = FakeProvider.create('nofollows');
    noFollows.capabilities.followedChannels = false;
    const registry = new ProviderRegistry().register(noFollows);

    expect(registry.capabilitiesOf('nofollows').followedChannels).toBe(false);
    expect(registry.supportsFollowedChannels).toEqual([]);
    expect(() => registry.requireCapability('nofollows', 'followedChannels')).toThrow(
      UnsupportedCapabilityError,
    );
  });

  it('lists only the providers that support followed channels', () => {
    const withFollows = FakeProvider.create('withfollows');
    const without = FakeProvider.create('without');
    without.capabilities.followedChannels = false;
    const registry = new ProviderRegistry().register(withFollows).register(without);

    expect(registry.supportsFollowedChannels).toEqual(['withfollows']);
  });

  it('returns a copy so a caller cannot mutate registered capabilities', () => {
    const provider = FakeProvider.create('p');
    const registry = new ProviderRegistry().register(provider);
    const caps = registry.capabilitiesOf('p');
    caps.followedChannels = false;
    expect(registry.capabilitiesOf('p').followedChannels).toBe(true);
  });

  it('lets the UI discover manual entry and unofficial import per provider', () => {
    const provider = FakeProvider.create('p');
    const registry = new ProviderRegistry().register(provider);
    expect(registry.capabilitiesOf('p')).toMatchObject({
      manualChannelEntry: true,
      unofficialFollowImport: false,
      realtimeEvents: false,
    });
  });
});
