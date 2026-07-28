import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const fixture = join(root, 'fixtures/game-dialogue-tree');
const acceptPath = JSON.stringify({
  decisions: [{ atEventId: 'E0', choiceId: 'accept_hunt', narrativeOrder: 0 }],
});

describe('built CLI game dialogue tree', () => {
  it('renders the committed tree and validates selected branch paths', () => {
    const project = mkdtempSync(join(tmpdir(), 'nova-game-tree-'));
    try {
      cpSync(fixture, project, { recursive: true });
      const rendered = spawnSync(
        process.execPath,
        [
          join(root, 'packages/cli/dist/index.js'),
          'render-tree',
          '--provider',
          'mock-pass2',
          '--reference-dir',
          join(project, 'reference/data'),
        ],
        { cwd: project, encoding: 'utf8' },
      );

      expect(rendered.status, rendered.stderr).toBe(0);
      const dialogueTreePath = join(project, 'output/dialogue-tree.md');
      expect(existsSync(dialogueTreePath)).toBe(true);
      const dialogueTree = readFileSync(dialogueTreePath, 'utf8');
      expect(dialogueTree).toContain('<!-- FABULA:PLAYER_CHOICES:v1 -->');
      expect(dialogueTree).toContain('[Accept the hunt](#event-E1a)');
      expect(existsSync(join(project, 'output/novel.md'))).toBe(false);

      const selected = spawnSync(
        process.execPath,
        [
          join(root, 'packages/cli/dist/index.js'),
          'render',
          'E0',
          '--all',
          '--branch-path',
          acceptPath,
          '--provider',
          'mock-pass2',
          '--reference-dir',
          join(project, 'reference/data'),
        ],
        { cwd: project, encoding: 'utf8' },
      );
      expect(selected.status, selected.stderr).toBe(0);
      expect(selected.stdout).toContain('E0:');
      expect(selected.stdout).toContain('E1a:');
      expect(selected.stdout).not.toContain('E1b:');

      const invalidJson = spawnSync(
        process.execPath,
        [join(root, 'packages/cli/dist/index.js'), 'render', 'E0', '--branch-path', '{invalid'],
        { cwd: project, encoding: 'utf8' },
      );
      expect(invalidJson.status).toBe(1);
      expect(invalidJson.stderr).toContain('Invalid --branch-path');

      const nonLeaf = spawnSync(
        process.execPath,
        [
          join(root, 'packages/cli/dist/index.js'),
          'assemble',
          '--branch-path',
          JSON.stringify({ decisions: [] }),
        ],
        { cwd: project, encoding: 'utf8' },
      );
      expect(nonLeaf.status).toBe(1);
      expect(nonLeaf.stderr).toContain('complete, ordered leaf');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
