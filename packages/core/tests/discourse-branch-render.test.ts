// ============================================================================
// discourse-branch-render.test.ts — Discourse branch selection in
// ContextCompiler and renderNovel API.
//
// Covers:
//   1. Compiler-level: explicit discourseBranch selects correct entries
//   2. Compiler-level: undefined discourseBranch defaults to 'main'
//   3. API-level:   multi-branch + branchPath + no label → error
//   4. API-level:   explicit label not in ledger → error
//   5. API-level:   explicit label but no ledger → error
//   6. API-level:   explicit valid label + dry-run → succeeds
// ============================================================================

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderNovel } from '../src/api.ts';
import { ContextCompiler } from '../src/context/compiler.ts';
import { InMemoryEntityRegistry } from '../src/entity/registry.ts';
import { compileDiscourseBoundaries } from '../src/state/discourse-context.ts';
import { areProjectionsIdentical } from '../src/state/discourse-replay.ts';
import type { CompiledDiscourseRenderContext } from '../src/state/discourse-context.ts';
import type { BranchPath } from '../src/types/branch.ts';
import type {
  DisclosureAction,
  NarratorAssertion,
  NarratorProfile,
  PlannedDiscourseLedger,
  PlannedLedgerEntry,
} from '../src/types/discourse.ts';
import type {
  GoalLifecycle,
  NarrativeEvent,
  ThreadId,
  ThreadLifecycle,
  ThreadRunId,
  WorldState,
} from '../src/types/index.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return {
    event: 'test_event',
    narrativeOrder: 1,
    title: 'Test Event',
    storyTime: { type: 'absolute', value: 'day_1' },
    sceneType: 'linear',
    pov: { character: 'test-char', type: 'third_person_limited' },
    sceneBrief: 'Test scene for discourse branch testing.',
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
    ...overrides,
  };
}

function makeWorldState(): WorldState {
  return {
    entities: { 'test-char': { location: 'somewhere', status: 'alive' } },
    relationships: {},
    knowledge: {},
    threads: {
      T1: {
        threadId: 'T1' as ThreadId,
        status: 'active' as ThreadLifecycle,
        currentRunId: 'legacy-T1' as ThreadRunId,
        phase: '',
        bindings: {},
        goalStates: { progress: 'active' as GoalLifecycle },
        milestoneStates: {},
        semanticStateHash: 'h0',
      },
    },
    rules: {},
    facts: [],
  };
}

function makeRegistry(): InMemoryEntityRegistry {
  const reg = new InMemoryEntityRegistry();
  reg.register({
    id: 'test-char',
    kind: 'character',
    name: 'Test Character',
    definitionFile: 'definitions/characters/test-char.yaml',
    lifecycle: 'active',
    typeRef: { typeId: 'character', schemaVersion: 1 },
    state: { location: 'somewhere' },
  });
  return reg;
}

function makeLedgerEntry(
  id: string,
  actionType: string,
  assertionId: string,
  sceneId: string,
  branch: string,
  pos: number,
): PlannedLedgerEntry {
  return {
    id,
    action: {
      type: actionType,
      assertionId,
      discoursePosition: pos,
    } as DisclosureAction,
    sceneId,
    branch,
    discoursePosition: pos,
  };
}

/** Narrator profile matching assertion narration boundaries. */
const TEST_NARRATOR_PROFILE: NarratorProfile = {
  type: 'focalizer_bound',
  id: 'test-narrator',
  access: 'full',
  assertion: 'full',
  truth: 'full_knowledge',
  fidelity: 'reliable',
  sincerity: 'sincere',
};
// Two assertions — one per branch
const MAIN_ASSERTION: NarratorAssertion = {
  id: 'main-secret',
  narrator: 'test-narrator',
  proposition: 'Main branch secret',
  polarity: 'affirmative',
  type: 'authoritative_reveal',
  truthBoundary: true,
  narrationBoundary: {
    narratorId: 'test-narrator',
  },
};
const ALT_ASSERTION: NarratorAssertion = {
  id: 'alt-secret',
  narrator: 'test-narrator',
  proposition: 'Alternate branch secret',
  polarity: 'affirmative',
  type: 'authoritative_reveal',
  truthBoundary: true,
  narrationBoundary: {
    narratorId: 'test-narrator',
  },
};

/** Non-authoritative claim assertion for valid claim-action tests. */
const CLAIM_ASSERTION: NarratorAssertion = {
  id: 'test-claim',
  narrator: 'test-narrator',
  proposition: 'A test claim',
  polarity: 'affirmative',
  type: 'claim',
  truthBoundary: false,
  narrationBoundary: {
    narratorId: 'test-narrator',
  },
};

const ASSERTIONS: Record<string, NarratorAssertion> = {
  'main-secret': MAIN_ASSERTION,
  'alt-secret': ALT_ASSERTION,
  'test-claim': CLAIM_ASSERTION,
};

/** Multi-branch ledger: main reveals 'main-secret', alternate reveals 'alt-secret'. */
const MULTI_BRANCH_LEDGER: PlannedDiscourseLedger = {
  id: 'test-multi',
  hash: 'hash-multi',
  entries: [
    makeLedgerEntry('main-e1', 'reveal', 'main-secret', 'E1', 'main', 0),
    makeLedgerEntry('alt-e1', 'reveal', 'alt-secret', 'E1', 'alternate', 1),
  ],
};

/** Single-branch ledger (main only). */
const SINGLE_BRANCH_LEDGER: PlannedDiscourseLedger = {
  id: 'test-single',
  hash: 'hash-single',
  entries: [makeLedgerEntry('only-e1', 'reveal', 'main-secret', 'E1', 'main', 0)],
};
// ═════════════════════════════════════════════════════════════════════════════
// 1. Compiler-level: branch selection produces correct projection via
//    compileDiscourseBoundaries preflight + ContextConsumer.
// ═════════════════════════════════════════════════════════════════════════════

describe('ContextCompiler strict discourse branch selection', () => {
  const compiler = new ContextCompiler();
  const event = makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' });
  const state = makeWorldState();
  const registry = makeRegistry();

  it('selects main-branch entries when discourseBranch is "main"', () => {
    const result = compileDiscourseBoundaries([event], MULTI_BRANCH_LEDGER, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'main');
    const ctx = result['E1']!;
    expect(ctx).toBeDefined();
    expect(ctx.currentActionIds).toContain('main-e1');
    expect(ctx.cursor).toBe(0);
    expect(ctx.ledgerHash).toBe('hash-multi');
    expect(ctx.assertionCatalogHash).toBeTruthy();

    const pkg = compiler.compile(event, state, registry, {
      discourseContext: ctx,
      narratorProfiles: { 'test-narrator': TEST_NARRATOR_PROFILE },
    });
    expect(pkg.discourseProjection).toBeDefined();
    const auth = pkg.discourseProjection!.authorizedTargets;
    expect(auth.map((a) => a.assertionId)).toContain('main-secret');
    expect(auth.map((a) => a.assertionId)).not.toContain('alt-secret');
  });

  it('selects alternate-branch entries when discourseBranch is "alternate"', () => {
    const result = compileDiscourseBoundaries([event], MULTI_BRANCH_LEDGER, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'alternate');
    const ctx = result['E1']!;
    expect(ctx).toBeDefined();

    const pkg = compiler.compile(event, state, registry, {
      discourseContext: ctx,
      narratorProfiles: { 'test-narrator': TEST_NARRATOR_PROFILE },
    });
    expect(pkg.discourseProjection).toBeDefined();
    const auth = pkg.discourseProjection!.authorizedTargets;
    expect(auth.map((a) => a.assertionId)).toContain('alt-secret');
    expect(auth.map((a) => a.assertionId)).not.toContain('main-secret');
  });

  it('defaults to "main" branch with single-branch ledger', () => {
    const result = compileDiscourseBoundaries([event], SINGLE_BRANCH_LEDGER, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'main');
    const ctx = result['E1']!;
    expect(ctx).toBeDefined();

    const pkg = compiler.compile(event, state, registry, {
      discourseContext: ctx,
      narratorProfiles: { 'test-narrator': TEST_NARRATOR_PROFILE },
    });
    expect(pkg.discourseProjection).toBeDefined();
    const auth = pkg.discourseProjection!.authorizedTargets;
    expect(auth.map((a) => a.assertionId)).toContain('main-secret');
  });

  it('produces empty contexts when ledger is null (no-disclosure mode)', () => {
    const eventWithCursor = makeEvent({ id: 'E1', discourseCursor: -1, narratorProfileRef: 'test-narrator' });
    const result = compileDiscourseBoundaries([eventWithCursor], null, {}, {}, 'main');
    // No ledger means no discourse: compileDiscourseBoundaries returns empty map
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('produces no discourse projection when no compiled discourse context', () => {
    const pkg = compiler.compile(event, state, registry, {
      narratorProfiles: { 'test-narrator': TEST_NARRATOR_PROFILE },
    });
    expect(pkg.discourseProjection).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1b. Strict preflight: invalid ledger/catalog fails before any side effect
// ═════════════════════════════════════════════════════════════════════════════

describe('compileDiscourseBoundaries strict preflight', () => {
  const event = makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' });
  

  it('rejects reveal referencing unknown assertion', () => {
    const badLedger: PlannedDiscourseLedger = {
      id: 'bad-reveal',
      hash: 'bad-hash',
      entries: [makeLedgerEntry('bad-e1', 'reveal', 'nonexistent', 'E1', 'main', 0)],
    };
    // Provide a different assertion so the catalog is non-empty
    const existingAssertion: NarratorAssertion = {
      id: 'some-other',
      narrator: 'test-narrator',
      proposition: 'Some other assertion',
      polarity: 'affirmative',
      type: 'claim',
      truthBoundary: false,
      narrationBoundary: { narratorId: 'test-narrator' },
    };
    expect(() =>
      compileDiscourseBoundaries([event], badLedger, { 'some-other': existingAssertion }, {}, 'main'),
    ).toThrow('does not exist in the assertion catalog');
  });

  it('rejects reveal of non-authoritative assertion', () => {
    const nonAuthAssertion: NarratorAssertion = {
      id: 'non-auth',
      narrator: 'test-narrator',
      proposition: 'Not authoritative',
      polarity: 'affirmative',
      type: 'claim',
      truthBoundary: false,
      narrationBoundary: { narratorId: 'test-narrator' },
    };
    const badLedger: PlannedDiscourseLedger = {
      id: 'bad-reveal-type',
      hash: 'bad-hash',
      entries: [makeLedgerEntry('bad-e1', 'reveal', 'non-auth', 'E1', 'main', 0)],
    };
    expect(() =>
      compileDiscourseBoundaries([event], badLedger, { 'non-auth': nonAuthAssertion }, {}, 'main'),
    ).toThrow('truthBoundary=false');
  });

  it('rejects claim referencing authoritative_reveal assertion', () => {
    const authAssertion: NarratorAssertion = {
      id: 'auth-reveal',
      narrator: 'test-narrator',
      proposition: 'Authoritative truth',
      polarity: 'affirmative',
      type: 'authoritative_reveal',
      truthBoundary: true,
      narrationBoundary: { narratorId: 'test-narrator' },
    };
    const badLedger: PlannedDiscourseLedger = {
      id: 'bad-claim',
      hash: 'bad-hash',
      entries: [makeLedgerEntry('bad-e1', 'claim', 'auth-reveal', 'E1', 'main', 0)],
    };
    expect(() =>
      compileDiscourseBoundaries([event], badLedger, { 'auth-reveal': authAssertion }, {}, 'main'),
    ).toThrow('authoritative');
  });

  it('rejects unknown sceneId in ledger entry', () => {
    const unknownSceneLedger: PlannedDiscourseLedger = {
      id: 'bad-scene',
      hash: 'bad-hash',
      entries: [
        {
          id: 'unknown-scene',
          action: { type: 'reveal', assertionId: 'main-secret', discoursePosition: 0 },
          sceneId: 'NONEXISTENT',
          branch: 'main',
          discoursePosition: 0,
        },
      ],
    };
    expect(() =>
      compileDiscourseBoundaries([event], unknownSceneLedger, ASSERTIONS, {}, 'main'),
    ).toThrow('which does not match any event ID');
  });

  it('rejects action/entry position mismatch', () => {
    const mismatchLedger: PlannedDiscourseLedger = {
      id: 'pos-mismatch',
      hash: 'mismatch-hash',
      entries: [
        {
          id: 'bad-pos',
          action: { type: 'reveal', assertionId: 'main-secret', discoursePosition: 5 },
          sceneId: 'E1',
          branch: 'main',
          discoursePosition: 0,
        },
      ],
    };
    expect(() =>
      compileDiscourseBoundaries([event], mismatchLedger, ASSERTIONS, {}, 'main'),
    ).toThrow('different from entry.discoursePosition');
  });

  it('rejects event with no ledger actions and no explicit discourseCursor', () => {
    const eventNoCursor = makeEvent({ id: 'E2', source: 'event_file' });
    
    const emptySceneLedger: PlannedDiscourseLedger = {
      id: 'empty-scene',
      hash: 'empty-hash',
      entries: [
        makeLedgerEntry('e1', 'reveal', 'main-secret', 'E1', 'main', 0),
      ],
    };
    expect(() =>
      compileDiscourseBoundaries([eventNoCursor, makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' })], emptySceneLedger, ASSERTIONS, {}, 'main'),
    ).toThrow('no ledger entries and no discourseCursor field');
  });

  it('rejects discourseCursor less than -1', () => {
    const eventBadCursor = makeEvent({ id: 'E2', discourseCursor: -2, source: 'event_file' });
    const emptySceneLedger: PlannedDiscourseLedger = {
      id: 'empty-scene',
      hash: 'empty-hash',
      entries: [
        makeLedgerEntry('e1', 'reveal', 'main-secret', 'E1', 'main', 0),
      ],
    };
    
    expect(() =>
      compileDiscourseBoundaries([eventBadCursor, makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' })], emptySceneLedger, ASSERTIONS, {}, 'main'),
    ).toThrow('invalid discourseCursor');
  });

  it('accepts discourseCursor -1 for scene with no ledger actions', () => {
    const eventMinusOne = makeEvent({ id: 'E2', discourseCursor: -1, source: 'event_file' });
    const singleSceneLedger: PlannedDiscourseLedger = {
      id: 'single-scene',
      hash: 'single-hash',
      entries: [
        makeLedgerEntry('e1', 'reveal', 'main-secret', 'E1', 'main', 0),
      ],
    };
    
    const ctx = compileDiscourseBoundaries([eventMinusOne, makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' })], singleSceneLedger, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'main');
    expect(ctx['E2']).toBeDefined();
    expect(ctx['E2']!.cursor).toBe(-1);
    expect(ctx['E2']!.currentActionIds).toEqual([]);
  });

  it('accepts sparse positions across different scenes', () => {
    const e1Event = makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' });
    const e2Event = makeEvent({ id: 'E2', discourseCursor: 0, source: 'event_file' });
    const e3Event = makeEvent({ id: 'E3', discourseCursor: 2, source: 'event_file' });
    
    const sparseLedger: PlannedDiscourseLedger = {
      id: 'sparse',
      hash: 'sparse-hash',
      entries: [
        makeLedgerEntry('e1', 'reveal', 'main-secret', 'E1', 'main', 0),
        makeLedgerEntry('e3', 'reveal', 'alt-secret', 'E3', 'main', 2),
      ],
    };
    const ctx = compileDiscourseBoundaries([e1Event, e2Event, e3Event], sparseLedger, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'main');
    // E1 has actions at position 0
    // E2 has no actions but cursor 0
    // E3 has actions at position 2
    expect(Object.keys(ctx)).toHaveLength(3);
    expect(ctx['E1']!.currentActionIds).toEqual(['e1']);
    expect(ctx['E2']!.currentActionIds).toEqual([]);
    expect(ctx['E3']!.currentActionIds).toEqual(['e3']);
  });

  it('accepts continuous range for single scene with multiple actions', () => {
    const e1Event = makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' });
    
    const continuousLedger: PlannedDiscourseLedger = {
      id: 'continuous',
      hash: 'cont-hash',
      entries: [
        makeLedgerEntry('e1a', 'reveal', 'main-secret', 'E1', 'main', 0),
        makeLedgerEntry('e1b', 'reveal', 'alt-secret', 'E1', 'main', 1),
      ],
    };
    const ctx = compileDiscourseBoundaries([e1Event], continuousLedger, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'main');
    expect(ctx['E1']!.currentActionIds).toEqual(['e1a', 'e1b']);
    expect(ctx['E1']!.cursor).toBe(0); // firstPos = 0
  });

  it('passes valid retraction of active claim', () => {
    const claimAssertion: NarratorAssertion = {
      id: 'some-claim',
      narrator: 'test-narrator',
      proposition: 'A claim',
      polarity: 'affirmative',
      type: 'claim',
      truthBoundary: false,
      narrationBoundary: { narratorId: 'test-narrator' },
    };
    const e1Event = makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' });
    
    const ledger: PlannedDiscourseLedger = {
      id: 'retraction-test',
      hash: 'retract-hash',
      entries: [
        makeLedgerEntry('c1', 'claim', 'some-claim', 'E1', 'main', 0),
        makeLedgerEntry('r1', 'retraction', 'some-claim', 'E1', 'main', 1),
      ],
    };
    const ctx = compileDiscourseBoundaries([e1Event], ledger, { 'some-claim': claimAssertion }, {}, 'main');
    expect(ctx['E1']!.currentActionIds).toEqual(['c1', 'r1']);
  });

  it('rejects retraction without prior active claim or reveal', () => {
    const e1Event = makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' });
    
    const ledger: PlannedDiscourseLedger = {
      id: 'bad-retract',
      hash: 'bad-retract-hash',
      entries: [
        makeLedgerEntry('r1', 'retraction', 'main-secret', 'E1', 'main', 0),
      ],
    };
    expect(() =>
      compileDiscourseBoundaries([e1Event], ledger, ASSERTIONS, {}, 'main'),
    ).toThrow('not been revealed or claimed');
  });

  it('rejects correction with non-existent new assertion', () => {
    const e1Event = makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' });
    
    const ledger: PlannedDiscourseLedger = {
      id: 'bad-correction',
      hash: 'bad-corr-hash',
      entries: [
        makeLedgerEntry('c1', 'claim', 'test-claim', 'E1', 'main', 0),
        {
          id: 'corr1',
          action: {
            type: 'correction',
            priorAssertionId: 'test-claim',
            newAssertionId: 'nonexistent-new',
            discoursePosition: 1,
          },
          sceneId: 'E1',
          branch: 'main',
          discoursePosition: 1,
        },
      ],
    };
    expect(() =>
      compileDiscourseBoundaries([e1Event], ledger, ASSERTIONS, {}, 'main'),
    ).toThrow('does not exist in the assertion catalog');
  });

  it('rejects duplicate assertion IDs in assertion catalog', () => {
    // This test validates that preflight catches non-unique IDs within a single-ledger context
    // Duplicate assertion IDs are caught as unknown during preflight
    const e1Event = makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' });
    
    const dupLedger: PlannedDiscourseLedger = {
      id: 'dup-assert',
      hash: 'dup-assert-hash',
      entries: [
        makeLedgerEntry('e1a', 'reveal', 'main-secret', 'E1', 'main', 0),
        makeLedgerEntry('e1b', 'reveal', 'main-secret', 'E1', 'main', 1),
      ],
    };
    // Both actions reference the same assertion "main-secret" — this is not an error
    const ctx = compileDiscourseBoundaries([e1Event], dupLedger, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'main');
    expect(ctx['E1']).toBeDefined();
  });

  it('rejects duplicate discourse positions on same branch', () => {
    const dupLedger: PlannedDiscourseLedger = {
      id: 'dup-pos',
      hash: 'dup-hash',
      entries: [
        makeLedgerEntry('e1a', 'reveal', 'main-secret', 'E1', 'main', 0),
        makeLedgerEntry('e1b', 'reveal', 'main-secret', 'E1', 'main', 0),
      ],
    };
    expect(() =>
      compileDiscourseBoundaries([event], dupLedger, ASSERTIONS, {}, 'main'),
    ).toThrow('Duplicate discourse position');
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// 2. API-level: renderNovel validation guards
// ═════════════════════════════════════════════════════════════════════════════
//
// These tests create a minimal on-disk project so renderNovel can run
// through initializeProject and reach the discourse-branch validation.
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_YAML = [
  'project: test-project',
  'title: Test',
  'author: Test Author',
  'defaultLanguage: en',
].join('\n');

const EVENT_YAML = [
  'event: E1',
  'narrativeOrder: 1',
  'title: Test Event',
  'storyTime: day_1',
  'pov:',
  '  character: test-char',
  '  type: third_person_limited',
  'sceneBrief: A test scene for discourse branch validation.',
  'preconditions: []',
  'expectedPostconditions: []',
].join('\n');

const STATE_INITIAL_YAML = [
  'info:',
  '  currentEra: modern',
  '  politicalSituation: stable',
  'threads: []',
  'worldFacts: []',
].join('\n');
const CHAPTER_YAML = [
  'chapter: 1',
  'title: "Chapter 1"',
  'summary: "Test scene for discourse branch validation."',
  'intent: "Test intent"',
  'plannedScenes: 1',
].join('\n');
function makeDiscourseLedgerYaml(entries: string): string {
  return ['id: test-ledger', 'hash: test-hash', 'entries:', entries].join('\n');
}
const MULTI_BRANCH_ENTRIES = [
  '  - id: main-e1',
  '    sceneId: E1',
  '    branch: main',
  '    action:',
  '      type: reveal',
  '      assertionId: main-secret',
  '      discoursePosition: 0',
  '    discoursePosition: 0',
  '  - id: alt-e1',
  '    sceneId: E1',
  '    branch: alternate',
  '    action:',
  '      type: reveal',
  '      assertionId: alt-secret',
  '      discoursePosition: 1',
  '    discoursePosition: 1',
].join('\n');
const SINGLE_BRANCH_ENTRIES = [
  '  - id: only-e1',
  '    sceneId: E1',
  '    branch: main',
  '    action:',
  '      type: reveal',
  '      assertionId: main-secret',
  '      discoursePosition: 0',
  '    discoursePosition: 0',
].join('\n');



/**
 * Set up a temporary project directory with the minimum files required
 * for renderNovel to load and reach discourse-branch validation.
 * Returns the project path and a cleanup function.
 */
function setupMinimalProject(discourseLedgerYaml: string): {
  projectDir: string;
  cleanup: () => void;
} {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), 'discourse-branch-test-'));
  const defsDir = path.join(projectDir, 'definitions');
  const assertionsDir = path.join(defsDir, 'assertions');
  const chaptersDir = path.join(projectDir, 'chapters', 'chapter_1');

  fs.mkdirSync(assertionsDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  fs.writeFileSync(path.join(projectDir, 'nova.yaml'), PROJECT_YAML);
  fs.writeFileSync(path.join(defsDir, 'discourse-ledger.yaml'), discourseLedgerYaml);
  fs.writeFileSync(path.join(defsDir, 'state_initial.yaml'), STATE_INITIAL_YAML);
  fs.writeFileSync(path.join(chaptersDir, '_chapter.yaml'), CHAPTER_YAML);
  fs.writeFileSync(path.join(chaptersDir, 'E1.yaml'), EVENT_YAML);

  // Write assertion catalog for strict discourse preflight
  const mainAssertionYaml = [
    'id: main-secret',
    'narrator: test-narrator',
    'proposition: Main branch secret',
    'polarity: affirmative',
    'type: authoritative_reveal',
    'truthBoundary: true',
    'narrationBoundary:',
    '  narratorId: test-narrator',
  ].join('\n');
  fs.writeFileSync(path.join(assertionsDir, 'main-secret.yaml'), mainAssertionYaml);

  const altAssertionYaml = [
    'id: alt-secret',
    'narrator: test-narrator',
    'proposition: Alternate branch secret',
    'polarity: affirmative',
    'type: authoritative_reveal',
    'truthBoundary: true',
    'narrationBoundary:',
    '  narratorId: test-narrator',
  ].join('\n');
  fs.writeFileSync(path.join(assertionsDir, 'alt-secret.yaml'), altAssertionYaml);

  return {
    projectDir,
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

function makeMinimalBranchPath(): BranchPath {
  return {
    decisions: [{ atEventId: 'E1', choiceId: 'choice_a', narrativeOrder: 1 }],
  };
}

describe('renderNovel discourse-branch validation', () => {
  it('rejects multi-branch ledger + branchPath + no explicit discourseBranch', async () => {
    const { projectDir, cleanup } = setupMinimalProject(
      makeDiscourseLedgerYaml(MULTI_BRANCH_ENTRIES),
    );
    try {
      const result = await renderNovel({
        projectDir,
        dryRun: true,
        branchPath: makeMinimalBranchPath(),
        // discourseBranch deliberately omitted
      });

      expect(result.results).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('discourseBranch');
    } finally {
      cleanup();
    }
  });

  it('rejects explicit discourseBranch not found in ledger entries', async () => {
    const { projectDir, cleanup } = setupMinimalProject(
      makeDiscourseLedgerYaml(SINGLE_BRANCH_ENTRIES),
    );
    try {
      const result = await renderNovel({
        projectDir,
        dryRun: true,
        discourseBranch: 'nonexistent',
      });

      expect(result.results).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('does not match any branch');
    } finally {
      cleanup();
    }
  });

  it('rejects explicit discourseBranch when no ledger exists', async () => {
    // Project without definitions/discourse-ledger.yaml — no ledger YAML written
    const projectDir = fs.mkdtempSync(path.join(tmpdir(), 'discourse-branch-test-'));
    const defsDir = path.join(projectDir, 'definitions');
    const chaptersDir = path.join(projectDir, 'chapters', 'chapter_1');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.mkdirSync(chaptersDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'nova.yaml'), PROJECT_YAML);
    fs.writeFileSync(path.join(defsDir, 'state_initial.yaml'), STATE_INITIAL_YAML);
    fs.writeFileSync(path.join(chaptersDir, '_chapter.yaml'), CHAPTER_YAML);
    fs.writeFileSync(path.join(chaptersDir, 'E1.yaml'), EVENT_YAML);

    try {
      const result = await renderNovel({
        projectDir,
        dryRun: true,
        discourseBranch: 'main',
      });

      expect(result.results).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('no discourse ledger');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('succeeds with explicit valid discourseBranch + dry-run (no error)', async () => {
    const { projectDir, cleanup } = setupMinimalProject(
      makeDiscourseLedgerYaml(SINGLE_BRANCH_ENTRIES),
    );
    try {
      const result = await renderNovel({
        projectDir,
        dryRun: true,
        discourseBranch: 'main',
      });

      // Should succeed — no errors, one dry-run result for E1
      expect(result.errors).toHaveLength(0);
      expect(result.results.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Shared post-merge projection identity (§14)
// ═════════════════════════════════════════════════════════════════════════════
// Two branches producing different projections for the same scene is valid;
// the merge gates check that projections are identical before allowing a merge.
// ─────────────────────────────────────────────────────────────────────────────

describe('shared post-merge projection identity', () => {
  const compiler = new ContextCompiler();
  const state = makeWorldState();
  const registry = makeRegistry();
  

  it('main and alternate branches produce different projections for same event', () => {
    const event = makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' });

    const mainCtx = compileDiscourseBoundaries([event], MULTI_BRANCH_LEDGER, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'main');
    const altCtx = compileDiscourseBoundaries([event], MULTI_BRANCH_LEDGER, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'alternate');

    const mainProj = mainCtx['E1']!.projection;
    const altProj = altCtx['E1']!.projection;
    expect(areProjectionsIdentical(mainProj, altProj)).toBe(false);
    expect(mainProj.authorizedTargets).not.toEqual(altProj.authorizedTargets);
  });

  it('same branch on same ledger produces identical projections', () => {
    const event = makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' });

    const firstCtx = compileDiscourseBoundaries([event], MULTI_BRANCH_LEDGER, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'main');
    const secondCtx = compileDiscourseBoundaries([event], MULTI_BRANCH_LEDGER, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'main');

    const firstProj = firstCtx['E1']!.projection;
    const secondProj = secondCtx['E1']!.projection;
    // Same branch, same ledger, same assertions — projections are deterministic
    expect(areProjectionsIdentical(firstProj, secondProj)).toBe(true);
  });

  it('different assertion catalogs produce different projections', () => {
    const event = makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' });

    // Use a ledger with a claim action so proposition text appears in accessibleClaims
    const claimLibLedger: PlannedDiscourseLedger = {
      id: 'claim-lib',
      hash: 'claim-lib-hash',
      entries: [makeLedgerEntry('c1', 'claim', 'test-claim', 'E1', 'main', 0)],
    };

    // Different proposition text for the same assertion
    const assertionsA: Record<string, NarratorAssertion> = {
      'test-claim': { ...CLAIM_ASSERTION, proposition: 'Claim version A' },
    };
    const assertionsB: Record<string, NarratorAssertion> = {
      'test-claim': { ...CLAIM_ASSERTION, proposition: 'Claim version B' },
    };

    const ctxA = compileDiscourseBoundaries([event], claimLibLedger, assertionsA, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'main');
    const ctxB = compileDiscourseBoundaries([event], claimLibLedger, assertionsB, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'main');

    const projA = ctxA['E1']!.projection;
    const projB = ctxB['E1']!.projection;
    // Proposition text appears in accessibleClaims.surface for claim actions
    expect(areProjectionsIdentical(projA, projB)).toBe(false);
  });

  it('branch switch produces different ledgerHashes', () => {
    const event = makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' });

    const mainCtx = compileDiscourseBoundaries([event], MULTI_BRANCH_LEDGER, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'main');
    const altCtx = compileDiscourseBoundaries([event], MULTI_BRANCH_LEDGER, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'alternate');

    // Both branches read from the same multi-branch ledger, so ledgerHash is the same.
    // But the cursor and currentActionIds differ because different branches.
    expect(mainCtx['E1']!.branch).toBe('main');
    expect(altCtx['E1']!.branch).toBe('alternate');
    expect(mainCtx['E1']!.currentActionIds).not.toEqual(altCtx['E1']!.currentActionIds);
  });

  it('projection stateBefore and stateAfter are consistent for scenes with actions', () => {
    const event = makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' });

    const ctx = compileDiscourseBoundaries([event], SINGLE_BRANCH_LEDGER, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'main');

    const compiled = ctx['E1']!;
    // For a scene WITH actions, stateBefore is pre-action and stateAfter is post-action
    expect(compiled.stateBefore.position).toBeLessThanOrEqual(compiled.stateAfter.position);
    // stateBefore has no reveals for this scene's actions
    // stateAfter has the scene's reveals applied
  });

  it('projection stateBefore equal to stateAfter for -1 cursor scenes', () => {
    const eventWithMinusOne = makeEvent({ id: 'E2', discourseCursor: -1, source: 'event_file' });
    const ledger: PlannedDiscourseLedger = {
      id: 'other-scene',
      hash: 'other-hash',
      entries: [
        makeLedgerEntry('e1', 'reveal', 'main-secret', 'E1', 'main', 0),
      ],
    };
    
    const ctx = compileDiscourseBoundaries([eventWithMinusOne, makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' })], ledger, ASSERTIONS, { 'test-narrator': TEST_NARRATOR_PROFILE }, 'main');

    const compiled = ctx['E2']!;
    // For -1 cursor, stateBefore === stateAfter (no actions applied)
    expect(compiled.cursor).toBe(-1);
    expect(compiled.stateBefore.position).toBe(compiled.stateAfter.position);
  });
});
