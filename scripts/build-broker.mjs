import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, '..', 'broker', 'dist');

await rm(outdir, { recursive: true, force: true });

await build({
  entryPoints: [path.join(root, '..', 'broker', 'src', 'server.ts')],
  outfile: path.join(outdir, 'server.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'warning',
});

console.log(`built token-broker at ${outdir}`);
