import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  ReviewComment,
  SceneActionResult,
  SceneInspection,
  SourceChangePreviewV1,
  SourceChangeResultV1,
} from '@novalistically/core';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const cli = join(root, 'packages/cli/dist/index.js');
const fixture = join(root, 'fixtures/game-dialogue-tree');
const acceptPath = JSON.stringify({
  decisions: [{ atEventId: 'E0', choiceId: 'accept_hunt', narrativeOrder: 0 }],
});

function run(project: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: project,
    encoding: 'utf8',
  });
}

function expectJson<T>(project: string, args: string[]): T {
  const result = run(project, args);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

describe('built CLI editorial facade flow', () => {
  it('revises, adopts, versions source, and exposes operations through DTO commands', () => {
    const project = mkdtempSync(join(tmpdir(), 'nova-editorial-flow-'));
    try {
      cpSync(fixture, project, { recursive: true });
      const referenceDir = join(project, 'reference/data');
      const tree = run(project, [
        'render-tree',
        '--provider',
        'mock-pass2',
        '--reference-dir',
        referenceDir,
      ]);
      expect(tree.status, tree.stderr).toBe(0);

      const review = expectJson<ReviewComment>(project, [
        'review',
        'add',
        'E1a',
        'Keep the hunter restrained.',
        '--category',
        'character_voice',
        '--actor',
        'cli-test',
        '--json',
      ]);
      expect(review.target).toEqual({ type: 'scene', id: 'E1a' });
      expect(review.category).toBe('character_voice');

      const revised = expectJson<{
        results: Array<{ eventId: string; released: boolean }>;
      }>(project, [
        'revise',
        'E1a',
        '--review',
        review.id,
        '--branch-path',
        acceptPath,
        '--provider',
        'mock-pass2',
        '--reference-dir',
        referenceDir,
        '--json',
      ]);
      expect(revised.results).toEqual([
        expect.objectContaining({ eventId: 'E1a', released: true }),
      ]);

      const shown = expectJson<SceneInspection>(project, ['scene', 'show', 'E1a', '--json']);
      expect(shown.revisionId).not.toBeNull();

      appendFileSync(join(project, 'scenes/chapter-01/E1a.md'), '\nHe answered only with a nod.\n');
      const adopted = expectJson<SceneActionResult>(project, [
        'scene',
        'adopt',
        'E1a',
        '--lock',
        '--note',
        'Local prose polish',
        '--branch-path',
        acceptPath,
        '--provider',
        'mock-pass2',
        '--reference-dir',
        referenceDir,
        '--json',
      ]);
      expect(adopted.locked).toBe(true);
      expect(adopted.promoted).toBe(true);
      const scenePath = join(project, 'scenes/chapter-01/E1a.md');
      const novelPath = join(project, 'output/novel.md');
      const sceneHashBeforeSourceChange = createHash('sha256')
        .update(readFileSync(scenePath))
        .digest('hex');
      const novelHashBeforeSourceChange = createHash('sha256')
        .update(readFileSync(novelPath))
        .digest('hex');

      const eventPath = join(project, 'chapters/chapter_01/E1a.yaml');
      const replacementPath = join(project, 'E1a-edited.yaml');
      writeFileSync(
        replacementPath,
        readFileSync(eventPath, 'utf8').replace(
          'The hunt begins in the jungle.',
          'The cautious hunt begins in the jungle.',
        ),
      );
      const preview = expectJson<SourceChangePreviewV1>(project, [
        'source',
        'preview',
        'chapters/chapter_01/E1a.yaml',
        '--file',
        replacementPath,
        '--json',
      ]);
      expect(preview.validation.valid).toBe(true);
      const previewPath = join(project, 'source-preview.json');
      writeFileSync(previewPath, JSON.stringify(preview));

      const applied = expectJson<SourceChangeResultV1>(project, [
        'source',
        'apply',
        previewPath,
        '--actor',
        'cli-test',
        '--json',
      ]);
      expect(applied.changedDocuments.map((document) => document.path)).toEqual([
        'chapters/chapter_01/E1a.yaml',
      ]);
      expect(readFileSync(eventPath, 'utf8')).toContain('cautious hunt');
      const staleScene = expectJson<SceneInspection>(project, ['scene', 'show', 'E1a', '--json']);
      expect(staleScene.staleReasons).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'SCENE_LOCK_STALE' })]),
      );
      const staleRender = run(project, [
        'render',
        'E0',
        '--all',
        '--actor',
        'cli-test',
        '--branch-path',
        acceptPath,
        '--provider',
        'mock-pass2',
        '--reference-dir',
        referenceDir,
        '--json',
      ]);
      expect(staleRender.status, `${staleRender.stderr}\n${staleRender.stdout}`).toBe(1);
      expect(staleRender.stderr).toContain('SCENE_LOCK_STALE');
      expect(createHash('sha256').update(readFileSync(scenePath)).digest('hex')).toBe(
        sceneHashBeforeSourceChange,
      );
      expect(createHash('sha256').update(readFileSync(novelPath)).digest('hex')).toBe(
        novelHashBeforeSourceChange,
      );
      expect(JSON.parse(readFileSync(join(project, '.nova/publication.json'), 'utf8')).status).toBe(
        'stale',
      );

      const operation = expectJson<{ status: string; actorId: string }>(project, [
        'operation',
        'show',
        adopted.operationId,
        '--json',
      ]);
      expect(operation).toMatchObject({ status: 'succeeded', actorId: 'local-cli' });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
