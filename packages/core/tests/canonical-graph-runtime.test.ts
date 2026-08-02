import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectCanonicalGraphRuntime } from '../src/api.ts';
import { canonicalGraphRuntimeSnapshotSchema } from '../src/schemas/graph.ts';
import { materializeFixtureSnapshot } from './fixtures/fixture-snapshots.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const ZHU_FU = materializeFixtureSnapshot(path.join(ROOT, 'fixtures', 'zhu-fu'));
const GAME_DIALOGUE = materializeFixtureSnapshot(path.join(ROOT, 'fixtures', 'game-dialogue-tree'));

describe('inspectCanonicalGraphRuntime', () => {
  it('returns a schema-valid canonical graph with compiler-owned nodes and reader order', () => {
    const snapshot = inspectCanonicalGraphRuntime(ZHU_FU);

    expect(canonicalGraphRuntimeSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.story.nodes).toContainEqual(
      expect.objectContaining({
        coordinate: { type: 'storyTime', kind: 'initial' },
        origin: { type: 'initial' },
      }),
    );
    expect(snapshot.story.nodes).toContainEqual(
      expect.objectContaining({
        origin: expect.objectContaining({ type: 'event', source: 'event_file' }),
      }),
    );
    expect(snapshot.story.graph.outputs).toContainEqual(
      expect.objectContaining({
        effectiveCoordinate: expect.objectContaining({ type: 'storyTime' }),
        provenanceHash: expect.any(String),
      }),
    );
    expect(snapshot.discourse.graph.sceneSequence.length).toBeGreaterThan(0);
    expect(snapshot.discourse.nodes.every((node) => node.origin.type === 'discourse')).toBe(true);
    expect(snapshot.route).toMatchObject({
      branchPath: { decisions: [] },
      branchScope: 'Linear',
      discourseBranch: 'main',
    });
  });

  it('preserves authored route choices and exact leaf paths without parsing branch scopes', () => {
    const snapshot = inspectCanonicalGraphRuntime(GAME_DIALOGUE, {
      branchPath: {
        decisions: [{ atEventId: 'E0', choiceId: 'accept_hunt', narrativeOrder: 0 }],
      },
      discourseBranch: 'accept_hunt',
    });

    expect(snapshot.route.choices.length).toBeGreaterThan(0);
    expect(snapshot.route.leafPaths.some((path) => path.decisions.length > 0)).toBe(true);
    expect(snapshot.route.eventScopes).toContainEqual(expect.objectContaining({ eventId: 'E0' }));
    expect(canonicalGraphRuntimeSnapshotSchema.parse(snapshot).route).toEqual(snapshot.route);
  });
});
