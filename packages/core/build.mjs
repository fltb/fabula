#!/usr/bin/env node
// ============================================================================
// Build core package with esbuild
// ============================================================================

import { build } from 'esbuild';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const outdir = join(root, 'dist');
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: join(outdir, 'index.js'),
  sourcemap: true,
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

console.log('✅ Core bundle built to', join(outdir, 'index.js'));
