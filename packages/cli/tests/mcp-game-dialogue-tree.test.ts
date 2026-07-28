import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MockPass2Provider } from '@novalistically/core';
import { describe, expect, it } from 'vitest';
import {
  createMCPServer,
  mcpNovaAssemble,
  mcpNovaRender,
  mcpNovaRenderTree,
} from '../src/mcp-server.ts';

const root = resolve(import.meta.dirname, '../../..');
const fixture = join(root, 'fixtures/game-dialogue-tree');
const acceptPath = {
  decisions: [{ atEventId: 'E0', choiceId: 'accept_hunt', narrativeOrder: 0 }],
};

describe('MCP game dialogue tree handlers', () => {
  it('renders the tree, accepts selected paths, and registers the MCP tool', async () => {
    const project = mkdtempSync(join(tmpdir(), 'nova-mcp-game-tree-'));
    try {
      cpSync(fixture, project, { recursive: true });
      const treeRender = await mcpNovaRenderTree(project, {
        model: 'mock-pass2',
        provider: new MockPass2Provider({ referenceDir: join(project, 'reference/data') }),
      });

      expect(treeRender.errors).toEqual([]);
      expect(treeRender.results.map((result) => result.eventId)).toEqual(['E0', 'E1a', 'E1b']);
      expect(treeRender.choicesByEventId.E0).toEqual([
        expect.objectContaining({ id: 'accept_hunt', targetEvent: 'E1a' }),
        expect.objectContaining({ id: 'refuse_hunt', targetEvent: 'E1b' }),
      ]);
      expect(treeRender.dialogueTree).toContain('[Accept the hunt](#event-E1a)');

      const dryRun = await mcpNovaRender(project, 'E1a', acceptPath);
      expect(dryRun.markdown).toContain('"eventId": "E1a"');

      const assembled = mcpNovaAssemble(project, {
        outputPath: join(project, 'output', 'selected.md'),
        branchPath: acceptPath,
      });
      expect(assembled.sceneCount).toBe(2);
      expect(existsSync(join(project, 'output', 'selected.md'))).toBe(true);

      const server = createMCPServer(project);
      expect(server.tools).toHaveProperty('nova_render_tree');
      expect(server.tools).toHaveProperty('nova_render');
      expect(server.tools).toHaveProperty('nova_render_scene');
      expect(server.tools).toHaveProperty('nova_assemble');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
