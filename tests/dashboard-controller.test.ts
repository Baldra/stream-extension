import { describe, expect, it, vi } from 'vitest';
import {
  createPopupController,
  parseAction,
  type ActionElement,
  type PopupApi,
  type PopupViewState,
} from '../src/popup/controller';
const el = (dataset: Record<string, string | undefined>, extra: Partial<ActionElement> = {}): ActionElement => ({
  dataset,
  ...extra,
});

const capabilities = (followedChannels: boolean) => ({
  followedChannels,
  followedStreams: followedChannels,
  manualChannelEntry: true,
  unofficialFollowImport: !followedChannels,
  supportsMultipleAccounts: true,
  realtimeEvents: false,
});

const state = (overrides: Partial<PopupViewState> = {}): PopupViewState => ({
  dashboard: { accounts: [], live: [], history: [], hasHistory: false, notUpdatingPlatforms: [] },
  platforms: [
    { id: 'twitch', displayName: 'Twitch', capabilities: capabilities(true) },
    { id: 'kick', displayName: 'Kick', capabilities: capabilities(false) },
  ],
  unofficialImportEnabled: false,
  notificationsGranted: true,
  notificationsEnabledFor: ['twitch', 'kick'],
  ...overrides,
});

function api(overrides: Partial<PopupApi> = {}): PopupApi {
  return {
    load: vi.fn(async () => state()),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    addChannel: vi.fn(async () => {}),
    removeChannel: vi.fn(async () => {}),
    importFollows: vi.fn(async () => {}),
    setNotificationsEnabled: vi.fn(async () => {}),
    setUnofficialImportEnabled: vi.fn(async () => {}),
    runUnofficialImport: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  };
}

describe('parseAction', () => {
  it('ignores elements that are not dashboard controls', () => {
    expect(parseAction(el({}))).toBeNull();
    expect(parseAction(el({ action: 'unknown', provider: 'twitch' }))).toBeNull();
  });

  it('ignores a control with no provider', () => {
    expect(parseAction(el({ action: 'disconnect', account: 't1' }))).toBeNull();
  });

  it('parses connect with and without an account', () => {
    expect(parseAction(el({ action: 'connect', provider: 'twitch' }))).toEqual({
      kind: 'connect',
      providerId: 'twitch',
    });
    expect(parseAction(el({ action: 'connect', provider: 'twitch', account: 't1' }))).toEqual({
      kind: 'connect',
      providerId: 'twitch',
      accountId: 't1',
    });
  });

  it('parses account-scoped actions', () => {
    expect(parseAction(el({ action: 'disconnect', provider: 'kick', account: 'k1' }))).toEqual({
      kind: 'disconnect',
      providerId: 'kick',
      accountId: 'k1',
    });
    expect(
      parseAction(el({ action: 'remove-channel', provider: 'twitch', account: 't1', channel: 'c1' })),
    ).toEqual({ kind: 'remove-channel', providerId: 'twitch', accountId: 't1', channelId: 'c1' });
    expect(parseAction(el({ action: 'import-follows', provider: 'twitch', account: 't1' }))).toEqual({
      kind: 'import-follows',
      providerId: 'twitch',
      accountId: 't1',
    });
  });

  it('parses a notification toggle from its checked state', () => {
    const off = { action: 'toggle-notifications', provider: 'twitch' };
    expect(parseAction(el(off, { checked: false }))).toEqual({
      kind: 'toggle-notifications',
      providerId: 'twitch',
      enabled: false,
    });
    expect(parseAction(el(off, { checked: true }))).toEqual({
      kind: 'toggle-notifications',
      providerId: 'twitch',
      enabled: true,
    });
  });

  it('trims the handle and rejects an empty one', () => {
    const form = el({ action: 'add-channel', provider: 'twitch', account: 't1' }, { value: '  alpha  ' });
    expect(parseAction(form)).toEqual({
      kind: 'add-channel',
      providerId: 'twitch',
      accountId: 't1',
      handle: 'alpha',
    });
    expect(parseAction(el({ action: 'add-channel', provider: 'twitch', account: 't1' }, { value: '  ' }))).toBeNull();
  });

  it('rejects an action missing its account', () => {
    expect(() => parseAction(el({ action: 'disconnect', provider: 'twitch' }))).toThrow(
      /Missing account/,
    );
  });
});

describe('controller', () => {
  it('renders current state on refresh without polling', async () => {
    const load = vi.fn(async () => state());
    const render = vi.fn();
    const controller = createPopupController({ api: api({ load }), render });

    await controller.refresh();

    expect(render).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reports a failed load instead of leaving the popup on its loading state', async () => {
    // start() discards refresh()'s promise, so a rejection here used to become an
    // unhandled rejection: no banner, no render, just "Loading..." forever.
    const onError = vi.fn();
    const render = vi.fn();
    const load = vi.fn(async () => {
      throw new Error('The background sent a response the popup cannot read.');
    });
    const controller = createPopupController({ api: api({ load }), render, onError });

    await controller.refresh();

    expect(onError).toHaveBeenCalledWith('The background sent a response the popup cannot read.');
    expect(render).not.toHaveBeenCalled();
  });

  it('reports a failure from the initial load started by start()', async () => {
    const onError = vi.fn();
    const load = vi.fn(async () => {
      throw new Error('The extension background is not responding');
    });
    const controller = createPopupController({ api: api({ load }), render: vi.fn(), onError });

    const stop = controller.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    stop();
  });

  it('dispatches each action to the right call', async () => {
    const calls = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      addChannel: vi.fn(async () => {}),
      removeChannel: vi.fn(async () => {}),
      importFollows: vi.fn(async () => {}),
      setNotificationsEnabled: vi.fn(async () => {}),
    setUnofficialImportEnabled: vi.fn(async () => {}),
    runUnofficialImport: vi.fn(async () => {}),
    };
    const controller = createPopupController({ api: api(calls), render: vi.fn() });

    await controller.handleClick(el({ action: 'connect', provider: 'twitch' }));
    await controller.handleClick(el({ action: 'disconnect', provider: 'kick', account: 'k1' }));
    await controller.handleClick(
      el({ action: 'remove-channel', provider: 'twitch', account: 't1', channel: 'c1' }),
    );
    await controller.handleClick(el({ action: 'import-follows', provider: 'twitch', account: 't1' }));
    await controller.handleToggle(el({ action: 'toggle-notifications', provider: 'kick' }, { checked: false }));

    const form = el({ action: 'add-channel', provider: 'twitch', account: 't1' }, { value: 'alpha' });
    await controller.handleSubmit(form);

    expect(calls.connect).toHaveBeenCalledWith('twitch', undefined);
    expect(calls.disconnect).toHaveBeenCalledWith('kick', 'k1');
    expect(calls.removeChannel).toHaveBeenCalledWith('twitch', 't1', 'c1');
    expect(calls.importFollows).toHaveBeenCalledWith('twitch', 't1');
    expect(calls.setNotificationsEnabled).toHaveBeenCalledWith('kick', false);
    expect(calls.addChannel).toHaveBeenCalledWith('twitch', 't1', 'alpha');
    expect(form.value).toBe('');
  });

  it('re-renders after every action', async () => {
    const render = vi.fn();
    const controller = createPopupController({ api: api(), render });

    await controller.handleClick(el({ action: 'connect', provider: 'twitch' }));
    await controller.handleClick(el({ action: 'disconnect', provider: 'twitch', account: 't1' }));

    expect(render).toHaveBeenCalledTimes(2);
  });

  it('ignores clicks on non-controls', async () => {
    const disconnect = vi.fn(async () => {});
    const controller = createPopupController({ api: api({ disconnect }), render: vi.fn() });

    await controller.handleClick(el({ href: 'https://example.com' }));

    expect(disconnect).not.toHaveBeenCalled();
  });

  it('ignores a submit from an unrelated form', async () => {
    const addChannel = vi.fn(async () => {});
    const controller = createPopupController({ api: api({ addChannel }), render: vi.fn() });

    await controller.handleSubmit(el({ action: 'something-else' }, { value: 'x' }));

    expect(addChannel).not.toHaveBeenCalled();
  });

  it('reports a failure and still re-renders the current state', async () => {
    const onError = vi.fn();
    const disconnect = vi.fn(async () => {
      throw new Error('disconnect failed');
    });
    const controller = createPopupController({ api: api({ disconnect }), render: vi.fn(), onError });

    await controller.handleClick(el({ action: 'disconnect', provider: 'twitch', account: 't1' }));

    expect(onError).toHaveBeenCalledWith('disconnect failed');
  });

  it('does not let one failure block later actions', async () => {
    const disconnect = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const connect = vi.fn(async () => {});
    const controller = createPopupController({ api: api({ disconnect, connect }), render: vi.fn() });

    await controller.handleClick(el({ action: 'disconnect', provider: 'twitch', account: 't1' }));
    await controller.handleClick(el({ action: 'connect', provider: 'twitch' }));

    expect(connect).toHaveBeenCalled();
  });

  it('runs the unofficial import for the named account', async () => {
    const runUnofficialImport = vi.fn(async () => {});
    const controller = createPopupController({ api: api({ runUnofficialImport }), render: vi.fn() });

    await controller.handleClick(
      el({ action: 'unofficial-import', provider: 'kick', account: 'k1' }),
    );

    expect(runUnofficialImport).toHaveBeenCalledWith('kick', 'k1');
  });

  it('turns the unofficial import on and off', async () => {
    const setUnofficialImportEnabled = vi.fn(async () => {});
    const controller = createPopupController({ api: api({ setUnofficialImportEnabled }), render: vi.fn() });

    // The opt-in is extension-wide, so its control carries no provider.
    await controller.handleToggle(el({ action: 'toggle-unofficial-import' }, { checked: true }));
    await controller.handleToggle(el({ action: 'toggle-unofficial-import' }, { checked: false }));

    expect(setUnofficialImportEnabled.mock.calls).toEqual([[true], [false]]);
  });

  it('reports an unavailable unofficial import without claiming success', async () => {
    const onError = vi.fn();
    const runUnofficialImport = vi.fn(async () => {
      throw new Error('The unofficial follow import is unavailable. Tracked channels were not changed.');
    });
    const render = vi.fn();
    const controller = createPopupController({ api: api({ runUnofficialImport }), render, onError });

    await controller.handleClick(
      el({ action: 'unofficial-import', provider: 'kick', account: 'k1' }),
    );

    expect(onError).toHaveBeenCalledWith(
      'The unofficial follow import is unavailable. Tracked channels were not changed.',
    );
    // A failure is reported and nothing is re-rendered, so the view keeps showing
    // the tracked set the user already had.
    expect(render).not.toHaveBeenCalled();
  });

  it('serialises overlapping actions', async () => {
    const order: string[] = [];
    const connect = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('connect');
    });
    const disconnect = vi.fn(async () => {
      order.push('disconnect');
    });
    const controller = createPopupController({ api: api({ connect, disconnect }), render: vi.fn() });

    await Promise.all([
      controller.handleClick(el({ action: 'connect', provider: 'twitch' })),
      controller.handleClick(el({ action: 'disconnect', provider: 'twitch', account: 't1' })),
    ]);

    // The slow first action finishes before the second one starts.
    expect(order).toEqual(['connect', 'disconnect']);
  });

  it('re-renders when state changes elsewhere while open', async () => {
    let notify: (() => void) | undefined;
    const subscribe = vi.fn((cb: () => void) => {
      notify = cb;
      return () => {
        notify = undefined;
      };
    });
    const render = vi.fn();
    const controller = createPopupController({ api: api({ subscribe }), render });

    const stop = controller.start();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));

    notify?.();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));

    stop();
    notify?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(render).toHaveBeenCalledTimes(2);
  });
});
