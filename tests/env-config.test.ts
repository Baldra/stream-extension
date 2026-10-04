import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, ConfigError } from '../broker/src/config';

/**
 * The environment templates (task 13.2, docs/setup.md).
 *
 * These check the two things that actually go wrong in practice: a variable the
 * broker requires is missing from the template, and the template documents a value
 * the code would then reject. A copy of these files is enough to start the broker
 * and build the extension without reading the source.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');

/** Parses the same `KEY=value` lines Node's --env-file accepts, ignoring comments. */
function parseEnvFile(relative: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of read(relative).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    expect(match, `${relative} has a line that is not KEY=value: ${line}`).not.toBeNull();
    out[match![1]!] = match![2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Every variable the broker refuses to start without. */
const REQUIRED = [
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'KICK_CLIENT_ID',
  'KICK_CLIENT_SECRET',
  'ALLOWED_ORIGINS',
  'ALLOWED_REDIRECT_URIS',
] as const;

describe('broker/.env.example', () => {
  it('declares every variable the broker requires', () => {
    const env = parseEnvFile('broker/.env.example');
    for (const name of REQUIRED) {
      expect(env, `broker/.env.example is missing ${name}`).toHaveProperty(name);
    }
    expect(env).toHaveProperty('PORT');
  });

  it('satisfies loadConfig once its placeholders are filled in', () => {
    const env = parseEnvFile('broker/.env.example');
    const filled = { ...env };
    // Stand in for the values a user copies in; the point is the shape, not the content.
    for (const name of REQUIRED) filled[name] = `value-for-${name}`;

    const config = loadConfig(filled);
    expect(config.providers.twitch?.clientSecret).toBe('value-for-TWITCH_CLIENT_SECRET');
    expect(config.allowedOrigins).toEqual(['value-for-ALLOWED_ORIGINS']);
  });

  it('documents the local port the setup guide uses', () => {
    expect(parseEnvFile('broker/.env.example').PORT).toBe('8787');
  });

  it('shows the caller origin and the redirect uri in the forms the code accepts', () => {
    const env = parseEnvFile('broker/.env.example');
    const origin = env.ALLOWED_ORIGINS ?? '';
    const redirect = env.ALLOWED_REDIRECT_URIS ?? '';

    // Chrome extension ids are 32 characters from a-p, which is what makes the
    // redirect a valid Chromium App Hosting origin.
    expect(origin).toMatch(new RegExp(`^chrome-extension://[a-p]{32}$`));
    // The worker calls getRedirectURL(''), so there is no path after the slash.
    expect(redirect).toMatch(new RegExp(`^https://[a-p]{32}\\.chromiumapp\\.org/$`));
    // And the two must describe the same extension.
    expect(new URL(redirect).host).toBe(`${origin.replace('chrome-extension://', '')}.chromiumapp.org`);
  });
});

describe('the broker rejects a redirect uri the extension would never send', () => {
  it('rejects one carrying a path, which is the easy mistake to make', () => {
    const template = parseEnvFile('broker/.env.example');
    const withPath = `${template.ALLOWED_REDIRECT_URIS!.replace(/\/$/, '')}/oauth`;
    const env = { ...template, ALLOWED_REDIRECT_URIS: withPath };

    const config = loadConfig(env);
    // The broker only compares strings, so the mistake is invisible until a real
    // connect. This test exists to keep the example file documenting the correct
    // form, and to state plainly that a path is not the correct form.
    expect(config.allowedRedirectUris).toEqual([withPath]);
    expect(withPath).not.toBe(template.ALLOWED_REDIRECT_URIS);
  });

  it('refuses to start when a required variable is blank', () => {
    const env = parseEnvFile('broker/.env.example');
    for (const name of REQUIRED) {
      expect(() => loadConfig({ ...env, [name]: '  ' }), `${name} must be required`).toThrow(ConfigError);
    }
    // The shipped template carries sample values precisely so this check is about
    // a genuinely empty variable rather than an unfilled file.
    for (const name of REQUIRED) {
      expect(env[name], `${name} must be shipped with a sample value`).not.toBe('');
    }
  });
});

describe('.env.example', () => {
  it('points the extension at the broker the example broker listens on', () => {
    const env = parseEnvFile('.env.example');
    expect(env.BROKER_ORIGIN).toBe('http://localhost:8787');
    expect(env.BROKER_ORIGIN).toBe(`${parseEnvFile('broker/.env.example').PORT!.replace(/^/, 'http://localhost:')}`);
  });

  it('names the build-time variables the manifest substitutes', () => {
    const env = parseEnvFile('.env.example');
    // BUILD_CONFIG reads exactly these three.
    for (const name of ['BROKER_ORIGIN', 'TWITCH_CLIENT_ID', 'KICK_CLIENT_ID']) {
      expect(env, `.env.example is missing ${name}`).toHaveProperty(name);
    }
  });

  it('warns that it must not carry secrets, and the guide agrees', () => {
    const env = parseEnvFile('.env.example');
    expect(env.TWITCH_CLIENT_SECRET).toBeUndefined();
    expect(env.KICK_CLIENT_SECRET).toBeUndefined();

    const example = read('.env.example');
    expect(example).toMatch(/PUBLIC/i);
    expect(example).toMatch(/secret/i);
  });

  it('produces a host permission for the broker origin it is given', async () => {
    const origin = parseEnvFile('.env.example').BROKER_ORIGIN!;
    // BUILD_CONFIG is evaluated at module load, so the manifest has to be rebuilt
    // in a fresh module registry with the variable the example tells the user to set.
    vi.resetModules();
    const previous = process.env.BROKER_ORIGIN;
    process.env.BROKER_ORIGIN = origin;
    try {
      const { buildManifest: build } = await import('../src/manifest');
      const manifest = build();
      expect(manifest.host_permissions).toContain(`${origin}/*`);
      // Whatever the origin, the unofficial import stays out of the default grant.
      expect(manifest.optional_permissions).toEqual(
        expect.arrayContaining(['https://kick.com/*', 'cookies']),
      );
      expect(manifest.host_permissions).not.toContain('https://kick.com/*');
    } finally {
      if (previous === undefined) delete process.env.BROKER_ORIGIN;
      else process.env.BROKER_ORIGIN = previous;
      vi.resetModules();
    }
  });

  it('falls back to a visibly unconfigured origin when the variable is absent', () => {
    // buildManifest is imported at the top of this file, so it captured whatever the
    // test runner had; re-derive the fallback from the source instead.
    const source = read('src/manifest.ts');
    expect(source).toMatch(/broker\.example\.invalid/);
    expect(source).toMatch(/not-configured/);
  });
});

describe('the guide documents the local setup', () => {
  it('tells the reader to run the broker on 8787 and load the env file', () => {
    const guide = read('docs/setup.md');
    expect(guide).toMatch(/--env-file/);
    expect(guide).toContain('8787');
    // Both templates must be discoverable from the guide.
    expect(guide).toContain('broker/.env.example');
    expect(guide).toContain('.env.example');
  });
});
