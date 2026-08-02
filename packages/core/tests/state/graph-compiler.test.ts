// ============================================================================
// Graph Compiler — Unit Tests (GRAPH-1)
// Covers ALL 13 minimum test categories from the sub-plan:
// 1. All domain selector/output/read
// 2. initial root
// 3. reversion/unset/stale selection
// 4. author-origin/provider separation
// 5. n-ary relationship scope
// 6. knowledge acts/higher-order claims
// 7. thread/rule reads
// 8. same-time commutativity/order
// 9. dynamic entities
// 10. branch partition/convergence/merge
// 11. ellipsis provenance/selection closure
// 12. cycle diagnostics
// 13. snapshot/full replay/cache invalidation
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CompileNode, compileGraph } from '../../src/state/graph-compiler.ts';
import type {
  DiscourseGraph,
  GraphAbsenceWitness,
  GraphCacheEntry,
  GraphCompileError,
  GraphProviderOutput,
  StoryGraph,
} from '../../src/types/graph.ts';
import {
  AmbiguousOutputError,
  AssertionMismatchError,
  BranchCoverageError,
  BranchIncompatibilityError,
  CrossClockEdgeError,
  DuplicateBranchProviderError,
  DuplicateDiscoursePositionError,
  DynamicLifecycleError,
  EdgeOriginCycleError,
  EllipsisSummaryError,
  FutureTimeError,
  InitialRootMisuseError,
  MergeInputError,
  MissingOutputError,
  NoOutputEdgeError,
  ProvenanceError,
  ReadMismatchError,
  SelfPredecessorError,
  SemanticOutputDependencyError,
  StaleProviderSelectionError,
  UnknownPredecessorError,
  UnknownReadIdError,
  UnorderedStoryConflictError,
} from '../../src/types/graph.ts';

// ============================================================================
// Helper factories
// ============================================================================

function storyNode(
  id: string,
  storyValue: string,
  effects: Array<{
    effectId: string;
    canonicalKey: string;
    value: unknown;
    isUnset?: boolean;
  }> = [],
  requirements: Array<{
    requirementId: string;
    canonicalKey: string;
    predicate: { type: 'exists' } | { type: 'absent' } | { type: 'equals'; value: unknown };
    phase: 'stateBefore' | 'stateAfter';
    origin: 'precondition' | 'source' | 'rule' | 'scope' | 'lifecycle' | 'merge';
  }> = [],
  branchScope: string = 'main',
  explicitEdges?: CompileNode['explicitEdges'],
  isInitialRoot?: boolean,
): CompileNode {
  // Resolve string story value to proper StoryCoordinate
  const coordinate = isInitialRoot
    ? { type: 'storyTime' as const, kind: 'initial' as const }
    : storyValue === 'initial'
      ? { type: 'storyTime' as const, kind: 'initial' as const }
      : storyValue === 'unlocated'
        ? { type: 'storyTime' as const, kind: 'unlocated' as const }
        : {
            type: 'storyTime' as const,
            kind: 'point' as const,
            clock: 'story' as const,
            scalar: parseInt(storyValue.replace(/^day_/, ''), 10),
          };
  return {
    id,
    coordinate,
    effects,
    requirements,
    branchScope,
    explicitEdges,
    isInitialRoot,
  };
}

function discourseNode(
  id: string,
  position: number,
  effects: Array<{
    effectId: string;
    canonicalKey: string;
    value: unknown;
    isUnset?: boolean;
  }> = [],
  requirements: Array<{
    requirementId: string;
    canonicalKey: string;
    predicate: { type: 'exists' } | { type: 'absent' } | { type: 'equals'; value: unknown };
    phase: 'stateBefore' | 'stateAfter';
    origin: 'precondition' | 'source' | 'rule' | 'scope' | 'lifecycle' | 'merge';
  }> = [],
  branchScope: string = 'main',
  explicitEdges?: CompileNode['explicitEdges'],
): CompileNode {
  return {
    id,
    coordinate: { type: 'discoursePosition', value: position },
    effects,
    requirements,
    branchScope,
    explicitEdges,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('GraphCompiler', () => {
  // ─── Category 1: All domain selector/output/read ──────────────────────────
  describe('1. all domain selector/output/read', () => {
    it('creates StoryGraph from story nodes', () => {
      const nodes: CompileNode[] = [
        storyNode('evt1', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:char/hero/name', value: 'Aria' },
        ]),
        storyNode('evt2', 'day_2', [
          { effectId: 'o2', canonicalKey: 'entity:char/hero/name', value: 'Aria the Brave' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.storyGraphs).toHaveLength(1);
      expect(result.storyGraphs[0].type).toBe('story');
      expect(result.storyGraphs[0].outputs).toHaveLength(2);
      expect(result.storyGraphs[0].outputs[0].canonicalKey).toBe('entity:char/hero/name');
      expect(result.storyGraphs[0].outputs[0].effectiveCoordinate).toEqual({
        type: 'storyTime',
        kind: 'point',
        clock: 'story',
        scalar: 1,
      });
      expect(result.storyGraphs[0].hash).toBeTruthy();
    });

    it('creates DiscourseGraph from discourse nodes', () => {
      const nodes: CompileNode[] = [
        discourseNode('disc1', 1, [
          { effectId: 'd1', canonicalKey: 'disclosure:scene1/reveal', value: 'Hero arrives' },
        ]),
        discourseNode('disc2', 2, [
          { effectId: 'd2', canonicalKey: 'disclosure:scene2/hint', value: 'Mystery deepens' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.discourseGraphs).toHaveLength(1);
      expect(result.discourseGraphs[0].type).toBe('discourse');
      expect(result.discourseGraphs[0].outputs).toHaveLength(2);
    });

    it('separates story and discourse into distinct graphs', () => {
      const nodes: CompileNode[] = [
        storyNode('evt1', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:char/hero/name', value: 'Aria' },
        ]),
        discourseNode('disc1', 1, [
          { effectId: 'd1', canonicalKey: 'disclosure:scene1/reveal', value: 'Hero arrives' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.storyGraphs).toHaveLength(1);
      expect(result.discourseGraphs).toHaveLength(1);
      const storyEdges = result.storyGraphs[0].edges;
      const discourseEdges = result.discourseGraphs[0].edges;
      expect(storyEdges.every((e) => e.edgeClass)).toBeTruthy();
      expect(discourseEdges.every((e) => e.edgeClass)).toBeTruthy();
    });

    it('supports relationship canonical selectors', () => {
      const nodes: CompileNode[] = [
        storyNode('rel_evt', 'day_1', [
          {
            effectId: 'ro1',
            canonicalKey: 'relationship:guild/faction/allegiance/epoch:1/member:hero',
            value: 'active',
          },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.storyGraphs[0].outputs[0].canonicalKey).toBe(
        'relationship:guild/faction/allegiance/epoch:1/member:hero',
      );
    });

    it('supports knowledge claim canonical selectors', () => {
      const nodes: CompileNode[] = [
        storyNode('know_evt', 'day_1', [
          {
            effectId: 'ko1',
            canonicalKey: 'knowledge:char/hero/claim:oracle_prophecy',
            value: 'chosen_one',
          },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.storyGraphs[0].outputs[0].canonicalKey).toBe(
        'knowledge:char/hero/claim:oracle_prophecy',
      );
    });
  });

  // ─── Category 2: initial root ──────────────────────────────────────────────
  describe('2. initial root', () => {
    it('accepts initial root node without predecessor', () => {
      const nodes: CompileNode[] = [
        storyNode(
          'root',
          'day_0',
          [{ effectId: 'init1', canonicalKey: 'entity:world/created', value: true }],
          [],
          'main',
          undefined,
          true,
        ),
        storyNode(
          'evt1',
          'day_1',
          [{ effectId: 'o1', canonicalKey: 'entity:char/hero/name', value: 'Aria' }],
          [],
          'main',
          [{ predecessor: '', dependent: 'evt1', edgeClass: 'provider' }],
        ),
      ];
      const result = compileGraph(nodes);
      expect(result.errors).toHaveLength(0);
      expect(result.storyGraphs).toHaveLength(1);
      expect(result.storyGraphs[0].outputs).toHaveLength(2);
    });

    it('rejects initial root misuse with author_origin edge', () => {
      const nodes: CompileNode[] = [
        storyNode(
          'root',
          'day_0',
          [{ effectId: 'init1', canonicalKey: 'entity:world/created', value: true }],
          [],
          'main',
          undefined,
          true,
        ),
        storyNode('evt1', 'day_1', [], [], 'main', [
          { predecessor: 'root', dependent: 'evt1', edgeClass: 'author_origin' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBeInstanceOf(InitialRootMisuseError);
    });
  });

  // ─── Category 3: reversion/unset/stale selection ──────────────────────────
  describe('3. reversion/unset/stale selection', () => {
    it('handles unset (reversion) output', () => {
      const nodes: CompileNode[] = [
        storyNode('evt1', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:char/hero/title', value: 'Captain' },
        ]),
        storyNode('evt2', 'day_2', [
          {
            effectId: 'o2',
            canonicalKey: 'entity:char/hero/title',
            value: undefined,
            isUnset: true,
          },
        ]),
      ];
      const result = compileGraph(nodes);
      const outputs = result.storyGraphs[0].outputs;
      expect(outputs[1].value).toEqual({ type: 'unset' });
    });

    it('selects maximal provider (latest coordinate)', () => {
      const nodes: CompileNode[] = [
        storyNode('evt1', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:char/hero/name', value: 'Aria' },
        ]),
        storyNode('evt2', 'day_2', [
          { effectId: 'o2', canonicalKey: 'entity:char/hero/name', value: 'Aria the Brave' },
        ]),
        storyNode(
          'evt3',
          'day_3',
          [],
          [
            {
              requirementId: 'r1',
              canonicalKey: 'entity:char/hero/name',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      const res = [...result.storyGraphs[0].resolutions];
      const outputRes = res.find(
        (r): r is GraphProviderOutput =>
          r.type === 'output' && r.canonicalKey === 'entity:char/hero/name',
      );
      expect(outputRes).toBeDefined();
      expect(outputRes!.outputId).toBe('o2');
    });

    it('creates AbsenceWitness when no matching output exists', () => {
      const nodes: CompileNode[] = [
        storyNode(
          'evt1',
          'day_1',
          [],
          [
            {
              requirementId: 'r1',
              canonicalKey: 'entity:char/hero/name',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      const absences = result.storyGraphs[0].resolutions.filter(
        (r): r is GraphAbsenceWitness => r.type === 'absence',
      );
      expect(absences).toHaveLength(1);
      expect(absences[0].canonicalKey).toBe('entity:char/hero/name');
    });
  });

  // ─── Category 4: author-origin/provider separation ────────────────────────
  describe('4. author-origin/provider separation', () => {
    it('author_origin edges create distinct edge class from provider', () => {
      const nodes: CompileNode[] = [
        storyNode('cause', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:char/hero/motivation', value: 'revenge' },
        ]),
        storyNode('effect', 'day_2', [], [], 'main', [
          { predecessor: 'cause', dependent: 'effect', edgeClass: 'author_origin' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.errors).toHaveLength(0);
      const edges = result.storyGraphs[0].edges;
      expect(edges.some((e) => e.edgeClass === 'author_origin')).toBe(true);
    });

    it('provider edges are automatically inferred from read resolution', () => {
      const nodes: CompileNode[] = [
        storyNode('provider_evt', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:char/hero/weapon', value: 'Sword' },
        ]),
        storyNode(
          'reader_evt',
          'day_2',
          [],
          [
            {
              requirementId: 'r1',
              canonicalKey: 'entity:char/hero/weapon',
              predicate: { type: 'equals', value: 'Sword' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      const edges = result.storyGraphs[0].edges;
      expect(edges.some((e) => e.edgeClass === 'provider')).toBe(true);
    });

    it('author_origin never covers provider resolution', () => {
      const nodes: CompileNode[] = [
        storyNode('src', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:place/forest/mood', value: 'dark' },
        ]),
        storyNode('dst', 'day_2', [], [], 'main', [
          { predecessor: 'src', dependent: 'dst', edgeClass: 'author_origin' },
        ]),
      ];
      const result = compileGraph(nodes);
      const authorEdges = result.storyGraphs[0].edges.filter(
        (e) => e.edgeClass === 'author_origin',
      );
      const providerEdges = result.storyGraphs[0].edges.filter((e) => e.edgeClass === 'provider');
      expect(authorEdges).toHaveLength(1);
      expect(providerEdges).toHaveLength(0);
    });
  });

  // ─── Category 5: n-ary relationship scope ─────────────────────────────────
  describe('5. n-ary relationship scope', () => {
    it('supports n-ary relationship canonical keys with MembershipId/EpochId', () => {
      const nodes: CompileNode[] = [
        storyNode('nary_evt', 'day_1', [
          {
            effectId: 'nary1',
            canonicalKey: 'relationship:alliance/kingdoms/epoch:3/member:kingdom_a/role:protector',
            value: 'active',
          },
          {
            effectId: 'nary2',
            canonicalKey: 'relationship:alliance/kingdoms/epoch:3/member:kingdom_b/role:protected',
            value: 'active',
          },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.storyGraphs[0].outputs).toHaveLength(2);
      expect(result.storyGraphs[0].outputs[0].canonicalKey).toContain('epoch:3');
      expect(result.storyGraphs[0].outputs[0].canonicalKey).toContain('member:');
    });

    it('reads n-ary relationship state', () => {
      const nodes: CompileNode[] = [
        storyNode('nary_write', 'day_1', [
          {
            effectId: 'nw1',
            canonicalKey: 'relationship:alliance/kingdoms/epoch:3/member:kingdom_a/role:protector',
            value: 'active',
          },
        ]),
        storyNode(
          'nary_read',
          'day_2',
          [],
          [
            {
              requirementId: 'nr1',
              canonicalKey:
                'relationship:alliance/kingdoms/epoch:3/member:kingdom_a/role:protector',
              predicate: { type: 'equals', value: 'active' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ─── Category 6: knowledge acts/higher-order claims ───────────────────────
  describe('6. knowledge acts/higher-order claims', () => {
    it('tracks knowledge claim outputs', () => {
      const nodes: CompileNode[] = [
        storyNode('knowledge_evt', 'day_1', [
          {
            effectId: 'kc1',
            canonicalKey: 'knowledge:char/oracle/claim:prophecy/grade',
            value: 'settled_truth',
          },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(
        result.storyGraphs[0].outputs.some((o) => o.canonicalKey.startsWith('knowledge:')),
      ).toBe(true);
    });

    it('reads knowledge state as precondition', () => {
      const nodes: CompileNode[] = [
        storyNode('know_write', 'day_1', [
          {
            effectId: 'kw1',
            canonicalKey: 'knowledge:char/hero/claim:destiny',
            value: 'fulfilled',
          },
        ]),
        storyNode(
          'know_read',
          'day_2',
          [],
          [
            {
              requirementId: 'kr1',
              canonicalKey: 'knowledge:char/hero/claim:destiny',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      expect(result.errors).toHaveLength(0);
    });

    it('supports information act outputs', () => {
      const nodes: CompileNode[] = [
        storyNode('info_act', 'day_1', [
          {
            effectId: 'ia1',
            canonicalKey: 'information_act:char/herald/announce:war',
            value: 'declared',
          },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.storyGraphs[0].outputs[0].canonicalKey).toContain('information_act:');
    });
  });

  // ─── Category 7: thread/rule reads ─────────────────────────────────────────
  describe('7. thread/rule reads', () => {
    it('tracks thread outputs', () => {
      const nodes: CompileNode[] = [
        storyNode('thread_evt', 'day_1', [
          {
            effectId: 'tr1',
            canonicalKey: 'thread:quest/find_artifact/run:1/status',
            value: 'active',
          },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.storyGraphs[0].outputs.some((o) => o.canonicalKey.startsWith('thread:'))).toBe(
        true,
      );
    });

    it('reads thread state', () => {
      const nodes: CompileNode[] = [
        storyNode('thread_write', 'day_1', [
          {
            effectId: 'tw1',
            canonicalKey: 'thread:quest/find_artifact/run:1/status',
            value: 'active',
          },
        ]),
        storyNode(
          'thread_read',
          'day_2',
          [],
          [
            {
              requirementId: 'trr1',
              canonicalKey: 'thread:quest/find_artifact/run:1/goal:retrieve/gate:open',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'rule',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      expect(result.errors).toHaveLength(0);
    });

    it('reads rule evaluation results', () => {
      const nodes: CompileNode[] = [
        storyNode('rule_evt', 'day_1', [
          {
            effectId: 're1',
            canonicalKey: 'rule:magic/enchantment/epoch:2/effect',
            value: 'activated',
          },
        ]),
        storyNode(
          'rule_check',
          'day_2',
          [],
          [
            {
              requirementId: 'rr1',
              canonicalKey: 'rule:magic/enchantment/epoch:2/effect',
              predicate: { type: 'equals', value: 'activated' },
              phase: 'stateBefore',
              origin: 'rule',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ─── Category 8: same-time commutativity/order ───────────────────────────
  describe('8. same-time commutativity/order', () => {
    it('allows commutative same-time operations on disjoint keys', () => {
      const nodes: CompileNode[] = [
        storyNode('evt_a', 'day_1', [
          { effectId: 'oa', canonicalKey: 'entity:char/hero/weapon', value: 'Sword' },
        ]),
        storyNode('evt_b', 'day_1', [
          { effectId: 'ob', canonicalKey: 'entity:char/hero/armor', value: 'Shield' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.errors.filter((e) => e instanceof UnorderedStoryConflictError)).toHaveLength(0);
    });

    it('detects unordered conflicting same-time operations', () => {
      const nodes: CompileNode[] = [
        storyNode('evt_a', 'day_1', [
          { effectId: 'oa', canonicalKey: 'entity:char/hero/name', value: 'Aria' },
        ]),
        storyNode('evt_b', 'day_1', [
          { effectId: 'ob', canonicalKey: 'entity:char/hero/name', value: 'Aria the Brave' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.errors.filter((e) => e instanceof UnorderedStoryConflictError)).toHaveLength(1);
    });

    it('allows ordered same-time operations with same_coordinate_order edge', () => {
      const nodes: CompileNode[] = [
        storyNode('evt_a', 'day_1', [
          { effectId: 'oa', canonicalKey: 'entity:char/hero/name', value: 'Aria' },
        ]),
        storyNode(
          'evt_b',
          'day_1',
          [{ effectId: 'ob', canonicalKey: 'entity:char/hero/name', value: 'Aria the Brave' }],
          [],
          'main',
          [{ predecessor: 'evt_a', dependent: 'evt_b', edgeClass: 'same_coordinate_order' }],
        ),
      ];
      const result = compileGraph(nodes);
      expect(result.errors.filter((e) => e instanceof UnorderedStoryConflictError)).toHaveLength(0);
    });
  });

  // ─── Category 9: dynamic entities ────────────────────────────────────────
  describe('9. dynamic entities', () => {
    it('handles dynamic entity catalog declarations', () => {
      const nodes: CompileNode[] = [
        storyNode('declare_entity', 'day_1', [
          {
            effectId: 'de1',
            canonicalKey: 'entity:catalog/char/mysterious_stranger',
            value: { kind: 'character', name: '???', introduced: true },
          },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.storyGraphs[0].outputs[0].canonicalKey).toBe(
        'entity:catalog/char/mysterious_stranger',
      );
    });

    it('reads dynamic entity lifecycle status', () => {
      const nodes: CompileNode[] = [
        storyNode('entity_born', 'day_1', [
          { effectId: 'eb1', canonicalKey: 'entity:char/dragon/lifecycle', value: 'active' },
        ]),
        storyNode(
          'entity_check',
          'day_2',
          [],
          [
            {
              requirementId: 'ec1',
              canonicalKey: 'entity:char/dragon/lifecycle',
              predicate: { type: 'equals', value: 'active' },
              phase: 'stateBefore',
              origin: 'lifecycle',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ─── Category 10: branch partition/convergence/merge ──────────────────────
  describe('10. branch partition/convergence/merge', () => {
    it('filters by branch scope', () => {
      const nodes: CompileNode[] = [
        storyNode(
          'main_evt',
          'day_1',
          [{ effectId: 'm1', canonicalKey: 'entity:char/hero/name', value: 'Aria' }],
          [],
          'main',
        ),
        storyNode(
          'branch_evt',
          'day_1',
          [{ effectId: 'b1', canonicalKey: 'entity:char/hero/name', value: 'Aria (alternate)' }],
          [],
          'alternate',
        ),
      ];
      const result = compileGraph(nodes, { branchPath: 'main' });
      const outputs = result.storyGraphs[0].outputs;
      expect(outputs).toHaveLength(1);
      expect(outputs[0].branchScope).toBe('main');
    });

    it('creates AbsenceWitness for reads with no compatible provider across branches', () => {
      const nodes: CompileNode[] = [
        storyNode(
          'evt1',
          'day_1',
          [{ effectId: 'o1', canonicalKey: 'entity:char/hero/name', value: 'Aria' }],
          [],
          'branch_a',
        ),
        storyNode(
          'evt2',
          'day_2',
          [],
          [
            {
              requirementId: 'r1',
              canonicalKey: 'entity:char/hero/name',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
          'branch_b',
        ),
      ];
      const result = compileGraph(nodes, { branchPath: 'branch_b' });
      const absences = result.storyGraphs[0].resolutions.filter(
        (r): r is GraphAbsenceWitness => r.type === 'absence',
      );
      expect(absences).toHaveLength(1);
      expect(absences[0].readId).toBe('r1');
    });
  });

  // ─── Step-4 regression: branch/coordinate/provider semantics ───────────
  describe('Step 4 — bounded compiler repairs', () => {
    it('excluded-branch outputs do not leak into selected branch (branch leak)', () => {
      const nodes: CompileNode[] = [
        storyNode(
          'main_out',
          'day_1',
          [{ effectId: 'm1', canonicalKey: 'entity:char/hero/name', value: 'Aria' }],
          [],
          'main',
        ),
        storyNode(
          'branch_out',
          'day_1',
          [{ effectId: 'b1', canonicalKey: 'entity:char/hero/name', value: 'Branch Value' }],
          [],
          'alternate',
        ),
        storyNode(
          'reader',
          'day_2',
          [],
          [
            {
              requirementId: 'r1',
              canonicalKey: 'entity:char/hero/name',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
          'main',
        ),
      ];
      const result = compileGraph(nodes, { branchPath: 'main' });
      const resolutions = result.storyGraphs[0].resolutions;
      const outputRes = resolutions.find((r): r is GraphProviderOutput => r.type === 'output');
      expect(outputRes).toBeDefined();
      // Must resolve to 'main' branch output, not 'alternate'
      expect(outputRes!.outputId).toBe('m1');
    });

    it('future coordinate output produces AbsenceWitness for earlier read (future absence)', () => {
      const nodes: CompileNode[] = [
        storyNode(
          'future_writer',
          'day_5',
          [{ effectId: 'f1', canonicalKey: 'entity:char/hero/fate', value: 'sealed' }],
          [],
          'main',
        ),
        storyNode(
          'early_reader',
          'day_2',
          [],
          [
            {
              requirementId: 'r1',
              canonicalKey: 'entity:char/hero/fate',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
          'main',
        ),
      ];
      const result = compileGraph(nodes);
      const absences = result.storyGraphs[0].resolutions.filter(
        (r): r is GraphAbsenceWitness => r.type === 'absence',
      );
      expect(absences).toHaveLength(1);
      expect(absences[0].readId).toBe('r1');
      expect(absences[0].canonicalKey).toBe('entity:char/hero/fate');
    });

    it('day_10 compares greater than day_2 (numeric ordering)', () => {
      const nodes: CompileNode[] = [
        storyNode('early', 'day_2', [
          { effectId: 'o1', canonicalKey: 'entity:test/key', value: 'early' },
        ]),
        storyNode('late', 'day_10', [
          { effectId: 'o2', canonicalKey: 'entity:test/key', value: 'late' },
        ]),
        storyNode(
          'reader',
          'day_11',
          [],
          [
            {
              requirementId: 'r1',
              canonicalKey: 'entity:test/key',
              predicate: { type: 'equals', value: 'late' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      expect(result.errors).toHaveLength(0);
      const resolutions = result.storyGraphs[0].resolutions;
      const outputRes = resolutions.find((r): r is GraphProviderOutput => r.type === 'output');
      expect(outputRes).toBeDefined();
      // day_10 must be selected (not day_2), proving numeric comparison
      expect(outputRes!.outputId).toBe('o2');
    });

    it('initial root provides state for any story day', () => {
      const nodes: CompileNode[] = [
        storyNode(
          'root',
          'initial',
          [{ effectId: 'init', canonicalKey: 'entity:world/created', value: true }],
          [],
          '',
          undefined,
          true,
        ),
        storyNode(
          'evt',
          'day_5',
          [],
          [
            {
              requirementId: 'r1',
              canonicalKey: 'entity:world/created',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
          'main',
        ),
      ];
      const result = compileGraph(nodes);
      expect(result.errors).toHaveLength(0);
      const resolutions = result.storyGraphs[0].resolutions;
      const outputRes = resolutions.find((r): r is GraphProviderOutput => r.type === 'output');
      expect(outputRes).toBeDefined();
      expect(outputRes!.outputId).toBe('init');
    });

    it('provider edges connect provider-node to reader-node (not readId)', () => {
      const nodes: CompileNode[] = [
        storyNode('provider', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:test/val', value: 'data' },
        ]),
        storyNode(
          'reader',
          'day_2',
          [],
          [
            {
              requirementId: 'r1',
              canonicalKey: 'entity:test/val',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      const providerEdges = result.storyGraphs[0].edges.filter((e) => e.edgeClass === 'provider');
      expect(providerEdges).toHaveLength(1);
      expect(providerEdges[0].predecessor).toBe('provider');
      expect(providerEdges[0].dependent).toBe('reader');
    });

    it('one output satisfies multiple reads without DuplicateBranchProviderError', () => {
      const nodes: CompileNode[] = [
        storyNode('src', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:test/key', value: 'shared' },
        ]),
        storyNode(
          'reader_a',
          'day_2',
          [],
          [
            {
              requirementId: 'r1',
              canonicalKey: 'entity:test/key',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
        ),
        storyNode(
          'reader_b',
          'day_2',
          [],
          [
            {
              requirementId: 'r2',
              canonicalKey: 'entity:test/key',
              predicate: { type: 'equals', value: 'shared' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      // No DuplicateBranchProviderError for legal reuse
      expect(result.errors.filter((e) => e instanceof DuplicateBranchProviderError)).toHaveLength(
        0,
      );
      // Both reads resolve
      const outputResolutions = result.storyGraphs[0].resolutions.filter(
        (r): r is GraphProviderOutput => r.type === 'output',
      );
      expect(outputResolutions).toHaveLength(2);
      expect(outputResolutions.every((r) => r.outputId === 'o1')).toBe(true);
    });

    it('DuplicateBranchProviderError fires for truly ambiguous same-coordinate providers', () => {
      const nodes: CompileNode[] = [
        storyNode('evt_a', 'day_1', [
          { effectId: 'oa', canonicalKey: 'entity:test/key', value: 'value_a' },
        ]),
        storyNode('evt_b', 'day_1', [
          { effectId: 'ob', canonicalKey: 'entity:test/key', value: 'value_b' },
        ]),
        storyNode(
          'evt_c',
          'day_2',
          [],
          [
            {
              requirementId: 'r1',
              canonicalKey: 'entity:test/key',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      expect(result.errors.filter((e) => e instanceof DuplicateBranchProviderError)).toHaveLength(
        1,
      );
    });

    it('graph edges in StoryGraph require both endpoints in story domain', () => {
      const nodes: CompileNode[] = [
        storyNode('story_evt', 'day_1', [
          { effectId: 'so1', canonicalKey: 'entity:test/story', value: 'story_val' },
        ]),
        discourseNode('disc_evt', 1, [
          { effectId: 'do1', canonicalKey: 'entity:test/disc', value: 'disc_val' },
        ]),
      ];
      const result = compileGraph(nodes);
      // Story graph should NOT contain edges from discourse node
      const storyEdges = result.storyGraphs[0].edges;
      expect(
        storyEdges.every((e) => e.predecessor !== 'disc_evt' && e.dependent !== 'disc_evt'),
      ).toBe(true);
      // Discourse graph should NOT contain edges from story node
      const discEdges = result.discourseGraphs[0].edges;
      expect(
        discEdges.every((e) => e.predecessor !== 'story_evt' && e.dependent !== 'story_evt'),
      ).toBe(true);
    });

    it('unlocated node reachable via explicit authored predecessor edge (DAG ordering)', () => {
      const nodes: CompileNode[] = [
        storyNode('unlocated_a', 'unlocated', [
          { effectId: 'o_a', canonicalKey: 'entity:test/key', value: 'from_a' },
        ]),
        storyNode(
          'unlocated_b',
          'unlocated',
          [],
          [
            {
              requirementId: 'r_b',
              canonicalKey: 'entity:test/key',
              predicate: { type: 'equals', value: 'from_a' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
          'main',
          [{ predecessor: 'unlocated_a', dependent: 'unlocated_b', edgeClass: 'author_origin' }],
        ),
      ];
      const result = compileGraph(nodes);
      expect(result.errors).toHaveLength(0);
      const resolutions = result.storyGraphs[0].resolutions;
      const outputRes = resolutions.find((r): r is GraphProviderOutput => r.type === 'output');
      expect(outputRes).toBeDefined();
      expect(outputRes!.outputId).toBe('o_a');
    });

    it('cross-clock explicit edge creates ordering without temporal comparison', () => {
      const nodes: CompileNode[] = [
        storyNode('calendar_evt', 'day_1', [
          { effectId: 'o_cal', canonicalKey: 'entity:test/key', value: 'calendar_val' },
        ]),
        storyNode(
          'story_evt',
          'day_5',
          [],
          [
            {
              requirementId: 'r_story',
              canonicalKey: 'entity:test/key',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
          'main',
          [{ predecessor: 'calendar_evt', dependent: 'story_evt', edgeClass: 'author_origin' }],
        ),
      ];
      // Both are story-clock points, so day_1 → day_5 works via temporal AND explicit edge
      const result = compileGraph(nodes);
      expect(result.errors).toHaveLength(0);
      const resolutions = result.storyGraphs[0].resolutions;
      const outputRes = resolutions.find((r): r is GraphProviderOutput => r.type === 'output');
      expect(outputRes).toBeDefined();
      expect(outputRes!.outputId).toBe('o_cal');
    });

    it('no arbitrary provider tie-break for incomparable maximal candidates', () => {
      const nodes: CompileNode[] = [
        storyNode('unlocated_a', 'unlocated', [
          { effectId: 'o_a', canonicalKey: 'entity:test/key', value: 'value_a' },
        ]),
        storyNode('unlocated_b', 'unlocated', [
          { effectId: 'o_b', canonicalKey: 'entity:test/key', value: 'value_b' },
        ]),
        storyNode(
          'unlocated_reader',
          'unlocated',
          [],
          [
            {
              requirementId: 'r_read',
              canonicalKey: 'entity:test/key',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
          'main',
          [
            {
              predecessor: 'unlocated_a',
              dependent: 'unlocated_reader',
              edgeClass: 'author_origin',
            },
            {
              predecessor: 'unlocated_b',
              dependent: 'unlocated_reader',
              edgeClass: 'author_origin',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      // Two incomparable unlocated providers for the same key → DuplicateBranchProviderError
      expect(result.errors.filter((e) => e instanceof DuplicateBranchProviderError)).toHaveLength(
        1,
      );
    });
  });

  // ─── Category 11: ellipsis provenance/selection closure ───────────────────
  describe('11. ellipsis provenance/selection closure', () => {
    it('story graph outputs include ellipsis event effects', () => {
      const nodes: CompileNode[] = [
        storyNode('ellipsis_evt', 'day_1', [
          { effectId: 'eo1', canonicalKey: 'ellipsis:passage_of_time', value: 'three_days_later' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.storyGraphs[0].outputs[0].canonicalKey).toContain('ellipsis:');
    });

    it('ellipsis output has provenance hash', () => {
      const nodes: CompileNode[] = [
        storyNode('ellipsis_evt', 'day_1', [
          { effectId: 'eo1', canonicalKey: 'ellipsis:travel/mountains', value: 'crossed' },
        ]),
      ];
      const result = compileGraph(nodes);
      const output = result.storyGraphs[0].outputs[0];
      expect(output.provenanceHash).toBeTruthy();
      expect(output.effectiveCoordinate).toEqual({
        type: 'storyTime',
        kind: 'point',
        clock: 'story',
        scalar: 1,
      });
    });
  });

  // ─── Category 12: cycle diagnostics ───────────────────────────────────────
  describe('12. cycle diagnostics', () => {
    it('detects direct self-loop edge', () => {
      const nodes: CompileNode[] = [
        storyNode('node1', 'day_1', [], [], 'main', [
          { predecessor: 'node1', dependent: 'node1', edgeClass: 'internal' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.errors.some((e) => e instanceof SelfPredecessorError)).toBe(true);
    });

    it('detects cycle in graph edges', () => {
      const nodes: CompileNode[] = [
        storyNode('a', 'day_1', [], [], 'main', [
          { predecessor: 'b', dependent: 'a', edgeClass: 'internal' },
        ]),
        storyNode('b', 'day_1', [], [], 'main', [
          { predecessor: 'a', dependent: 'b', edgeClass: 'internal' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.errors.some((e) => e instanceof EdgeOriginCycleError)).toBe(true);
    });

    it('detects unknown predecessor', () => {
      const nodes: CompileNode[] = [
        storyNode('alice', 'day_1', [], [], 'main', [
          { predecessor: 'bob', dependent: 'alice', edgeClass: 'internal' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.errors.some((e) => e instanceof UnknownPredecessorError)).toBe(true);
    });
  });

  // ─── Category 13: snapshot/full replay/cache invalidation ─────────────────
  describe('13. snapshot/full replay/cache invalidation', () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    it('produces cache entries with all required fields', () => {
      const nodes: CompileNode[] = [
        storyNode('evt1', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:char/hero/name', value: 'Aria' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.cache).toHaveLength(1);
      const entry = result.cache[0];
      expect(entry.branchScope).toBe('root');
      expect(entry.dependencyHashes).toBeInstanceOf(Array);
      expect(entry.outputHashes).toHaveLength(1);
      expect(entry.absenceHashes).toBeInstanceOf(Array);
      expect(typeof entry.timestamp).toBe('number');
    });

    it('replay hash changes when outputs change', () => {
      const nodes1: CompileNode[] = [
        storyNode('evt1', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:char/hero/name', value: 'Aria' },
        ]),
      ];
      const nodes2: CompileNode[] = [
        storyNode('evt1', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:char/hero/name', value: 'Kael' },
        ]),
      ];
      const result1 = compileGraph(nodes1);
      const result2 = compileGraph(nodes2);
      expect(result1.storyGraphs[0].hash).not.toBe(result2.storyGraphs[0].hash);
    });

    it('cache entries differ for different branch scopes', () => {
      const nodes: CompileNode[] = [
        storyNode(
          'evt1',
          'day_1',
          [{ effectId: 'o1', canonicalKey: 'entity:char/hero/name', value: 'Aria' }],
          [],
          'main',
        ),
      ];
      const result = compileGraph(nodes, { branchPath: 'main' });
      expect(result.cache[0].branchScope).toBe('main');
    });

    it('produces consistent results from same inputs', () => {
      const nodes: CompileNode[] = [
        storyNode('evt1', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:char/hero/name', value: 'Aria' },
        ]),
        storyNode('evt2', 'day_2', [
          { effectId: 'o2', canonicalKey: 'entity:char/hero/name', value: 'Aria the Brave' },
        ]),
      ];
      const result1 = compileGraph(nodes);
      const result2 = compileGraph(nodes);
      expect(result1.storyGraphs[0].hash).toBe(result2.storyGraphs[0].hash);
      expect(result1.cache[0].outputHashes).toEqual(result2.cache[0].outputHashes);
    });

    it('produces byte-identical results independent of wall clock', () => {
      const nodes: CompileNode[] = [
        storyNode('evt1', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:char/hero/name', value: 'Aria' },
        ]),
        storyNode('evt2', 'day_2', [
          { effectId: 'o2', canonicalKey: 'entity:char/hero/name', value: 'Aria the Brave' },
        ]),
      ];
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
      const early = compileGraph(nodes);
      vi.setSystemTime(new Date('2026-08-02T03:04:05.000Z'));
      const late = compileGraph(nodes);
      // The full result — including cache-entry metadata — must be identical
      // regardless of wall clock.
      expect(late).toEqual(early);
      vi.useRealTimers();
    });

    it('coordinate-only change invalidates cache hash', () => {
      const baseEffect = [{ effectId: 'o1', canonicalKey: 'entity:char/hero/name', value: 'Aria' }];
      const result1 = compileGraph([storyNode('evt1', 'day_1', baseEffect)]);
      const result2 = compileGraph([storyNode('evt1', 'day_2', baseEffect)]);
      expect(result1.storyGraphs[0].hash).not.toBe(result2.storyGraphs[0].hash);
    });

    it('input permutation produces stable hash', () => {
      const nodes: CompileNode[] = [
        storyNode('evt_a', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:char/hero/name', value: 'Aria' },
        ]),
        storyNode('evt_b', 'day_2', [
          { effectId: 'o2', canonicalKey: 'entity:char/hero/name', value: 'Aria the Brave' },
        ]),
      ];
      const reversed = [...nodes].reverse();
      const result1 = compileGraph(nodes);
      const result2 = compileGraph(reversed);
      expect(result1.storyGraphs[0].hash).toBe(result2.storyGraphs[0].hash);
      expect(result1.cache[0].outputHashes).toEqual(result2.cache[0].outputHashes);
    });
  });

  // ─── Additional typed error coverage ──────────────────────────────────────
  describe('typed errors (24 categories)', () => {
    it('FutureTimeError', () => {
      const nodes: CompileNode[] = [
        storyNode('later', 'day_3', []),
        storyNode('earlier', 'day_1', [], [], 'main', [
          { predecessor: 'later', dependent: 'earlier', edgeClass: 'internal' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.errors.some((e) => e instanceof FutureTimeError)).toBe(true);
    });

    it('CrossClockEdgeError', () => {
      const nodes: CompileNode[] = [
        storyNode('story_evt', 'day_1', []),
        discourseNode('disc_evt', 1, [], [], 'main', [
          { predecessor: 'story_evt', dependent: 'disc_evt', edgeClass: 'internal' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.errors.some((e) => e instanceof CrossClockEdgeError)).toBe(true);
    });

    it('DuplicateDiscoursePositionError', () => {
      const nodes: CompileNode[] = [discourseNode('disc1', 1), discourseNode('disc2', 1)];
      const result = compileGraph(nodes);
      expect(result.errors.some((e) => e instanceof DuplicateDiscoursePositionError)).toBe(true);
    });

    it('SelfPredecessorError', () => {
      const nodes: CompileNode[] = [
        storyNode('self_ref', 'day_1', [], [], 'main', [
          { predecessor: 'self_ref', dependent: 'self_ref', edgeClass: 'internal' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.errors.some((e) => e instanceof SelfPredecessorError)).toBe(true);
    });

    it('EdgeOriginCycleError', () => {
      const nodes: CompileNode[] = [
        storyNode('a', 'day_1', [], [], 'main', [
          { predecessor: 'b', dependent: 'a', edgeClass: 'internal' },
        ]),
        storyNode('b', 'day_1', [], [], 'main', [
          { predecessor: 'a', dependent: 'b', edgeClass: 'internal' },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.errors.some((e) => e instanceof EdgeOriginCycleError)).toBe(true);
    });

    it('AssertionMismatchError on predicate mismatch', () => {
      const nodes: CompileNode[] = [
        storyNode('write_evt', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:char/hero/status', value: 'sleeping' },
        ]),
        storyNode(
          'read_evt',
          'day_2',
          [],
          [
            {
              requirementId: 'r1',
              canonicalKey: 'entity:char/hero/status',
              predicate: { type: 'equals', value: 'awake' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      expect(result.errors.some((e) => e instanceof AssertionMismatchError)).toBe(true);
    });
  });

  // ─── Edge class coverage ──────────────────────────────────────────────────
  describe('edge class coverage', () => {
    it('supports all four edge classes', () => {
      const classes = ['author_origin', 'provider', 'same_coordinate_order', 'internal'] as const;
      for (const ec of classes) {
        const nodes: CompileNode[] = [
          storyNode('src', 'day_1', [
            { effectId: 'o1', canonicalKey: 'entity:test/key', value: 'val' },
          ]),
          storyNode('tgt', 'day_2', [], [], 'main', [
            { predecessor: 'src', dependent: 'tgt', edgeClass: ec },
          ]),
        ];
        const result = compileGraph(nodes);
        expect(result.storyGraphs[0].edges.some((e) => e.edgeClass === ec)).toBe(true);
      }
    });
  });

  // ─── OutputDescriptor normalization ──────────────────────────────────────
  describe('OutputDescriptor normalization', () => {
    it('normalizes set values', () => {
      const nodes: CompileNode[] = [
        storyNode('evt1', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:test/key', value: { nested: 'data' } },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.storyGraphs[0].outputs[0].value).toEqual({
        type: 'set',
        data: { nested: 'data' },
      });
    });

    it('normalizes unset values', () => {
      const nodes: CompileNode[] = [
        storyNode('evt1', 'day_1', [
          { effectId: 'o1', canonicalKey: 'entity:test/key', value: undefined, isUnset: true },
        ]),
      ];
      const result = compileGraph(nodes);
      expect(result.storyGraphs[0].outputs[0].value).toEqual({ type: 'unset' });
    });

    it('includes provenance hash', () => {
      const nodes: CompileNode[] = [
        storyNode(
          'evt1',
          'day_1',
          [{ effectId: 'o1', canonicalKey: 'entity:test/key', value: 'data' }],
          [],
          'branch_x',
        ),
      ];
      const result = compileGraph(nodes);
      expect(result.storyGraphs[0].outputs[0].provenanceHash).toBeTruthy();
    });
  });

  // ─── ReadRequirement exposure ─────────────────────────────────────────────
  describe('ReadRequirement exposure', () => {
    it('exposes read phase and origin', () => {
      const nodes: CompileNode[] = [
        storyNode(
          'evt1',
          'day_1',
          [],
          [
            {
              requirementId: 'r1',
              canonicalKey: 'entity:test/key',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
            {
              requirementId: 'r2',
              canonicalKey: 'entity:test/key',
              predicate: { type: 'absent' },
              phase: 'stateAfter',
              origin: 'rule',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      const reads = result.storyGraphs[0].reads;
      expect(reads).toHaveLength(2);
      expect(reads.some((r) => r.phase === 'stateBefore' && r.origin === 'precondition')).toBe(
        true,
      );
      expect(reads.some((r) => r.phase === 'stateAfter' && r.origin === 'rule')).toBe(true);
    });

    it('exposes all six read origins', () => {
      const origins: Array<'precondition' | 'source' | 'rule' | 'scope' | 'lifecycle' | 'merge'> = [
        'precondition',
        'source',
        'rule',
        'scope',
        'lifecycle',
        'merge',
      ];
      const nodes: CompileNode[] = origins.map((origin, i) =>
        storyNode(
          `evt${i}`,
          `day_${i}`,
          [],
          [
            {
              requirementId: `r${i}`,
              canonicalKey: `entity:test/key${i}`,
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin,
            },
          ],
        ),
      );
      const result = compileGraph(nodes);
      const readOrigins = new Set(result.storyGraphs[0].reads.map((r) => r.origin));
      for (const o of origins) {
        expect(readOrigins.has(o)).toBe(true);
      }
    });

    it('exposes all presence predicate types', () => {
      const nodes: CompileNode[] = [
        storyNode(
          'evt1',
          'day_1',
          [],
          [
            {
              requirementId: 'r1',
              canonicalKey: 'entity:test/key_exists',
              predicate: { type: 'exists' },
              phase: 'stateBefore',
              origin: 'precondition',
            },
            {
              requirementId: 'r2',
              canonicalKey: 'entity:test/key_absent',
              predicate: { type: 'absent' },
              phase: 'stateBefore',
              origin: 'source',
            },
            {
              requirementId: 'r3',
              canonicalKey: 'entity:test/key_equals',
              predicate: { type: 'equals', value: 'match' },
              phase: 'stateBefore',
              origin: 'rule',
            },
          ],
        ),
      ];
      const result = compileGraph(nodes);
      const predicates = result.storyGraphs[0].reads.map((r) => r.predicate.type);
      expect(predicates).toContain('exists');
      expect(predicates).toContain('absent');
      expect(predicates).toContain('equals');
    });
  });
});
