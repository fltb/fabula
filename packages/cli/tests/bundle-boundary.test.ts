import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('built ESM package boundaries', () => {
  it('starts the built CLI on Node ESM without bundled CommonJS YAML', () => {
    const cli = readFileSync(resolve(root, 'packages/cli/dist/index.js'), 'utf8');
    const bench = readFileSync(resolve(root, 'packages/bench/dist/index.js'), 'utf8');
    expect(cli).not.toContain('@novalistically/bench');
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

  it('keeps the CLI bundle from embedding Core source', () => {
    const cli = readFileSync(resolve(root, 'packages/cli/dist/index.js'), 'utf8');
    expect(cli).toMatch(/from "@novalistically\/core/);
  });

  it('keeps the MCP bundle free of the Commander entry, Bench, and embedded Core', () => {
    const mcp = readFileSync(resolve(root, 'packages/cli/dist/mcp-server.js'), 'utf8');
    expect(mcp).not.toContain('@novalistically/bench');
    expect(mcp).not.toMatch(/from "commander"/);
    expect(mcp).not.toContain('parseAsync');
    expect(mcp).not.toContain('resolveRoute');
    expect(mcp).toMatch(/from "@novalistically\/core/);
  });
});
