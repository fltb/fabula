#!/usr/bin/env node

// ============================================================================
// Build CLI package with esbuild
// ============================================================================

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const outdir = join(root, 'dist');
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

const result = await build({
  entryPoints: [join(root, 'src/index.ts'), join(root, 'src/mcp-server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node26',
  format: 'esm',
  outdir,
  sourcemap: true,
  metafile: true,
  external: ['node:*', 'commander', '@novalistically/core', '@novalistically/node-host'],
  logLevel: 'info',
});

// Make CLI entry executable
chmodSync(join(outdir, 'index.js'), 0o755);

const metaPath = join(outdir, 'meta.json');
const meta = {
  inputs: result.metafile.inputs,
  outputs: result.metafile.outputs,
  warnings: result.warnings,
};
writeFileSync(metaPath, JSON.stringify(meta, null, 2));
console.log('📊 Metafile written to', metaPath);
console.log('✅ CLI bundle built to', outdir);
