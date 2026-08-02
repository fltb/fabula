#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';

const root = dirname(new URL(import.meta.url).pathname);
const outdir = resolve(root, 'dist/host');
mkdirSync(outdir, { recursive: true });

const result = await build({
  entryPoints: [
    // Browser-safe contract barrel (package "exports" target).
    resolve(root, 'src/contracts/index.ts'),
    // Host server entry: listener lifecycle + facade.
    resolve(root, 'src/host/server.ts'),
    // Host listener module: server.ts imports it and bundle:false keeps
    // imports external, so it must be emitted as its own entry point.
    resolve(root, 'src/host/listener.ts'),
  ],
  bundle: false,
  platform: 'node',
  target: 'node26',
  format: 'esm',
  outdir,
  outbase: resolve(root, 'src'),
  sourcemap: true,
  metafile: true,
  logLevel: 'info',
});

writeFileSync(resolve(outdir, 'meta.json'), JSON.stringify({
  inputs: result.metafile.inputs,
  outputs: result.metafile.outputs,
  warnings: result.warnings,
}, null, 2));
