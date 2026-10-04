import { describe, expect, it } from 'vitest';
import { pollAccount } from '../../src/core/polling';
import { diffTransitions, nextLiveState } from '../../src/core/transitions';
import { buildDashboard, dashboardChannelKey } from '../../src/core/dashboard';
import { AuthError, UnsupportedCapabilityError, type ProviderAccount } from '../../src/core/provider';
import { ProviderRegistry, DuplicateProviderError, UnknownProviderError } from '../../src/core/registry';
import { authFailure, type FixtureBuilder } from './fixture';

const contextFor = (
  providerId: string,
  account: ProviderAccount,
  previouslyLiveChannelIds: string[],
  /** Assumes the tracked set was observed on a previous successful poll. */
  observedChannelIds: string[] = previouslyLiveChannelIds,
) => ({ providerId, accountId: account.accountId, previouslyLiveChannelIds, observedChannelIds });

/**
 * The shared-behaviour suite (task 3.4). Every adapter -- the fake provider now,
 * Twitch in group 7 and Kick in group 8 -- is run through this one function,
 * which is what proves the polling, notification, and dashboard layers need no
 * platform-specific branching.
 *
 * Everything here goes through {@link ProviderFixture}, i.e. the contract.
 */
export function describeSharedProviderBehaviour(name: string, build: FixtureBuilder): void {
  describe(`shared behaviour: ${name}`, () => {
    it('reports nothing live for a channel that is offline', async () => {
      const f = build();
      f.follow('c1', 'alpha');

      const result = await pollAccount({
        adapter: f.adapter,
        account: f.account,
        trackedChannelIds: ['c1'],
        previouslyLiveChannelIds: [],
      });

      expect(result.outcome.live).toEqual([]);
      expect(result.outcome.wentOffline).toEqual([]);
    });

    it('emits exactly one went_live event on the offline-to-online transition', async () => {
      const f = build();
      f.follow('c1', 'alpha');
      f.setLive('c1', 'alpha', { title: 'hi', viewers: 5 });

      const result = await pollAccount({
        adapter: f.adapter,
        account: f.account,
        trackedChannelIds: ['c1'],
        previouslyLiveChannelIds: [],
      });
      const events = diffTransitions({
        // Last known state for c1 was offline, so this is a real transition.
        context: contextFor(f.adapter.id, f.account, [], ['c1']),
        outcome: result.outcome,
        liveByChannelId: result.liveByChannelId,
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'went_live', providerId: f.adapter.id, accountId: f.account.accountId });
      expect(events[0]?.kind === 'went_live' && events[0].info).toMatchObject({
        channelId: 'c1',
        displayName: 'alpha',
        title: 'hi',
        viewers: 5,
      });
    });

    it('emits nothing when a channel is already live, so polling cannot re-notify', async () => {
      const f = build();
      f.follow('c1', 'alpha');
      f.setLive('c1', 'alpha');

      const result = await pollAccount({
        adapter: f.adapter,
        account: f.account,
        trackedChannelIds: ['c1'],
        previouslyLiveChannelIds: ['c1'],
      });
      const events = diffTransitions({
        context: contextFor(f.adapter.id, f.account, ['c1']),
        outcome: result.outcome,
        liveByChannelId: result.liveByChannelId,
      });

      expect(events).toEqual([]);
    });

    it('emits nothing for a channel first observed already live', async () => {
      const f = build();
      f.follow('c1', 'alpha');
      f.setLive('c1', 'alpha');

      const result = await pollAccount({
        adapter: f.adapter,
        account: f.account,
        trackedChannelIds: ['c1'],
        previouslyLiveChannelIds: [],
      });
      const events = diffTransitions({
        // Never tracked before this poll, so there is no transition to report.
        context: contextFor(f.adapter.id, f.account, [], []),
        outcome: result.outcome,
        liveByChannelId: result.liveByChannelId,
      });

      expect(events).toEqual([]);
    });

    it('derives went-offline from the previous live set', async () => {
      const f = build();
      f.follow('c1', 'alpha');
      f.follow('c2', 'beta');
      f.setLive('c1', 'alpha');
      f.setLive('c2', 'beta');
      // c1 ends between polls; c2 stays live.
      f.setOffline('c1');

      const result = await pollAccount({
        adapter: f.adapter,
        account: f.account,
        trackedChannelIds: ['c1', 'c2'],
        previouslyLiveChannelIds: ['c1', 'c2'],
      });

      expect(result.outcome.wentOffline).toEqual(['c1']);
      expect(nextLiveState(result.liveByChannelId)).toEqual(['c2']);
    });

    it('emits a went_offline event when a live channel stops being live', async () => {
      const f = build();
      f.follow('c1', 'alpha');
      f.setLive('c1', 'alpha');
      f.setOffline('c1');

      const result = await pollAccount({
        adapter: f.adapter,
        account: f.account,
        trackedChannelIds: ['c1'],
        previouslyLiveChannelIds: ['c1'],
      });
      const events = diffTransitions({
        context: contextFor(f.adapter.id, f.account, ['c1']),
        outcome: result.outcome,
        liveByChannelId: result.liveByChannelId,
      });

      expect(events).toEqual([
        {
          kind: 'went_offline',
          providerId: f.adapter.id,
          accountId: f.account.accountId,
          channelId: 'c1',
        },
      ]);
    });

    it('scopes a poll to the channels actually tracked for the account', async () => {
      const f = build();
      f.follow('c1', 'alpha');
      f.follow('c2', 'beta');
      f.setLive('c1', 'alpha');
      f.setLive('c2', 'beta');

      const result = await pollAccount({
        adapter: f.adapter,
        account: f.account,
        trackedChannelIds: ['c1'],
        previouslyLiveChannelIds: [],
      });

      // Only the tracked channel is reported live, even though c2 is also live.
      expect(result.outcome.live.map((l) => l.channelId)).toEqual(['c1']);
    });

    it('attributes the outcome to the account and provider that were polled', async () => {
      const f = build();
      const result = await pollAccount({
        adapter: f.adapter,
        account: f.account,
        trackedChannelIds: [],
        previouslyLiveChannelIds: [],
      });
      expect(result.outcome.providerId).toBe(f.adapter.id);
      expect(result.outcome.accountId).toBe(f.account.accountId);
    });

    it('pages a followed-channel listing until it is exhausted, when supported', async () => {
      const f = build();

      // Capability-driven, not provider-driven: a platform with no official
      // follow listing must report that rather than page an empty result.
      if (!f.adapter.capabilities.followedChannels) {
        await expect(f.adapter.listFollowedChannels(f.account)).rejects.toBeInstanceOf(
          UnsupportedCapabilityError,
        );
        return;
      }

      const total = 5;
      for (let i = 0; i < total; i += 1) f.follow(`c${i}`, `chan${i}`);
      f.setPageSize(2);

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await f.adapter.listFollowedChannels(f.account, cursor);
        seen.push(...page.channels.map((c) => c.channelId));
        cursor = page.nextCursor;
      } while (cursor);

      expect(seen).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    });

    it('builds a public stream url with no credential in it', () => {
      const f = build();
      const url = f.streamUrlFor('c1', 'alpha');
      expect(url).toContain('alpha');
      expect(url).not.toMatch(/token|secret/i);
    });

    it('is reachable through the registry by id', () => {
      const f = build();
      const registry = new ProviderRegistry().register(f.adapter);
      expect(registry.get(f.adapter.id)).toBe(f.adapter);
    });

    it('renders a dashboard row from live state with no provider branching', () => {
      const f = build();
      f.follow('c1', 'alpha');
      f.follow('c2', 'beta');
      f.setLive('c2', 'beta', { title: 'now playing', viewers: 120 });

      const model = buildDashboard({
        providerId: f.adapter.id,
        accounts: [
          { accountId: f.account.accountId, displayName: f.account.displayName, requiresReconnection: false },
        ],
        channels: [
          { accountId: f.account.accountId, channelId: 'c1', displayName: 'alpha', isLive: false },
          {
            accountId: f.account.accountId,
            channelId: 'c2',
            displayName: 'beta',
            isLive: true,
            info: { channelId: 'c2', displayName: 'beta', title: 'now playing', viewers: 120 },
          },
        ],
        streamUrlFor: (_providerId, channelId, displayName) => f.streamUrlFor(channelId, displayName),
      });

      expect(model.liveChannels).toHaveLength(1);
      expect(model.liveChannels[0]).toMatchObject({ displayName: 'beta', viewers: 120, isLive: true });
      expect(model.accounts[0]).toMatchObject({ trackedCount: 2, liveCount: 1 });
      expect(dashboardChannelKey(f.adapter.id, f.account.accountId, 'c2')).toBe(
        `${f.adapter.id}:${f.account.accountId}:c2`,
      );
    });

    it('propagates an adapter auth error so the caller can require reconnection', async () => {
      const f = build();
      // A poll needs a tracked channel, otherwise it makes no request at all and
      // cannot fail.
      f.follow('c1', 'alpha');
      f.failPoll(authFailure(f.adapter.id));
      await expect(
        pollAccount({ adapter: f.adapter, account: f.account, trackedChannelIds: ['c1'], previouslyLiveChannelIds: [] }),
      ).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects a duplicate registration without disturbing the original', () => {
      const f = build();
      const registry = new ProviderRegistry().register(f.adapter);
      // Registration only reads `id`, so a bare impostor is enough to collide.
      const impostor = { id: f.adapter.id } as typeof f.adapter;

      expect(() => registry.register(impostor)).toThrow(DuplicateProviderError);
      expect(registry.get(f.adapter.id)).toBe(f.adapter);
      expect(registry.all()).toHaveLength(1);
    });

    it('reports an unknown provider as a typed error', () => {
      const registry = new ProviderRegistry();
      expect(() => registry.get('nope')).toThrow(UnknownProviderError);
    });

    it('guards any capability it does not provide as a typed error', () => {
      const f = build();
      const registry = new ProviderRegistry().register(f.adapter);
      const capabilities = registry.capabilitiesOf(f.adapter.id);

      // Every provider must provide followed-stream status.
      expect(() => registry.requireCapability(f.adapter.id, 'followedStreams')).not.toThrow();

      // Pick whatever this provider actually lacks, so the suite works for a
      // provider that supports the optional capabilities too.
      const missing = (Object.keys(capabilities) as Array<keyof typeof capabilities>).filter(
        (key) => !capabilities[key],
      );
      expect(missing.length).toBeGreaterThan(0);
      for (const key of missing) {
        expect(() => registry.requireCapability(f.adapter.id, key)).toThrow(UnsupportedCapabilityError);
      }
    });
  });
}
