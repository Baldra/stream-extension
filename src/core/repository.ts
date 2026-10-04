import { redactForPersistence } from './redact';
import {
  CURRENT_SCHEMA_VERSION,
  emptyState,
  type NotificationHistoryEntry,
  type PersistedAccount,
  type PersistedChannel,
  type PersistedLiveState,
  type PersistedState,
} from './state';
import type { ProviderId } from './provider';
import { createChromeLocalStore, type KeyValueStore } from './store';

export const STATE_KEY = 'appState';
export const HISTORY_LIMIT = 200;

/**
 * Serialises operations per key (task 4.4). Each key gets its own promise chain
 * so unrelated accounts never block one another, and a rejected operation does
 * not poison the chain for later callers.
 */
export class KeyedMutex {
  readonly #chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    // Swallow the predecessor's rejection so this operation still runs.
    const next = previous.then(operation, operation);
    this.#chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  get pending(): number {
    return this.#chains.size;
  }
}

export class Repository {
  #cache: PersistedState | undefined;
  readonly #accountLocks = new KeyedMutex();
  readonly #documentLock = new KeyedMutex();

  constructor(
    private readonly store: KeyValueStore = createChromeLocalStore(),
    private readonly historyLimit: number = HISTORY_LIMIT,
  ) {}

  /** Reads, or lazily loads from storage. */
  async read(): Promise<PersistedState> {
    if (this.#cache) return this.#cache;
    const stored = await this.store.get<PersistedState>(STATE_KEY);
    this.#cache = stored ? migrate(stored) : emptyState();
    return this.#cache;
  }

  /**
   * Runs a mutation, then persists.
   *
   * Two locks are involved, and both are needed:
   *  - the per-account lock gives task 4.4's guarantee that concurrent work
   *    against one account serialises;
   *  - the document lock makes the read-modify-write of the *shared* state
   *    object atomic. Without it, two accounts mutating concurrently each clone
   *    the same pre-mutation snapshot and the last writer silently drops the
   *    other's change. Both locks are always taken in this order, so there is no
   *    cycle.
   *
   * Redaction happens on the way *out*, after the mutation, so a value the
   * mutation itself introduces cannot reach disk. The account's own OAuth tokens
   * are exempt, since a restarted worker could not poll without them.
   */
  async mutate<T>(lockKey: string, mutation: (state: PersistedState) => T | Promise<T>): Promise<T> {
    return this.#accountLocks.run(lockKey, () =>
      this.#documentLock.run(DOCUMENT_LOCK, async () => {
        const draft = structuredClone(await this.read()) as PersistedState;
        const result = await mutation(draft);
        const state = redactForPersistence(draft);
        state.schemaVersion = CURRENT_SCHEMA_VERSION;
        this.#cache = state;
        await this.store.set(STATE_KEY, state);
        return result;
      }),
    );
  }

  /** Drops the in-memory cache, e.g. after the service worker is revived. */
  invalidate(): void {
    this.#cache = undefined;
  }

  // ---- accounts -----------------------------------------------------------

  async accounts(providerId?: ProviderId): Promise<PersistedAccount[]> {
    const state = await this.read();
    return providerId ? state.accounts.filter((a) => a.providerId === providerId) : state.accounts;
  }

  async account(providerId: ProviderId, accountId: string): Promise<PersistedAccount | undefined> {
    return (await this.accounts(providerId)).find((a) => a.accountId === accountId);
  }

  async putAccount(account: PersistedAccount): Promise<void> {
    await this.mutate(accountKey(account.providerId, account.accountId), (state) => {
      const index = state.accounts.findIndex(
        (a) => a.providerId === account.providerId && a.accountId === account.accountId,
      );
      if (index === -1) state.accounts.push(account);
      else state.accounts[index] = account;
    });
  }

  /** Removes the account plus every channel, live row, and history entry it owns. */
  async removeAccount(providerId: ProviderId, accountId: string): Promise<void> {
    await this.mutate(accountKey(providerId, accountId), (state) => {
      state.accounts = state.accounts.filter(
        (a) => !(a.providerId === providerId && a.accountId === accountId),
      );
      state.channels = state.channels.filter(
        (c) => !(c.providerId === providerId && c.accountId === accountId),
      );
      state.live = state.live.filter((l) => !(l.providerId === providerId && l.accountId === accountId));
      state.history = state.history.filter(
        (h) => !(h.providerId === providerId && h.accountId === accountId),
      );
    });
  }

  // ---- channels -----------------------------------------------------------

  async channels(providerId?: ProviderId, accountId?: string): Promise<PersistedChannel[]> {
    const state = await this.read();
    return state.channels.filter(
      (c) => (!providerId || c.providerId === providerId) && (!accountId || c.accountId === accountId),
    );
  }

  async channel(providerId: ProviderId, accountId: string, channelId: string): Promise<PersistedChannel | undefined> {
    return (await this.channels(providerId, accountId)).find((c) => c.providerChannelId === channelId);
  }

  /**
   * Enforces that a channel belongs to exactly one account (task 4.2): adding it
   * for a second account moves it rather than duplicating it.
   */
  async putChannel(channel: PersistedChannel): Promise<void> {
    await this.mutate(accountKey(channel.providerId, channel.accountId), (state) => {
      state.channels = state.channels.filter(
        (c) => !(c.providerId === channel.providerId && c.providerChannelId === channel.providerChannelId),
      );
      state.channels.push(channel);
    });
  }

  async removeChannel(providerId: ProviderId, accountId: string, channelId: string): Promise<void> {
    await this.mutate(accountKey(providerId, accountId), (state) => {
      state.channels = state.channels.filter(
        (c) => !(c.providerId === providerId && c.providerChannelId === channelId),
      );
      state.live = state.live.filter(
        (l) => !(l.providerId === providerId && l.accountId === accountId && l.channelId === channelId),
      );
    });
  }

  // ---- live state ---------------------------------------------------------

  async liveState(providerId: ProviderId, accountId: string): Promise<PersistedLiveState[]> {
    const state = await this.read();
    return state.live.filter((l) => l.providerId === providerId && l.accountId === accountId);
  }

  async liveChannelIds(providerId: ProviderId, accountId: string): Promise<string[]> {
    return (await this.liveState(providerId, accountId)).map((l) => l.channelId);
  }

  /**
   * The full live rows, which carry the notified flag a channel must keep across
   * polls and the identity of a stream that a partial answer could not refresh.
   */
  async liveRows(providerId: ProviderId, accountId: string): Promise<PersistedLiveState[]> {
    return this.liveState(providerId, accountId);
  }

  async replaceLiveState(providerId: ProviderId, accountId: string, rows: PersistedLiveState[]): Promise<void> {
    await this.mutate(accountKey(providerId, accountId), (state) => {
      state.live = [
        ...state.live.filter((l) => !(l.providerId === providerId && l.accountId === accountId)),
        ...rows,
      ];
    });
  }

  async markNotified(providerId: ProviderId, accountId: string, channelId: string): Promise<void> {
    await this.mutate(accountKey(providerId, accountId), (state) => {
      const row = state.live.find(
        (l) => l.providerId === providerId && l.accountId === accountId && l.channelId === channelId,
      );
      if (row) row.notified = true;
    });
  }

  /**
   * Applies the result of one successful poll in a single write.
   *
   * The live set and the observation stamps must move together: if they were
   * written separately, a worker termination between them would leave channels
   * that look observed but have stale state, and the next poll would either skip
   * a real transition or re-raise one. `observedChannelIds` must contain only
   * channels the platform gave a definitive answer for, never ones that were
   * merely absent from a partial result.
   */
  async applySuccessfulPoll(input: {
    providerId: ProviderId;
    accountId: string;
    liveRows: PersistedLiveState[];
    observedChannelIds: string[];
    at: number;
  }): Promise<void> {
    const { providerId, accountId, liveRows, observedChannelIds, at } = input;
    const observed = new Set(observedChannelIds);
    await this.mutate(accountKey(providerId, accountId), (state) => {
      state.live = [
        ...state.live.filter((l) => !(l.providerId === providerId && l.accountId === accountId)),
        ...liveRows,
      ];
      for (const channel of state.channels) {
        if (channel.providerId !== providerId || channel.accountId !== accountId) continue;
        if (observed.has(channel.providerChannelId)) channel.lastObservedAt = at;
      }
    });
  }

  // ---- settings -----------------------------------------------------------

  /**
   * A platform is enabled unless it is explicitly listed, so adding a platform
   * later does not silently mute it and a v1 state file needs no backfill.
   */
  async notificationsEnabledFor(providerId: ProviderId): Promise<boolean> {
    return !(await this.read()).settings.notificationsDisabled.includes(providerId);
  }

  async setNotificationsEnabled(providerId: ProviderId, enabled: boolean): Promise<void> {
    await this.mutate(`settings:${providerId}`, (state) => {
      const disabled = new Set(state.settings.notificationsDisabled);
      if (enabled) disabled.delete(providerId);
      else disabled.add(providerId);
      state.settings.notificationsDisabled = [...disabled];
    });
  }

  /**
   * The unofficial import opt-in, which is false until the user turns it on.
   *
   * Kept in one place so no caller can read a missing field as permission.
   */
  async unofficialFollowImportEnabled(): Promise<boolean> {
    return (await this.read()).settings.unofficialFollowImportEnabled === true;
  }

  async setUnofficialFollowImportEnabled(enabled: boolean): Promise<void> {
    await this.mutate('settings:unofficial-follow-import', (state) => {
      // Turning it off only stops the import; tracked channels are untouched, so a
      // user can disable it without losing anything they already added.
      state.settings.unofficialFollowImportEnabled = enabled;
    });
  }

  // ---- history ------------------------------------------------------------

  async history(limit = this.historyLimit): Promise<NotificationHistoryEntry[]> {
    return (await this.read()).history.slice(0, limit);
  }

  /** Prepends and discards oldest entries past the limit (task 4.3). */
  async addHistoryEntry(entry: NotificationHistoryEntry): Promise<NotificationHistoryEntry[]> {
    return this.mutate(`history:${entry.providerId}:${entry.accountId}`, (state) => {
      state.history = [entry, ...state.history].slice(0, this.historyLimit);
      return state.history;
    });
  }

  async clearHistory(): Promise<void> {
    await this.mutate('history:*', (state) => {
      state.history = [];
    });
  }

  /** Test/diagnostic helper: the exact bytes that would be written to disk. */
  async serialize(): Promise<string> {
    return JSON.stringify(await this.read());
  }
}

/** Single key for the shared document, as distinct from per-account keys. */
const DOCUMENT_LOCK = 'state:document';

export const accountKey = (providerId: ProviderId, accountId: string): string =>
  `account:${providerId}:${accountId}`;

/** Fills in fields added by later schema versions without dropping user data. */
export function migrate(stored: PersistedState): PersistedState {
  const base = { ...emptyState(), ...stored };
  // Defaults go last so an already-persisted value always wins.
  base.accounts = base.accounts.map((a) => ({ ...a, requiresReconnection: a.requiresReconnection ?? false }));
  base.channels = base.channels.map((c) => ({ ...c, source: c.source ?? 'manual' }));
  // v2 added the per-platform notification switch. State written by v1 has no
  // `settings`, which would otherwise make every read fail on `.disabled`.
  base.settings = {
    notificationsDisabled: [...(base.settings?.notificationsDisabled ?? [])],
    // v3 added the unofficial-import opt-in. Absent means not enabled, which is the
    // only safe default for an unsupported integration.
    unofficialFollowImportEnabled: base.settings?.unofficialFollowImportEnabled ?? false,
  };
  base.schemaVersion = CURRENT_SCHEMA_VERSION;
  return base;
}
