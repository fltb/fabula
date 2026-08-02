#!/usr/bin/env node

// ============================================================================
// Bundle check — validates esbuild metafiles, warning count, expected outputs,
// and built CLI help.  Offline and deterministic.
// ============================================================================

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const packages = [
  {
    name: 'core',
    dir: 'packages/core',
    outputs: [
      'index.js',
      'index.js.map',
      'source.js',
      'source.js.map',
      'schema.js',
      'schema.js.map',
      'extensions.js',
      'extensions.js.map',
      'editorial.js',
      'editorial.js.map',
      'tooling.js',
      'tooling.js.map',
      'testing.js',
      'testing.js.map',
    ],
  },
  { name: 'bench', dir: 'packages/bench', outputs: ['index.js', 'index.js.map'] },
  {
    name: 'cli',
    dir: 'packages/cli',
    outputs: ['index.js', 'index.js.map', 'mcp-server.js', 'mcp-server.js.map'],
  },
];

let allOk = true;
const validatedMetafiles = new Map();

console.log('═══════════════════════════════════════════════');
console.log('  Bundle Check Report');
console.log('═══════════════════════════════════════════════\n');

function ok(msg) {
  console.log(`  ✅ ${msg}`);
}
function fail(msg) {
  console.log(`  ❌ ${msg}`);
  allOk = false;
}

// ── 1. Metafile validation ────────────────────────────────────────────
console.log('── Metafile validation ──');

for (const pkg of packages) {
  const metaPath = join(root, pkg.dir, 'dist', 'meta.json');
  if (!existsSync(metaPath)) {
    fail(`${pkg.name}: metafile not found at dist/meta.json`);
    continue;
  }
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch (e) {
    fail(`${pkg.name}: metafile is not valid JSON — ${e.message}`);
    continue;
  }
  if (!meta.inputs || typeof meta.inputs !== 'object') {
    fail(`${pkg.name}: metafile missing 'inputs'`);
    continue;
  }
  if (!meta.outputs || typeof meta.outputs !== 'object') {
    fail(`${pkg.name}: metafile missing 'outputs'`);
    continue;
  }
  validatedMetafiles.set(pkg.name, meta);

  const inputCount = Object.keys(meta.inputs).length;
  const outputCount = Object.keys(meta.outputs).length;
  ok(`${pkg.name}: ${inputCount} inputs, ${outputCount} outputs`);

  // ── 1b. Core source must stay external for bench and cli ──
  if (pkg.name === 'bench' || pkg.name === 'cli') {
    for (const key of Object.keys(meta.inputs)) {
      if (key.includes('packages/core/src') || /packages[\\/]core[\\/]src/.test(key)) {
        fail(
          `${pkg.name}: metafile contains Core source input ${key} — Core subpaths must remain external`,
        );
      }
    }
  }

  // ── 1a. Warning check ──
  const warns = meta.warnings || [];
  if (warns.length > 0) {
    fail(`${pkg.name}: ${warns.length} build warning(s)`);
    for (const w of warns) {
      console.log(`       ${w.text || JSON.stringify(w)}`);
    }
  } else {
    ok(`${pkg.name}: 0 warnings`);
  }
}

// ── 2. Expected output files ─────────────────────────────────────────
console.log('\n── Expected outputs ──');

for (const pkg of packages) {
  const distDir = join(root, pkg.dir, 'dist');
  for (const outFile of pkg.outputs) {
    const fpath = join(distDir, outFile);
    if (!existsSync(fpath)) {
      fail(`${pkg.name}: missing expected output ${outFile}`);
    } else {
      const size = readFileSync(fpath).length;
      ok(`${pkg.name}: ${outFile} (${size} bytes)`);
    }
  }
}

// ── 2a. Stale top-level runtime artifacts ─────────────────────────────
console.log('\n── Stale runtime artifacts ──');

for (const pkg of packages) {
  const distDir = join(root, pkg.dir, 'dist');
  const meta = validatedMetafiles.get(pkg.name);
  if (!meta) continue;
  const outputPrefix = `${pkg.dir.replaceAll('\\', '/')}/dist/`;
  const declaredRuntimeOutputs = new Set(
    Object.keys(meta.outputs)
      .map((output) => output.replaceAll('\\', '/'))
      .filter((output) => output.startsWith(outputPrefix))
      .map((output) => output.slice(outputPrefix.length)),
  );

  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      (entry.name.endsWith('.js') || entry.name.endsWith('.js.map')) &&
      !declaredRuntimeOutputs.has(entry.name)
    ) {
      fail(`${pkg.name}: stale runtime artifact ${entry.name} is not in dist/meta.json`);
    }
  }
}

// ── 2a. Core subpath runtime namespaces ───────────────────────────────
console.log('\n── Core subpath runtime namespaces ──');

const coreManifest = JSON.parse(readFileSync(join(root, 'public-api.manifest.json'), 'utf-8'));
const coreEntries = coreManifest.packages?.['@novalistically/core']?.entries;

// Entry key in the manifest -> built file in packages/core/dist.
// ./extensions is type-only: its manifest values are empty and the built
// module must expose zero runtime keys — the generic assertion covers it.
const coreNamespaces = [
  { entry: './source', file: 'source.js' },
  { entry: '.', file: 'index.js' },
  { entry: './schema', file: 'schema.js' },
  { entry: './extensions', file: 'extensions.js' },
  { entry: './editorial', file: 'editorial.js' },
  { entry: './tooling', file: 'tooling.js' },
  { entry: './testing', file: 'testing.js' },
];

for (const { entry, file } of coreNamespaces) {
  const entryRecord = coreEntries?.[entry];
  if (!entryRecord) {
    fail(`core ${entry}: no entry in public-api.manifest.json`);
    continue;
  }
  const expected = [...(entryRecord.values ?? [])].sort();
  try {
    const namespace = await import(pathToFileURL(join(root, 'packages/core/dist', file)).href);
    const actual = Object.keys(namespace).sort();
    if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
      const missing = expected.filter((k) => !actual.includes(k));
      const extra = actual.filter((k) => !expected.includes(k));
      fail(
        `core ${entry}: runtime namespace mismatch` +
          (missing.length ? ` — missing ${missing.join(', ')}` : '') +
          (extra.length ? ` — extra ${extra.join(', ')}` : ''),
      );
    } else {
      ok(`core ${entry}: runtime namespace matches manifest (${actual.length} values)`);
    }
  } catch (e) {
    fail(`core ${entry}: failed to import ${file} — ${e.message}`);
  }
}

// ── 3. CLI help output ────────────────────────────────────────────────
console.log('\n── CLI --help check ──');

const cliPath = join(root, 'packages/cli/dist/index.js');
if (existsSync(cliPath)) {
  try {
    const helpText = execSync(`node "${cliPath}" --help 2>&1`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    if (helpText.includes('--help') || helpText.includes('Usage') || helpText.includes('Options')) {
      ok('CLI --help produces expected output');
    } else {
      fail('CLI --help output does not contain expected markers');
    }
    // Print first 10 lines as sanity
    const lines = helpText.trim().split('\n').slice(0, 10);
    console.log(`     First lines: ${lines[0]}`);
    if (lines.length > 1) console.log(`                   ${lines[1]}`);
  } catch (e) {
    fail(`CLI --help execution failed: ${e.message}`);
  }
} else {
  fail('CLI index.js not found — cannot test --help');
}

console.log(`\n═══════════════════════════════════════════════`);
if (allOk) {
  console.log('  ✅ Bundle check PASSED');
  console.log('═══════════════════════════════════════════════\n');
  process.exit(0);
} else {
  console.log('  ❌ Bundle check FAILED');
  console.log('═══════════════════════════════════════════════\n');
  process.exit(1);
}
