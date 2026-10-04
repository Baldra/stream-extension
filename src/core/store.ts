import { redact } from './redact';

/**
 * A minimal, synchronous-capable async key/value store matching the surface of
 * `chrome.storage.local` that the extension uses. Tests inject a plain Map.
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  getMany(keys: string[]): Promise<unknown[]>;
}

export function createMemoryStore(initial: Record<string, unknown> = {}): KeyValueStore {
  const map = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const read = (key: string) => {
    const raw = map.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
  };
  return {
    async get<T>(key: string) {
      return read(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      map.set(key, JSON.stringify(value));
    },
    async remove(key: string) {
      map.delete(key);
    },
    async getMany(keys: string[]) {
      return keys.map((key) => read(key));
    },
  };
}

export const createChromeLocalStore = (): KeyValueStore => {
  const area = () => chrome.storage.local;
  return {
    async get<T>(key: string) {
      return (await area().get(key))[key] as T | undefined;
    },
    async set(key: string, value: unknown) {
      await area().set({ [key]: value });
    },
    async remove(key: string) {
      await area().remove(key);
    },
    async getMany(keys: string[]) {
      return area().get(keys) as Promise<unknown[]>;
    },
  };
};
