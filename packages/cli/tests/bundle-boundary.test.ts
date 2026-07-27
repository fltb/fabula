import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('built ESM package boundaries', () => {
  it('starts the built CLI on Node ESM without bundled CommonJS YAML', () => {
    const cli = readFileSync(resolve(root, 'packages/cli/dist/index.js'), 'utf8');
    const bench = readFileSync(resolve(root, 'packages/bench/dist/index.js'), 'utf8');
    expect(cli).toContain('@novalistically/bench');
    expect(bench).toMatch(/from ['"]yaml['"]/);
    expect(cli).not.toContain('Dynamic require');
    expect(bench).not.toContain('Dynamic require');
    expect(
      execFileSync(process.execPath, ['packages/cli/dist/index.js', '--help'], {
        cwd: root,
        encoding: 'utf8',
      }),
    ).toContain('Usage:');
  });
});
