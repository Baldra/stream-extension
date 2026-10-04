import { describe, expect, it } from 'vitest';
import { Platforms, renderDashboard, formatTime, formatViewers } from '../src/popup/view';
import type { DashboardViewModel } from '../src/core/dashboard-model';
import { ProviderRegistry } from '../src/core/registry';
import { TwitchAdapter } from '../src/providers/twitch/adapter';
import { KickAdapter } from '../src/providers/kick/adapter';
import type { ProviderId } from '../src/core/provider';
import type { NotificationHistoryEntry } from '../src/core/state';

const http = {
  clientId: 'test',
  get: async () => ({}) as never,
  post: async () => ({}) as never,
};
const twitch = new TwitchAdapter({ http, resolveUserId: () => '1' });
const kick = new KickAdapter({
  http,
  resolveUserId: (_a, c) => c,
  resolveSlug: (_a, c) => c,
});
const registry = new Platforms(
  new ProviderRegistry()
    .register(twitch)
    .register(kick)
    .all()
    .map((a) => ({ id: a.id, displayName: a.displayName, capabilities: { ...a.capabilities } })),
);

const NOW = 1_700_000_000_000;

const ctx = (overrides: Partial<Parameters<typeof renderDashboard>[1]> = {}) => ({
  now: NOW,
  registry,
  unofficialImportEnabled: false,
  notificationsGranted: true,
  notificationsEnabledFor: (_p: ProviderId) => true,
  ...overrides,
});

const model = (overrides: Partial<DashboardViewModel> = {}): DashboardViewModel => ({
  accounts: [],
  live: [],
  history: [],
  hasHistory: false,
  notUpdatingPlatforms: [],
  ...overrides,
});

const account = (overrides: Partial<DashboardViewModel['accounts'][number]> = {}) => ({
  providerId: 'twitch' as ProviderId,
  accountId: 't1',
  displayName: 'streamer',
  platformLabel: 'Twitch',
  requiresReconnection: false,
  trackedCount: 0,
  liveCount: 0,
  channels: [],
  notUpdating: false,
  ...overrides,
});

const historyEntry = (
  overrides: Partial<NotificationHistoryEntry> = {},
): NotificationHistoryEntry => ({
  entryId: 'e1',
  providerId: 'twitch',
  accountId: 't1',
  channelId: 'c1',
  displayName: 'alpha',
  title: 'title',
  wentLiveAt: NOW - 60_000,
  streamUrl: 'https://www.twitch.tv/alpha',
  ...overrides,
});

describe('live list markup', () => {
  it('states when nothing is live', () => {
    const html = renderDashboard(model(), ctx());
    expect(html).toContain('No tracked channels are currently live.');
  });

  it('marks each entry as live and names its platform', () => {
    const html = renderDashboard(
      model({
        live: [
          {
            key: 'twitch:t1:c1',
            providerId: 'twitch',
            platformLabel: 'Twitch',
            accountId: 't1',
            channelId: 'c1',
            displayName: 'alpha',
            isLive: true,
            streamUrl: 'https://www.twitch.tv/alpha',
            title: 'Playing something',
            viewers: 1234,
            unverified: false,
          },
        ],
      }),
      ctx(),
    );

    expect(html).toContain('>Live<');
    expect(html).toContain('Twitch');
    expect(html).toContain('alpha');
    expect(html).toContain('Playing something · 1,234 watching');
    expect(html).toContain('href="https://www.twitch.tv/alpha"');
  });

  it('does not present an unverified entry as confirmed', () => {
    const html = renderDashboard(
      model({
        live: [
          {
            key: 'twitch:t1:c1',
            providerId: 'twitch',
            platformLabel: 'Twitch',
            accountId: 't1',
            channelId: 'c1',
            displayName: 'alpha',
            isLive: true,
            streamUrl: 'u',
            unverified: true,
          },
        ],
        notUpdatingPlatforms: [{ providerId: 'twitch', platformLabel: 'Twitch' }],
      }),
      ctx(),
    );

    expect(html).toContain('Not verified');
    expect(html).toContain('Not currently updating: Twitch');
    expect(html).toContain('may be out of date');
  });
});

describe('stale state messaging', () => {
  it('marks an account not updating with its reason', () => {
    const html = renderDashboard(
      model({
        accounts: [account({ notUpdating: true, notUpdatingReason: 'failing' })],
      }),
      ctx(),
    );
    expect(html).toContain('data-not-updating="failing"');
    expect(html).toContain('Not updating');
  });

  it('reports never-polled and overdue accounts differently', () => {
    const html = renderDashboard(
      model({
        accounts: [
          account({ notUpdating: true, notUpdatingReason: 'never_polled' }),
          account({ accountId: 't2', notUpdating: true, notUpdatingReason: 'overdue' }),
        ],
      }),
      ctx(),
    );
    expect(html).toContain('data-not-updating="never_polled"');
    expect(html).toContain('data-not-updating="overdue"');
    expect(html).toContain('Not checked yet');
  });

  it('warns when notification permission is blocked', () => {
    const html = renderDashboard(model(), ctx({ notificationsGranted: false }));
    expect(html).toContain('Notifications are blocked');
  });
});

describe('account actions', () => {
  it('offers connect for every platform with no connected account', () => {
    const html = renderDashboard(model(), ctx());
    expect(html).toContain('Connect Twitch');
    expect(html).toContain('Connect Kick');
  });

  it('offers connect only for unconnected platforms', () => {
    const html = renderDashboard(model({ accounts: [account()] }), ctx());
    expect(html).not.toContain('Connect Twitch');
    expect(html).toContain('Connect Kick');
  });

  it('offers reconnect instead of connect for a broken account', () => {
    const html = renderDashboard(
      model({ accounts: [account({ requiresReconnection: true })] }),
      ctx(),
    );
    expect(html).toContain('Needs reconnecting');
    expect(html).toContain('data-action="connect"');
    expect(html).toContain('Reconnect');
  });

  it('always offers disconnect', () => {
    const html = renderDashboard(model({ accounts: [account()] }), ctx());
    expect(html).toContain('data-action="disconnect"');
  });

  it('offers a notification toggle reflecting the current setting', () => {
    const on = renderDashboard(
      model({ accounts: [account()] }),
      ctx({ notificationsEnabledFor: () => true }),
    );
    expect(on).toContain('checked');

    const off = renderDashboard(
      model({ accounts: [account()] }),
      ctx({ notificationsEnabledFor: () => false }),
    );
    expect(off).toMatch(/data-action="toggle-notifications"[\s\S]*?(?<!checked)>/);
  });
});

describe('channel actions are account-scoped', () => {
  it('carries the owning account on each channel control', () => {
    const channel = {
      key: 'twitch:t1:c1',
      providerId: 'twitch' as ProviderId,
      platformLabel: 'Twitch',
      accountId: 't1',
      channelId: 'c1',
      displayName: 'alpha',
      isLive: false,
      streamUrl: 'u',
      unverified: false,
    };
    const html = renderDashboard(
      model({
        accounts: [
          account({ trackedCount: 1, channels: [channel] }),
          account({ accountId: 't2', displayName: 'other', trackedCount: 1, channels: [{ ...channel, key: 'twitch:t2:c2', accountId: 't2', channelId: 'c2' }] }),
        ],
      }),
      ctx(),
    );

    expect(html).toContain('data-account="t1"');
    expect(html).toContain('data-account="t2"');
    expect(html).toMatch(/data-action="remove-channel"[\s\S]*?data-account="t1"[\s\S]*?data-channel="c1"/);
    expect(html).toMatch(/data-action="remove-channel"[\s\S]*?data-account="t2"[\s\S]*?data-channel="c2"/);
  });

  it('provides an add-channel form per account', () => {
    const html = renderDashboard(
      model({
        accounts: [account(), account({ accountId: 't2', displayName: 'other' })],
      }),
      ctx(),
    );
    expect(html.match(/data-action="add-channel"/g)).toHaveLength(2);
    expect(html).toContain('placeholder="channel name"');
  });

  it('lists tracked channels for each account separately', () => {
    const html = renderDashboard(
      model({
        accounts: [
          account({
            trackedCount: 1,
            channels: [
              {
                key: 'twitch:t1:c1',
                providerId: 'twitch' as ProviderId,
                platformLabel: 'Twitch',
                accountId: 't1',
                channelId: 'c1',
                displayName: 'first',
                isLive: false,
                streamUrl: 'u',
                unverified: false,
              },
            ],
          }),
        ],
      }),
      ctx(),
    );
    expect(html).toContain('first');
    expect(html).not.toContain('No channels tracked for this account.');
  });

  it('says when an account tracks nothing', () => {
    const html = renderDashboard(model({ accounts: [account()] }), ctx());
    expect(html).toContain('No channels tracked for this account.');
  });
});

describe('follow-import availability', () => {
  it('offers official import only for Twitch', () => {
    const html = renderDashboard(
      model({ accounts: [account(), account({ providerId: 'kick', accountId: 'k1', displayName: 'k' })] }),
      ctx(),
    );
    expect(html.match(/data-action="import-follows"/g)).toHaveLength(1);
    expect(html).toMatch(/data-action="import-follows"[\s\S]*?data-provider="twitch"/);
  });

  it('labels the Kick unofficial import as unsupported and not enabled by default', () => {
    const html = renderDashboard(
      model({ accounts: [account({ providerId: 'kick', accountId: 'k1', displayName: 'k' })] }),
      ctx(),
    );
    expect(html).not.toContain('Import followed channels');
    expect(html).toContain('data-action="unofficial-import"');
    expect(html).toContain('Unofficial, unsupported');
    expect(html).toContain('not enabled');
    // Nothing that runs an undocumented request is active before the opt-in.
    expect(html).toMatch(/data-action="unofficial-import"[\s\S]*?disabled/);
    expect(html).toContain('not needed for live detection');
  });

  it('makes the run control available once the user opts in', () => {
    const html = renderDashboard(
      model({ accounts: [account({ providerId: 'kick', accountId: 'k1' })] }),
      ctx({ unofficialImportEnabled: true }),
    );
    expect(html).toContain('Run unofficial follow import');
    expect(html).toMatch(/data-action="unofficial-import"[\s\S]*?title="Unofficial/);
    expect(html).toMatch(/data-action="toggle-unofficial-import"[\s\S]*?checked/);
    expect(html).not.toContain('(not enabled)');
  });

  it('never offers the unofficial import for a platform with an official list', () => {
    const html = renderDashboard(model({ accounts: [account()] }), ctx());
    expect(html).not.toContain('data-action="unofficial-import"');
  });
});

describe('notification history markup', () => {
  it('says nothing has been raised yet', () => {
    const html = renderDashboard(model(), ctx());
    expect(html).toContain('No notifications have been raised yet.');
  });

  it('shows channel, platform, title and time for each entry', () => {
    const html = renderDashboard(
      model({ history: [historyEntry()], hasHistory: true }),
      ctx(),
    );
    expect(html).toContain('alpha');
    expect(html).toContain('Twitch');
    expect(html).toContain('title');
    expect(html).toContain('1 min ago');
    expect(html).toMatch(/<time datetime="[^"]+"/);
  });
});

describe('escaping', () => {
  it('escapes hostile titles and display names', () => {
    const html = renderDashboard(
      model({
        history: [historyEntry({ title: '<script>x</script>', displayName: '"><img src=x>' })],
        hasHistory: true,
      }),
      ctx(),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('formatters', () => {
  it('formats relative times', () => {
    expect(formatTime(NOW, NOW)).toBe('just now');
    expect(formatTime(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
    expect(formatTime(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(formatTime(NOW - 2 * 86_400_000, NOW)).toBe('2 d ago');
  });

  it('formats viewer counts and tolerates missing ones', () => {
    expect(formatViewers(1234567)).toBe('1,234,567');
    expect(formatViewers(undefined)).toBeUndefined();
  });
});

describe('last checked status bar', () => {
  it('reports the most recent check', () => {
    const html = renderDashboard(model({ lastCheckedAt: NOW - 120_000 }), ctx());
    expect(html).toContain('data-last-checked=');
    expect(html).toContain('Last checked 2 min ago');
  });

  it('says not checked yet when there is none', () => {
    const html = renderDashboard(model(), ctx());
    expect(html).toContain('data-last-checked=""');
  });
});
