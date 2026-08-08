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

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const CORE_SRC = path.resolve(import.meta.dirname, '..', 'src');
const TSC_BIN = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'node_modules',
  'typescript',
  'lib',
  'tsc.js',
);

/**
 * Compile one fixture through the tsc CLI (TS7 exposes no programmatic
 * createProgram API) and return the fixture-file diagnostic messages.
 */
function compileFixture(fixturePath: string, sourceCode: string): readonly string[] {
  writeFileSync(fixturePath, sourceCode, 'utf8');
  try {
    execFileSync(
      process.execPath,
      [
        TSC_BIN,
        fixturePath,
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'es2022',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--allowImportingTsExtensions',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return [];
  } catch (error) {
    const errorRecord =
      error !== null && typeof error === 'object' && 'stdout' in error
        ? error
        : { stdout: '', stderr: '' };
    const stdout = typeof errorRecord.stdout === 'string' ? errorRecord.stdout : '';
    const stderr =
      'stderr' in errorRecord && typeof errorRecord.stderr === 'string' ? errorRecord.stderr : '';
    const fixtureName = path.basename(fixturePath);
    return (stdout + stderr)
      .split('\n')
      .filter((line) => line.includes(fixtureName) && line.includes('error TS'))
      .map((line) => line.replace(/^.*error TS\d+: /, ''))
      .filter((message) => message.length > 0);
  }
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
    const fixtureDiagnostics = compileFixture(fixturePath, fixtureSource);

    expect(fixtureDiagnostics.length).toBeGreaterThan(0);
    expect(fixtureDiagnostics.some((message) => message.includes('register'))).toBe(true);
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
    const fixtureDiagnostics = compileFixture(fixturePath, fixtureSource);
    expect(fixtureDiagnostics.length).toBeGreaterThan(0);
    expect(fixtureDiagnostics.some((message) => message.includes('validate'))).toBe(true);
    expect(fixtureDiagnostics.some((message) => message.includes('validateRender'))).toBe(true);
  });
});
