import { afterEach, describe, expect, it, vi } from 'vitest';
import { alarmScheduler, createTestScheduler } from '../src/core/scheduler';
import { createTestClock } from '../src/core/clock';
import { ALARM_NAME } from '../src/core/constants';

/**
 * A chrome.alarms stub shaped like the real MV3 API, where `get` and `clear`
 * return Promises. Chrome 117+ promisified most extension APIs, so a synchronous
 * comparison against their result is always `false` -- the classic bug being an
 * alarm that is re-created on every service-worker wake, resetting its phase.
 */
function promiseAlarmsStub(initial: Record<string, unknown> = {}) {
  const existing: Record<string, unknown> = { ...initial };
  const created: Array<{ name: string; info: Record<string, number> }> = [];
  const cleared: string[] = [];

  const stub = {
    alarms: {
      get: (name: string) => Promise.resolve(existing[name]),
      create: (name: string, info: Record<string, number>) => {
        created.push({ name, info });
        existing[name] = { name, ...info };
      },
      clear: (name: string) => {
        cleared.push(name);
        delete existing[name];
        return Promise.resolve(true);
      },
      onAlarm: { addListener: () => {} },
    },
  };

  return { stub, created, cleared };
}

/**
 * The stub has to stay installed until the scheduler's internal `get().then(...)`
 * settles, so an async body cannot simply be wrapped in try/finally.
 */
const withChrome = async <T>(stub: unknown, run: () => T | Promise<T>): Promise<T> => {
  vi.stubGlobal('chrome', stub);
  try {
    return await run();
  } finally {
    vi.unstubAllGlobals();
  }
};

/** Lets the scheduler's internal `get().then(...)` settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('alarm scheduler against the promisified chrome.alarms API', () => {
  it('creates the alarm when none exists, even though get resolves later', async () => {
    const { stub, created } = promiseAlarmsStub();
    await withChrome(stub, () => {
      alarmScheduler(ALARM_NAME, createTestClock(0)).start(60_000, () => {});
    });
    await settle();

    expect(created).toHaveLength(1);
    expect(created[0]?.info).toEqual({ periodInMinutes: 1, delayInMinutes: 1 });
  });

  it('does not re-create an alarm that already exists', async () => {
    const { stub, created } = promiseAlarmsStub({ [ALARM_NAME]: { name: ALARM_NAME, periodInMinutes: 1 } });
    await withChrome(stub, () => {
      alarmScheduler(ALARM_NAME, createTestClock(0)).start(60_000, () => {});
    });
    await settle();

    expect(created).toEqual([]);
  });

  it('still reports as running while the existence check is in flight', async () => {
    const { stub } = promiseAlarmsStub();
    let wasRunningBefore: boolean | undefined;
    await withChrome(stub, () => {
      const scheduler = alarmScheduler(ALARM_NAME, createTestClock(0));
      wasRunningBefore = scheduler.isRunning();
      scheduler.start(60_000, () => {});
      expect(scheduler.isRunning()).toBe(true);
    });
    await settle();
    expect(wasRunningBefore).toBe(false);
  });

  it('creates the alarm again after a stop, since none is registered', async () => {
    const { stub, created, cleared } = promiseAlarmsStub();
    await withChrome(stub, () => {
      const scheduler = alarmScheduler(ALARM_NAME, createTestClock(0));
      scheduler.start(60_000, () => {});
      scheduler.stop();
    });
    await settle();
    expect(cleared).toEqual([ALARM_NAME]);
    // The cleared alarm is gone, so a later worker generation re-creates it.
    await withChrome(stub, () => {
      alarmScheduler(ALARM_NAME, createTestClock(0)).start(60_000, () => {});
    });
    await settle();

    expect(created).toHaveLength(1);
  });

  it('keeps the schedule alive when a tick throws', async () => {
    const { stub } = promiseAlarmsStub();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let ticks = 0;

    await withChrome(stub, async () => {
      const scheduler = alarmScheduler(ALARM_NAME, createTestClock(0));
      scheduler.start(60_000, () => {
        ticks += 1;
        throw new Error('poll failed');
      });
      await scheduler.runNow();
      // A failing poll must not tear down the schedule.
      await scheduler.runNow();
    });

    expect(ticks).toBe(2);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('test scheduler', () => {
  it('ticks only when asked and counts starts', async () => {
    const scheduler = createTestScheduler();
    let ticks = 0;
    scheduler.start(60_000, () => {
      ticks += 1;
    });

    expect(scheduler.isRunning()).toBe(true);
    expect(ticks).toBe(0);
    await scheduler.tick();
    await scheduler.runNow();
    expect(ticks).toBe(2);
    expect(scheduler.starts()).toBe(1);

    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
    await scheduler.tick();
    expect(ticks).toBe(2);
  });
});
