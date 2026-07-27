#!/usr/bin/env node

// ============================================================================
// Bundle check — validates esbuild metafiles, warning count, expected outputs,
// and built CLI help.  Offline and deterministic.
// ============================================================================

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const packages = [
  { name: 'core', dir: 'packages/core', outputs: ['index.js', 'index.js.map'] },
  { name: 'bench', dir: 'packages/bench', outputs: ['index.js', 'index.js.map'] },
  {
    name: 'cli',
    dir: 'packages/cli',
    outputs: ['index.js', 'index.js.map', 'mcp-server.js', 'mcp-server.js.map'],
  },
];

let allOk = true;

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
  const inputCount = Object.keys(meta.inputs).length;
  const outputCount = Object.keys(meta.outputs).length;
  ok(`${pkg.name}: ${inputCount} inputs, ${outputCount} outputs`);

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
