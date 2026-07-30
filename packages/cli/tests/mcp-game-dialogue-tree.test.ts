import * as crypto from 'node:crypto';
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
      const treeRender = await mcpNovaRenderTree(
        project,
        { model: 'mock-pass2' },
        new MockPass2Provider({ referenceDir: join(project, 'reference/data') }),
      );

      expect(treeRender.errors).toEqual([]);
      expect(treeRender.results.map((result) => result.eventId)).toEqual(['E0', 'E1a', 'E1b']);
      expect(treeRender.tree.choicesByEventId.E0).toEqual([
        expect.objectContaining({ id: 'accept_hunt', targetEvent: 'E1a' }),
        expect.objectContaining({ id: 'refuse_hunt', targetEvent: 'E1b' }),
      ]);
      expect(treeRender.dialogueTree).toContain('[Accept the hunt](#event-E1a)');

      const dryRun = await mcpNovaRender(project, 'E1a', acceptPath, 'accept_hunt');
      expect(dryRun.markdown).toContain('"eventId": "E1a"');

      expect(() =>
        mcpNovaAssemble(project, {
          outputPath: join(project, 'output', 'selected.md'),
          branchPath: acceptPath,
          discourseBranch: 'accept_hunt',
        }),
      ).toThrow('Assembly scope mismatch');
      expect(existsSync(join(project, 'output', 'selected.md'))).toBe(false);

      const server = createMCPServer(project);
      expect(server.tools).toHaveProperty('nova_render_tree');
      expect(server.tools).toHaveProperty('nova_render');
      expect(server.tools).toHaveProperty('nova_render_scene');
      expect(server.tools).toHaveProperty('nova_assemble');
      expect(server.tools).toHaveProperty('nova_workspace_get');
      expect(server.tools).toHaveProperty('nova_source_preview');
      expect(server.tools).toHaveProperty('nova_review_replace');
      expect(server.tools).toHaveProperty('nova_review_status');
      expect(server.tools).toHaveProperty('nova_render_batch');
      expect(server.tools).toHaveProperty('nova_revise');
      expect(server.tools).toHaveProperty('nova_scene_adopt');
      expect(server.tools).toHaveProperty('nova_operation_get');

      const tools = server.tools as unknown as Record<
        string,
        (input: Record<string, unknown>) => Promise<unknown> | unknown
      >;
      const added = (await tools.nova_review_add({
        operationId: crypto.randomUUID(),
        actorId: 'mcp-test',
        eventId: 'E1a',
        content: 'Keep the response restrained.',
        severity: 'suggestion',
        category: 'character_voice',
      })) as { id: string; actorId: string; status: string };
      expect(added).toMatchObject({
        actorId: 'mcp-test',
        status: 'open',
      });
      const resolved = (await tools.nova_review_status({
        operationId: crypto.randomUUID(),
        actorId: 'mcp-test',
        commentId: added.id,
        action: 'resolve',
      })) as { id: string; status: string };
      expect(resolved).toMatchObject({ id: added.id, status: 'resolved' });
      const scene = (await tools.nova_scene_show({
        operationId: crypto.randomUUID(),
        actorId: 'mcp-test',
        eventId: 'E1a',
      })) as { eventId: string; revisionId: string | null };
      expect(scene.eventId).toBe('E1a');
      expect(scene.revisionId).not.toBeNull();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
