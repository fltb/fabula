import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateNovel, type LLMProvider } from '@novalistically/core';
import { FileProjectSourceLoader, createFileCoreRuntimeServices } from '@novalistically/node-host';
import { describe, expect, it } from 'vitest';
import { createHostBoundMcpTools } from '../src/mcp-server.ts';

const root = resolve(import.meta.dirname, '../../..');
const fixture = join(root, 'fixtures', 'most-dangerous-game');
const statusFixture = join(root, 'fixtures', 'arcane-aftermath');
const loader = new FileProjectSourceLoader();

const provider: LLMProvider = {
  name: 'test',
  async complete() {
    return {
      content: '',
      model: 'test',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  },
};

describe('CLI source and MCP boundaries', () => {
  it('exposes source-derived MCP tools through an explicit host context', async () => {
    const project = mkdtempSync(join(tmpdir(), 'nova-cli-host-'));
    try {
      const source = loader.load(fixture);
      const tools = new Map(
        createHostBoundMcpTools({
          currentSource: () => source,
          runtime: { services: createFileCoreRuntimeServices(project, { provider }), provider },
        }).map((tool) => [tool.name, tool]),
      );

      const documents = (await tools.get('nova_source_list')!.run({})) as readonly { logicalPath: string }[];
      expect(documents.some((document) => document.logicalPath === 'nova.yaml')).toBe(true);

      const config = (await tools.get('nova_source_get')!.run({ logicalPath: 'nova.yaml' })) as {
        logicalPath: string;
        content: string;
      };
      expect(config).toMatchObject({ logicalPath: 'nova.yaml' });
      expect(config.content).toContain('project: most-dangerous-game');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('runs snapshot-only status from the built CLI', () => {
    const result = spawnSync(process.execPath, [join(root, 'packages/cli/dist/index.js'), 'status', '--json'], {
      cwd: statusFixture,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ summary: { totalEvents: 2 } });
  });

  it('scaffolds a valid source topology without initializing Git', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'nova-cli-init-'));
    const project = join(parent, 'novel');
    try {
      const result = spawnSync(
        process.execPath,
        [join(root, 'packages/cli/dist/index.js'), 'project', 'init', 'novel'],
        { cwd: parent, encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(project, '.git'))).toBe(false);
      expect(existsSync(join(project, 'definitions', 'discourse-ledger.yaml'))).toBe(true);
      expect(existsSync(join(project, 'chapters', 'chapter_01', '_chapter.yaml'))).toBe(true);
      await expect(validateNovel(loader.load(project))).resolves.toMatchObject({ passed: true });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
