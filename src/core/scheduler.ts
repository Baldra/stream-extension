import type { Clock, TimerHandle } from './clock';

/**
 * Recurring scheduler abstraction over `chrome.alarms`.
 *
 * Detection must survive arbitrary service-worker termination, so it is driven by
 * a browser-persisted alarm rather than an in-worker interval. Core depends on this
 * interface instead of `chrome.alarms` so the poll loop is testable without a
 * browser (design.md decision 2).
 */
export interface Scheduler {
  /** Start (or restart) the recurring schedule. */
  start(periodMs: number, onTick: () => void | Promise<void>): void;
  /** Stop the schedule. Safe to call when not started. */
  stop(): void;
  /** Run onTick immediately, outside the schedule. */
  runNow(): Promise<void>;
  isRunning(): boolean;
}

export const alarmScheduler = (name: string, clock: Clock): Scheduler => {
  let onTick: (() => void | Promise<void>) | null = null;
  let running = false;

  const fire = async (): Promise<void> => {
    if (!onTick) return;
    try {
      await onTick();
    } catch (error) {
      // A throwing tick must not tear down the schedule: the next alarm still fires
      // and backoff inside the poller handles the failure.
      console.error('[scheduler] tick failed', error);
    }
  };

  return {
    start(periodMs, tick) {
      onTick = tick;
      running = true;
      const periodInMinutes = periodMs / 60_000;
      // chrome.alarms.get resolves asynchronously and always returns a Promise, so
      // it can never be compared to undefined synchronously. Creating an alarm that
      // already exists would reset its phase and could starve detection, so the
      // check is awaited: only create when nothing is registered.
      void Promise.resolve(chrome.alarms.get(name)).then((existing) => {
        if (!existing) {
          chrome.alarms.create(name, {
            periodInMinutes,
            delayInMinutes: periodInMinutes,
          });
        }
      });
    },
    stop() {
      chrome.alarms.clear(name);
      running = false;
    },
    async runNow() {
      await fire();
    },
    isRunning() {
      return running;
    },
  };
};

/** Fully manual scheduler for tests: ticks only when asked. */
export function createTestScheduler(): Scheduler & { tick(): Promise<void>; starts(): number } {
  let onTick: (() => void | Promise<void>) | null = null;
  let startCalls = 0;

  return {
    start(_periodMs, tick) {
      onTick = tick;
      startCalls += 1;
    },
    stop() {
      onTick = null;
    },
    async runNow() {
      await onTick?.();
    },
    isRunning() {
      return onTick !== null;
    },
    async tick() {
      await onTick?.();
    },
    starts() {
      return startCalls;
    },
  };
}

export type { TimerHandle };
