import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type LLMProvider, validateNovel } from '@novalistically/core';
import { createFileCoreRuntimeServices, FileProjectSourceLoader } from '@novalistically/node-host';
import { describe, expect, it } from 'vitest';
import { createHostBoundMcpTools, type HostBoundMcpTool } from '../src/mcp-server.ts';

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

function mustTool(tools: ReadonlyMap<string, HostBoundMcpTool>, name: string): HostBoundMcpTool {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`Missing MCP tool: ${name}`);
  return tool;
}

describe('CLI source and MCP boundaries', () => {
  it('exposes source-derived MCP tools through an explicit host context', async () => {
    const project = mkdtempSync(join(tmpdir(), 'nova-cli-host-'));
    try {
      const source = loader.load(fixture);
      const tools = new Map(
        createHostBoundMcpTools({
          currentSource: () => source,
          runtime: { services: createFileCoreRuntimeServices(project, { provider }), provider },
          actorId: 'local-cli',
          allocateOperationId: () => randomUUID(),
        }).map((tool) => [tool.name, tool]),
      );

      const documents = (await mustTool(tools, 'nova_source_list').run({})) as readonly {
        logicalPath: string;
      }[];
      expect(documents.some((document) => document.logicalPath === 'nova.yaml')).toBe(true);

      const config = (await mustTool(tools, 'nova_source_get').run({
        logicalPath: 'nova.yaml',
      })) as {
        logicalPath: string;
        content: string;
      };
      expect(config).toMatchObject({ logicalPath: 'nova.yaml' });
      expect(config.content).toContain('project: most-dangerous-game');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('derives render mutation identity from the host and rejects client-supplied identity', async () => {
    const project = mkdtempSync(join(tmpdir(), 'nova-cli-render-'));
    try {
      const source = loader.load(fixture);
      const services = createFileCoreRuntimeServices(project, { provider });
      const hostActorId = 'local-owner';
      const allocated: string[] = [];
      let capturedMutation: { operationId: string; actorId: string } | null = null;
      const tools = new Map(
        createHostBoundMcpTools({
          currentSource: () => source,
          runtime: { services, provider },
          actorId: hostActorId,
          allocateOperationId: () => {
            const operationId = randomUUID();
            allocated.push(operationId);
            return operationId;
          },
          render: async (request) => {
            capturedMutation = request.mutation;
            return { operationId: request.mutation.operationId } as never;
          },
        }).map((tool) => [tool.name, tool]),
      );

      // Client-supplied identity can never reach the runtime: unknown-key
      // validation rejects actorId/operationId before any render work.
      await expect(
        mustTool(tools, 'nova_render').run({
          sceneSelector: { type: 'all' },
          actorId: 'attacker',
          operationId: 'spoofed',
        }),
      ).rejects.toThrow(/Unknown field "actorId"/);
      expect(allocated).toHaveLength(0);

      // A valid render input keeps its product behavior, but the mutation
      // identity is host-derived: the allocator is invoked exactly once and
      // the injected Host render boundary receives the server-owned identity.
      const result = (await mustTool(tools, 'nova_render').run({
        sceneSelector: { type: 'all' },
        model: 'test',
      })) as { operationId: string };
      expect(allocated).toHaveLength(1);
      expect(result.operationId).toBe(allocated[0]);
      if (capturedMutation === null) throw new Error('Host render boundary was not invoked');
      expect(capturedMutation).toEqual({
        operationId: allocated[0],
        actorId: hostActorId,
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('runs snapshot-only status from the built CLI', () => {
    const result = spawnSync(
      process.execPath,
      [join(root, 'packages/cli/dist/index.js'), 'status', '--json'],
      {
        cwd: statusFixture,
        encoding: 'utf8',
      },
    );
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
