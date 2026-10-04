import { systemClock } from '../core/clock';
import { ALARM_NAME, POLL_PERIOD_MS } from '../core/constants';
import { alarmScheduler } from '../core/scheduler';
import { AccountManager } from '../core/accounts';
import { LiveDetectionService } from '../core/detection';
import { ProviderRegistry } from '../core/registry';
import { Repository } from '../core/repository';
import { createChromeLocalStore } from '../core/store';
import { KickAdapter } from '../providers/kick/adapter';
import { TwitchAdapter } from '../providers/twitch/adapter';
import { createHttpClient } from '../core/http';
import { BUILD_CONFIG } from '../manifest';
import { createBrokerHttpClient } from './broker-client';
import { createLogger } from '../core/logging';

import { NotificationService, type NotificationApi } from '../core/notifications';
import { ChannelTracker } from '../core/tracking';
import { registerMessageApi, type MessageApiDeps } from './messages';

/**
 * Service-worker composition root.
 *
 * Everything is rebuilt from scratch on each wake, because an MV3 worker may be
 * terminated at any point; only the repository's contents survive. That is why the
 * detection engine persists its decisions instead of holding them in memory.
 */
const logger = createLogger('background');
const http = createHttpClient(fetch, BUILD_CONFIG.twitchClientId);

const twitch = new TwitchAdapter({
  http,
  // Helix needs the numeric user id, which is resolved once when the account is
  // connected and then read back from the account itself.
  resolveUserId: (account) => {
    if (!account.providerUserId) throw new Error('twitch account is missing its user id');
    return account.providerUserId;
  },
});

const kick = new KickAdapter({
  http,
  // Kick keys its livestream endpoint by numeric channel id, which is what a
  // tracked channel's id holds. The slug is display data kept on the channel row.
  resolveUserId: (_account, channelId) => channelId,
  resolveSlug: async (account, channelId) => {
    const channel = await repository.channel('kick', account.accountId, channelId);
    if (!channel) throw new Error(`kick channel ${channelId} is not tracked`);
    return channel.handle;
  },
});

const registry = new ProviderRegistry().register(twitch).register(kick);
const repository = new Repository(createChromeLocalStore());

const accounts = new AccountManager({
  repository,
  broker: createBrokerHttpClient({ baseUrl: BUILD_CONFIG.brokerOrigin }),
  clock: systemClock,
  clientIds: {
    twitch: BUILD_CONFIG.twitchClientId,
    kick: BUILD_CONFIG.kickClientId,
  },
  // launchWebAuthFlow returns to any extension URL; the broker validates the
  // exact value against its redirect allowlist before exchanging a code.
  redirectUri: chrome.identity.getRedirectURL(''),
  identify: async (providerId, credentials) => {
    // Kick's own API answers with the channel and slug, so the tracked channel row
    // is resolved at add time instead; nothing extra is needed at connect.
    if (providerId !== 'twitch') return {};
    const body = await http.get<{ data?: Array<{ id: string; login: string }> }>(
      'https://api.twitch.tv/helix/users',
      { accessToken: credentials.accessToken, clientId: BUILD_CONFIG.twitchClientId },
    );
    const user = body.data?.[0];
    return user ? { providerUserId: user.id, displayName: user.login } : {};
  },
});

const scheduler = alarmScheduler(ALARM_NAME, systemClock);
const tracker = new ChannelTracker(repository, systemClock);

/**
 * `chrome.notifications` narrowed to the operations this service needs.
 *
 * The installed `@types/chrome` still declares these as callback-only, while
 * Chrome 117+ returns a promise when no callback is passed. Both shapes are
 * handled so the extension works on the runtime it ships to without the types
 * having caught up.
 */
/**
 * `requestPermission` and the promise overloads are missing from the installed
 * `@types/chrome`. They exist in Chrome 114+, which is the minimum this extension
 * targets, so the surface is declared here rather than worked around at each call.
 */
type NotificationsWithPermission = typeof chrome.notifications & {
  requestPermission(callback: (level: string) => void): void;
};
const notificationsApi = chrome.notifications as NotificationsWithPermission;

const callbackOrPromise = <T>(
  invoke: (callback: (value: T) => void) => unknown,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let result: unknown;
    try {
      result = invoke(finish);
    } catch (error) {
      settled = true;
      reject(error);
      return;
    }
    if (result && typeof (result as Promise<T>).then === 'function') {
      void (result as Promise<T>).then(finish, (error: unknown) => {
        settled = true;
        reject(error);
      });
    }
  });

const notificationApi: NotificationApi = {
  permission: () =>
    callbackOrPromise<'granted' | 'denied' | 'default'>((done) => {
      notificationsApi.getPermissionLevel((level) => done(level as 'granted' | 'denied' | 'default'));
    }),
  requestPermission: () =>
    callbackOrPromise<'granted' | 'denied'>((done) => {
      notificationsApi.requestPermission((level) => done(level as 'granted' | 'denied'));
    }),
  async create(notificationId, options) {
    try {
      const created = await callbackOrPromise<string | undefined>((done) => {
        chrome.notifications.create(
          notificationId,
          options as chrome.notifications.NotificationOptions<true>,
          (id) => done(id),
        );
      });
      return created ?? notificationId;
    } catch {
      return undefined;
    }
  },
  async clear(notificationId) {
    try {
      return await callbackOrPromise<boolean>((done) => {
        chrome.notifications.clear(notificationId, (wasCleared) => done(wasCleared));
      });
    } catch {
      return false;
    }
  },
};

const notifications = new NotificationService({
  repository,
  api: notificationApi,
  // The label comes from the adapter, so a new platform needs no change here.
  platformLabel: (providerId) => registry.get(providerId).displayName,
});

const detection = new LiveDetectionService({
  registry,
  repository,
  accounts,
  scheduler,
  clock: systemClock,
  streamUrlFor: (providerId, channelId, displayName) => {
    const adapter = registry.get(providerId);
    return adapter.publicStreamUrl({ channelId, displayName, accountId: '' });
  },
  onWentLive: async (notice) => {
    await notifications.raise(notice, notice.category);
  },
});

async function tick(): Promise<void> {
  await detection.pollAll();
  // A failed query may leave a channel tracked that the schedule does not know
  // about yet, so the schedule is re-evaluated after every tick.
  await detection.syncSchedule();
}

// Starting the alarm is left to the detection service, which knows whether any
// channel is tracked at all. Starting it unconditionally would keep a one-minute
// wakeup alive in an installation with nothing to poll (task 9.1).
chrome.runtime.onInstalled.addListener(() => {
  void detection.syncSchedule();
});

chrome.runtime.onStartup.addListener(() => {
  void detection.syncSchedule();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void tick();
});

// The notification id is recorded in history, so the click target survives the
// worker being terminated between the alert appearing and the user clicking it.
registerMessageApi(chrome as unknown as Parameters<typeof registerMessageApi>[0], {
  repository,
  registry,
  accounts,
  tracker,
  detection,
  clock: systemClock,
  notificationPermission: () => notificationApi.permission(),
  setUnofficialImportPermissions: async (enabled) => {
    // The website origin and the cookie API are optional, so a refusal is an
    // ordinary outcome rather than an error: the opt-in simply stays off.
    if (enabled) {
      return chrome.permissions.request({
        origins: ['https://kick.com/*'],
        permissions: ['cookies'],
      });
    }
    await chrome.permissions.remove({
      origins: ['https://kick.com/*'],
      permissions: ['cookies'],
    });
    return true;
  },
  kickCookie: async () => {
    const granted = await chrome.permissions.contains({
      origins: ['https://kick.com/*'],
      permissions: ['cookies'],
    });
    if (!granted) return undefined;
    const cookie = await chrome.cookies.get({ url: 'https://kick.com/', name: 'auth_token' });
    return cookie?.value;
  },
  connectAccount: async (providerId, existingAccountId) => {
    // Reconnecting reuses the stored account id, so its tracked channels and live
    // state survive the new authorization instead of starting over.
    logger.debug('connectAccount called', { providerId, hasExisting: Boolean(existingAccountId) });
    const existing = existingAccountId
      ? await repository.account(providerId, existingAccountId)
      : undefined;
    const { url, state } = await accounts.beginConnect(providerId, existing?.providerUserId);
    logger.debug('beginConnect ok', { providerId, state });
    const redirect = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
    logger.debug('launchWebAuthFlow result', { hasRedirect: Boolean(redirect) });
    if (!redirect) throw new Error('Authorization did not complete');
    const params = new URL(redirect).searchParams;
    const code = params.get('code');
    const returnedState = params.get('state');
    const error = params.get('error');
    logger.debug('redirect params', { hasCode: Boolean(code), hasState: Boolean(returnedState), error });
    if (error && !code) {
      const msg = `Kick authorization failed: ${error}`;
      logger.error(msg, { error });
      throw new Error(msg);
    }
    await accounts.completeConnect({
      state: returnedState ?? undefined,
      code: code ?? undefined,
    });
    logger.debug('connectAccount complete', { providerId });
  },
} satisfies MessageApiDeps);

chrome.notifications.onClicked.addListener((notificationId) => {
  void (async () => {
    const url = await notifications.handleClick(notificationId);
    if (url) await chrome.tabs.create({ url });
  })();
});
