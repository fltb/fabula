#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = join(__dirname, 'dist');
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

const result = await build({
  entryPoints: [join(__dirname, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node26',
  format: 'esm',
  outdir,
  entryNames: '[name]',
  sourcemap: true,
  metafile: true,
  external: ['node:*', '@novalistically/core', '@earendil-works/*', 'yaml'],
  logLevel: 'info',
});

const metaPath = join(outdir, 'meta.json');
writeFileSync(
  metaPath,
  JSON.stringify(
    {
      inputs: result.metafile.inputs,
      outputs: result.metafile.outputs,
      warnings: result.warnings,
    },
    null,
    2,
  ),
);
console.log('Node Host bundles built to', outdir);
