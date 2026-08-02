#!/usr/bin/env node
// ============================================================================
// public-api checker — validates that the declared public API surface
// (public-api.manifest.json) matches the actual source exports.
//
// Export resolution uses the TypeScript Compiler API with the repository's
// tsconfig module-resolution settings, so `export *` and `export type *`
// barrels are followed recursively and each re-export keeps its
// value-capable vs. type-only classification at the exporting statement.
//
// Checks per manifest entry (every package entry point):
//   1. The entry declares `source`, `dist`, and `stability`.
//   2. The source file exists and is part of a TypeScript program.
//   3. Every allowlisted value export exists as a runtime export in source.
//   4. Every allowlisted type export exists as a declaration-only export.
//   5. Every runtime export in source is allowlisted (no drift).
//   6. Every declaration-only export in source is allowlisted — including
//      wildcard (`export type *`) barrels, which the previous regex checker
//      silently skipped.
//   7. Declared bin entries reference real files.
//
// Exact equality per entry: the source value set must equal the allowlist
// value set and the source type set must equal the allowlist type set.
// Fail-fast: any drift exits non-zero.
//
// The module is importable for tests: `resolveEntryExports()`,
// `verifyManifest()`, and `main()` are exported. Running the file directly
// executes `main()`.
// ============================================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repository root, resolved from this file's location. */
export const repoRoot = join(__dirname, '..');

/** Stability semantics: core = general narrative-engine contract, scoped =
 * importable current surface without a compatibility guarantee, non-contract =
 * tooling/testing symbols. Semantic metadata, not a version policy. */
const STABILITY_VALUES = new Set(['core', 'scoped', 'non-contract']);

// ── export surface resolution (TypeScript Compiler API) ─────────────────────

const DEFAULT_COMPILER_OPTIONS = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  strict: true,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  resolveJsonModule: true,
};

/**
 * Load compiler options for the entry file: nearest `tsconfig.json` walked up
 * from the entry's directory (mirroring the repository's module resolution).
 * Falls back to NodeNext defaults when no tsconfig is present.
 */
function loadCompilerOptions(entryPath) {
  const tsconfigPath = ts.findConfigFile(dirname(entryPath), ts.sys.fileExists, 'tsconfig.json');
  if (!tsconfigPath) return { ...DEFAULT_COMPILER_OPTIONS };
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) return { ...DEFAULT_COMPILER_OPTIONS };
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfigPath));
  return { ...parsed.options };
}

/** Resolve an import specifier from `fromFile` to an on-disk source file. */
function resolveModuleFile(specifier, fromFile, compilerOptions) {
  const result = ts.resolveModuleName(specifier, fromFile, compilerOptions, ts.sys);
  const fileName = result.resolvedModule?.resolvedFileName;
  return fileName && existsSync(fileName) ? fileName : null;
}

function addBindingNames(name, target) {
  if (ts.isIdentifier(name)) {
    target.add(name.text);
  } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isBindingElement(element)) addBindingNames(element.name, target);
      else addBindingNames(element, target);
    }
  }
}

/**
 * Recursively resolve the named export surface of a TypeScript entry file.
 *
 * Returns `{ values, types, errors }`:
 * - `values`: runtime (value-capable) exports — functions, classes, enums,
 *   variables, namespaces, and re-exports through value `export *`.
 * - `types`: declaration-only exports — interfaces, type aliases, and any
 *   name re-exported through `export type` / `export type *` (which converts
 *   value-capable names to type-only, matching TS re-export semantics).
 *
 * Both are `Set<string>` of the *exported* names (aliases applied).
 */
export function resolveEntryExports(entryPath) {
  const compilerOptions = loadCompilerOptions(entryPath);
  const program = ts.createProgram([entryPath], compilerOptions);
  const checker = program.getTypeChecker();
  const errors = [];
  const memo = new Map();
  const visiting = new Set();

  const normalize = (filePath) => filePath.replaceAll('\\', '/');

  /**
   * Resolve a named export specifier's local symbol through the TypeChecker.
   * Returns the resolved symbol, or null when the exported name does not
   * resolve to a declared symbol (in the current file or the target module).
   * An unresolved re-export aliases to a transient symbol with no
   * declarations — that is exactly the broken surface the checker must reject.
   */
  const resolveSpecifierSymbol = (specifier) => {
    const localName = specifier.propertyName ?? specifier.name;
    try {
      let symbol = checker.getSymbolAtLocation(localName) ?? null;
      if (!symbol) return null;
      if (symbol.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      if (!symbol.declarations || symbol.declarations.length === 0) return null;
      return symbol;
    } catch {
      return null;
    }
  };

  const collect = (filePath) => {
    const normalized = normalize(filePath);
    // each file's own declarations are still collected on first visit.
    if (visiting.has(normalized)) return { values: new Set(), types: new Set() };
    visiting.add(normalized);

    const values = new Set();
    const types = new Set();
    const sourceFile = program.getSourceFile(normalized);
    if (!sourceFile) {
      errors.push(`${normalized}: source file not part of the TypeScript program`);
      visiting.delete(normalized);
      const empty = { values, types };
      memo.set(normalized, empty);
      return empty;
    }

    for (const statement of sourceFile.statements) {
      // ── export { ... } / export type { ... } / export * as ns from ──
      if (ts.isExportDeclaration(statement)) {
        const clause = statement.exportClause;
        if (clause) {
          if (ts.isNamespaceExport(clause)) {
            values.add(clause.name.text);
            continue;
          }
          const declarationTypeOnly = statement.isTypeOnly;
          for (const specifier of clause.elements) {
            const exportedName = specifier.name.text;
            // A named re-export must resolve to a declared symbol; a specifier
            // pointing at a name the target does not export is a broken
            // surface and must fail verification, not silently pass.
            const symbol = resolveSpecifierSymbol(specifier);
            if (symbol === null) {
              errors.push(
                `${normalized}: export '${exportedName}' does not resolve to a declared symbol`,
              );
              continue;
            }
            if (specifier.isTypeOnly || declarationTypeOnly) {
              types.add(exportedName);
            } else {
              values.add(exportedName);
            }
          }
          continue;
        }
        // ── export * from / export type * from ──
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          const target = resolveModuleFile(
            statement.moduleSpecifier.text,
            sourceFile.fileName,
            compilerOptions,
          );
          if (!target) {
            errors.push(
              `${normalized}: cannot resolve re-export '${statement.moduleSpecifier.text}'`,
            );
            continue;
          }
          const sub = collect(target);
          if (statement.isTypeOnly) {
            // `export type *` re-exports only the type side of every name.
            for (const value of sub.values) types.add(value);
            for (const typeName of sub.types) types.add(typeName);
          } else {
            for (const value of sub.values) values.add(value);
            for (const typeName of sub.types) types.add(typeName);
          }
          continue;
        }
        // ExportDeclaration with neither clause nor module specifier is malformed.
        errors.push(`${normalized}: malformed export declaration`);
        continue;
      }

      // ── export default — not part of the named export surface ──
      if (ts.isExportAssignment(statement)) continue;

      // ── exported declarations ──
      const isExported = statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!isExported) continue;

      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        if (statement.name) types.add(statement.name.text);
      } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        if (statement.name) values.add(statement.name.text);
      } else if (ts.isEnumDeclaration(statement)) {
        if (statement.name) values.add(statement.name.text);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          addBindingNames(declaration.name, values);
        }
      } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
        // `export namespace Foo` — a value-capable namespace.
        values.add(statement.name.text);
      }
    }

    visiting.delete(normalized);
    const result = { values, types };
    memo.set(normalized, result);
    return result;
  };

  const entry = collect(entryPath);
  return { values: entry.values, types: entry.types, errors };
}

// ── manifest verification ────────────────────────────────────────────────────

/**
 * Verify a manifest against the actual source surfaces.
 * Returns `{ problems, okMessages }`; `problems` is non-empty on any drift.
 * `root` is the directory manifest paths are relative to (defaults to the
 * repository root; tests pass a temporary fixture root).
 */
export function verifyManifest(manifest, root = repoRoot) {
  const problems = [];
  const okMessages = [];
  const packages = manifest.packages ?? {};

  for (const [pkgName, cfg] of Object.entries(packages)) {
    const entries = cfg.entries;
    if (!entries || typeof entries !== 'object') {
      problems.push(`${pkgName}: missing 'entries' object`);
      continue;
    }

    for (const [entryName, entry] of Object.entries(entries)) {
      const label = `${pkgName}${entryName}`;
      if (!entry || typeof entry !== 'object') {
        problems.push(`${label}: manifest entry is not an object`);
        continue;
      }
      if (!entry.stability) {
        problems.push(`${label}: manifest entry missing 'stability'`);
        continue;
      }
      if (!STABILITY_VALUES.has(entry.stability)) {
        problems.push(
          `${label}: invalid stability '${entry.stability}' (expected core | scoped | non-contract)`,
        );
        continue;
      }
      if (!entry.source) {
        problems.push(`${label}: manifest entry missing 'source'`);
        continue;
      }
      const sourcePath = join(root, entry.source);
      if (!existsSync(sourcePath)) {
        problems.push(`${label}: source entry ${entry.source} not found`);
        continue;
      }
      if (!entry.dist) {
        problems.push(`${label}: manifest entry missing 'dist'`);
        continue;
      }

      const resolved = resolveEntryExports(sourcePath);
      for (const error of resolved.errors) {
        problems.push(`${label}: ${error}`);
      }

      const manifestValues = new Set(entry.values ?? []);
      const manifestTypes = new Set(entry.types ?? []);

      // 1. Declared values that exist in source
      for (const name of manifestValues) {
        if (!resolved.values.has(name)) {
          problems.push(`${label}: declared value "${name}" not found in entry source`);
        }
      }

      // 2. Declared types that exist in source
      for (const name of manifestTypes) {
        if (!resolved.types.has(name)) {
          problems.push(`${label}: declared type "${name}" not found in entry source`);
        }
      }

      // 3. Actual values not allowlisted
      for (const name of resolved.values) {
        if (!manifestValues.has(name)) {
          problems.push(
            `${label}: undeclared value export "${name}" in source (add to manifest or make internal)`,
          );
        }
      }

      // 4. Actual types not allowlisted — includes `export type *` barrels,
      //    which the previous regex checker skipped entirely.
      for (const name of resolved.types) {
        if (!manifestTypes.has(name)) {
          problems.push(
            `${label}: undeclared type export "${name}" in source (add to manifest or make internal)`,
          );
        }
      }

      if (resolved.values.size === 0 && resolved.types.size === 0) {
        okMessages.push(`${label}: no declared exports (pass-through verification)`);
      } else {
        okMessages.push(
          `${label}: ${resolved.values.size} values, ${resolved.types.size} types verified`,
        );
      }
    }

    // Bin entries reference real files (package-level field)
    const bin = cfg.bin;
    if (bin) {
      for (const [binName, binPath] of Object.entries(bin)) {
        if (!existsSync(join(root, binPath))) {
          problems.push(`${pkgName}: bin "${binName}" target ${binPath} not found`);
        } else {
          okMessages.push(`${pkgName}: bin "${binName}" → ${binPath}`);
        }
      }
    }
  }

  // ── Cross-package check: every workspace package is declared ──
  const rootPkgPath = join(root, 'package.json');
  if (existsSync(rootPkgPath)) {
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
    for (const ws of rootPkg.workspaces ?? []) {
      if (!ws.includes('*')) continue;
      const wsDir = dirname(ws);
      for (const entry of readdirSync(join(root, wsDir))) {
        const pkgJsonPath = join(root, wsDir, entry, 'package.json');
        if (!existsSync(pkgJsonPath)) continue;
        const pkgName = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')).name;
        if (pkgName && !packages[pkgName]) {
          problems.push(
            `workspace package "${pkgName}" (${wsDir}/${entry}) is not declared in the manifest`,
          );
        }
      }
    }
  }

  return { problems, okMessages };
}

// ── CLI main ─────────────────────────────────────────────────────────────────

export function main() {
  const manifestPath = join(repoRoot, 'public-api.manifest.json');
  if (!existsSync(manifestPath)) {
    console.error('FATAL: public-api.manifest.json not found at root');
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (manifest.version !== 1) {
    console.error(`FATAL: unsupported manifest version ${manifest.version}`);
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════');
  console.log('  Public API Manifest Check');
  console.log('═══════════════════════════════════════════════\n');

  const { problems, okMessages } = verifyManifest(manifest, repoRoot);
  let allOk = problems.length === 0;

  for (const message of okMessages) {
    console.log(`  OK: ${message}`);
  }
  for (const problem of problems) {
    console.error(`  ERROR: ${problem}`);
    allOk = false;
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

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}
