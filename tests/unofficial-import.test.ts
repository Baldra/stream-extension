import { describe, expect, it, vi } from 'vitest';
import {
  fetchUnofficialFollows,
  KICK_UNOFFICIAL_FOLLOWING_PATH,
  KICK_UNOFFICIAL_ORIGIN,
} from '../src/providers/kick/unofficial-import';
import { UnofficialImportUnavailableError } from '../src/core/unofficial-import';
import { ChannelTracker } from '../src/core/tracking';
import { Repository } from '../src/core/repository';
import { createMemoryStore } from '../src/core/store';
import { createTestClock } from '../src/core/clock';
import { FakeProvider } from './helpers/fake-provider';
import type { ProviderAccount } from '../src/core/provider';

const account: ProviderAccount = {
  accountId: 'k1',
  providerId: 'kick',
  displayName: 'me',
  credentials: { accessToken: 'at', expiresAt: Number.MAX_SAFE_INTEGER },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const following = (slugs: string[]) => ({
  data: slugs.map((slug, index) => ({ channel: { id: 100 + index, slug } })),
});

describe('the unofficial endpoint request', () => {
  it('calls the website endpoint with the session cookie', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse(following(['alpha'])),
    );

    const channels = await fetchUnofficialFollows('k1', {
      cookie: 'session=abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(channels).toEqual([{ channelId: '100', displayName: 'alpha', accountId: 'k1' }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${KICK_UNOFFICIAL_ORIGIN}${KICK_UNOFFICIAL_FOLLOWING_PATH}`);
    expect(init.headers).toMatchObject({ cookie: 'session=abc' });
  });

  it('reports an error status as unavailable', async () => {
    await expect(
      fetchUnofficialFollows('k1', {
        cookie: 'session=abc',
        fetchImpl: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('reports an unreachable endpoint as unavailable', async () => {
    await expect(
      fetchUnofficialFollows('k1', {
        cookie: 'session=abc',
        fetchImpl: (async () => {
          throw new Error('network down');
        }) as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(UnofficialImportUnavailableError);
  });

  it('reports a non-JSON answer as unrecognized rather than an empty list', async () => {
    // The dangerous failure is mistaking a changed endpoint for "you follow nobody".
    await expect(
      fetchUnofficialFollows('k1', {
        cookie: 'session=abc',
        fetchImpl: (async () =>
          new Response('<html>login</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ reason: 'unrecognized' });
  });

  it('reports a changed response shape as unrecognized', async () => {
    await expect(
      fetchUnofficialFollows('k1', {
        cookie: 'session=abc',
        fetchImpl: (async () => jsonResponse({ channels: [] })) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ reason: 'unrecognized' });
  });

  it('refuses to run without Kick access', async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchUnofficialFollows('k1', { cookie: undefined, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ reason: 'permission_missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts a genuinely empty follow list', async () => {
    const channels = await fetchUnofficialFollows('k1', {
      cookie: 'session=abc',
      fetchImpl: (async () => jsonResponse({ data: [] })) as unknown as typeof fetch,
    });
    expect(channels).toEqual([]);
  });
});

describe('the import is off until the user enables it (task 12.2)', () => {
  function harness() {
    const repository = new Repository(createMemoryStore());
    return {
      repository,
      tracker: new ChannelTracker(repository, createTestClock(1_000)),
    };
  }

  it('makes no request while it is disabled', async () => {
    const { repository, tracker } = harness();
    const fetchFollowed = vi.fn(async () => []);

    await expect(
      tracker.importUnofficial(account, fetchFollowed as unknown as () => Promise<never[]>),
    ).rejects.toMatchObject({ reason: 'not_enabled' });

    // The guard is the point: not one request leaves the extension.
    expect(fetchFollowed).not.toHaveBeenCalled();
    expect(await repository.channels('kick', 'k1')).toEqual([]);
  });

  it('is disabled in a freshly created state', async () => {
    const { repository } = harness();
    expect(await repository.unofficialFollowImportEnabled()).toBe(false);
  });

  it('adds the returned channels once enabled', async () => {
    const { repository, tracker } = harness();
    await repository.setUnofficialFollowImportEnabled(true);

    const summary = await tracker.importUnofficial(account, async () => [
      { channelId: '100', displayName: 'alpha', accountId: 'k1' },
      { channelId: '101', displayName: 'beta', accountId: 'k1' },
    ]);

    expect(summary.added).toEqual(['100', '101']);
    expect((await tracker.trackedIds(account)).sort()).toEqual(['100', '101']);
  });
});

describe('a broken endpoint changes nothing (task 12.3)', () => {
  function harness() {
    const repository = new Repository(createMemoryStore());
    const tracker = new ChannelTracker(repository, createTestClock(1_000));
    return { repository, tracker };
  }

  it('leaves the tracked set unchanged when the fetch fails', async () => {
    const { repository, tracker } = harness();
    await repository.setUnofficialFollowImportEnabled(true);
    // A channel that was added by hand must survive a failed import.
    await repository.putChannel({
      providerId: 'kick',
      providerChannelId: '1',
      handle: 'manual',
      accountId: 'k1',
      trackedAt: 1,
      source: 'manual',
    });

    await expect(
      tracker.importUnofficial(account, async () => {
        throw new UnofficialImportUnavailableError('unavailable', 'endpoint changed');
      }),
    ).rejects.toBeInstanceOf(UnofficialImportUnavailableError);

    expect((await tracker.trackedIds(account)).sort()).toEqual(['1']);
  });

  it('does not pollute the tracked set when only part of a batch is usable', async () => {
    const { repository, tracker } = harness();
    await repository.setUnofficialFollowImportEnabled(true);

    await expect(
      tracker.importUnofficial(account, async () => {
        throw new UnofficialImportUnavailableError('unrecognized', 'changed shape');
      }),
    ).rejects.toMatchObject({ reason: 'unrecognized' });

    expect(await repository.channels('kick', 'k1')).toEqual([]);
  });

  it('does not depend on detection or notifications continuing', async () => {
    // The import is reached only through an explicit user action, so a failure
    // cannot interrupt a poll: nothing here touches the repository's live state.
    const { repository, tracker } = harness();
    await repository.setUnofficialFollowImportEnabled(true);
    await repository.replaceLiveState('kick', 'k1', [
      {
        providerId: 'kick',
        accountId: 'k1',
        channelId: '1',
        title: 'live',
        viewers: 1,
        wentLiveAt: 1,
        notified: true,
      },
    ]);

    await expect(
      tracker.importUnofficial(account, async () => {
        throw new UnofficialImportUnavailableError('unavailable', 'down');
      }),
    ).rejects.toBeInstanceOf(UnofficialImportUnavailableError);

    expect(await repository.liveChannelIds('kick', 'k1')).toEqual(['1']);
  });
});

describe('disabling keeps what was already tracked (task 12.4)', () => {
  it('removes nothing and stops requesting', async () => {
    const repository = new Repository(createMemoryStore());
    const tracker = new ChannelTracker(repository, createTestClock(1_000));
    await repository.setUnofficialFollowImportEnabled(true);
    await tracker.importUnofficial(account, async () => [
      { channelId: '100', displayName: 'alpha', accountId: 'k1' },
    ]);

    await repository.setUnofficialFollowImportEnabled(false);

    expect(await repository.unofficialFollowImportEnabled()).toBe(false);
    expect((await tracker.trackedIds(account)).sort()).toEqual(['100']);

    const fetchFollowed = vi.fn(async () => []);
    await expect(
      tracker.importUnofficial(account, fetchFollowed as unknown as () => Promise<never[]>),
    ).rejects.toMatchObject({ reason: 'not_enabled' });
    expect(fetchFollowed).not.toHaveBeenCalled();
  });

  it('can be turned off without ever having been on', async () => {
    const repository = new Repository(createMemoryStore());
    await repository.setUnofficialFollowImportEnabled(false);
    expect(await repository.unofficialFollowImportEnabled()).toBe(false);
  });
});

describe('the import stays additive', () => {
  it('never resurrects a locally removed channel', async () => {
    const repository = new Repository(createMemoryStore());
    const tracker = new ChannelTracker(repository, createTestClock(1_000));
    const provider = new FakeProvider('kick');
    await repository.setUnofficialFollowImportEnabled(true);
    await repository.putChannel({
      providerId: 'kick',
      providerChannelId: '100',
      handle: 'alpha',
      accountId: 'k1',
      trackedAt: 1,
      source: 'follow_import',
      locallyRemoved: true,
    });

    const summary = await tracker.importUnofficial(account, async () => [
      { channelId: '100', displayName: 'alpha', accountId: 'k1' },
    ]);

    expect(summary.skippedLocallyRemoved).toEqual(['100']);
    expect(summary.added).toEqual([]);
    expect(await tracker.trackedIds(account)).toEqual([]);
    expect(provider).toBeDefined();
  });
});
