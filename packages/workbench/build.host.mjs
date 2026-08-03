#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { arch, platform } from 'node:os';
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
    // Persistence worker entry: real worker_threads target spawned by the
    // Host launch (`new Worker(entry, { workerData })`). The worker module
    // owns DatabaseSync/Kysely; the Host thread only talks typed RPC over
    // the worker's implicit parent port. Emitted at
    // dist/host/persistence/worker.js (outbase = src).
    resolve(root, 'src/persistence/worker.ts'),
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
const outputFiles = Object.keys(result.metafile.outputs)
  .map((outputPath) => relative(outdir, outputPath).split('\\').join('/'))
  .filter((outputPath) => outputPath.length > 0);
const entryPoints = {
  contracts: 'contracts/index.js',
  host: 'host/main.js',
  mcp: 'host/mcp/index.js',
  'persistence-worker': 'persistence/worker.js',
};
const entryByPath = new Map(Object.entries(entryPoints).map(([name, outputPath]) => [outputPath, name]));
const outputs = outputFiles.map((path) => {
  const bytes = readFileSync(resolve(outdir, path));
  return {
    path,
    hash: createHash('sha256').update(bytes).digest('hex'),
    size: statSync(resolve(outdir, path)).size,
    ...(entryByPath.has(path) ? { entryPointFor: entryByPath.get(path) } : {}),
  };
});
const buildId = /^[A-Za-z0-9._-]{1,128}$/.test(process.env.WORKBENCH_BUILD_ID ?? '')
  ? process.env.WORKBENCH_BUILD_ID
  : 'development';
writeFileSync(
  resolve(outdir, 'artifact-manifest.json'),
  JSON.stringify(
    {
      version: 1,
      manifestId: randomUUID(),
      build: {
        version: 1,
        packageId: '@novalistically/workbench',
        buildId,
        protocolVersion: 1,
        nodeVersion: process.versions.node,
        platform: platform(),
        arch: arch(),
      },
      buildTimestamp: new Date().toISOString(),
      outputRoot: outdir,
      outputs,
    },
    null,
    2,
  ),
);
