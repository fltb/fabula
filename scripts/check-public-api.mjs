#!/usr/bin/env node
// ============================================================================
// public-api checker — validates that the declared public API surface
// (public-api.manifest.json) matches the actual source exports.
//
// Checks per package:
//   1. Every declared value export exists in the entry source.
//   2. Every declared type export exists in the entry source.
//   3. Every value export in the entry source is declared (no drift).
//   4. Every type export in the entry source is declared (no drift).
//   5. Declared typeBarrel files exist and export types.
//   6. Declared bin entries reference real files.
//
// Fail-fast: any drift exits non-zero.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// ── utilities ────────────────────────────────────────────────────────────────

function err(msg) {
  console.error(`  ERROR: ${msg}`);
  return false;
}

function ok(msg) {
  console.log(`  OK: ${msg}`);
  return true;
}

// ── export parsing ───────────────────────────────────────────────────────────

/**
 * Extract named exports from a source string.
 * Returns { values: Set<string>, types: Set<string> } covering every
 * top-level export statement found.
 */
function parseNamedExports(source, filePath) {
  const values = new Set();
  const types = new Set();
  const errors = [];

  const lines = source.split('\n');

  // We work line by line building up multi-line export blocks
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // ── export { ... } from '...'  (named value re-export) ──
    if (/^export\s*\{/.test(trimmed) && !/^export\s+type\s*\{/.test(trimmed)) {
      let block = trimmed;
      while (!block.includes('}') && i + 1 < lines.length) {
        i++;
        block += ' ' + lines[i].trim();
      }
      const m = block.match(/^export\s*\{\s*([^}]+)\s*\}\s*(from\s+['"][^'"]+['"]\s*)?;?$/);
      if (m) {
        const names = m[1]
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean);
        for (const n of names) {
          // Handle `A as B` → actual name is B
          const parts = n.split(/\s+as\s+/i);
          const name = parts[parts.length - 1].trim();
          // Handle `type A` or `type { A }` mixed inline type markers
          if (n.startsWith('type ')) {
            types.add(
              n
                .replace(/^type\s+/, '')
                .replace(/\s+as\s+/i, ' ')
                .split(/\s+as\s+/i)
                .pop()
                .trim(),
            );
          } else if (n.match(/^\s*type\s+/)) {
            // another form of inline type marker
          } else {
            values.add(name);
          }
        }
      } else {
        errors.push(`Could not parse export block at line ${i + 1}: ${block.slice(0, 80)}`);
      }
      i++;
      continue;
    }

    // ── export type { ... } from '...'  (named type re-export) ──
    // Also catches `export type { A, B }` without from clause
    if (/^export\s+type\s*\{/.test(trimmed)) {
      let block = trimmed;
      while (!block.includes('}') && i + 1 < lines.length) {
        i++;
        block += ' ' + lines[i].trim();
      }
      const m = block.match(/^export\s+type\s*\{\s*([^}]+)\s*\}\s*(from\s+['"][^'"]+['"]\s*)?;?$/);
      if (m) {
        const names = m[1]
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean);
        for (const n of names) {
          // Handle `A as B` → actual name is B
          const parts = n.split(/\s+as\s+/i);
          types.add(parts[parts.length - 1].trim());
        }
      }
      i++;
      continue;
    }

    // ── export type * from '...'  (type barrel re-export) ──
    // We don't collect individual names from these — the manifest uses
    // typeBarrels to declare them. We just note existence.
    // However, individual declared types that are re-exported through a
    // barrel are verified via resolveTypeFromBarrel() in the main loop.
    if (/^export\s+type\s*\*\s*from/.test(trimmed)) {
      // tracked via typeBarrels, skip
      i++;
      continue;
    }

    // ── export * from '...'  (star value re-export) ──
    if (/^export\s*\*\s*from/.test(trimmed) && !/^export\s+type\s*\*/.test(trimmed)) {
      // capture all exports from the target file — but for a manifest
      // check this is tricky because we'd need full resolution.
      // In this codebase only ai/index.ts uses export *, so we resolve it.
      const m = trimmed.match(/export\s*\*\s*from\s+['"]([^'"]+)['"]\s*;?$/);
      if (m) {
        const resolved = resolveStarExports(m[1], dirname(filePath));
        for (const name of resolved.values) values.add(name);
        for (const name of resolved.types) types.add(name);
      }
      i++;
      continue;
    }

    // ── export function name(… / export async function name(… ──
    {
      const m = trimmed.match(/^export\s+(async\s+)?function\s+(\w+)/);
      if (m) {
        values.add(m[2]);
        i++;
        continue;
      }
    }

    // ── export class name ──
    {
      const m = trimmed.match(/^export\s+class\s+(\w+)/);
      if (m) {
        values.add(m[1]);
        i++;
        continue;
      }
    }

    // ── export const/let/var name ──
    {
      const m = trimmed.match(/^export\s+(const|let|var)\s+(\w+)/);
      if (m) {
        values.add(m[2]);
        i++;
        continue;
      }
    }

    // ── export type name = … (type alias) ──
    {
      const m = trimmed.match(/^export\s+type\s+(\w+)\s*=/);
      if (m) {
        types.add(m[1]);
        i++;
        continue;
      }
    }

    // ── export interface name ──
    {
      const m = trimmed.match(/^export\s+interface\s+(\w+)/);
      if (m) {
        types.add(m[1]);
        i++;
        continue;
      }
    }

    i++;
  }

  return { values, types, errors };
}

/**
 * Handle `export * from './path'` — read the target file and return
 * all its named exports (at one level, no deep chaining).
 */
function resolveStarExports(relPath, baseDir) {
  const targetPath = join(baseDir, relPath);
  let content;
  let resolved;
  try {
    // resolve extension: try .ts, .js, .mjs, then exact
    resolved = targetPath;
    if (!existsSync(resolved)) {
      // if import used .js but source is .ts, try swapping extension
      if (relPath.endsWith('.js')) {
        const tsPath = targetPath.replace(/\.js$/, '.ts');
        if (existsSync(tsPath)) {
          resolved = tsPath;
        }
      }
    }
    if (!existsSync(resolved)) {
      for (const ext of ['.ts', '.js', '.mjs', '']) {
        const candidate = targetPath + ext;
        if (existsSync(candidate)) {
          resolved = candidate;
          break;
        }
        // also try /index.ts etc.
        if (ext === '' && existsSync(join(targetPath, 'index.ts'))) {
          resolved = join(targetPath, 'index.ts');
          break;
        }
        if (ext === '' && existsSync(join(targetPath, 'index.js'))) {
          resolved = join(targetPath, 'index.js');
          break;
        }
      }
    }
    content = readFileSync(resolved, 'utf-8');
  } catch {
    return { values: new Set(), types: new Set() };
  }
  return parseNamedExports(content, resolved);
}

/**
 * Check whether a type name is exported from any of the given typeBarrel files.
 */
function resolveTypeFromBarrel(name, barrelPaths) {
  for (const relPath of barrelPaths) {
    const abs = join(root, relPath);
    if (!existsSync(abs)) continue;
    const source = readFileSync(abs, 'utf-8');
    const { types } = parseNamedExports(source, abs);
    if (types.has(name)) return true;
  }
  return false;
}

/**
 * Verify that a typeBarrel file exists and its first export is a type export.
 */
function checkTypeBarrel(relPath) {
  const abs = join(root, relPath);
  if (!existsSync(abs)) {
    return `typeBarrel file not found: ${relPath}`;
  }
  const content = readFileSync(abs, 'utf-8');
  const firstNonBlank = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'));
  if (!firstNonBlank || !firstNonBlank.startsWith('export type')) {
    return `typeBarrel file ${relPath} does not start with type exports`;
  }
  return null; // ok
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const manifestPath = join(root, 'public-api.manifest.json');
  if (!existsSync(manifestPath)) {
    console.error('FATAL: public-api.manifest.json not found at root');
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (manifest.version !== 1) {
    console.error(`FATAL: unsupported manifest version ${manifest.version}`);
    process.exit(1);
  }

  let allOk = true;
  const packages = manifest.packages;

  console.log('═══════════════════════════════════════════════');
  console.log('  Public API Manifest Check');
  console.log('═══════════════════════════════════════════════\n');

  for (const [pkgName, cfg] of Object.entries(packages)) {
    console.log(`── package: ${pkgName} ──`);

    const entryAbs = join(root, cfg.entry);
    if (!existsSync(entryAbs)) {
      allOk = err(`${pkgName}: entry file ${cfg.entry} not found`);
      continue;
    }

    const source = readFileSync(entryAbs, 'utf-8');
    const {
      values: actualValues,
      types: actualTypes,
      errors: parseErrors,
    } = parseNamedExports(source, entryAbs);

    if (parseErrors.length > 0) {
      for (const pe of parseErrors) {
        allOk = err(`${pkgName}: ${pe}`);
      }
    }

    // Check value exports
    const manifestValues = new Set(cfg.values || []);
    const manifestTypes = new Set(cfg.types || []);
    const barrels = cfg.typeBarrels || [];

    // 1. Declared values that exist in source
    for (const name of manifestValues) {
      if (!actualValues.has(name)) {
        allOk = err(`${pkgName}: declared value "${name}" not found in entry source`);
      }
    }

    // 2. Declared types that exist in source
    //    (with fallback to typeBarrel resolution)
    for (const name of manifestTypes) {
      if (!actualTypes.has(name) && !resolveTypeFromBarrel(name, barrels)) {
        allOk = err(`${pkgName}: declared type "${name}" not found in entry source`);
      }
    }

    // 3. Actual values not in manifest
    for (const name of actualValues) {
      if (!manifestValues.has(name)) {
        allOk = err(
          `${pkgName}: undeclared value export "${name}" in source (add to manifest or make internal)`,
        );
      }
    }

    // 4. Actual types not in manifest
    for (const name of actualTypes) {
      if (!manifestTypes.has(name)) {
        allOk = err(
          `${pkgName}: undeclared type export "${name}" in source (add to manifest or make internal)`,
        );
      }
    }

    // 5. Check typeBarrels exist and are type-only
    for (const barrel of barrels) {
      const barrelErr = checkTypeBarrel(barrel);
      if (barrelErr) {
        allOk = err(`${pkgName}: ${barrelErr}`);
      } else {
        ok(`${pkgName}: typeBarrel ${barrel} verified`);
      }
    }

    // 6. Check bin entries reference real files
    const bin = cfg.bin;
    if (bin) {
      for (const [binName, binPath] of Object.entries(bin)) {
        const absBin = join(root, binPath);
        if (!existsSync(absBin)) {
          allOk = err(`${pkgName}: bin "${binName}" target ${binPath} not found`);
        } else {
          ok(`${pkgName}: bin "${binName}" → ${binPath}`);
        }
      }
    }

    if (manifestValues.size === 0 && manifestTypes.size === 0) {
      ok(`${pkgName}: no declared exports (pass-through verification)`);
    } else {
      ok(`${pkgName}: ${manifestValues.size} values, ${manifestTypes.size} types verified`);
    }

    console.log('');
  }

  // ── Cross-package checks ──────────────────────────────────────────────
  console.log('── cross-package checks ──');

  // Verify all workspace packages are covered
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  const workspaces = rootPkg.workspaces || [];
  const pkgDirs = [];
  for (const ws of workspaces) {
    // handle glob patterns like packages/*
    if (ws.includes('*')) {
      const dir = dirname(ws);
      const entries = readdirSync(join(root, dir));
      for (const e of entries) {
        const pkgPath = join(root, dir, e, 'package.json');
        if (existsSync(pkgPath)) {
          pkgDirs.push(join(dir, e));
        }
      }
    }
  }

  // check each workspace package has a manifest entry
  for (const pkgDir of pkgDirs) {
    const pkgJson = JSON.parse(readFileSync(join(root, pkgDir, 'package.json'), 'utf-8'));
    const pkgName = pkgJson.name;
    if (pkgName && !packages[pkgName]) {
      allOk = err(`workspace package "${pkgName}" (${pkgDir}) is not declared in the manifest`);
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════════════');
  if (allOk) {
    console.log('  ✅ Public API manifest checks passed');
  } else {
    console.log('  ❌ Public API manifest checks FAILED — fix drift above');
  }
  console.log('═══════════════════════════════════════════════\n');

  process.exit(allOk ? 0 : 1);
}

// ── Need readdirSync for cross-package checks ──
import { readdirSync } from 'node:fs';

main();
