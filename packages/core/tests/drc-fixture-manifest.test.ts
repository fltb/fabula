import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'drc-fixture-manifest.mjs');
const FIXTURE = path.join(ROOT, 'fixtures', 'dream-of-red-chamber');

describe('Dream of Red Chamber fixture manifest', () => {
  it('checks the committed four-chapter E01–E36 inventory', () => {
    const output = execFileSync(process.execPath, [SCRIPT, FIXTURE, '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(output).toContain('4 chapters, 36 events');
  });
});
