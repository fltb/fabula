#!/usr/bin/env node
// ============================================================================
// Build CLI package with esbuild
// ============================================================================

import { build } from 'esbuild';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const outdir = join(root, 'dist');
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [join(root, 'src/index.ts'), join(root, 'src/mcp-server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outdir,
  sourcemap: true,
  external: [
    'node:*',
    'commander',
    '@novalistically/core',
  ],
  logLevel: 'info',
});

// Make CLI entry executable
chmodSync(join(outdir, 'index.js'), 0o755);

console.log('✅ CLI bundle built to', outdir);
