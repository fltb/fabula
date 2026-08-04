// ============================================================================
// Novalistically — Technique Resolver Tests (GRAPH-3)
// Covers all eight direct technique kinds and hard-error rejection paths.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { resolveNarrativeTechniques } from '../../src/state/technique-resolver.ts';
import type { NarratorAssertion } from '../../src/types/discourse.ts';
import type { NarrativeEvent } from '../../src/types/event.ts';
import type { DiscourseGraph, GraphEdge, StoryGraph } from '../../src/types/graph.ts';
import type {
  AbsentApparatus,
  CausalDiscontinuity,
  CausalMultiplicity,
  IrresolvableIndeterminacy,
  MetanarrativeLevel,
  Multiplicity,
  SurfaceMode,
  VoiceDissonance,
} from '../../src/types/narrative-techniques.ts';

// ═════════════════════════════════════════════════════════════════════════════
// Test Helpers — each returns fully-typed objects
// ═════════════════════════════════════════════════════════════════════════════

const BRANCH_SCOPE = '';
const PROVIDER_HASH = 'hash000';

function storyTimeCoordinate(day: number): { type: 'storyTime'; value: string } {
  return { type: 'storyTime', value: `day_${day}` };
}

function storyEdge(
  predecessor: string,
  dependent: string,
  edgeClass: 'author_origin' | 'provider',
): GraphEdge {
  return { predecessor, dependent, edgeClass };
}

function storyOutput(
  outputId: string,
  canonicalKey: string,
  day: number,
): StoryGraph['outputs'][number] {
  return {
    outputId,
    canonicalKey,
    value: { type: 'set', data: `${outputId}_value` },
    branchScope: BRANCH_SCOPE,
    effectiveCoordinate: storyTimeCoordinate(day),
    provenanceHash: `${PROVIDER_HASH}:${outputId}`,
  };
}

function storyAbsenceResolution(
  readId: string,
  canonicalKey: string,
): StoryGraph['resolutions'][number] {
  return {
    type: 'absence',
    readId,
    canonicalKey,
    reason: 'No provider found on branch',
  };
}

function storyProviderResolution(
  outputId: string,
  canonicalKey: string,
  day: number,
): StoryGraph['resolutions'][number] {
  return {
    type: 'output',
    outputId,
    canonicalKey,
    coordinate: storyTimeCoordinate(day),
    provenanceHash: `${PROVIDER_HASH}:${outputId}`,
  };
}

function discOutput(
  outputId: string,
  canonicalKey: string,
  data: Record<string, unknown>,
  pos: number,
): DiscourseGraph['outputs'][number] {
  return {
    outputId,
    canonicalKey,
    value: { type: 'set', data },
    branchScope: BRANCH_SCOPE,
    effectiveCoordinate: { type: 'discoursePosition', value: pos },
    provenanceHash: `${PROVIDER_HASH}:disc:${outputId}`,
  };
}

const EMPTY_SCENE_SEQUENCE: DiscourseGraph['sceneSequence'] = [];

function baseEvent(id: string, day: number): NarrativeEvent {
  return {
    id,
    event: id,
    narrativeOrder: day,
    title: id,
    storyTime: { type: 'absolute', value: `day_${day}` },
    sceneType: 'linear',
    pov: { character: 'narrator', type: 'omniscient' },
    sceneBrief: id,
    beats: [id],
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
  };
}

function makeAssertion(id: string): NarratorAssertion {
  return {
    id,
    narrator: 'narrator',
    proposition: `prop_${id}`,
    polarity: 'affirmative',
    type: 'claim',
    status: 'unknown',
    narrationBoundary: { narratorId: 'narrator' },
  };
}

// ── Minimal valid graphs shared by most tests ──────────────────────────

/**
 * Build a StoryGraph with given edges, outputs, and resolutions.
 * The responses array is an alternating list of output-or-absence entries
 * with the shape expected by GraphReadResolution union.
 */
function buildStoryGraph(opts: {
  edges?: GraphEdge[];
  outputs?: StoryGraph['outputs'];
  reads?: StoryGraph['reads'];
  resolutions?: StoryGraph['resolutions'];
}): StoryGraph {
  return {
    type: 'story',
    edges: opts.edges ?? [],
    outputs: opts.outputs ?? [],
    reads: opts.reads ?? [],
    resolutions: opts.resolutions ?? [],
    hash: 'story-hash-base',
    effectiveCoordinate: { type: 'storyTime', value: 'day_1' },
  };
}

function buildDiscourseGraph(opts: { outputs?: DiscourseGraph['outputs'] }): DiscourseGraph {
  return {
    type: 'discourse',
    edges: [],
    outputs: opts.outputs ?? [],
    hash: 'discourse-hash-base',
    effectiveCoordinate: { type: 'discoursePosition', value: 0 },
    sceneSequence: EMPTY_SCENE_SEQUENCE,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveNarrativeTechniques', () => {
  // ── surfaceMode ──────────────────────────────────────────────────────

  describe('surfaceMode', () => {
    it('resolves surfaceMode contract with no external references', () => {
      const sm: SurfaceMode = {
        instruction: 'Use vivid sensory language',
        requiredEvidence: 'Sensory description present',
      };
      const event = { ...baseEvent('E1', 1), surfaceMode: sm };

      const result = resolveNarrativeTechniques({
        events: [event],
        storyGraph: buildStoryGraph({}),
        discourseGraph: buildDiscourseGraph({}),
        assertions: {},
      });

      expect(result.has('E1')).toBe(true);
      const contracts = result.get('E1');
      expect(contracts).toBeDefined();
      if (!contracts) throw new Error('Expected E1 technique contracts fixture');
      expect(contracts).toHaveLength(1);
      expect(contracts[0].kind).toBe('surfaceMode');
      expect(contracts[0].instruction).toBe('Use vivid sensory language');
      expect(contracts[0].requiredEvidence).toBe('Sensory description present');
    });
  });

  // ── metanarrativeLevel ─────────────────────────────────────────────

  describe('metanarrativeLevel', () => {
    it('resolves metanarrativeLevel contract with no external references', () => {
      const mn: MetanarrativeLevel = {
        instruction: 'Acknowledge the constructed nature',
        requiredEvidence: 'Metafictional commentary',
      };
      const event = { ...baseEvent('E1', 1), metanarrativeLevel: mn };

      const result = resolveNarrativeTechniques({
        events: [event],
        storyGraph: buildStoryGraph({}),
        discourseGraph: buildDiscourseGraph({}),
        assertions: {},
      });

      expect(result.has('E1')).toBe(true);
      const contracts = result.get('E1');
      expect(contracts).toBeDefined();
      if (!contracts) throw new Error('Expected E1 technique contracts fixture');
      expect(contracts).toHaveLength(1);
      expect(contracts[0].kind).toBe('metanarrativeLevel');
    });
  });

  // ── causalDiscontinuity ─────────────────────────────────────────────

  describe('causalDiscontinuity', () => {
    it('resolves when no causal path exists between predecessor and dependent', () => {
      const cd: CausalDiscontinuity = {
        predecessor: 'E1',
        dependent: 'E3',
        instruction: 'Break expected causal chain',
        requiredEvidence: 'Causal break apparent',
      };
      const events: NarrativeEvent[] = [
        { ...baseEvent('E1', 1) },
        { ...baseEvent('E2', 2) },
        { ...baseEvent('E3', 3), causalDiscontinuity: cd },
      ];
      // Edge E1 → E2 exists, but NOT E1 → E3
      const edges: GraphEdge[] = [storyEdge('E1', 'E2', 'author_origin')];

      const result = resolveNarrativeTechniques({
        events,
        storyGraph: buildStoryGraph({ edges }),
        discourseGraph: buildDiscourseGraph({}),
        assertions: {},
      });

      expect(result.has('E3')).toBe(true);
      const contracts = result.get('E3');
      expect(contracts).toBeDefined();
      if (!contracts) throw new Error('Expected E3 technique contracts fixture');
      expect(contracts.some((c) => c.kind === 'causalDiscontinuity')).toBe(true);
    });

    it('throws ConfigError when dependent does not equal owning event', () => {
      // dependent="E2" but owning event is "E1" → owner mismatch
      const cd: CausalDiscontinuity = {
        predecessor: 'E2',
        dependent: 'E2', // NOT the owning event E1
        instruction: 'Break',
        requiredEvidence: 'Break evidence',
      };
      const event = { ...baseEvent('E1', 1), causalDiscontinuity: cd };
      const events: NarrativeEvent[] = [{ ...baseEvent('E2', 2) }, event];

      expect(() =>
        resolveNarrativeTechniques({
          events,
          storyGraph: buildStoryGraph({}),
          discourseGraph: buildDiscourseGraph({}),
          assertions: {},
        }),
      ).toThrowError(
        expect.objectContaining({
          name: 'ConfigError',
          message: expect.stringContaining('dependent'),
        }),
      );
    });

    it('throws ConfigError when predecessor is not a selected story node', () => {
      // predecessor="E_GHOST" does not exist in the events array
      const cd: CausalDiscontinuity = {
        predecessor: 'E_GHOST',
        dependent: 'E1',
        instruction: 'Break',
        requiredEvidence: 'Break evidence',
      };
      const event = { ...baseEvent('E1', 1), causalDiscontinuity: cd };

      expect(() =>
        resolveNarrativeTechniques({
          events: [event],
          storyGraph: buildStoryGraph({}),
          discourseGraph: buildDiscourseGraph({}),
          assertions: {},
        }),
      ).toThrowError(
        expect.objectContaining({
          name: 'ConfigError',
          message: expect.stringContaining('not in selected story nodes'),
        }),
      );
    });

    it('throws ConfigError when a causal path exists via author_origin/provider edges', () => {
      // E1 → E2 (author_origin) creates a causal path.
      // If E2's contract claims predecessor=E1, dependent=E2 → path exists → error.
      const cd: CausalDiscontinuity = {
        predecessor: 'E1',
        dependent: 'E2',
        instruction: 'Break',
        requiredEvidence: 'Break evidence',
      };
      const events: NarrativeEvent[] = [
        { ...baseEvent('E1', 1) },
        { ...baseEvent('E2', 2), causalDiscontinuity: cd },
      ];
      const edges: GraphEdge[] = [storyEdge('E1', 'E2', 'author_origin')];

      expect(() =>
        resolveNarrativeTechniques({
          events,
          storyGraph: buildStoryGraph({ edges }),
          discourseGraph: buildDiscourseGraph({}),
          assertions: {},
        }),
      ).toThrowError(
        expect.objectContaining({
          name: 'ConfigError',
          message: expect.stringContaining('causal path exists'),
        }),
      );
    });

    it('throws ConfigError on transitive causal path', () => {
      // E1 → E2 → E3. If E3 claims predecessor=E1 → path via E2 → error.
      const cd: CausalDiscontinuity = {
        predecessor: 'E1',
        dependent: 'E3',
        instruction: 'Break',
        requiredEvidence: 'Break evidence',
      };
      const events: NarrativeEvent[] = [
        { ...baseEvent('E1', 1) },
        { ...baseEvent('E2', 2) },
        { ...baseEvent('E3', 3), causalDiscontinuity: cd },
      ];
      const edges: GraphEdge[] = [
        storyEdge('E1', 'E2', 'provider'),
        storyEdge('E2', 'E3', 'author_origin'),
      ];

      expect(() =>
        resolveNarrativeTechniques({
          events,
          storyGraph: buildStoryGraph({ edges }),
          discourseGraph: buildDiscourseGraph({}),
          assertions: {},
        }),
      ).toThrowError(
        expect.objectContaining({
          name: 'ConfigError',
          message: expect.stringContaining('causal path exists'),
        }),
      );
    });
  });

  // ── causalMultiplicity ──────────────────────────────────────────────

  describe('causalMultiplicity', () => {
    it('resolves when outgoing edges meet the minimum', () => {
      const cm: CausalMultiplicity = {
        minimumOutgoingEdges: 2,
        instruction: 'Multiple causal threads',
        requiredEvidence: 'At least 2 distinct dependent events',
      };
      const events: NarrativeEvent[] = [
        { ...baseEvent('E1', 1) },
        { ...baseEvent('E2', 2) },
        { ...baseEvent('E3', 3) },
        { ...baseEvent('E4', 4), causalMultiplicity: cm },
      ];
      // E4 has author_origin/provider edges to E2 and E3 → 2 outgoing
      const edges: GraphEdge[] = [
        storyEdge('E4', 'E2', 'provider'),
        storyEdge('E4', 'E3', 'author_origin'),
      ];

      const result = resolveNarrativeTechniques({
        events,
        storyGraph: buildStoryGraph({ edges }),
        discourseGraph: buildDiscourseGraph({}),
        assertions: {},
      });

      expect(result.has('E4')).toBe(true);
      const contracts = result.get('E4');
      expect(contracts).toBeDefined();
      if (!contracts) throw new Error('Expected E4 technique contracts fixture');
      expect(contracts.some((c) => c.kind === 'causalMultiplicity')).toBe(true);
    });

    it('deduplicates outgoing edges when counting', () => {
      // Same dependent via two edge classes should count as 1
      const cm: CausalMultiplicity = {
        minimumOutgoingEdges: 1,
        instruction: 'At least one causal thread',
        requiredEvidence: 'One distinct dependent',
      };
      const events: NarrativeEvent[] = [
        { ...baseEvent('E1', 1) },
        { ...baseEvent('E2', 2) },
        { ...baseEvent('E3', 3), causalMultiplicity: cm },
      ];
      // E3 → E2 via both provider and author_origin — deduped to 1
      const edges: GraphEdge[] = [
        storyEdge('E3', 'E2', 'provider'),
        storyEdge('E3', 'E2', 'author_origin'),
      ];

      const result = resolveNarrativeTechniques({
        events,
        storyGraph: buildStoryGraph({ edges }),
        discourseGraph: buildDiscourseGraph({}),
        assertions: {},
      });

      const contracts = result.get('E3');
      expect(contracts).toBeDefined();
      if (!contracts) throw new Error('Expected E3 technique contracts fixture');
      expect(contracts.some((c) => c.kind === 'causalMultiplicity')).toBe(true);
    });

    it('throws ConfigError when outgoing edges fall below minimum', () => {
      const cm: CausalMultiplicity = {
        minimumOutgoingEdges: 3,
        instruction: 'Multiple causal threads',
        requiredEvidence: 'At least 3 distinct dependents',
      };
      const events: NarrativeEvent[] = [
        { ...baseEvent('E1', 1) },
        { ...baseEvent('E2', 2) },
        { ...baseEvent('E3', 3) },
        { ...baseEvent('E4', 4), causalMultiplicity: cm },
      ];
      // E4 → E2 only → 1 < 3
      const edges: GraphEdge[] = [storyEdge('E4', 'E2', 'author_origin')];

      expect(() =>
        resolveNarrativeTechniques({
          events,
          storyGraph: buildStoryGraph({ edges }),
          discourseGraph: buildDiscourseGraph({}),
          assertions: {},
        }),
      ).toThrowError(
        expect.objectContaining({
          name: 'ConfigError',
          message: expect.stringContaining('unique outgoing'),
        }),
      );
    });

    it('throws ConfigError when event has zero outgoing edges', () => {
      const cm: CausalMultiplicity = {
        minimumOutgoingEdges: 1,
        instruction: 'Need causal thread',
        requiredEvidence: 'Evidence',
      };
      const event = { ...baseEvent('E1', 1), causalMultiplicity: cm };

      expect(() =>
        resolveNarrativeTechniques({
          events: [event],
          storyGraph: buildStoryGraph({}),
          discourseGraph: buildDiscourseGraph({}),
          assertions: {},
        }),
      ).toThrowError(
        expect.objectContaining({
          name: 'ConfigError',
          message: expect.stringContaining('0 unique outgoing'),
        }),
      );
    });
  });

  // ── irresolvableIndeterminacy ───────────────────────────────────────

  describe('irresolvableIndeterminacy', () => {
    it('resolves when all assertionIds are in catalog and discourse outputs', () => {
      const ii: IrresolvableIndeterminacy = {
        assertionIds: ['A1'],
        instruction: 'Leave unresolved',
        requiredEvidence: 'Indeterminacy remains',
      };
      const event = { ...baseEvent('E1', 1), irresolvableIndeterminacy: ii };
      const assertions: Record<string, NarratorAssertion> = { A1: makeAssertion('A1') };
      const discGraph = buildDiscourseGraph({
        outputs: [
          discOutput('disc:reveal1', 'disclosure:E1:A1', { type: 'reveal', assertionId: 'A1' }, 1),
        ],
      });

      const result = resolveNarrativeTechniques({
        events: [event],
        storyGraph: buildStoryGraph({}),
        discourseGraph: discGraph,
        assertions,
      });

      expect(result.has('E1')).toBe(true);
      const contracts = result.get('E1');
      expect(contracts).toBeDefined();
      if (!contracts) throw new Error('Expected E1 technique contracts fixture');
      expect(contracts.some((c) => c.kind === 'irresolvableIndeterminacy')).toBe(true);
    });

    it('throws ConfigError when an assertionId is not in the catalog', () => {
      const ii: IrresolvableIndeterminacy = {
        assertionIds: ['A_MISSING'],
        instruction: 'Leave unresolved',
        requiredEvidence: 'Not resolved',
      };
      const event = { ...baseEvent('E1', 1), irresolvableIndeterminacy: ii };

      // A_MISSING is not in assertions, nor in discourse outputs
      expect(() =>
        resolveNarrativeTechniques({
          events: [event],
          storyGraph: buildStoryGraph({}),
          discourseGraph: buildDiscourseGraph({}),
          assertions: {},
        }),
      ).toThrowError(
        expect.objectContaining({
          name: 'ConfigError',
          message: expect.stringContaining('not found in runtime assertion catalog'),
        }),
      );
    });

    it('throws ConfigError when assertion is catalog-only (not in discourse outputs)', () => {
      const ii: IrresolvableIndeterminacy = {
        assertionIds: ['A1'],
        instruction: 'Leave unresolved',
        requiredEvidence: 'Not resolved',
      };
      const event = { ...baseEvent('E1', 1), irresolvableIndeterminacy: ii };
      const assertions: Record<string, NarratorAssertion> = { A1: makeAssertion('A1') };

      // A1 exists in catalog but is NOT referenced by any discourse output
      expect(() =>
        resolveNarrativeTechniques({
          events: [event],
          storyGraph: buildStoryGraph({}),
          discourseGraph: buildDiscourseGraph({}),
          assertions,
        }),
      ).toThrowError(
        expect.objectContaining({
          name: 'ConfigError',
          message: expect.stringContaining('not referenced by selected DiscourseGraph.outputs'),
        }),
      );
    });
  });

  // ── absentApparatus ─────────────────────────────────────────────────

  describe('absentApparatus', () => {
    it('resolves when readId is absent in story graph resolutions', () => {
      const aa: AbsentApparatus = {
        readId: 'E1:precondition:0',
        instruction: 'Treat absence as meaningful',
        requiredEvidence: 'Absence is treated meaningfully',
      };
      const event = { ...baseEvent('E1', 1), absentApparatus: aa };
      const storyGraph = buildStoryGraph({
        reads: [
          {
            readId: 'E1:precondition:0',
            canonicalKey: 'entity.attr',
            predicate: { type: 'exists' },
            phase: 'stateBefore',
            branchScope: BRANCH_SCOPE,
            origin: 'precondition',
          },
        ],
        resolutions: [storyAbsenceResolution('E1:precondition:0', 'entity.attr')],
      });

      const result = resolveNarrativeTechniques({
        events: [event],
        storyGraph,
        discourseGraph: buildDiscourseGraph({}),
        assertions: {},
      });

      expect(result.has('E1')).toBe(true);
      const contracts = result.get('E1');
      expect(contracts).toBeDefined();
      if (!contracts) throw new Error('Expected E1 technique contracts fixture');
      expect(contracts.some((c) => c.kind === 'absentApparatus')).toBe(true);
    });

    it('throws ConfigError when readId is not an absence resolution', () => {
      const aa: AbsentApparatus = {
        readId: 'E1:precondition:0',
        instruction: 'Treat absence as meaningful',
        requiredEvidence: 'Not applicable',
      };
      const event = { ...baseEvent('E1', 1), absentApparatus: aa };
      // The readId resolves to an OUTPUT, not an absence
      const storyGraph = buildStoryGraph({
        reads: [
          {
            readId: 'E1:precondition:0',
            canonicalKey: 'entity.attr',
            predicate: { type: 'exists' },
            phase: 'stateBefore',
            branchScope: BRANCH_SCOPE,
            origin: 'precondition',
          },
        ],
        outputs: [storyOutput('E1:postcondition:0', 'entity.attr', 1)],
        resolutions: [storyProviderResolution('E1:postcondition:0', 'entity.attr', 1)],
      });

      expect(() =>
        resolveNarrativeTechniques({
          events: [event],
          storyGraph,
          discourseGraph: buildDiscourseGraph({}),
          assertions: {},
        }),
      ).toThrowError(
        expect.objectContaining({
          message: expect.stringContaining('must be an owning event precondition'),
        }),
      );
    });
  });

  // ── voiceDissonance ──────────────────────────────────────────────────

  describe('voiceDissonance', () => {
    it('resolves when assertion and story output are in the respective graphs', () => {
      const vd: VoiceDissonance = {
        assertionId: 'A1',
        storyOutputId: 'E1:postcondition:0',
        instruction: 'Dissonant voice',
        requiredEvidence: 'Voice mismatch evident',
      };
      const event = { ...baseEvent('E1', 1), voiceDissonance: vd };
      const assertions: Record<string, NarratorAssertion> = { A1: makeAssertion('A1') };
      const storyGraph = buildStoryGraph({
        outputs: [storyOutput('E1:postcondition:0', 'entity.attr', 1)],
      });
      const discGraph = buildDiscourseGraph({
        outputs: [
          discOutput('disc:reveal1', 'disclosure:E1:A1', { type: 'reveal', assertionId: 'A1' }, 1),
        ],
      });

      const result = resolveNarrativeTechniques({
        events: [event],
        storyGraph,
        discourseGraph: discGraph,
        assertions,
      });

      expect(result.has('E1')).toBe(true);
      const contracts = result.get('E1');
      expect(contracts).toBeDefined();
      if (!contracts) throw new Error('Expected E1 technique contracts fixture');
      expect(contracts.some((c) => c.kind === 'voiceDissonance')).toBe(true);
    });

    it('throws ConfigError when assertionId is not in catalog', () => {
      const vd: VoiceDissonance = {
        assertionId: 'A_MISSING',
        storyOutputId: 'E1:postcondition:0',
        instruction: 'Dissonant voice',
        requiredEvidence: 'Mismatch',
      };
      const event = { ...baseEvent('E1', 1), voiceDissonance: vd };
      const storyGraph = buildStoryGraph({
        outputs: [storyOutput('E1:postcondition:0', 'entity.attr', 1)],
      });

      expect(() =>
        resolveNarrativeTechniques({
          events: [event],
          storyGraph,
          discourseGraph: buildDiscourseGraph({}),
          assertions: {},
        }),
      ).toThrowError(
        expect.objectContaining({
          name: 'ConfigError',
          message: expect.stringContaining('not found in runtime assertion catalog'),
        }),
      );
    });

    it('throws ConfigError when assertionId is not in discourse outputs', () => {
      const vd: VoiceDissonance = {
        assertionId: 'A1',
        storyOutputId: 'E1:postcondition:0',
        instruction: 'Dissonant voice',
        requiredEvidence: 'Mismatch',
      };
      const event = { ...baseEvent('E1', 1), voiceDissonance: vd };
      const assertions: Record<string, NarratorAssertion> = { A1: makeAssertion('A1') };
      const storyGraph = buildStoryGraph({
        outputs: [storyOutput('E1:postcondition:0', 'entity.attr', 1)],
      });
      // Discourse graph has zero outputs → A1 not referenced

      expect(() =>
        resolveNarrativeTechniques({
          events: [event],
          storyGraph,
          discourseGraph: buildDiscourseGraph({}),
          assertions,
        }),
      ).toThrowError(
        expect.objectContaining({
          name: 'ConfigError',
          message: expect.stringContaining('not referenced by selected DiscourseGraph.outputs'),
        }),
      );
    });

    it('throws ConfigError when storyOutputId is not in story outputs', () => {
      const vd: VoiceDissonance = {
        assertionId: 'A1',
        storyOutputId: 'E1:postcondition:0', // not in storyGraph.outputs
        instruction: 'Dissonant voice',
        requiredEvidence: 'Mismatch',
      };
      const event = { ...baseEvent('E1', 1), voiceDissonance: vd };
      const assertions: Record<string, NarratorAssertion> = { A1: makeAssertion('A1') };
      const discGraph = buildDiscourseGraph({
        outputs: [
          discOutput('disc:reveal1', 'disclosure:E1:A1', { type: 'reveal', assertionId: 'A1' }, 1),
        ],
      });
      // StoryGraph has zero outputs → storyOutputId not found

      expect(() =>
        resolveNarrativeTechniques({
          events: [event],
          storyGraph: buildStoryGraph({}),
          discourseGraph: discGraph,
          assertions,
        }),
      ).toThrowError(
        expect.objectContaining({
          name: 'ConfigError',
          message: expect.stringContaining('not found in selected StoryGraph.outputs'),
        }),
      );
    });
  });

  // ── multiplicity ─────────────────────────────────────────────────────

  describe('multiplicity', () => {
    it('resolves when all assertionIds are in catalog and discourse outputs', () => {
      const mult: Multiplicity = {
        assertionIds: ['A1', 'A2'],
        instruction: 'Multiple valid interpretations',
        requiredEvidence: 'At least two interpretations coexist',
      };
      const event = { ...baseEvent('E1', 1), multiplicity: mult };
      const assertions: Record<string, NarratorAssertion> = {
        A1: makeAssertion('A1'),
        A2: makeAssertion('A2'),
      };
      const discGraph = buildDiscourseGraph({
        outputs: [
          discOutput('disc:reveal1', 'disclosure:E1:A1', { type: 'reveal', assertionId: 'A1' }, 1),
          discOutput('disc:reveal2', 'disclosure:E1:A2', { type: 'reveal', assertionId: 'A2' }, 2),
        ],
      });

      const result = resolveNarrativeTechniques({
        events: [event],
        storyGraph: buildStoryGraph({}),
        discourseGraph: discGraph,
        assertions,
      });

      expect(result.has('E1')).toBe(true);
      const contracts = result.get('E1');
      expect(contracts).toBeDefined();
      if (!contracts) throw new Error('Expected E1 technique contracts fixture');
      expect(contracts.some((c) => c.kind === 'multiplicity')).toBe(true);
    });

    it('throws ConfigError when an assertionId is not in the catalog', () => {
      const mult: Multiplicity = {
        assertionIds: ['A1', 'A_MISSING'],
        instruction: 'Multiple interpretations',
        requiredEvidence: 'Evidence',
      };
      const event = { ...baseEvent('E1', 1), multiplicity: mult };
      const assertions: Record<string, NarratorAssertion> = { A1: makeAssertion('A1') };

      // Discourse outputs include A1 so the resolver reaches A_MISSING
      const discGraph = buildDiscourseGraph({
        outputs: [
          discOutput('disc:reveal1', 'disclosure:E1:A1', { type: 'reveal', assertionId: 'A1' }, 1),
        ],
      });

      expect(() =>
        resolveNarrativeTechniques({
          events: [event],
          storyGraph: buildStoryGraph({}),
          discourseGraph: discGraph,
          assertions,
        }),
      ).toThrowError(
        expect.objectContaining({
          name: 'ConfigError',
          message: expect.stringContaining('not found in runtime assertion catalog'),
        }),
      );
    });

    it('throws ConfigError when an assertionId is catalog-only (not in discourse)', () => {
      const mult: Multiplicity = {
        assertionIds: ['A1', 'A2'],
        instruction: 'Multiple interpretations',
        requiredEvidence: 'Evidence',
      };
      const event = { ...baseEvent('E1', 1), multiplicity: mult };
      const assertions: Record<string, NarratorAssertion> = {
        A1: makeAssertion('A1'),
        A2: makeAssertion('A2'),
      };
      // Only A1 is in discourse outputs; A2 is catalog-only
      const discGraph = buildDiscourseGraph({
        outputs: [
          discOutput('disc:reveal1', 'disclosure:E1:A1', { type: 'reveal', assertionId: 'A1' }, 1),
        ],
      });

      expect(() =>
        resolveNarrativeTechniques({
          events: [event],
          storyGraph: buildStoryGraph({}),
          discourseGraph: discGraph,
          assertions,
        }),
      ).toThrowError(
        expect.objectContaining({
          name: 'ConfigError',
          message: expect.stringContaining('not referenced by selected DiscourseGraph.outputs'),
        }),
      );
    });
  });

  // ── Multi-technique event ───────────────────────────────────────────

  describe('multiple techniques on one event', () => {
    it('resolves all techniques on a single event in kind order', () => {
      const sm: SurfaceMode = {
        instruction: 'Vivid language',
        requiredEvidence: 'Sensory details',
      };
      const mn: MetanarrativeLevel = {
        instruction: 'Meta awareness',
        requiredEvidence: 'Meta commentary',
      };
      const event = {
        ...baseEvent('E1', 1),
        surfaceMode: sm,
        metanarrativeLevel: mn,
      };

      const result = resolveNarrativeTechniques({
        events: [event],
        storyGraph: buildStoryGraph({}),
        discourseGraph: buildDiscourseGraph({}),
        assertions: {},
      });

      expect(result.has('E1')).toBe(true);
      const contracts = result.get('E1');
      expect(contracts).toBeDefined();
      if (!contracts) throw new Error('Expected E1 technique contracts fixture');
      // surfaceMode and metanarrativeLevel both pass (no external refs)
      const kinds = contracts.map((c) => c.kind);
      expect(kinds).toContain('surfaceMode');
      expect(kinds).toContain('metanarrativeLevel');
      // Order follows NARRATIVE_TECHNIQUE_KINDS: surfaceMode (index 1) before metanarrativeLevel (index 7)
      expect(kinds.indexOf('surfaceMode')).toBeLessThan(kinds.indexOf('metanarrativeLevel'));
    });
  });

  // ── Event filtering ───────────────────────────────────────────────────

  describe('event filtering', () => {
    it('only processes source === event_file events', () => {
      const sm: SurfaceMode = { instruction: 'Vivid', requiredEvidence: 'Sensory' };
      const events: NarrativeEvent[] = [
        { ...baseEvent('E1', 1), source: 'branch_point' as const, surfaceMode: sm },
        { ...baseEvent('E2', 2), source: 'system' as const },
      ];

      const result = resolveNarrativeTechniques({
        events,
        storyGraph: buildStoryGraph({}),
        discourseGraph: buildDiscourseGraph({}),
        assertions: {},
      });

      // E1 is branch_point, E2 is system — neither is event_file → result is empty
      expect(result.size).toBe(0);
    });

    it('omits events with no contracts from result map', () => {
      const events: NarrativeEvent[] = [
        { ...baseEvent('E1', 1) }, // no technique contracts
        { ...baseEvent('E2', 2) }, // no technique contracts
      ];

      const result = resolveNarrativeTechniques({
        events,
        storyGraph: buildStoryGraph({}),
        discourseGraph: buildDiscourseGraph({}),
        assertions: {},
      });

      expect(result.size).toBe(0);
    });
  });

  // ── priorAssertionId / newAssertionId in discourse outputs ──────────

  describe('discourse assertion ID extraction', () => {
    it('recognizes priorAssertionId and newAssertionId fields', () => {
      // The resolver's collectDiscourseAssertionIds also checks priorAssertionId
      // and newAssertionId — test this via irresolvableIndeterminacy
      const ii: IrresolvableIndeterminacy = {
        assertionIds: ['A_OLD', 'A_NEW'],
        instruction: 'Transition unresolved',
        requiredEvidence: 'Indeterminate transition',
      };
      const event = { ...baseEvent('E1', 1), irresolvableIndeterminacy: ii };
      const assertions: Record<string, NarratorAssertion> = {
        A_OLD: makeAssertion('A_OLD'),
        A_NEW: makeAssertion('A_NEW'),
      };
      // A_OLD via priorAssertionId, A_NEW via newAssertionId
      const discGraph = buildDiscourseGraph({
        outputs: [
          discOutput(
            'disc:corr1',
            'disclosure:E1:corr',
            {
              type: 'correction',
              priorAssertionId: 'A_OLD',
              newAssertionId: 'A_NEW',
            },
            1,
          ),
        ],
      });

      const result = resolveNarrativeTechniques({
        events: [event],
        storyGraph: buildStoryGraph({}),
        discourseGraph: discGraph,
        assertions,
      });

      expect(result.has('E1')).toBe(true);
      const contracts = result.get('E1');
      expect(contracts).toBeDefined();
      if (!contracts) throw new Error('Expected E1 technique contracts fixture');
      expect(contracts.some((c) => c.kind === 'irresolvableIndeterminacy')).toBe(true);
    });
  });

  // ── Non-event_file events with no contracts are just absent from result ──

  it('returns empty map for no matching events with contracts', () => {
    const result = resolveNarrativeTechniques({
      events: [],
      storyGraph: buildStoryGraph({}),
      discourseGraph: buildDiscourseGraph({}),
      assertions: {},
    });

    expect(result.size).toBe(0);
  });
});
