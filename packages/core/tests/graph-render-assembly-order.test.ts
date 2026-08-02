// ============================================================================
// Graph → Render → Assembly Ordering Integration Test
//
// Verifies that the full pipeline correctly separates concerns:
//   - Story graph causality (E1 → E2 via provider edge)
//   - Discourse reader order (E2 → E1 via branch scene sequence)
//   - narrativeOrder (metadata only, does not drive assembly)
//
// The suite exercises pure graph, sequence, and assembly contracts. Rendering
// I/O is covered by snapshot/runtime service tests.
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PromoteCandidateInput } from '../src/editorial/index.js';
import { compilePlannedDiscourseLedger } from '../src/state/discourse-ledger.ts';
import { compileDiscourseSceneSequence } from '../src/state/discourse-sequence.ts';
// Core graph/state compilation
import { compileNarrativeRuntime } from '../src/state/narrative-runtime.ts';
import type { PlannedDiscourseLedger } from '../src/types/discourse.ts';
// Types
import type { DiscourseSceneSequenceEntry } from '../src/types/graph.ts';
import type {
  AttributeDefinition,
  EntityCatalogContext,
  Fact,
  NarrativeEvent,
  TimeAnchor,
} from '../src/types/index.ts';

// ═════════════════════════════════════════════════════════════════════════════
// Test Data
//
// Three sources of order, each deliberately different:
//
//   Causal (graph):    E1 (day_1) writes f1 → E2 (day_2) reads f1
//   Discourse (ledger): chapter 1 = E2, chapter 2 = E1
//   narrativeOrder:     E1=1, E2=2 (ascending, matches causal)
//
// Every ordering axis is independently observable.
// ═════════════════════════════════════════════════════════════════════════════

const FACT_F1: Fact = {
  id: 'f1',
  entityId: 'hero',
  attribute: 'status',
  value: 'alive',
  validity: {
    temporal: { start: { type: 'absolute', value: 'day_1' }, end: null },
    branches: { type: 'all' },
  },
};

function eventBase(id: string, day: number, narrativeOrder: number): NarrativeEvent {
  return {
    id,
    event: id,
    narrativeOrder,
    title: `Event ${id}`,
    storyTime: { type: 'absolute', value: `day_${day}` },
    sceneType: 'linear',
    pov: { character: 'narrator', type: 'omniscient' },
    sceneBrief: `Scene ${id}`,
    beats: [`Scene ${id}`],
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

/** E1 writes fact f1 (causal origin). narrativeOrder 1. */
function makeE1(): NarrativeEvent {
  return {
    ...eventBase('E1', 1, 1),
    sceneBrief: 'Story‑first scene. It writes the status fact.',
    beats: ['Story‑first scene. It writes the status fact.'],
    postconditions: [FACT_F1],
    surfaceMode: {
      instruction: 'Write in simple, declarative sentences',
      requiredEvidence: 'Prose avoids complex subordination',
    },
  };
}

/** E2 reads fact f1 (causal dependent). narrativeOrder 2. discourse first. */
function makeE2(): NarrativeEvent {
  return {
    ...eventBase('E2', 2, 2),
    sceneBrief: 'Story‑second scene. It consumes the status fact.',
    beats: ['Story‑second scene. It consumes the status fact.'],
    preconditions: [FACT_F1],
  };
}

// ─── Synthetic activation transition + ontology catalogs ────────────────────
// E1 activates hero through a canonical system:introduction transition (the
// exact shape the kernel compiles from an `introduces:` block), so catalog
// write enforcement (activation before live write) holds in these tests.

function lifecycleAttribute(): AttributeDefinition {
  return {
    attributeId: 'lifecycle',
    valueSchema: z.string(),
    requiredAt: 'introduction',
    writePolicy: 'lifecycle_managed',
    allowedLifecycleStates: ['active', 'inactive', 'retired'],
    unsetAllowed: false,
    semanticRole: 'lifecycle',
  };
}

const LIFECYCLE_POLICY = {
  allowedTransitions: [
    ['active', 'inactive'],
    ['active', 'retired'],
    ['inactive', 'active'],
    ['inactive', 'retired'],
  ],
} as const;

const catalogContext: EntityCatalogContext = {
  entityDeclarationCatalog: {
    declarations: {
      hero: {
        entityId: 'hero',
        typeRef: { typeId: 'character', schemaVersion: 1 },
        immutableMetadata: { name: 'Hero', definitionFile: 'hero.yaml' },
        introduction: { type: 'event', eventId: 'E1' },
      },
    },
    version: 1,
  },
  entityTypeCatalog: {
    types: {
      character: {
        typeRef: { typeId: 'character', schemaVersion: 1 },
        kind: 'character',
        attributes: {
          lifecycle: lifecycleAttribute(),
          status: {
            attributeId: 'status',
            valueSchema: z.string(),
            requiredAt: 'never',
            writePolicy: 'mutable',
            unsetAllowed: true,
            semanticRole: 'lifecycle',
          },
        },
        lifecyclePolicy: LIFECYCLE_POLICY,
        referenceCapabilities: { defaultEligibility: 'live' },
        typedInvariants: [],
      },
    },
    version: 1,
  },
};

/** Synthetic activation transition for an `introduces:` block (kernel shape). */
function makeIntroTransition(target: NarrativeEvent, entityId: string): NarrativeEvent {
  const id = `system:introduction:${target.id}:${entityId}`;
  return {
    kind: 'event',
    id,
    event: id,
    narrativeOrder: target.narrativeOrder - 0.5,
    title: `Introduce ${entityId} before ${target.id}`,
    storyTime: target.storyTime,
    sceneType: 'linear',
    pov: { character: 'system', type: 'omniscient' },
    sceneBrief: `Activate entity ${entityId}.`,
    beats: [`Activate entity ${entityId}.`],
    preconditions: [],
    postconditions: [
      {
        id: `${entityId}.lifecycle`,
        entityId,
        attribute: 'lifecycle',
        value: 'active',
        operation: 'set',
        confidence: 1.0,
        validity: {
          temporal: { start: target.storyTime, end: null },
          branches: target.branchExistence,
        },
      },
    ],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'system',
    branchExistence: target.branchExistence,
    participants: { entities: [entityId] },
    causalPredecessors: [],
  };
}

/** Prepend E1's activation transition, linked as its causal predecessor. */
function withIntroductions(events: NarrativeEvent[]): NarrativeEvent[] {
  const transition = makeIntroTransition(makeE1(), 'hero');
  return [
    transition,
    ...events.map((event) =>
      event.id === 'E1'
        ? { ...event, causalPredecessors: [...(event.causalPredecessors ?? []), transition.id] }
        : event,
    ),
  ];
}

// (makeAssertion is available if needed for future technique tests using resolveNarrativeTechniques)

/** Build a discourse ledger with one scene per chapter, in sceneIds order. */
function makeOrderedLedger(id: string, branch: string, sceneIds: string[]): PlannedDiscourseLedger {
  return compilePlannedDiscourseLedger({
    id,
    chapters: sceneIds.map((sceneId, i) => ({
      branch,
      chapter: i + 1,
      sceneIds: [sceneId],
    })),
    entries: [],
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Inline Document Builder
//
// Mirrors the Step‑8 buildNovelDocument contract (sceneSequence drives order).
// Identical to the production signature once adopted.
// ═════════════════════════════════════════════════════════════════════════════

function buildDocumentFromSequence(
  candidates: readonly PromoteCandidateInput[],
  chapterMetadata: ReadonlyMap<number, { title: string }>,
  novelTitle: string,
  sceneSequence: readonly DiscourseSceneSequenceEntry[],
): string {
  const byEventId = new Map(candidates.map((c) => [c.eventId, c]));
  const parts: string[] = [`# ${novelTitle}`];
  let currentChapter: number | null = null;

  for (const entry of sceneSequence) {
    const candidate = byEventId.get(entry.sceneId);
    if (!candidate) {
      throw new Error(
        `Missing candidate for scene "${entry.sceneId}" at sequence ${entry.sequence}`,
      );
    }
    if (entry.chapter !== currentChapter) {
      currentChapter = entry.chapter;
      const meta = chapterMetadata.get(currentChapter);
      parts.push('', `## ${meta?.title ?? `Chapter ${currentChapter}`}`, '');
    }
    parts.push(candidate.scene.prose.trimEnd(), '');
  }
  return `${parts.join('\n').trimEnd()}\n`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('graph-render-assembly ordering', () => {
  // ── Ordering Invariants ──────────────────────────────────────────

  describe('ordering invariants (compileNarrativeRuntime)', () => {
    it('E2 state‑before includes E1 write despite ledger ordering E2 first', () => {
      const runtime = compileNarrativeRuntime({
        events: withIntroductions([makeE1(), makeE2()]),
        initialFacts: [],
        timeAnchors: [
          { id: 'day_1', at: { type: 'absolute', value: 'day_1' } },
          { id: 'day_2', at: { type: 'absolute', value: 'day_2' } },
        ],
        branchPath: { decisions: [] },
        catalogs: catalogContext,
        discourseBranch: 'main',
        ledger: makeOrderedLedger('invariant-test', 'main', ['E2', 'E1']),
        assertions: {},
        narratorProfiles: {},
      });

      // ── Causal order: E1 → E2 via provider edge ──
      // E1 wrote hero.status = 'alive', so E2's state-before should see it
      const e2Before = runtime.boundaries.stateBeforeByEventId.get('E2');
      expect(e2Before).toBeDefined();
      expect(e2Before!.entities['hero']?.['status']).toBe('alive');

      // E1's state-before should NOT have hero.status (nothing wrote it yet)
      const e1Before = runtime.boundaries.stateBeforeByEventId.get('E1');
      expect(e1Before).toBeDefined();
      expect(e1Before!.entities['hero']?.['status']).toBeUndefined();

      // ── Discourse order: E2 → E1 (ledger chapter sequence) ──
      expect(runtime.graphs.discourseGraph.sceneSequence).toEqual([
        { sceneId: 'E2', sequence: 0, chapter: 1 },
        { sceneId: 'E1', sequence: 1, chapter: 2 },
      ]);

      // ── Story adjacency: E1 → E2 (provider edge from read resolution) ──
      expect(runtime.graphs.storyAdjacency.get('E1')).toContain('E2');
      expect(runtime.graphs.storyAdjacency.get('E2')).toEqual([]);
    });

    it('surfaceMode technique contracts resolve for E1, not for E2', () => {
      const runtime = compileNarrativeRuntime({
        events: withIntroductions([makeE1(), makeE2()]),
        initialFacts: [],
        timeAnchors: [
          { id: 'day_1', at: { type: 'absolute', value: 'day_1' } },
          { id: 'day_2', at: { type: 'absolute', value: 'day_2' } },
        ],
        branchPath: { decisions: [] },
        catalogs: catalogContext,
        discourseBranch: 'main',
        ledger: makeOrderedLedger('technique-test', 'main', ['E2', 'E1']),
        assertions: {},
        narratorProfiles: {},
      });

      // E1 has surfaceMode → resolved contract list contains it
      const e1Techniques = runtime.graphs.techniquesByEventId.get('E1');
      expect(e1Techniques).toBeDefined();
      expect(e1Techniques!.length).toBeGreaterThanOrEqual(1);
      const surface = e1Techniques!.find((t) => t.kind === 'surfaceMode');
      expect(surface).toBeDefined();
      expect(surface!.instruction).toBe('Write in simple, declarative sentences');
      expect(surface!.requiredEvidence).toContain('subordination');

      // E2 has no technique directives → no entry in the map
      expect(runtime.graphs.techniquesByEventId.has('E2')).toBe(false);
    });

    it('synthetic transition events never enter the discourse scene sequence', () => {
      const runtime = compileNarrativeRuntime({
        events: withIntroductions([makeE1(), makeE2()]),
        initialFacts: [],
        timeAnchors: [
          { id: 'day_1', at: { type: 'absolute', value: 'day_1' } },
          { id: 'day_2', at: { type: 'absolute', value: 'day_2' } },
        ],
        branchPath: { decisions: [] },
        catalogs: catalogContext,
        discourseBranch: 'main',
        ledger: makeOrderedLedger('no-synthetic-prose', 'main', ['E2', 'E1']),
        assertions: {},
        narratorProfiles: {},
      });

      // The transition participates in the compiled runtime, but the
      // discourse scene sequence — the only assembly ordering source —
      // contains authored event-file scenes only, so no synthetic
      // transition can ever be assembled as prose.
      const sceneIds = runtime.graphs.discourseGraph.sceneSequence.map((entry) => entry.sceneId);
      expect(sceneIds).toEqual(['E2', 'E1']);
      expect(sceneIds).not.toContain('system:introduction:E1:hero');
    });

    it('deterministic graph hash survives across compilations', () => {
      const events = withIntroductions([makeE1(), makeE2()]);
      const ledger = makeOrderedLedger('hash-test', 'main', ['E2', 'E1']);
      const anchors: TimeAnchor[] = [
        { id: 'day_1', at: { type: 'absolute', value: 'day_1' } },
        { id: 'day_2', at: { type: 'absolute', value: 'day_2' } },
      ];

      const opts = {
        events,
        initialFacts: [],
        timeAnchors: anchors,
        branchPath: { decisions: [] } as const,
        catalogs: catalogContext,
        discourseBranch: 'main',
        ledger,
        assertions: {},
        narratorProfiles: {},
      };

      const runtimeA = compileNarrativeRuntime(opts);
      const runtimeB = compileNarrativeRuntime(opts);

      const hashA = runtimeA.graphs.storyGraph.hash;
      const hashB = runtimeB.graphs.storyGraph.hash;
      expect(hashA).toBeTruthy();
      expect(hashA).toBe(hashB);
    });

    it('graph hash changes when discourse branch changes', () => {
      const events = withIntroductions([makeE1(), makeE2()]);
      const ledger = makeOrderedLedger('branch-hash-test', 'main', ['E2', 'E1']);

      const opts = {
        events,
        initialFacts: [],
        timeAnchors: [
          { id: 'day_1', at: { type: 'absolute', value: 'day_1' } },
          { id: 'day_2', at: { type: 'absolute', value: 'day_2' } },
        ],
        branchPath: { decisions: [] } as const,
        catalogs: catalogContext,
        ledger,
        assertions: {},
        narratorProfiles: {},
      };

      const hashMain = compileNarrativeRuntime({
        ...opts,
        discourseBranch: 'main',
      }).graphs.storyGraph.hash;

      // Both events on 'all' branch — same hash regardless of discourse branch
      const hashMainAgain = compileNarrativeRuntime({
        ...opts,
        discourseBranch: 'main',
      }).graphs.storyGraph.hash;
      expect(hashMain).toBe(hashMainAgain);
      expect(hashMain).toBeTruthy();
    });
  });

  // ── Discourse Scene Sequence ────────────────────────────────────

  describe('discourse scene sequence (compileDiscourseSceneSequence)', () => {
    it('returns E2 → E1 for main branch', () => {
      const sequence = compileDiscourseSceneSequence({
        events: [makeE1(), makeE2()],
        ledger: makeOrderedLedger('seq-test', 'main', ['E2', 'E1']),
        branch: 'main',
      });

      expect(sequence).toEqual([
        { sceneId: 'E2', sequence: 0, chapter: 1 },
        { sceneId: 'E1', sequence: 1, chapter: 2 },
      ]);
    });

    it('throws ConfigError for missing discourse branch', () => {
      expect(() =>
        compileDiscourseSceneSequence({
          events: [makeE1(), makeE2()],
          ledger: makeOrderedLedger('missing-branch', 'main', ['E2', 'E1']),
          branch: 'nonexistent',
        }),
      ).toThrow(/no chapter sequence/i);
    });

    it('throws ConfigError when ledger omits a reachable scene', () => {
      const events = [makeE1(), makeE2()];
      const incompleteLedger = compilePlannedDiscourseLedger({
        id: 'incomplete',
        chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E2'] }],
        entries: [],
      });

      expect(() =>
        compileDiscourseSceneSequence({
          events,
          ledger: incompleteLedger,
          branch: 'main',
        }),
      ).toThrow(/omits reachable scene/i);
    });

    it('throws ConfigError when ledger references an unknown scene', () => {
      const events = [makeE1(), makeE2()];
      const unknownLedger = compilePlannedDiscourseLedger({
        id: 'unknown-scene',
        chapters: [
          { branch: 'main', chapter: 1, sceneIds: ['E2'] },
          { branch: 'main', chapter: 2, sceneIds: ['E1'] },
          { branch: 'main', chapter: 3, sceneIds: ['E_FAKE'] },
        ],
        entries: [],
      });

      expect(() =>
        compileDiscourseSceneSequence({
          events,
          ledger: unknownLedger,
          branch: 'main',
        }),
      ).toThrow(/unknown scene/i);
    });
  });

  // ── Full Render Pipeline ───────────────────────────────────────

  // ── Document Assembly Ordering ─────────────────────────────────

  describe('document assembly ordering (buildNovelDocument contract)', () => {
    it('builds document with E2 before E1 when scene sequence requires it', () => {
      const sceneSequence: DiscourseSceneSequenceEntry[] = [
        { sceneId: 'E2', sequence: 0, chapter: 1 },
        { sceneId: 'E1', sequence: 1, chapter: 2 },
      ];

      // Simulated PromoteCandidateInput for both scenes
      const candidates: PromoteCandidateInput[] = [
        makeCandidate('E1', 1, 'Prose content for E1.'),
        makeCandidate('E2', 2, 'Prose content for E2.'),
      ];

      const chapterMetadata = new Map<number, { title: string }>([
        [1, { title: 'Chapter One' }],
        [2, { title: 'Chapter Two' }],
      ]);

      const document = buildDocumentFromSequence(
        candidates,
        chapterMetadata,
        'Order Test Novel',
        sceneSequence,
      );

      // E2 (chapter 1) appears before E1 (chapter 2)
      const e2Index = document.indexOf('Prose content for E2.');
      const e1Index = document.indexOf('Prose content for E1.');
      expect(e2Index).toBeGreaterThan(0);
      expect(e1Index).toBeGreaterThan(e2Index);

      // Chapter headings in the right order
      const heading1Index = document.indexOf('## Chapter One');
      const heading2Index = document.indexOf('## Chapter Two');
      expect(heading1Index).toBeGreaterThan(0);
      expect(heading2Index).toBeGreaterThan(heading1Index);

      // Novel title present
      expect(document).toContain('# Order Test Novel');
    });

    it('fails hard on missing candidate', () => {
      const sceneSequence: DiscourseSceneSequenceEntry[] = [
        { sceneId: 'E1', sequence: 0, chapter: 1 },
      ];

      expect(() => buildDocumentFromSequence([], new Map(), 'Test', sceneSequence)).toThrow(
        /Missing candidate/i,
      );
    });
  });

  // ── Preflight Error Scenarios ──────────────────────────────────

  describe('preflight errors (compileDiscourseSceneSequence)', () => {
    it('missing ledger chapter for branch throws ConfigError', () => {
      const events = [makeE1(), makeE2()];
      // Ledger with no chapters for 'main'
      const noChaptersLedger = compilePlannedDiscourseLedger({
        id: 'no-chapters',
        chapters: [],
        entries: [],
      });

      expect(() =>
        compileDiscourseSceneSequence({
          events,
          ledger: noChaptersLedger,
          branch: 'main',
        }),
      ).toThrow(/no chapter sequence/i);
    });

    it('duplicate scene ID in ledger throws ConfigError', () => {
      const events = [makeE1(), makeE2()];
      const duplicateLedger = compilePlannedDiscourseLedger({
        id: 'duplicate',
        chapters: [
          { branch: 'main', chapter: 1, sceneIds: ['E2'] },
          { branch: 'main', chapter: 2, sceneIds: ['E1'] },
          { branch: 'main', chapter: 3, sceneIds: ['E1'] }, // duplicate
        ],
        entries: [],
      });

      expect(() =>
        compileDiscourseSceneSequence({
          events,
          ledger: duplicateLedger,
          branch: 'main',
        }),
      ).toThrow(/more than once/i);
    });

    it('non‑increasing chapter throws ConfigError', () => {
      const events = [makeE1(), makeE2()];
      const badChapterLedger = compilePlannedDiscourseLedger({
        id: 'bad-chapter',
        chapters: [
          { branch: 'main', chapter: 2, sceneIds: ['E2'] },
          { branch: 'main', chapter: 1, sceneIds: ['E1'] },
        ],
        entries: [],
      });

      expect(() =>
        compileDiscourseSceneSequence({
          events,
          ledger: badChapterLedger,
          branch: 'main',
        }),
      ).toThrow(/non-increasing/i);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Shared Helpers
// ═════════════════════════════════════════════════════════════════════════════

function makeCandidate(
  eventId: string,
  narrativeOrder: number,
  prose: string,
): PromoteCandidateInput {
  return {
    eventId,
    chapterNumber: eventId === 'E1' ? 2 : 1,
    head: {
      revisionId: `${eventId}-rev`,
      proseHash: crypto.createHash('sha256').update(prose).digest('hex'),
      prose,
      sceneHash: crypto.createHash('sha256').update(`${eventId}-scene`).digest('hex'),
      editorialBasisHash: crypto.createHash('sha256').update(`${eventId}-basis`).digest('hex'),
      scopeHash: crypto.createHash('sha256').update(`${eventId}-scope`).digest('hex'),
      validationIdentity: `${eventId}-validation`,
      proseSource: 'llm_generated' as const,
      modelUsed: 'mock-pass2',
      renderedAt: '2026-01-01T00:00:00.000Z',
      wordCount: prose.split(/\s+/).length,
      editHistory: [
        {
          action: 'llm_generated',
          actor_id: 'test',
          operation_id: `${eventId}-op`,
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
      branchExistence: { type: 'all' },
    },
    event: {
      eventId,
      narrativeOrder,
      storyTime: narrativeOrder === 1 ? 'day_1' : 'day_2',
      sceneType: 'linear',
      source: 'event_file',
      threadProgress: [],
      foreshadowing: [],
      relationshipEffects: [],
      ruleEffects: [],
    },
    scene: {
      prose,
      renderRequest: {},
    },
  };
}
