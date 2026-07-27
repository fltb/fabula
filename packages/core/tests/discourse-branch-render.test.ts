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

const ASSERTIONS: Record<string, NarratorAssertion> = {
  'main-secret': MAIN_ASSERTION,
  'alt-secret': ALT_ASSERTION,
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
// 1. Compiler-level: branch selection produces correct projection
// ═════════════════════════════════════════════════════════════════════════════

describe('ContextCompiler discourse branch selection', () => {
  const compiler = new ContextCompiler();
  const event = makeEvent({ id: 'E1', narratorProfileRef: 'test-narrator' });
  const state = makeWorldState();
  const registry = makeRegistry();

  it('selects main-branch entries when discourseBranch is "main"', () => {
    const pkg = compiler.compile(event, state, registry, {
      discourseLedger: MULTI_BRANCH_LEDGER,
      narratorAssertions: ASSERTIONS,
      narratorProfiles: { 'test-narrator': TEST_NARRATOR_PROFILE },
      discourseBranch: 'main',
    });

    expect(pkg.discourseProjection).toBeDefined();
    const auth = pkg.discourseProjection!.authorizedTargets;
    expect(auth.map((a) => a.assertionId)).toContain('main-secret');
    expect(auth.map((a) => a.assertionId)).not.toContain('alt-secret');
  });

  it('selects alternate-branch entries when discourseBranch is "alternate"', () => {
    const pkg = compiler.compile(event, state, registry, {
      discourseLedger: MULTI_BRANCH_LEDGER,
      narratorAssertions: ASSERTIONS,
      narratorProfiles: { 'test-narrator': TEST_NARRATOR_PROFILE },
      discourseBranch: 'alternate',
    });

    expect(pkg.discourseProjection).toBeDefined();
    const auth = pkg.discourseProjection!.authorizedTargets;
    expect(auth.map((a) => a.assertionId)).toContain('alt-secret');
    expect(auth.map((a) => a.assertionId)).not.toContain('main-secret');
  });

  it('defaults to "main" when discourseBranch is undefined and ledger is single-branch', () => {
    const pkg = compiler.compile(event, state, registry, {
      discourseLedger: SINGLE_BRANCH_LEDGER,
      narratorAssertions: ASSERTIONS,
      narratorProfiles: { 'test-narrator': TEST_NARRATOR_PROFILE },
    });

    expect(pkg.discourseProjection).toBeDefined();
    const auth = pkg.discourseProjection!.authorizedTargets;
    expect(auth.map((a) => a.assertionId)).toContain('main-secret');
  });

  it('defaults to "main" when discourseBranch is undefined and ledger is multi-branch', () => {
    // The compiler itself does not reject multi-branch+no-label — the API
    // guard in renderNovel handles that.  The compiler's default is 'main'.
    const pkg = compiler.compile(event, state, registry, {
      discourseLedger: MULTI_BRANCH_LEDGER,
      narratorAssertions: ASSERTIONS,
      narratorProfiles: { 'test-narrator': TEST_NARRATOR_PROFILE },
    });

    expect(pkg.discourseProjection).toBeDefined();
    const auth = pkg.discourseProjection!.authorizedTargets;
    expect(auth.map((a) => a.assertionId)).toContain('main-secret');
    expect(auth.map((a) => a.assertionId)).not.toContain('alt-secret');
  });

  it('produces no discourse projection when ledger is null (no discourse-ledger.yaml)', () => {
    const pkg = compiler.compile(event, state, registry, {});

    expect(pkg.discourseProjection).toBeUndefined();
    expect(pkg.discourseReplayError).toBeUndefined();
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
  const chaptersDir = path.join(projectDir, 'chapters', 'chapter_1');

  fs.mkdirSync(defsDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  fs.writeFileSync(path.join(projectDir, 'nova.yaml'), PROJECT_YAML);
  fs.writeFileSync(path.join(defsDir, 'discourse-ledger.yaml'), discourseLedgerYaml);
  fs.writeFileSync(path.join(defsDir, 'state_initial.yaml'), STATE_INITIAL_YAML);
  fs.writeFileSync(path.join(chaptersDir, '_chapter.yaml'), CHAPTER_YAML);
  fs.writeFileSync(path.join(chaptersDir, 'E1.yaml'), EVENT_YAML);

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
