import { rm } from 'node:fs/promises';
import path from 'node:path';
import { buildExtension, EXTENSION_ENTRIES, PUBLIC_DIR, ROOT } from './config.mjs';

const outdir = path.join(ROOT, 'dist');

await rm(outdir, { recursive: true, force: true });

const { manifest } = await buildExtension(outdir);

console.log(`built unpacked extension at ${outdir}`);
console.log(`  entries:  ${Object.values(EXTENSION_ENTRIES).map((e) => e.replace(`${ROOT}/`, '')).join(', ')}`);
console.log(`  public:   ${PUBLIC_DIR.replace(`${ROOT}/`, '')}`);
console.log(`  min Chrome: ${manifest.minimum_chrome_version}`);
