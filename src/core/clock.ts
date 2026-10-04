/**
 * Injected time source. Nothing in core calls `Date.now()` directly, so tests can
 * advance time deterministically instead of sleeping.
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export type TimerHandle = number | ReturnType<typeof setTimeout>;

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Manually advanced clock for tests. */
export function createTestClock(startMs = 0): Clock & { advance(ms: number): Promise<void> } {
  let current = startMs;
  const timers: Array<{ at: number; fn: () => void; seq: number }> = [];
  let seq = 0;

  return {
    now: () => current,
    setTimeout(fn, ms) {
      const timer = { at: current + ms, fn, seq: seq++ };
      timers.push(timer);
      return timer.seq;
    },
    clearTimeout(handle) {
      const index = timers.findIndex((t) => t.seq === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = timers
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = due[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        current = Math.max(current, next.at);
        next.fn();
        // Let any promise continuations the callback triggered settle.
        await Promise.resolve();
        await Promise.resolve();
      }
      current = target;
      await Promise.resolve();
    },
  };
}
