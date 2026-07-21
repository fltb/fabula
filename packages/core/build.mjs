#!/usr/bin/env node
// ============================================================================
// Build core package with esbuild
// ============================================================================

import { build } from 'esbuild';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const outdir = join(root, 'dist');
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

const result = await build({
  entryPoints: [join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: join(outdir, 'index.js'),
  sourcemap: true,
  metafile: true,
  external: [
    'node:*',
    'yaml',
    'zod',
    'better-sqlite3',
    'ai',
    '@ai-sdk/*',
    '@vercel/*',
    'eventsource-parser',
    'json-schema',
    'secure-json-parse',
  ],
  logLevel: 'info',
});

const metaPath = join(outdir, 'meta.json');
const meta = { inputs: result.metafile.inputs, outputs: result.metafile.outputs, warnings: result.warnings };
writeFileSync(metaPath, JSON.stringify(meta, null, 2));
console.log('📊 Metafile written to', metaPath);
console.log('✅ Core bundle built to', join(outdir, 'index.js'));
