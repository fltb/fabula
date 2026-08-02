import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderGameDialogueTree, renderNovel } from '../../src/api.ts';
import { type MockPass2Entry, MockPass2Provider } from '../../src/testing.ts';
import { materializeFixtureSnapshot } from '../fixtures/fixture-snapshots.ts';
import { createRuntimeServices } from '../fixtures/runtime-services.ts';

const projectRoot = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'game-dialogue-tree',
);
const source = materializeFixtureSnapshot(projectRoot);

/** Load deterministic Pass 2 reference fixtures without Host involvement. */
function loadReferenceEntries(referenceDir: string): Record<string, MockPass2Entry> {
  const root = path.resolve(referenceDir);
  const entries: Record<string, MockPass2Entry> = {};
  for (const file of readdirSync(root)
    .filter((entry) => entry.endsWith('.json'))
    .sort()) {
    const value = JSON.parse(readFileSync(path.join(root, file), 'utf8')) as MockPass2Entry;
    entries[path.basename(file, '.json')] = value;
  }
  return entries;
}

function runtime() {
  const provider = new MockPass2Provider({
    entries: loadReferenceEntries(path.join(projectRoot, 'reference', 'data')),
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
      (
        await host.execution.readTrace({
          projectId: 'game-dialogue-tree',
          operationId,
        })
      )?.value.value,
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
