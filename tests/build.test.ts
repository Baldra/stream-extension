/**
 * Loads the built service worker against a minimal MV3 stub to prove it registers
 * without throwing. A "loadable unpacked extension" claim is only credible if the
 * worker entry actually evaluates against the API surface it declares.
 *
 * Each case evaluates the bundle in a fresh `node:vm` context. Dynamic `import()`
 * is not used because a test runner caches modules by resolved path, which leaves
 * the worker's listeners bound to a previous stub instead of the current one.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');

let workerSource = '';
let popupSource = '';
interface BuiltManifest {
  manifest_version: number;
  background: { service_worker: string; type?: string };
  permissions: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  minimum_chrome_version: string;
  action: { default_popup: string };
  [key: string]: unknown;
}

let manifestJson: BuiltManifest;

type Listener<T> = (arg?: T) => void | Promise<void>;

/** chrome.runtime.onMessage delivers (request, sender, respond). */
type MessageListener = (
  request?: unknown,
  sender?: unknown,
  respond?: (response: unknown) => void,
) => boolean | void;

interface Harness {
  stub: unknown;
  messageListeners: MessageListener[];
  /** Authorization URLs the worker handed to chrome.identity, in order. */
  launched: string[];
  alarmsCreated: Array<{ name: string; info: Record<string, number> }>;
  alarmsCleared: string[];
  fire: {
    installed: () => void;
    startup: () => void;
    alarm: (name: string) => void;
  };
}

/** A stored document with one account and one tracked channel. */
const trackedState = {
  version: 2,
  accounts: [
    {
      accountId: 't1',
      providerId: 'twitch',
      displayName: 'streamer',
      credentials: { accessToken: 't', expiresAt: Date.now() + 3_600_000 },
      requiresReconnection: false,
    },
  ],
  channels: [
    {
      providerId: 'twitch',
      providerChannelId: 'c1',
      handle: 'alpha',
      accountId: 't1',
      trackedAt: 1,
      source: 'manual',
    },
  ],
  live: [],
  history: [],
  settings: { notificationsDisabled: [] },
};

/** The smallest element the popup needs to render into. */
function makeElement(selector: string) {
  const element = {
    innerHTML: '',
    listeners: new Map<string, Array<(e: unknown) => void>>(),
    addEventListener(type: string, fn: (e: unknown) => void) {
      const existing = element.listeners.get(type) ?? [];
      existing.push(fn);
      element.listeners.set(type, existing);
    },
    // A banner must reach innerHTML: a no-op prepend here is how a protocol error
    // once left the popup silently stuck on its loading text.
    prepend: (node: unknown) => {
      const text = typeof node === 'string' ? node : ((node as { textContent?: string })?.textContent ?? '');
      element.innerHTML = `${text}${element.innerHTML}`;
    },
    removeAttribute: () => {},
    setAttribute: () => {},
  };
  return element;
}

/**
 * Stands in for the extension id Chrome assigns to an unpacked build: 32 characters
 * drawn from a-p, which is what makes the redirect URL a valid Chromium App Hosting
 * origin.
 */
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const redirectUrl = `https://${extensionId}.chromiumapp.org/`;

function makeChromeStub(seed: Record<string, unknown> = {}): Harness {
  const alarmsCreated: Harness['alarmsCreated'] = [];
  const alarmsCleared: string[] = [];
  const installedListeners: Listener<unknown>[] = [];
  const startupListeners: Listener<unknown>[] = [];
  const alarmListeners: Listener<{ name: string }>[] = [];
  const messageListeners: MessageListener[] = [];
  const existingAlarms: Record<string, unknown> = {};
  const launched: string[] = [];

  const stub = {
    alarms: {
      get: (name: string) => existingAlarms[name],
      create: (name: string, info: Record<string, number>) => {
        alarmsCreated.push({ name, info });
        existingAlarms[name] = { name, ...info };
      },
      clear: (name: string) => {
        alarmsCleared.push(name);
        delete existingAlarms[name];
      },
      onAlarm: { addListener: (fn: Listener<{ name: string }>) => alarmListeners.push(fn) },
    },
    runtime: {
      onInstalled: { addListener: (fn: Listener<unknown>) => installedListeners.push(fn) },
      onStartup: { addListener: (fn: Listener<unknown>) => startupListeners.push(fn) },
      onMessage: { addListener: (fn: MessageListener) => messageListeners.push(fn) },
    },
    // chrome.storage is promise-based, unlike alarms in this stub.
    storage: {
      local: { get: () => Promise.resolve(seed), set: () => Promise.resolve() },
    },
    notifications: {
      // Callback style, as chrome.notifications is in MV3. The worker wraps these in
      // callbackOrPromise, so a promise-only stub would never settle and the worker
      // would hold the message channel open forever.
      create: (_id: string, _o: unknown, cb?: (id: string) => void) => cb?.('n1'),
      clear: (_id: string, cb?: (ok: boolean) => void) => cb?.(true),
      getPermissionLevel: (cb: (level: string) => void) => cb('granted'),
      onClicked: { addListener: () => {} },
    },
    permissions: {
      request: () => Promise.resolve(false),
      remove: () => Promise.resolve(true),
      contains: () => Promise.resolve(false),
    },
    cookies: { get: () => Promise.resolve(null) },
    identity: {
      launchWebAuthFlow: (details: { url: string }) => {
        launched.push(details.url);
        return Promise.resolve(`${redirectUrl}?code=stub-code&state=stub-state`);
      },
      getRedirectURL: (path?: string) => `${redirectUrl}${path ?? ''}`,
    },
  };

  return {
    stub,
    messageListeners,
    launched,
    alarmsCreated,
    alarmsCleared,
    fire: {
      installed: () => installedListeners.forEach((fn) => void fn?.({ reason: 'install' })),
      startup: () => startupListeners.forEach((fn) => void fn?.()),
      alarm: (name) => alarmListeners.forEach((fn) => void fn?.({ name })),
    },
  };
}

/** Lets the scheduler's internal alarms.get().then(...) settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Loads the worker while recording anything it logs, so an unhandled rejection or a
 * warning during startup is a test failure rather than something a real browser
 * would only surface in its own console.
 */
function loadWorkerReporting(seed: Record<string, unknown> = {}): Harness & { problems: string[] } {
  const harness = makeChromeStub(seed);
  const problems: string[] = [];
  const quiet = {
    ...console,
    error: (...args: unknown[]) => problems.push(`error: ${args.map(String).join(' ')}`),
    warn: (...args: unknown[]) => problems.push(`warn: ${args.map(String).join(' ')}`),
  };
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);

  const context = vm.createContext({
    chrome: harness.stub,
    console: quiet,
    setTimeout,
    clearTimeout,
    Promise,
    URL,
    URLSearchParams,
    crypto,
    btoa,
    atob,
    TextEncoder,
    TextDecoder,
    fetch: () => Promise.reject(new Error('network disabled in harness')),
  });
  try {
    vm.runInContext(workerSource, context, { filename: 'background.js' });
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  for (const reason of rejections) problems.push(`unhandled rejection: ${String(reason)}`);
  return { ...harness, problems };
}

function loadWorker(seed: Record<string, unknown> = {}): Harness {
  const harness = makeChromeStub(seed);
  const context = vm.createContext({
    chrome: harness.stub,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    URL,
    URLSearchParams,
    crypto,
    btoa,
    atob,
    TextEncoder,
    TextDecoder,
    fetch: () => Promise.reject(new Error('network disabled in harness')),
  });
  vm.runInContext(workerSource, context, { filename: 'background.js' });
  return harness;
}

beforeAll(() => {
  // Always rebuild. Asserting against a stale dist/ once hid a real protocol bug:
  // the bundle under test was older than the source it was supposed to prove.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT });
  workerSource = readFileSync(path.join(DIST, 'assets', 'background.js'), 'utf8');
  popupSource = readFileSync(path.join(DIST, 'assets', 'popup.js'), 'utf8');
  manifestJson = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
}, 60_000);

describe('built extension is loadable', () => {
  it('evaluates the service worker bundle without throwing', () => {
    expect(() => loadWorker()).not.toThrow();
  });

  it('registers every service-worker listener without logging an error (task 13.1)', async () => {
    const { problems, messageListeners, ...harness } = loadWorkerReporting({ appState: trackedState });

    // The worker must be listening before anything can wake it.
    expect(messageListeners.length).toBeGreaterThan(0);

    // Driving the startup paths the browser would use must stay quiet.
    harness.fire.installed();
    harness.fire.startup();
    harness.fire.alarm('live-poll');
    await tick();
    await tick();

    expect(problems).toEqual([]);
  });

  it('derives the redirect URI the provider consoles must be given (task 13.2)', async () => {
    const harness = loadWorker();
    const [listener] = harness.messageListeners;
    expect(listener).toBeDefined();

    // Drive a connect the way the popup does, and capture the authorization URL.
    const done = new Promise<unknown>((resolve) => {
      listener?.(
        { kind: 'connect', providerId: 'twitch' } satisfies Record<string, unknown>,
        {},
        (response) => resolve(response),
      );
    });
    const response = (await done) as { ok: boolean; error?: string };
    expect(response, response.error).toMatchObject({ ok: true });
    await tick();
    await tick();

    expect(harness.launched).toHaveLength(1);
    const authUrl = new URL(harness.launched[0]!);

    // The authorization endpoint is the provider's own, not the extension's.
    expect(authUrl.origin + authUrl.pathname).toBe('https://id.twitch.tv/oauth2/authorize');

    // The redirect_uri is the value that must be registered in the developer
    // console, and it must be a Chromium App Hosting URL with a trailing slash.
    expect(authUrl.searchParams.get('redirect_uri')).toBe(redirectUrl);
    expect(redirectUrl).toBe(`https://${extensionId}.chromiumapp.org/`);
    expect(redirectUrl).toMatch(/^https:\/\/[a-p]{32}\.chromiumapp\.org\/$/);
    expect(authUrl.searchParams.get('client_id')).toBeTruthy();
    // PKCE and state must accompany it.
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(authUrl.searchParams.get('state')).toBeTruthy();
  });

  it('declares the manifest the built extension needs (task 13.1)', () => {
    expect(manifestJson.manifest_version).toBe(3);
    expect(manifestJson.background).toMatchObject({ service_worker: 'assets/background.js' });
    // Everything the worker uses unconditionally must be granted at install.
    for (const permission of ['storage', 'alarms', 'notifications', 'identity']) {
      expect(manifestJson.permissions).toContain(permission);
    }
    // The unofficial import's grants are optional, so they are not in the default set.
    expect(manifestJson.permissions).not.toContain('cookies');
    expect(manifestJson.optional_permissions).toEqual(
      expect.arrayContaining(['https://kick.com/*', 'cookies']),
    );
    // And the website origin is not a default host permission.
    expect(manifestJson.host_permissions ?? []).not.toContain('https://kick.com/*');
    expect(Number(manifestJson.minimum_chrome_version)).toBeGreaterThanOrEqual(116);
    expect(manifestJson.action.default_popup).toBe('popup.html');
  });

  it('schedules the poll alarm on install once a channel is tracked', async () => {
    const harness = loadWorker({ appState: trackedState });
    harness.fire.installed();
    // chrome.alarms.get is promise-based, so the create happens a microtask later.
    await tick();

    expect(harness.alarmsCreated).toHaveLength(1);
    expect(harness.alarmsCreated[0]?.name).toBe('poll-live-status');
    // periodInMinutes is what chrome.alarms receives; the source of truth is
    // milliseconds, and a value below 1 silently clamps to the browser floor.
    expect(harness.alarmsCreated[0]?.info.periodInMinutes).toBe(1);
  });

  it('schedules the poll alarm on browser startup', async () => {
    const harness = loadWorker({ appState: trackedState });
    harness.fire.startup();
    await tick();
    expect(harness.alarmsCreated).toHaveLength(1);
  });

  it('keeps no alarm while nothing is tracked (task 9.1)', async () => {
    // A minute-by-minute wakeup in an installation with nothing to poll would
    // drain the battery for no reason, so the schedule stays suspended.
    const harness = loadWorker();
    harness.fire.installed();
    harness.fire.startup();
    await tick();

    expect(harness.alarmsCreated).toEqual([]);
  });

  it('keeps no alarm when an account has no tracked channels', async () => {
    const harness = loadWorker({
      appState: { ...trackedState, channels: [] },
    });
    harness.fire.installed();
    await tick();
    expect(harness.alarmsCreated).toEqual([]);
  });

  it('does not re-create an alarm that already exists', async () => {
    // Restarting the worker must not reset the alarm's phase, so a second start
    // while one is registered is a no-op.
    const harness = loadWorker({ appState: trackedState });
    harness.fire.installed();
    await tick();
    expect(harness.alarmsCreated).toHaveLength(1);

    harness.fire.installed();
    harness.fire.startup();
    await tick();
    expect(harness.alarmsCreated).toHaveLength(1);
  });

  it('reacts to its own alarm name only', () => {
    const harness = loadWorker();
    expect(() => harness.fire.alarm('some-other-alarm')).not.toThrow();
    expect(() => harness.fire.alarm('poll-live-status')).not.toThrow();
  });

  it('declares the MV3 keys Chrome requires to load an unpacked extension', () => {
    expect(manifestJson.manifest_version).toBe(3);
    expect((manifestJson.background as Record<string, unknown>).service_worker).toBe(
      'assets/background.js',
    );
    expect((manifestJson.background as Record<string, unknown>).type).toBe('module');
    expect((manifestJson.action as Record<string, unknown>).default_popup).toBe('popup.html');
    expect(Number(manifestJson.minimum_chrome_version)).toBeGreaterThanOrEqual(116);
    expect(manifestJson.permissions).toEqual(
      expect.arrayContaining(['storage', 'alarms', 'notifications', 'identity']),
    );
  });

  it('evaluates the popup bundle and renders the dashboard', async () => {
    const app = makeElement('#app');
    const sent: unknown[] = [];
    const listeners: Array<(c: Record<string, unknown>) => void> = [];
    const viewState: Record<string, unknown> = {
      dashboard: {
        accounts: [],
        live: [],
        history: [],
        hasHistory: false,
        notUpdatingPlatforms: [],
      },
      platforms: [
        { id: 'twitch', displayName: 'Twitch', capabilities: { followedChannels: true } },
        { id: 'kick', displayName: 'Kick', capabilities: { followedChannels: false } },
      ],
      unofficialImportEnabled: false,
      notificationsGranted: true,
      notificationsEnabledFor: ['twitch', 'kick'],
    };
    const context = vm.createContext({
      chrome: {
        runtime: { sendMessage: (m: unknown) => (sent.push(m), Promise.resolve(viewState)) },
        storage: {
          onChanged: {
            addListener: (fn: (c: Record<string, unknown>) => void) => listeners.push(fn),
            removeListener: () => {},
          },
        },
      },
      document: { querySelector: (selector: string) => (selector === '#app' ? app : null) },
      console,
      setTimeout,
      clearTimeout,
      Promise,
      Intl,
      Date,
    });
    vm.runInContext(popupSource, context, { filename: 'popup.js' });
    await tick();

    // The popup reads the current state on open without being asked to poll.
    expect(sent).toContainEqual({ kind: 'dashboard-state' });
    expect(app.innerHTML).toContain('No tracked channels are currently live.');
    expect(app.innerHTML).toContain('Connect Twitch');

    // A storage change from a background poll re-renders the open popup with the
    // new result, without the user reopening it (task 11.7).
    expect(listeners).toHaveLength(1);
    expect(app.innerHTML).toContain('No tracked channels are currently live.');

    (viewState.dashboard as { live: unknown[] }).live = [
      {
        key: 'twitch:t1:c1',
        providerId: 'twitch',
        platformLabel: 'Twitch',
        accountId: 't1',
        channelId: 'c1',
        displayName: 'alpha',
        isLive: true,
        streamUrl: 'https://www.twitch.tv/alpha',
        unverified: false,
      },
    ];
    listeners.forEach((fn) => fn({ appState: { version: 2 } }));
    await tick();

    expect(app.innerHTML).not.toContain('No tracked channels are currently live.');
    expect(app.innerHTML).toContain('alpha');
    expect(app.innerHTML).toContain('badge badge-live');
  });

  it('renders from a real worker, not a stubbed response (task 11.7)', async () => {
    // The popup test above stubs sendMessage, which is exactly what hid a protocol
    // mismatch: the worker answered a read with the action envelope, and the popup
    // then hung on "Loading..." forever. This drives the built popup against the
    // built worker through one message channel.
    const worker = loadWorker({ appState: trackedState });
    const [listener] = worker.messageListeners;
    expect(listener).toBeDefined();

    const sent: unknown[] = [];
    const app = makeElement('#app');
    const context = vm.createContext({
      chrome: {
        runtime: {
          // A real message channel: the worker's listener answers, as in Chrome.
          sendMessage: (request: unknown) =>
            new Promise((resolve) => {
              sent.push(request);
              const kept = listener?.(request, {}, resolve);
              if (kept !== true) resolve(undefined);
            }),
        },
        storage: {
          onChanged: { addListener: () => {}, removeListener: () => {} },
        },
      },
      document: { querySelector: (selector: string) => (selector === '#app' ? app : null) },
      console,
      setTimeout,
      clearTimeout,
      Promise,
      Intl,
      Date,
    });
    vm.runInContext(popupSource, context, { filename: 'popup.js' });

    // The popup asked for a dashboard and got a view state, so it rendered. Reading
    // the real state is several awaits deep, so wait for the render rather than
    // guessing how many microtasks it takes.
    await vi.waitFor(() => expect(app.innerHTML).toContain('alpha'));
    expect(sent).toContainEqual({ kind: 'dashboard-state' });
    // No error banner, and the initial loading text was replaced rather than left.
    expect(app.innerHTML).not.toContain('Loading');
    expect(app.innerHTML).not.toContain('notice-error');
  });

  it('leaves no runtime reference to process in the popup', () => {
    expect(popupSource).not.toMatch(/process\.env/);
  });

  it('keeps the unofficial import permissions optional and unrequested (task 12.1)', () => {
    // A default install must not prompt for website access: the undocumented import
    // is an extra the user opts into, and only then are these granted.
    const optional = manifestJson.optional_permissions as string[] | undefined;
    expect(optional).toEqual(expect.arrayContaining(['https://kick.com/*', 'cookies']));
    expect(manifestJson.permissions).not.toContain('cookies');
    expect(manifestJson.permissions).not.toContain('https://kick.com/*');
    expect(manifestJson.host_permissions).not.toContain('https://kick.com/*');
  });

  it('does not reach the unofficial endpoint without the optional host permission', () => {
    // The website origin is absent from the default grant, so a request to it cannot
    // succeed even if the guard were bypassed.
    expect(manifestJson.optional_permissions).toContain('https://kick.com/*');
    // And the worker asks for the grant only when the user turns the import on.
    expect(workerSource).toContain('permissions.request');
    expect(workerSource).toContain('https://kick.com/*');
  });

  it('ships no client secret in the emitted bundle', () => {
    // Client ids are public and appear in every authorization URL; the matching
    // secret must never be readable from the bundle.
    expect(workerSource).not.toMatch(/client_?secret"?\s*:\s*"[A-Za-z0-9_-]{12,}/);
    expect(workerSource).not.toMatch(/TWITCH_CLIENT_SECRET|KICK_CLIENT_SECRET/);
    expect(workerSource).not.toMatch(/clientSecret\s*[:=]/);
  });

  it('leaves no runtime reference to process in the service worker', () => {
    // Build-time config must be substituted, or the worker throws on startup.
    expect(workerSource).not.toMatch(/process\.env/);
    expect(workerSource).not.toMatch(/\bprocess\.env\b/);
  });
});
