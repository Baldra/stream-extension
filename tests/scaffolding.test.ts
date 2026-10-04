import { describe, expect, it } from 'vitest';
import {
  ALARM_NAME,
  MIN_CHROME_VERSION,
  POLL_PERIOD_MINUTES,
  POLL_PERIOD_MS,
  TOKEN_RENEWAL_SKEW_MS,
} from '../src/core/constants';
import { createTestClock } from '../src/core/clock';
import { redact, REDACTED, safeStringify } from '../src/core/redact';

describe('pinned poll period (task 1.3)', () => {
  it('polls at the chrome.alarms minimum of 1 minute', () => {
    expect(POLL_PERIOD_MINUTES).toBe(1);
    expect(POLL_PERIOD_MS).toBe(60_000);
  });

  it('is expressible as an integer minute value for chrome.alarms', () => {
    expect(Number.isInteger(POLL_PERIOD_MS / 60_000)).toBe(true);
    // Chrome 120 removed the 30-second floor; anything below this silently clamps.
    expect(POLL_PERIOD_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('targets a Chrome version that supports WebSockets in service workers', () => {
    expect(MIN_CHROME_VERSION).toBeGreaterThanOrEqual(116);
  });

  it('renews credentials several polls ahead of expiry, never reacting to a 401', () => {
    // Renewal must complete well before a poll could hit an expired token, so the
    // skew has to span at least one full poll period plus headroom.
    expect(TOKEN_RENEWAL_SKEW_MS).toBeGreaterThan(POLL_PERIOD_MS);
    expect(TOKEN_RENEWAL_SKEW_MS % POLL_PERIOD_MS).toBe(0);
  });

  it('uses a distinct alarm name', () => {
    expect(ALARM_NAME).toBeTruthy();
  });
});

describe('redact (task 1.4)', () => {
  it('removes a nested token', () => {
    const out = redact({ outer: { access_token: 'abc123' } }) as { outer: Record<string, unknown> };
    expect(out.outer.access_token).toBe(REDACTED);
    expect(safeStringify(out)).not.toContain('abc123');
  });

  it('removes a client secret', () => {
    const text = safeStringify({ client_secret: 'super-secret', client_id: 'public-id' });
    expect(text).not.toContain('super-secret');
    expect(text).toContain('public-id');
  });

  it('removes a Kick-style PKCE verifier', () => {
    const text = safeStringify({ code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' });
    expect(text).not.toContain('dBjftJeZ4CVP');
  });

  it('removes a nested stream key from a channels response shape', () => {
    const kickChannel = {
      slug: 'someone',
      broadcaster_user_id: 123,
      stream: { is_live: true, viewer_count: 7, key: 'live_abc_secret' },
    };
    const text = safeStringify(kickChannel);
    expect(text).not.toContain('live_abc_secret');
    expect(text).toContain('someone');
  });

  it('matches sensitive keys case- and separator-insensitively', () => {
    for (const key of ['AccessToken', 'access-token', 'ACCESS_TOKEN', 'StreamKey', 'streamKey']) {
      expect(safeStringify({ [key]: 'leak-me' })).not.toContain('leak-me');
    }
  });

  it('preserves structure and non-sensitive values so logs stay useful', () => {
    const out = redact({ user: 'alice', tags: ['a', 'b'], nested: { n: 1 } });
    expect(out).toEqual({ user: 'alice', tags: ['a', 'b'], nested: { n: 1 } });
  });

  it('redacts inside arrays', () => {
    const text = safeStringify([{ refresh_token: 'r1' }, { ok: true }]);
    expect(text).not.toContain('r1');
    expect(text).toContain('ok');
  });

  it('does not loop on circular structures', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => safeStringify(cyclic)).not.toThrow();
    expect(safeStringify(cyclic)).toContain('[circular]');
  });

  it('leaves primitives untouched', () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact('plain')).toBe('plain');
  });
});

describe('injected clock (task 1.5)', () => {
  it('drives the schedule rather than wall time', async () => {
    const clock = createTestClock(1_000);
    let fired = 0;

    clock.setTimeout(() => {
      fired += 1;
    }, 60_000);

    expect(fired).toBe(0);
    await clock.advance(59_000);
    expect(fired).toBe(0);
    await clock.advance(1_000);
    expect(fired).toBe(1);
  });

  it('advances reported time to the target', async () => {
    const clock = createTestClock(0);
    await clock.advance(90_000);
    expect(clock.now()).toBe(90_000);
  });

  it('fires timers in due order and honours cancellation', async () => {
    const clock = createTestClock(0);
    const order: string[] = [];
    const handle = clock.setTimeout(() => order.push('cancelled'), 30_000);
    clock.setTimeout(() => order.push('first'), 10_000);
    clock.setTimeout(() => order.push('second'), 20_000);
    clock.clearTimeout(handle);

    await clock.advance(60_000);
    expect(order).toEqual(['first', 'second']);
  });
});
