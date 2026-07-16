#!/usr/bin/env node
// ============================================================================
// Build bench package with esbuild
// ============================================================================

import { build } from 'esbuild';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = join(__dirname, 'dist');
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [join(__dirname, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: join(outdir, 'index.js'),
  sourcemap: true,
  external: [
    'node:*',
    '@novalistically/core',
    'tinybench',
  ],
  logLevel: 'info',
});

console.log('✅ Bench bundle built to', join(outdir, 'index.js'));
