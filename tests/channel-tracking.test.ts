import { describe, expect, it, vi } from 'vitest';
import { ChannelTracker, iterateFollowed } from '../src/core/tracking';
import { Repository } from '../src/core/repository';
import { createMemoryStore } from '../src/core/store';
import { createTestClock } from '../src/core/clock';
import { FakeProvider } from './helpers/fake-provider';
import type { ProviderAccount } from '../src/core/provider';

const accountFor = (provider: FakeProvider, accountId = 'a1'): ProviderAccount => ({
  accountId,
  providerId: provider.id,
  displayName: 'tester',
  credentials: { accessToken: 't', expiresAt: 1_000 },
});

function harness() {
  const provider = FakeProvider.create('fake');
  const clock = createTestClock(5_000);
  const repository = new Repository(createMemoryStore());
  const tracker = new ChannelTracker(repository, clock);
  return { provider, clock, repository, tracker, account: accountFor(provider) };
}

describe('channel identity (task 6.1)', () => {
  it('keys a channel on provider and id, keeping the handle for display only', async () => {
    const { tracker, account } = harness();
    const channel = await tracker.track(
      account,
      { channelId: 'c1', displayName: 'oldhandle', accountId: 'a1' },
      'follow_import',
    );
    expect(channel.providerChannelId).toBe('c1');
    expect(channel.handle).toBe('oldhandle');
  });

  it('keeps identity across a rename and only updates the display label', async () => {
    const { tracker, repository, account } = harness();
    await tracker.track(account, { channelId: 'c1', displayName: 'oldhandle', accountId: 'a1' }, 'follow_import');

    await tracker.track(account, { channelId: 'c1', displayName: 'newhandle', accountId: 'a1' }, 'follow_import');

    const stored = await repository.channel('fake', 'a1', 'c1');
    expect(stored?.handle).toBe('newhandle');
    expect(stored?.providerChannelId).toBe('c1');
    expect(await repository.channels()).toHaveLength(1);
  });

  it('does not confuse a handle reused by a different channel after a rename', async () => {
    const { tracker, repository, account } = harness();
    // Channel 1 was renamed away from "shared"; channel 2 now owns the handle.
    await tracker.track(account, { channelId: 'c1', displayName: 'shared', accountId: 'a1' }, 'follow_import');
    await tracker.track(account, { channelId: 'c1', displayName: 'renamed-away', accountId: 'a1' }, 'follow_import');
    await tracker.track(account, { channelId: 'c2', displayName: 'shared', accountId: 'a1' }, 'follow_import');

    const channels = await repository.channels();
    expect(channels).toHaveLength(2);
    expect(channels.find((c) => c.providerChannelId === 'c1')?.handle).toBe('renamed-away');
    expect(channels.find((c) => c.providerChannelId === 'c2')?.handle).toBe('shared');
  });

  it('preserves the original trackedAt across a rename', async () => {
    const { tracker, repository, account, clock } = harness();
    const first = await tracker.track(
      account,
      { channelId: 'c1', displayName: 'a', accountId: 'a1' },
      'manual',
    );
    await clock.advance(10_000);
    const second = await tracker.track(
      account,
      { channelId: 'c1', displayName: 'b', accountId: 'a1' },
      'manual',
    );
    expect(second.trackedAt).toBe(first.trackedAt);
    expect((await repository.channel('fake', 'a1', 'c1'))?.trackedAt).toBe(first.trackedAt);
  });
});

describe('manual add by handle (task 6.2)', () => {
  it('resolves a handle to a stable id and tracks it', async () => {
    const { tracker, provider, repository, account } = harness();
    provider.add({ channelId: 'c1', displayName: 'alpha' });

    const result = await tracker.addByHandle(provider, account, 'alpha');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.channel.providerChannelId).toBe('c1');
      expect(result.alreadyTracked).toBe(false);
    }
    expect(await repository.channels()).toHaveLength(1);
  });

  it('accepts a leading @ and mixed case', async () => {
    const { tracker, provider, account } = harness();
    provider.add({ channelId: 'c1', displayName: 'alpha' });
    for (const handle of ['@alpha', 'ALPHA', '  Alpha  ']) {
      const result = await tracker.addByHandle(provider, account, handle);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.channel.providerChannelId).toBe('c1');
    }
  });

  it('reports an unknown handle without tracking anything', async () => {
    const { tracker, provider, repository, account } = harness();
    provider.add({ channelId: 'c1', displayName: 'alpha' });

    const result = await tracker.addByHandle(provider, account, 'ghost');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_handle');
    expect(await repository.channels()).toEqual([]);
  });

  it('reports an empty handle as unknown rather than adding a blank channel', async () => {
    const { tracker, provider, repository, account } = harness();
    const result = await tracker.addByHandle(provider, account, '   ');
    expect(result.ok).toBe(false);
    expect(await repository.channels()).toEqual([]);
  });

  it('is idempotent on re-add', async () => {
    const { tracker, provider, repository, account } = harness();
    provider.add({ channelId: 'c1', displayName: 'alpha' });

    const first = await tracker.addByHandle(provider, account, 'alpha');
    const second = await tracker.addByHandle(provider, account, 'alpha');

    expect(first.ok && first.alreadyTracked).toBe(false);
    expect(second.ok && second.alreadyTracked).toBe(true);
    expect(await repository.channels()).toHaveLength(1);
  });

  it('reports unsupported when the platform has no follow listing to resolve against', async () => {
    const { tracker, provider, account } = harness();
    provider.capabilities.followedChannels = false;
    const result = await tracker.addByHandle(provider, account, 'alpha');
    expect(result.ok).toBe(false);
  });
});

describe('removal (task 6.3)', () => {
  it('clears the channel tracked and live state', async () => {
    const { tracker, repository, account } = harness();
    await tracker.track(account, { channelId: 'c1', displayName: 'alpha', accountId: 'a1' }, 'manual');
    await repository.replaceLiveState('fake', 'a1', [
      { providerId: 'fake', accountId: 'a1', channelId: 'c1', title: 't', wentLiveAt: 1, notified: true },
    ]);

    await tracker.remove(account, 'c1');

    expect(await repository.channels()).toEqual([]);
    expect(await repository.liveState('fake', 'a1')).toEqual([]);
  });

  it('succeeds without error for an untracked channel', async () => {
    const { tracker, repository, account } = harness();
    await expect(tracker.remove(account, 'never-tracked')).resolves.toBeUndefined();
    expect(await repository.channels()).toEqual([]);
  });

  it('leaves other channels alone', async () => {
    const { tracker, repository, account } = harness();
    await tracker.track(account, { channelId: 'c1', displayName: 'a', accountId: 'a1' }, 'manual');
    await tracker.track(account, { channelId: 'c2', displayName: 'b', accountId: 'a1' }, 'manual');

    await tracker.remove(account, 'c1');
    expect((await repository.channels()).map((c) => c.providerChannelId)).toEqual(['c2']);
  });
});

describe('additive follow import (task 6.4)', () => {
  it('adds newly followed channels without removing untracked ones', async () => {
    const { tracker, provider, repository, account } = harness();
    await tracker.track(account, { channelId: 'manual-only', displayName: 'mine', accountId: 'a1' }, 'manual');
    provider.add({ channelId: 'c1', displayName: 'alpha' });
    provider.add({ channelId: 'c2', displayName: 'beta' });

    const summary = await tracker.importFollowed(provider, account);

    expect(summary.added.sort()).toEqual(['c1', 'c2']);
    expect((await repository.channels()).map((c) => c.providerChannelId).sort()).toEqual([
      'c1',
      'c2',
      'manual-only',
    ]);
  });

  it('preserves a channel removed locally while still followed upstream', async () => {
    const { tracker, provider, repository, account } = harness();
    provider.add({ channelId: 'c1', displayName: 'alpha' });
    provider.add({ channelId: 'c2', displayName: 'beta' });
    await tracker.importFollowed(provider, account);
    expect(await repository.channels()).toHaveLength(2);

    await tracker.markLocallyRemoved(account, 'c1');
    expect((await tracker.trackedIds(account)).sort()).toEqual(['c2']);

    // Upstream still lists c1, but a re-import must not resurrect it.
    const summary = await tracker.importFollowed(provider, account);

    expect(summary.skippedLocallyRemoved).toEqual(['c1']);
    expect(summary.added).toEqual([]);
    expect((await tracker.trackedIds(account)).sort()).toEqual(['c2']);
  });

  it('adds a channel on a platform with no followed listing', async () => {
    // Kick publishes no follow list, so the direct lookup is the only way a name
    // becomes a trackable channel id.
    const { tracker, provider, account } = harness();
    provider.setCapabilities({ followedChannels: false });
    provider.add({ channelId: 'u-42', displayName: 'alpha' });

    const result = await tracker.addByHandle(provider, account, 'alpha');

    expect(result.ok).toBe(true);
    // It must not fall back to walking a listing the platform does not have.
    expect(provider.calls.listFollowed).toBe(0);
    expect(await tracker.trackedIds(account)).toEqual(['u-42']);
  });

  it('reports an unknown name on a platform with no listing as unknown', async () => {
    const { tracker, provider, account } = harness();
    provider.setCapabilities({ followedChannels: false });

    const result = await tracker.addByHandle(provider, account, 'ghost');

    expect(result).toEqual({ ok: false, reason: 'unknown_handle' });
    expect(provider.calls.listFollowed).toBe(0);
  });

  it('prefers the direct lookup over walking the followed listing', async () => {
    const { tracker, provider, account } = harness();
    provider.add({ channelId: 'c1', displayName: 'alpha' });

    await tracker.addByHandle(provider, account, 'alpha');

    expect(provider.calls.resolveByHandle).toBe(1);
    expect(provider.calls.listFollowed).toBe(0);
  });

  it('lets an explicit add re-enable a locally removed channel', async () => {
    const { tracker, provider, account } = harness();
    provider.add({ channelId: 'c1', displayName: 'alpha' });
    await tracker.importFollowed(provider, account);
    await tracker.markLocallyRemoved(account, 'c1');

    const result = await tracker.addByHandle(provider, account, 'alpha');
    expect(result.ok).toBe(true);
    expect(await tracker.trackedIds(account)).toEqual(['c1']);
  });

  it('refreshes handles for channels that changed name upstream', async () => {
    const { tracker, provider, repository, account } = harness();
    provider.add({ channelId: 'c1', displayName: 'alpha' });
    await tracker.importFollowed(provider, account);

    provider.followed[0]!.displayName = 'alpha-renamed';
    const summary = await tracker.importFollowed(provider, account);

    expect(summary.updated).toEqual(['c1']);
    expect((await repository.channel('fake', 'a1', 'c1'))?.handle).toBe('alpha-renamed');
  });

  it('does not fail the import when a channel vanishes upstream', async () => {
    const { tracker, provider, repository, account } = harness();
    provider.add({ channelId: 'c1', displayName: 'alpha' });
    provider.add({ channelId: 'gone', displayName: 'deleted' });
    await tracker.importFollowed(provider, account);
    expect(await repository.channels()).toHaveLength(2);

    provider.vanish('gone');
    const summary = await tracker.importFollowed(provider, account);

    expect(provider.deleted).toContain('gone');
    expect(summary.added).toEqual([]);
    // Additive only: the vanished channel stays tracked, it is not silently dropped.
    expect(await repository.channels()).toHaveLength(2);
  });
});

describe('follow-import pagination (task 6.5)', () => {
  it('fully imports a tracked set exceeding one page', async () => {
    const { tracker, provider, repository, account } = harness();
    const total = 250;
    for (let i = 0; i < total; i += 1) {
      provider.add({ channelId: `c${String(i).padStart(3, '0')}`, displayName: `chan${i}` });
    }
    provider.pageSize = 100;

    const summary = await tracker.importFollowed(provider, account);

    expect(summary.added).toHaveLength(total);
    expect(await repository.channels()).toHaveLength(total);
    expect(provider.calls.listFollowed).toBe(3);
  });

  it('exhausts a paged listing exactly, requesting no empty extra page', async () => {
    const { provider, account } = harness();
    for (let i = 0; i < 4; i += 1) provider.add({ channelId: `c${i}`, displayName: `n${i}` });
    provider.pageSize = 2;

    const seen: string[] = [];
    for await (const channel of iterateFollowed(provider, account)) seen.push(channel.channelId);

    expect(seen).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(provider.calls.listFollowed).toBe(2);
  });

  it('stops rather than looping forever on a provider that repeats a cursor', async () => {
    const provider = FakeProvider.create('looping');
    const account = accountFor(provider);
    vi.spyOn(provider, 'listFollowedChannels').mockResolvedValue({
      channels: [{ channelId: 'c1', displayName: 'a', accountId: 'a1' }],
      nextCursor: 'same-cursor',
    });

    const seen: string[] = [];
    for await (const channel of iterateFollowed(provider, account)) seen.push(channel.channelId);

    expect(seen).toEqual(['c1']);
  });

  it('handles a single page with no cursor at all', async () => {
    const { tracker, provider, repository, account } = harness();
    provider.add({ channelId: 'c1', displayName: 'alpha' });
    const summary = await tracker.importFollowed(provider, account);
    expect(summary.added).toEqual(['c1']);
    expect(provider.calls.listFollowed).toBe(1);
    expect(await repository.channels()).toHaveLength(1);
  });
});

describe('tracked ids for polling', () => {
  it('omits locally removed channels and is scoped to one account', async () => {
    const { tracker, provider, account } = harness();
    const other: ProviderAccount = { ...account, accountId: 'a2' };
    provider.add({ channelId: 'c1', displayName: 'a' });
    provider.add({ channelId: 'c2', displayName: 'b' });
    await tracker.track(account, { channelId: 'c1', displayName: 'a', accountId: 'a1' }, 'manual');
    await tracker.track(account, { channelId: 'c2', displayName: 'b', accountId: 'a1' }, 'manual');
    await tracker.markLocallyRemoved(account, 'c1');
    await tracker.track(other, { channelId: 'c3', displayName: 'c', accountId: 'a2' }, 'manual');

    expect(await tracker.trackedIds(account)).toEqual(['c2']);
    expect((await tracker.trackedIds(other)).sort()).toEqual(['c3']);
  });
});
