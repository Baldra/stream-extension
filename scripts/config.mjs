import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'stream-extension');

/** Output names are pinned: the manifest and popup.html reference them by path. */
export const EXTENSION_ENTRIES = {
  background: path.join(ROOT, 'src/background/index.ts'),
  popup: path.join(ROOT, 'src/popup/main.ts'),
};

/**
 * The manifest is authored in TypeScript so the manifest test can import the same
 * builder, but Node cannot import a .ts file directly. Stage it through esbuild so
 * there is exactly one source of truth rather than a duplicated JSON literal.
 */
async function loadManifestModule() {
  const outfile = path.join(CACHE_DIR, 'manifest.mjs');
  await mkdir(CACHE_DIR, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/manifest.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}

/** Builds a loadable unpacked extension into `outdir`. */
export async function buildExtension(outdir) {
  const { buildManifest } = await loadManifestModule();
  const { writeFile, copyFile, readdir } = await import('node:fs/promises');

  const manifest = buildManifest();
  const assets = path.join(outdir, 'assets');

  await mkdir(assets, { recursive: true });
  await writeFile(path.join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const file of await readdir(PUBLIC_DIR)) {
    await copyFile(path.join(PUBLIC_DIR, file), path.join(outdir, file));
  }

  await esbuild.build({
    entryPoints: EXTENSION_ENTRIES,
    outdir: assets,
    bundle: true,
    format: 'esm',
    target: `chrome${manifest.minimum_chrome_version}`,
    platform: 'browser',
    // Build-time configuration is substituted as a literal, so the service worker
    // never references `process` and cannot throw a ReferenceError at startup.
    define: {
      'process.env.BROKER_ORIGIN': JSON.stringify(process.env.BROKER_ORIGIN ?? ''),
      'process.env.TWITCH_CLIENT_ID': JSON.stringify(process.env.TWITCH_CLIENT_ID ?? ''),
      'process.env.KICK_CLIENT_ID': JSON.stringify(process.env.KICK_CLIENT_ID ?? ''),
    },
    sourcemap: true,
    logLevel: 'warning',
  });

  return { outdir, manifest };
}

export { loadManifestModule };
