// ============================================================================
// Public contract — negative compile-time fixtures
// ============================================================================
//
// Compiles two temporary TypeScript fixtures with the compiler API:
//
//  - Fixture A: `ProjectCompilation.entities` must NOT expose `register`.
//    The public contract is the read-only EntityLookup boundary; a legacy
//    registry mutation call must fail type checking.
//
//  - Fixture B: legacy-shaped objects must be rejected by `Validator`.
// ============================================================================

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const CORE_SRC = path.resolve(import.meta.dirname, '..', 'src');

function compileFixture(fixturePath: string, sourceCode: string): readonly ts.Diagnostic[] {
  writeFileSync(fixturePath, sourceCode, 'utf8');
  const program = ts.createProgram([fixturePath], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    // `allowImportingTsExtensions` is only legal with noEmit / emitDeclarationOnly.
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  });
  return ts.getPreEmitDiagnostics(program);
}

/** Diagnostics reported on the fixture file itself (not on resolved sources). */
function diagnosticsForFile(
  diagnostics: readonly ts.Diagnostic[],
  fixturePath: string,
): readonly ts.Diagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.file?.fileName === fixturePath);
}

describe('public contract negative typecheck fixtures', () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('fixture A: ProjectCompilation.entities has no register method', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'core-contract-a-'));
    tempDirs.push(dir);
    const fixturePath = path.join(dir, 'fixture-a.ts');
    const entityTypesPath = path.join(CORE_SRC, 'entity', 'types.ts');

    const fixtureSource = `import type { ProjectCompilation } from '${entityTypesPath}';
declare const compilation: ProjectCompilation;
compilation.entities.register({ id: 'x' } as never);
`;
    const fixtureDiagnostics = diagnosticsForFile(
      compileFixture(fixturePath, fixtureSource),
      fixturePath,
    );

    expect(fixtureDiagnostics.length).toBeGreaterThan(0);
    const messages = fixtureDiagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    );
    expect(messages.some((message) => message.includes('register'))).toBe(true);
  });

  it('fixture B: legacy validate and validateRender members are rejected', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'core-contract-b-'));
    tempDirs.push(dir);
    const fixturePath = path.join(dir, 'fixture-b.ts');
    const validatorTypesPath = path.join(CORE_SRC, 'types', 'validator.ts');
    const fixtureSource = `import type { Validator } from '${validatorTypesPath}';
const legacyValidate: Validator = { name: 'LegacyValidate', category: 'prose_quality', validate: () => [] };
const legacyRender: Validator = { name: 'LegacyRender', category: 'prose_quality', validateRender: () => [] };
void legacyValidate;
void legacyRender;
`;
    const fixtureDiagnostics = diagnosticsForFile(
      compileFixture(fixturePath, fixtureSource),
      fixturePath,
    );
    expect(fixtureDiagnostics.length).toBeGreaterThan(0);
    const messages = fixtureDiagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    );
    expect(messages.some((message) => message.includes('validate'))).toBe(true);
    expect(messages.some((message) => message.includes('validateRender'))).toBe(true);
  });
});
