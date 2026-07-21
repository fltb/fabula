#!/usr/bin/env node
// ============================================================================
// Build CLI package with esbuild
// ============================================================================

import { build } from 'esbuild';
import { existsSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const outdir = join(root, 'dist');
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

const result = await build({
  entryPoints: [join(root, 'src/index.ts'), join(root, 'src/mcp-server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outdir,
  sourcemap: true,
  metafile: true,
  external: [
    'node:*',
    'commander',
    '@novalistically/core',
    '@novalistically/bench',
  ],
  logLevel: 'info',
});

// Make CLI entry executable
chmodSync(join(outdir, 'index.js'), 0o755);

const metaPath = join(outdir, 'meta.json');
const meta = { inputs: result.metafile.inputs, outputs: result.metafile.outputs, warnings: result.warnings };
writeFileSync(metaPath, JSON.stringify(meta, null, 2));
console.log('📊 Metafile written to', metaPath);
console.log('✅ CLI bundle built to', outdir);
