import { describe, expect, it } from 'vitest';
import { DagCycleError, DagProviderError } from '../../src/errors.ts';
import type { AdjacencyList } from '../../src/state/dag.ts';
import { buildStoryOrderIndex, isProvenBefore } from '../../src/state/dag.ts';
import type { SceneStoryCoordinate } from '../../src/types/index.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────

function coord(clock: 'story' | 'calendar' | 'chapter', scalar: number): SceneStoryCoordinate {
  return { type: 'storyTime', kind: 'point', clock, scalar };
}

const noCoords = new Map<string, SceneStoryCoordinate>();

// ============================================================================
// buildStoryOrderIndex() & isProvenBefore()
// ============================================================================

describe('buildStoryOrderIndex()', () => {
  // ── Transitive reachability ───────────────────────────────────────────

  it('produces topological order respecting adjacency', () => {
    const adj: AdjacencyList = new Map([
      ['A', ['B']],
      ['B', ['C']],
      ['C', []],
    ]);
    const order = buildStoryOrderIndex(null, ['A', 'B', 'C'], adj, noCoords);
    expect(order.topologicalOrder).toEqual(['A', 'B', 'C']);
  });

  it('chains three unlocated scenes with causal predecessor edges', () => {
    // A → B → C  yields A visible to C via transitivity
    const adj: AdjacencyList = new Map([
      ['A', ['B']],
      ['B', ['C']],
      ['C', []],
    ]);
    const order = buildStoryOrderIndex(null, ['A', 'B', 'C'], adj, noCoords);
    expect(isProvenBefore('A', 'B', order)).toBe(true);
    expect(isProvenBefore('B', 'C', order)).toBe(true);
    expect(isProvenBefore('A', 'C', order)).toBe(true);
    expect(isProvenBefore('C', 'A', order)).toBe(false);
  });

  it('exposes transitive ancestors in ancestorsByEventId', () => {
    const adj: AdjacencyList = new Map([
      ['A', ['B', 'C']],
      ['B', ['C']],
      ['C', []],
    ]);
    const order = buildStoryOrderIndex(null, ['A', 'B', 'C'], adj, noCoords);
    expect(order.ancestorsByEventId.get('C')).toEqual(new Set(['A', 'B']));
    expect(order.ancestorsByEventId.get('B')).toEqual(new Set(['A']));
    expect(order.ancestorsByEventId.get('A')).toEqual(new Set());
  });

  it('disjoint events have no proven-before relationship', () => {
    // Two unlocated scenes without a path: no order relation
    const adj: AdjacencyList = new Map([
      ['A', []],
      ['B', []],
    ]);
    const order = buildStoryOrderIndex(null, ['A', 'B'], adj, noCoords);
    expect(isProvenBefore('A', 'B', order)).toBe(false);
    expect(isProvenBefore('B', 'A', order)).toBe(false);
  });

  // ── Initial root semantics ────────────────────────────────────────────

  it('initial root is before every ordinary event', () => {
    const adj: AdjacencyList = new Map([
      ['root', ['A', 'B']],
      ['A', ['B']],
      ['B', []],
    ]);
    const order = buildStoryOrderIndex('root', ['A', 'B'], adj, noCoords);
    expect(isProvenBefore('root', 'A', order)).toBe(true);
    expect(isProvenBefore('root', 'B', order)).toBe(true);
  });

  it('initial root does not appear in topologicalOrder', () => {
    const adj: AdjacencyList = new Map([
      ['root', ['A']],
      ['A', []],
    ]);
    const order = buildStoryOrderIndex('root', ['A'], adj, noCoords);
    expect(order.topologicalOrder).toEqual(['A']);
    expect(order.initialRootId).toBe('root');
  });

  it('initial root is not proven-before for nonexistent dependent', () => {
    const adj: AdjacencyList = new Map([
      ['root', ['A']],
      ['A', []],
    ]);
    const order = buildStoryOrderIndex('root', ['A'], adj, noCoords);
    expect(isProvenBefore('root', 'missing', order)).toBe(false);
  });

  it('null initialRootId still builds valid order', () => {
    const adj: AdjacencyList = new Map([
      ['A', ['B']],
      ['B', []],
    ]);
    const order = buildStoryOrderIndex(null, ['A', 'B'], adj, noCoords);
    expect(order.initialRootId).toBeNull();
    expect(isProvenBefore('A', 'B', order)).toBe(true);
  });

  // ── Mixed transitivity ────────────────────────────────────────────────

  it('temporal edge plus causal predecessor yields correct transitivity', () => {
    // U(unlocated)→A(day_1) plus independent B(day_2) — B has no path to U
    // Temporal edges: day_1→day_2 derived from chronology
    // So U→A→B → B proven after U and A
    const adj: AdjacencyList = new Map([
      ['U', ['A']],
      ['A', ['B']],
      ['B', []],
    ]);
    const coords = new Map<string, SceneStoryCoordinate>([
      ['A', coord('story', 1 * 86_400_000)],
      ['B', coord('story', 2 * 86_400_000)],
    ]);
    const order = buildStoryOrderIndex(null, ['U', 'A', 'B'], adj, coords);
    // U→A→B so U isBefore B
    expect(isProvenBefore('U', 'B', order)).toBe(true);
    expect(isProvenBefore('A', 'B', order)).toBe(true);
  });

  // ── Error paths ───────────────────────────────────────────────────────

  it('rejects duplicate ordinary event IDs', () => {
    const adj: AdjacencyList = new Map([
      ['A', []],
      ['B', []],
    ]);
    expect(() => buildStoryOrderIndex(null, ['A', 'A', 'B'], adj, noCoords)).toThrow(
      DagProviderError,
    );
  });

  it('rejects initial root in ordinary event set', () => {
    const adj: AdjacencyList = new Map([
      ['root', ['A']],
      ['A', []],
    ]);
    expect(() => buildStoryOrderIndex('root', ['root', 'A'], adj, noCoords)).toThrow(
      DagProviderError,
    );
  });

  it('rejects unknown predecessor in adjacency', () => {
    const adj: AdjacencyList = new Map([
      ['ghost', ['A']],
      ['A', []],
    ]);
    expect(() => buildStoryOrderIndex(null, ['A'], adj, noCoords)).toThrow(DagProviderError);
  });

  it('rejects unknown dependent in adjacency', () => {
    const adj: AdjacencyList = new Map([['A', ['ghost']]]);
    expect(() => buildStoryOrderIndex(null, ['A'], adj, noCoords)).toThrow(DagProviderError);
  });

  it('rejects cycles with DagCycleError', () => {
    // A → B and B → A
    const adj: AdjacencyList = new Map([
      ['A', ['B']],
      ['B', ['A']],
    ]);
    expect(() => buildStoryOrderIndex(null, ['A', 'B'], adj, noCoords)).toThrow(DagCycleError);
  });

  it('does not mutate the input adjacency', () => {
    const adj: Map<string, string[]> = new Map([
      ['A', ['B']],
      ['B', []],
    ]);
    const frozen: AdjacencyList = adj;
    const order = buildStoryOrderIndex(null, ['A', 'B'], frozen, noCoords);
    expect(adj.get('A')).toEqual(['B']);
    expect(order.topologicalOrder).toEqual(['A', 'B']);
  });
});

// ============================================================================
// isProvenBefore() — edge cases
// ============================================================================

describe('isProvenBefore()', () => {
  it('self is not proven before self', () => {
    const adj: AdjacencyList = new Map([
      ['A', []],
      ['B', []],
    ]);
    const order = buildStoryOrderIndex(null, ['A', 'B'], adj, noCoords);
    expect(isProvenBefore('A', 'A', order)).toBe(false);
  });

  it('returns false for unknown predecessor', () => {
    const adj: AdjacencyList = new Map([
      ['A', []],
      ['B', []],
    ]);
    const order = buildStoryOrderIndex(null, ['A', 'B'], adj, noCoords);
    expect(isProvenBefore('unknown', 'A', order)).toBe(false);
  });

  it('returns false for unknown dependent', () => {
    const adj: AdjacencyList = new Map([
      ['A', []],
      ['B', []],
    ]);
    const order = buildStoryOrderIndex(null, ['A', 'B'], adj, noCoords);
    expect(isProvenBefore('A', 'unknown', order)).toBe(false);
  });

  it('initial root is before every registered dependent', () => {
    const adj: AdjacencyList = new Map([
      ['system:initial', ['A', 'B']],
      ['A', ['B']],
      ['B', []],
    ]);
    const order = buildStoryOrderIndex('system:initial', ['A', 'B'], adj, noCoords);
    expect(isProvenBefore('system:initial', 'A', order)).toBe(true);
    expect(isProvenBefore('system:initial', 'B', order)).toBe(true);
  });
});
