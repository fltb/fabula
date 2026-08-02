import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileMockPass2Provider } from '@novalistically/node-host';
import { renderGameDialogueTree, renderNovel } from '../../src/api.ts';
import { materializeFixtureSnapshot } from '../fixtures/fixture-snapshots.ts';
import { createRuntimeServices } from '../fixtures/runtime-services.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'game-dialogue-tree');
const source = materializeFixtureSnapshot(projectRoot);

function runtime() {
  const provider = new FileMockPass2Provider({
    referenceDir: path.join(projectRoot, 'reference', 'data'),
  });
  const harness = createRuntimeServices({ provider });
  return { provider, ...harness };
}

describe('renderGameDialogueTree()', () => {
  it('renders each authored dialogue node once from a source snapshot', async () => {
    const host = runtime();
    const operationId = randomUUID();
    const result = await renderGameDialogueTree(
      {
        version: 1,
        source,
        mutation: { operationId, actorId: 'test' },
        model: 'mock-pass2',
        maxRounds: 1,
      },
      host,
    );

    expect(result.errors).toEqual([]);
    expect(result.results.map((scene) => scene.eventId)).toEqual(['E0', 'E1a', 'E1b']);
    expect(result.tree.choicesByEventId.E0).toEqual([
      expect.objectContaining({ id: 'accept_hunt', targetEvent: 'E1a' }),
      expect.objectContaining({ id: 'refuse_hunt', targetEvent: 'E1b' }),
    ]);
    expect(
      (await host.execution.readTrace({
        projectId: 'game-dialogue-tree',
        operationId,
      }))?.value.value,
    ).toMatchObject({
      format: 'jsonl',
      traceId: operationId,
      content: expect.stringContaining('"phase":"pipeline"'),
    });
  });

  it('renders only the explicitly selected branch route', async () => {
    const host = runtime();
    const result = await renderNovel(
      {
        version: 1,
        source,
        selector: { type: 'all' },
        branchPath: {
          decisions: [{ atEventId: 'E0', choiceId: 'accept_hunt', narrativeOrder: 0 }],
        },
        discourseBranch: 'accept_hunt',
        mutation: { operationId: randomUUID(), actorId: 'test' },
        model: 'mock-pass2',
        maxRounds: 1,
      },
      host,
    );

    expect(result.editorialErrors).toEqual([]);
    expect(result.results.map((scene) => scene.eventId)).toEqual(['E0', 'E1a']);
  });
});
