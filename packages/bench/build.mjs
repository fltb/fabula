#!/usr/bin/env node
// ============================================================================
// Build bench package with esbuild
// ============================================================================

import { build } from 'esbuild';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = join(__dirname, 'dist');
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

const result = await build({
  entryPoints: [join(__dirname, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: join(outdir, 'index.js'),
  sourcemap: true,
  metafile: true,
  external: [
    'node:*',
    '@novalistically/core',
    'tinybench',
    'yaml',
  ],
  logLevel: 'info',
});

const metaPath = join(outdir, 'meta.json');
const meta = { inputs: result.metafile.inputs, outputs: result.metafile.outputs, warnings: result.warnings };
writeFileSync(metaPath, JSON.stringify(meta, null, 2));
console.log('📊 Metafile written to', metaPath);
console.log('✅ Bench bundle built to', join(outdir, 'index.js'));
