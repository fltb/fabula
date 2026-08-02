import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectSourceSnapshotV1 } from '@novalistically/core';
import { buildSourceSnapshot, computeSourceDocumentHash } from '@novalistically/core/source';
import { inspectCanonicalGraphRuntime } from '@novalistically/core/tooling';
import { describe, expect, it } from 'vitest';
import { WORKBENCH_GRAPH_VIEW_VERSION } from '../src/contracts/graph.js';
import type {
  WorkbenchGraphProjectionV1,
  WorkbenchGraphViewV1,
  WorkbenchRouteSelectorV1,
} from '../src/contracts/index.js';
import { projectCanonicalGraphRuntime } from '../src/host/graph-projection.js';

// ─── Real compilable project snapshots (version-controlled fixtures) ────────

const ZHU_FU_ROOT = fileURLToPath(new URL('../../../fixtures/zhu-fu', import.meta.url));
const GAME_DIALOGUE_ROOT = fileURLToPath(
  new URL('../../../fixtures/game-dialogue-tree', import.meta.url),
);

/** Materialize a version-controlled fixture project into an immutable snapshot. */
function materializeFixture(root: string): ProjectSourceSnapshotV1 {
  const documents: ProjectSourceSnapshotV1['documents'] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory()) {
        if (entry.name === '.nova') continue;
        walk(join(dir, entry.name));
      } else if (/\.ya?ml$/i.test(entry.name)) {
        const logicalPath = relative(root, join(dir, entry.name)).split(sep).join('/');
        const content = readFileSync(join(dir, entry.name), 'utf8');
        documents.push({
          version: 1,
          logicalPath,
          content,
          contentHash: computeSourceDocumentHash(content),
          parseResult: { status: 'parsed', value: null },
          diagnostics: [],
        });
      }
    }
  };
  walk(root);
  return buildSourceSnapshot(documents);
}

const ZHU_FU = materializeFixture(ZHU_FU_ROOT);
const GAME_DIALOGUE = materializeFixture(GAME_DIALOGUE_ROOT);

const ACCEPT_HUNT: WorkbenchRouteSelectorV1 = {
  version: WORKBENCH_GRAPH_VIEW_VERSION,
  branchPath: {
    decisions: [{ atEventId: 'E0', choiceId: 'accept_hunt', narrativeOrder: 0 }],
  },
  discourseBranch: 'accept_hunt',
};

// ─── Structure helpers ──────────────────────────────────────────────────────

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.keys(value as Record<string, unknown>).every((key) =>
    isDeepFrozen((value as Record<string, unknown>)[key]),
  );
}

/** Every value must be JSON-plain: no functions, no class instances. */
function assertPlainData(value: unknown, path: string): void {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'undefined') {
    return;
  }
  if (type === 'function') throw new Error(`function value at ${path}`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertPlainData(item, `${path}[${index}]`);
    });
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`non-plain object at ${path}: ${String(proto.constructor?.name)}`);
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    assertPlainData((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

describe('projectCanonicalGraphRuntime', () => {
  it('projects the canonical story graph verbatim: node identity, coordinates, origins', () => {
    const projection = projectCanonicalGraphRuntime(ZHU_FU);
    const compiled = inspectCanonicalGraphRuntime(ZHU_FU);

    expect(projection.version).toBe(WORKBENCH_GRAPH_VIEW_VERSION);
    expect(projection.story.version).toBe(1);
    expect(projection.story.domain).toBe('story');

    // Compiler-owned node identity, coordinates, and origins come through
    // unchanged — never rebuilt from output ids or adjacency.
    expect(projection.story.nodes).toEqual(compiled.story.nodes);
    expect(projection.story.nodes.length).toBeGreaterThan(0);
    expect(projection.story.nodes.some((node) => node.origin.type === 'initial')).toBe(true);
    expect(
      projection.story.nodes.some(
        (node) => node.origin.type === 'event' && node.origin.source === 'event_file',
      ),
    ).toBe(true);
    expect(projection.story.nodes.some((node) => node.coordinate.type === 'storyTime')).toBe(true);
  });

  it('retains directed edges with class and causal group, and outputs with provenance', () => {
    const projection = projectCanonicalGraphRuntime(ZHU_FU);
    const compiled = inspectCanonicalGraphRuntime(ZHU_FU);

    expect(projection.story.edges).toEqual(compiled.story.graph.edges);
    expect(projection.story.edges.length).toBeGreaterThan(0);
    // Exact direction: predecessor → dependent pairs, classes, causal groups.
    expect(
      projection.story.edges.map((edge) => [
        edge.predecessor,
        edge.dependent,
        edge.edgeClass,
        edge.causalGroupId,
      ]),
    ).toEqual(
      compiled.story.graph.edges.map((edge) => [
        edge.predecessor,
        edge.dependent,
        edge.edgeClass,
        edge.causalGroupId,
      ]),
    );
    const edgeClasses = new Set(projection.story.edges.map((edge) => edge.edgeClass));
    for (const edge of compiled.story.graph.edges)
      expect(edgeClasses.has(edge.edgeClass)).toBe(true);

    expect(projection.story.outputs).toEqual(compiled.story.graph.outputs);
    expect(projection.story.outputs.length).toBeGreaterThan(0);
    for (const output of projection.story.outputs) {
      expect(output.provenanceHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('retains story reads/resolutions/ellipses and both graph hashes', () => {
    const projection = projectCanonicalGraphRuntime(ZHU_FU);
    const compiled = inspectCanonicalGraphRuntime(ZHU_FU);

    expect(projection.story.reads).toEqual(compiled.story.graph.reads);
    expect(projection.story.resolutions).toEqual(compiled.story.graph.resolutions);
    expect(projection.story.ellipses).toEqual(compiled.story.graph.ellipses ?? []);
    // Both canonical graph hashes survive unchanged.
    expect(projection.story.hash).toBe(compiled.story.graph.hash);
    expect(projection.discourse.hash).toBe(compiled.discourse.graph.hash);
    expect(projection.story.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(projection.discourse.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(projection.story.hash).not.toBe(projection.discourse.hash);
  });

  it('retains the canonical discourse sceneSequence, boundaries, and discourse-only nodes', () => {
    const projection = projectCanonicalGraphRuntime(ZHU_FU);
    const compiled = inspectCanonicalGraphRuntime(ZHU_FU);

    expect(projection.discourse.domain).toBe('discourse');
    // Canonical reader order: the exact compiler scene sequence.
    expect(projection.discourse.sceneSequence).toEqual(compiled.discourse.graph.sceneSequence);
    expect(projection.discourse.sceneSequence.length).toBeGreaterThan(0);
    const sequenceNumbers = projection.discourse.sceneSequence.map((entry) => entry.sequence);
    expect([...sequenceNumbers].sort((a, b) => a - b)).toEqual(sequenceNumbers);
    expect(new Set(sequenceNumbers).size).toBe(sequenceNumbers.length);

    expect(projection.discourse.boundaryReferences).toEqual(
      compiled.discourse.graph.boundaryReferences ?? [],
    );
    expect(projection.discourse.nodes).toEqual(compiled.discourse.nodes);
    expect(projection.discourse.nodes.every((node) => node.origin.type === 'discourse')).toBe(true);

    // Collections the other domain does not produce stay empty.
    expect(projection.story.sceneSequence).toEqual([]);
    expect(projection.story.boundaryReferences).toEqual([]);
    expect(projection.discourse.reads).toEqual([]);
    expect(projection.discourse.resolutions).toEqual([]);
    expect(projection.discourse.ellipses).toEqual([]);
  });

  it('projects the linear route with opaque branchScope and all route metadata', () => {
    const projection = projectCanonicalGraphRuntime(ZHU_FU);
    const compiled = inspectCanonicalGraphRuntime(ZHU_FU);

    expect(projection.route).toEqual({
      version: WORKBENCH_GRAPH_VIEW_VERSION,
      branchPath: { decisions: [] },
      branchScope: compiled.route.branchScope,
      discourseBranch: compiled.route.discourseBranch,
      selectedEventIds: compiled.route.selectedEventIds,
      leafPaths: compiled.route.leafPaths,
      eventScopes: compiled.route.eventScopes,
      choices: compiled.route.choices,
    });
    expect(projection.route.branchPath).toEqual({ decisions: [] });
    expect(projection.route.branchScope).toBe('Linear');
    expect(projection.route.discourseBranch).toBe('main');
    expect(projection.route.selectedEventIds.length).toBeGreaterThan(0);
  });

  it('projects a selected game-dialogue route: branchPath, choices, leaf paths, event scopes', () => {
    const projection = projectCanonicalGraphRuntime(GAME_DIALOGUE, ACCEPT_HUNT);
    const compiled = inspectCanonicalGraphRuntime(GAME_DIALOGUE, {
      branchPath: { decisions: [{ atEventId: 'E0', choiceId: 'accept_hunt', narrativeOrder: 0 }] },
      discourseBranch: 'accept_hunt',
    });

    expect(projection.route).toEqual({
      version: WORKBENCH_GRAPH_VIEW_VERSION,
      branchPath: compiled.route.branchPath,
      branchScope: compiled.route.branchScope,
      discourseBranch: 'accept_hunt',
      selectedEventIds: compiled.route.selectedEventIds,
      leafPaths: compiled.route.leafPaths,
      eventScopes: compiled.route.eventScopes,
      choices: compiled.route.choices,
    });

    // The exact authored choice metadata survives.
    expect(projection.route.choices).toContainEqual({
      eventId: 'E0',
      choiceId: 'accept_hunt',
      label: 'Accept the hunt',
      description: "Enter the jungle with a knife and three hours' head start.",
      targetEventId: 'E1a',
      narrativeOrder: 0,
    });
    // Leaf paths carry branch decisions; branchScope is an opaque string that
    // is passed through, never parsed.
    expect(projection.route.leafPaths.some((path) => path.decisions.length > 0)).toBe(true);
    expect(typeof projection.route.branchScope).toBe('string');
    expect(projection.route.branchScope).toBe(compiled.route.branchScope);
    expect(projection.route.eventScopes).toContainEqual(expect.objectContaining({ eventId: 'E0' }));
  });

  it('returns detached, deeply frozen, plain-data DTOs with no source text or handles', () => {
    const projection = projectCanonicalGraphRuntime(ZHU_FU);
    const compiled = inspectCanonicalGraphRuntime(ZHU_FU);

    // Frozen at every level, including the versioned route and both views.
    expect(Object.isFrozen(projection)).toBe(true);
    expect(isDeepFrozen(projection)).toBe(true);
    expect(isDeepFrozen(projection.story)).toBe(true);
    expect(isDeepFrozen(projection.discourse)).toBe(true);
    expect(isDeepFrozen(projection.route)).toBe(true);

    // Detached: no shared references with the compiler artifact.
    expect(projection.story.nodes).not.toBe(compiled.story.nodes);
    expect(projection.story.nodes[0]).not.toBe(compiled.story.nodes[0]);
    expect(projection.story.edges).not.toBe(compiled.story.graph.edges);
    expect(projection.story.outputs).not.toBe(compiled.story.graph.outputs);
    expect(projection.discourse.nodes).not.toBe(compiled.discourse.nodes);
    expect(projection.route).not.toBe(compiled.route);

    // Pure JSON data: no functions, no class instances (no Host handles).
    assertPlainData(projection, 'projection');
    expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);

    // The DTO surface exposes no source-text fields: every typed key (outside
    // the opaque `data`/`value` compiler payloads) is a graph/route field.
    const surfaceKeys: string[] = [];
    const collectSurfaceKeys = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach((item) => {
          collectSurfaceKeys(item);
        });
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'data' || key === 'value') continue; // opaque compiler payloads
        surfaceKeys.push(key);
        collectSurfaceKeys(child);
      }
    };
    collectSurfaceKeys(projection);
    expect(
      surfaceKeys.some((key) => key === 'content' || key === 'prose' || key === 'sourceText'),
    ).toBe(false);

    // No source document text leaks into the DTO.
    const json = JSON.stringify(projection);
    for (const document of ZHU_FU.documents) {
      expect(json).not.toContain(document.content);
    }
    for (const document of GAME_DIALOGUE.documents) {
      expect(json).not.toContain(document.content);
    }
  });

  it('is deterministic and independent of caller-side mutation of the snapshot', () => {
    const first = projectCanonicalGraphRuntime(ZHU_FU);
    const second = projectCanonicalGraphRuntime(ZHU_FU);
    expect(second).toEqual(first);

    // The frozen DTO shares nothing with the caller's snapshot: freezing the
    // output never touches the input, and the input stays mutable.
    const snapshot = structuredClone(ZHU_FU);
    const fromCopy = projectCanonicalGraphRuntime(snapshot);
    expect(fromCopy).toEqual(first);
    expect(Object.isFrozen(snapshot.documents[0])).toBe(false);
  });

  it('exposes only the documented selector fields and views through the barrel', () => {
    const selector: WorkbenchRouteSelectorV1 = {
      version: WORKBENCH_GRAPH_VIEW_VERSION,
      branchPath: { decisions: [] },
      discourseBranch: 'main',
    };
    const projection: WorkbenchGraphProjectionV1 = projectCanonicalGraphRuntime(ZHU_FU, selector);
    const story: WorkbenchGraphViewV1 = projection.story;
    expect(story.domain).toBe('story');
    expect(projection.discourse.domain).toBe('discourse');
    expect(projection.route.version).toBe(WORKBENCH_GRAPH_VIEW_VERSION);
  });
});
