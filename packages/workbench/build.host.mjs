#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';

const root = dirname(new URL(import.meta.url).pathname);
const outdir = resolve(root, 'dist/host');
mkdirSync(outdir, { recursive: true });

const result = await build({
  entryPoints: [
    // Browser-safe contract barrel (package "exports" target): pure type
    // re-exports only, so the bundled output is a dependency-free module.
    resolve(root, 'src/contracts/index.ts'),
    // Host server entry: listener lifecycle + facade. Bundling inlines its
    // listener/Yjs imports, so no separate listener entry is emitted.
    resolve(root, 'src/host/server.ts'),
    // Authenticated Streamable MCP attachment: explicit entry so the Host
    // composition layer can import the production endpoint after bundling.
    resolve(root, 'src/host/mcp/index.ts'),
    // Host process entry: runnable `start:host` target (node dist/host/host/main.js).
    resolve(root, 'src/host/main.ts'),
  ],
  // Bundle the complete Workbench-internal module graph (host/, persistence/
  // clients, contracts/) into each emitted entry: relative imports are
  // inlined, so Node never resolves them against missing dist source files,
  // and any unresolvable internal import fails the build instead of
  // surfacing as a runtime error.
  bundle: true,
  // Keep installed packages (hono, ws, yjs, @novalistically/*, ...) as
  // external runtime imports; only Workbench-internal modules are bundled.
  packages: 'external',
  // Node 26 Host runtime (package engines ">=26.5.0 <27"): node:* builtins
  // stay external and package "exports" resolve with Node conditions.
  platform: 'node',
  target: 'node26',
  format: 'esm',
  outdir,
  outbase: resolve(root, 'src'),
  sourcemap: true,
  metafile: true,
  logLevel: 'info',
});

writeFileSync(
  resolve(outdir, 'meta.json'),
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
