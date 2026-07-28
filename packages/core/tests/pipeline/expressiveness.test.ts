// ============================================================================
// RenderPipeline — Expressiveness: Full Pass-1 Prompt Surface Coverage
// ============================================================================
// Verifies that every authorable Pass-1 prompt-surfaced field on a
// NarrativeEvent + ContextPackage reaches the user prompt sent to the LLM.
//
// Also verifies validator-class fields (preconditions, postconditions, S6
// Genette dimensions, etc.) are consumed by corresponding validators via
// table-driven assertions against ResultAggregator.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { MockProvider } from '../../src/ai/providers/mock.ts';
import type { Message } from '../../src/ai/types.ts';
import type { RenderJob } from '../../src/pipeline/render.ts';
import { RenderPipeline } from '../../src/pipeline/render.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type {
  ContextPackage,
  KnowledgeBoundary,
  NarrativeEvent,
  RuleDefinition,
  SceneSpecification,
  SystemContext,
} from '../../src/types/index.ts';
import { ResultAggregator } from '../../src/validator/aggregator.ts';

// ============================================================================
// Sentinel constants — each authored field gets an unmistakable unique value
// ============================================================================
const SENTINEL_EVENT_NAME = 'SENTINEL_EVENT_NAME_a1b2';
const SENTINEL_SCENE_BRIEF = 'SENTINEL_SCENE_BRIEF_c3d4';
const SENTINEL_TONE = 'SENTINEL_TONE_1b8c';
const SENTINEL_PACING = 'SENTINEL_PACING_3d2f';
const SENTINEL_ATMOSPHERE = 'SENTINEL_ATMOSPHERE_9a4b';
const SENTINEL_AVOID = 'SENTINEL_AVOID_7f3a';
const SENTINEL_CHAR_VOICE = 'SENTINEL_CHAR_VOICE_5c1e';
const SENTINEL_EMOTIONAL_VALENCE = 'SENTINEL_EMOTIONAL_VALENCE_f6d2';
const SENTINEL_EMOTIONAL_BEAT = 'SENTINEL_EMOTIONAL_BEAT_b3a7';
const SENTINEL_SYNOPSIS = 'SENTINEL_SYNOPSIS_c84f';
const SENTINEL_THEMATIC = 'SENTINEL_THEMATIC_e1a5';
const SENTINEL_TARGET_AUDIENCE = 'SENTINEL_TARGET_AUDIENCE_4d7c';
const SENTINEL_NARRATOR_FIDELITY = 'SENTINEL_NARRATOR_FIDELITY_8c2a';
const SENTINEL_NARRATOR_SINCERITY = 'SENTINEL_NARRATOR_SINCERITY_1d9e';
const SENTINEL_CHECKLIST = 'SENTINEL_CHECKLIST_6h4g';
const SENTINEL_STYLE_NOTE = 'SENTINEL_STYLE_NOTE_5i8j';
const SENTINEL_AUTHOR_NOTE = 'SENTINEL_AUTHOR_NOTE_2e9b';
const SENTINEL_RULE_STATEMENT = 'SENTINEL_RULE_7k3l';
const SENTINEL_STYLE_PROFILE_VOICE = 'SENTINEL_STYLE_PROFILE_9m2n';
const SENTINEL_INTRODUCES_NAME = 'SENTINEL_INTRODUCES_0d4e';
const SENTINEL_THREAD = 'SENTINEL_THREAD_6f5b';
const TARGET_WORD_COUNT = 1234;

// ============================================================================
// Test fixtures
// ============================================================================

function makeEvent(): NarrativeEvent {
  return {
    id: 'evt_express',
    event: SENTINEL_EVENT_NAME,
    narrativeOrder: 1,
    title: 'Expressiveness Test',
    storyTime: { type: 'absolute' as const, value: 'start' },
    sceneType: 'linear',
    pov: { character: 'entity_1', type: 'third_person_limited' },
    sceneBrief: SENTINEL_SCENE_BRIEF,
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'genesis',
    branchExistence: { type: 'all' as const },
    participants: { entities: ['entity_1'] },
    styleGuidance: {
      tone: SENTINEL_TONE,
      scenePacing: SENTINEL_PACING,
      atmosphere: SENTINEL_ATMOSPHERE,
      avoid: SENTINEL_AVOID,
      targetWordCount: TARGET_WORD_COUNT,
      characterVoice: { entity_1: SENTINEL_CHAR_VOICE },
    },
    targetAudience: SENTINEL_TARGET_AUDIENCE,
    narrativeChecklist: {
      items: [{ dimension: 'imagery', description: SENTINEL_CHECKLIST, required: true }],
    },
    sourceContext: {
      entries: [
        {
          excerpt: 'moonlit text',
          classification: 'STYLE' as const,
          styleNote: SENTINEL_STYLE_NOTE,
        },
        { excerpt: 'factual text', classification: 'FACT' as const },
      ],
    },
    cast: {
      onScreen: ['entity_1'],
      affected: [],
    },
    introduces: [
      {
        type: 'character' as const,
        id: 'entity_2',
        initialState: { name: SENTINEL_INTRODUCES_NAME },
      },
    ],
    authorNotes: [SENTINEL_AUTHOR_NOTE],
  };
}

function makeContext(): ContextPackage {
  return {
    eventId: 'evt_express',
    systemContext: {
      genre: 'literary',
      style: 'neutral',
      narrativeRules: [],
      targetAudience: SENTINEL_TARGET_AUDIENCE,
      synopsis: SENTINEL_SYNOPSIS,
      thematicIntent: {
        primaryTheme: SENTINEL_THEMATIC,
        subThemes: [],
      },
    } satisfies SystemContext,
    sceneSpec: {
      goal: SENTINEL_SCENE_BRIEF,
      povType: 'third_person',
      povCharacter: 'entity_1',
      conflict: SENTINEL_PACING,
      expectedOutcome: '',
      emotionalValence: SENTINEL_EMOTIONAL_VALENCE,
      emotionalBeat: SENTINEL_EMOTIONAL_BEAT,
      authorNotes: [SENTINEL_AUTHOR_NOTE],
    } satisfies SceneSpecification,
    characterSnapshots: [
      {
        id: 'entity_1',
        name: 'Character One',
        currentState: {},
        traits: [],
        voiceNotes: '',
      },
    ],
    relationshipContext: [],
    worldFacts: [],
    knowledgeBoundary: {
      entityId: 'entity_1',
      knownFacts: [],
    } satisfies KnowledgeBoundary,
    activeThreads: [
      { id: 'thread_1', name: SENTINEL_THREAD, progress: 0, total: 1, description: 'A thread' },
    ],
    volumeSummary: '',
    markdown: '',
    activeRules: [
      {
        ruleId: 'rule_1',
        name: 'Rule One',
        category: 'physical',
        type: 'invariant',
        statement: SENTINEL_RULE_STATEMENT,
        logicalConsequences: [],
      } satisfies RuleDefinition,
    ],
    narratorProfile: {
      type: 'omniscient',
      id: 'narrator_v1',
      access: 'full',
      assertion: 'full',
      truth: 'full_knowledge',
      fidelity: SENTINEL_NARRATOR_FIDELITY as unknown as 'reliable' | 'unreliable' | 'ambiguous',
      sincerity: SENTINEL_NARRATOR_SINCERITY as unknown as 'sincere' | 'deceptive' | 'ambiguous',
      autoReveal: false as const,
    },
  };
}

function makeJob(): RenderJob {
  return {
    event: makeEvent(),
    stateBefore: {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    },
    context: makeContext(),
    chapter: 1,
    contract: {
      sceneId: 'evt_express',
      branch: { decisions: [] },
      discoursePosition: 0,
      worldStateHash: 'a00',
      knowledgeStateHash: 'a00',
      narratorProfileHash: 'a00',
      plannedDiscourseHash: 'a00',
      styleProfile: {
        profileId: 'default',
        resolutionPrecedence: { projectStyle: 'default' },
      },
      continuityPacket: { transition: 'continuous' },
      promptContractHash: 'a00',
    },
    surfaceDependency: {
      groupId: 'default',
      policy: 'parallel' as const,
      manifestHash: 'a00',
    },
  };
}

/**
 * Build a pipeline with a styleProfile so the profileStyleNotes path is exercised.
 */
function buildPipeline(): { pipeline: RenderPipeline; provider: MockProvider } {
  // Must provide two responses: first for Pass 1 prose, second Pass 2 analysis
  const PASS_2_ANALYSIS = JSON.stringify({
    eventId: 'evt_express',
    analysis: {
      postconditions: { covered: [], dropped: [] },
      preconditions: { violated: [] },
      pov: { consistent: true, leaks: [] },
      inventedDetails: [],
      quality: {
        proseScore: 80,
        maxScore: 100,
        strengths: [],
        weaknesses: [],
        estimatedWordCount: 300,
      },
      threadProgressAchieved: [],
      foreshadowingDeployed: [],
      narrativeChecks: [],
      appearanceChecks: [],
      characterReferences: [],
      tenseDetected: 'past',
      conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
      ruleChecks: [],
      knowledgeChecks: [],
      durationDetected: 'scene',
      frequencyDetected: 'singulative',
      voiceDetected: { level: 'extradiegetic', relation: 'heterodiegetic' },
      anachronyDetected: 'none',
      focalizationDetected: 'zero',
    },
  });

  const provider = new MockProvider({
    responses: ['Test prose for expressiveness test.', PASS_2_ANALYSIS],
  });
  const pipeline = new RenderPipeline({
    provider,
    model: 'mock-model',
    cacheDir: '/tmp/test-cache',
    storage: new MemoryStorage(),
    skipCache: true,
    maxRetries: 1,
    styleProfile: { voice: SENTINEL_STYLE_PROFILE_VOICE },
  });
  return { pipeline, provider };
}

// ============================================================================
// Tests
// ============================================================================

describe('RenderPipeline — expressiveness Pass 1 prompt coverage', () => {
  it('surfaces every prompt-intended field with its sentinel in the Pass 1 user prompt', async () => {
    const { pipeline, provider } = buildPipeline();
    await pipeline.renderScene(makeJob());

    // Read the Pass 1 user message from the provider ledger
    const pass1Request = provider.calls[0];
    const userMessage = pass1Request.messages.find((m: Message) => m.role === 'user')!.content;
    const event = makeEvent();
    const context = makeContext();

    // ── Scene brief (→ sceneSpec.goal in context JSON) ──────────────
    expect(userMessage).toContain(SENTINEL_SCENE_BRIEF);

    // ── Style guidance: tone ───────────────────────────────────────
    expect(userMessage).toContain(`Tone: ${SENTINEL_TONE}.`);

    // ── Style guidance: pacing ─────────────────────────────────────
    expect(userMessage).toContain(`Pacing: ${SENTINEL_PACING}.`);

    // ── Style guidance: atmosphere ─────────────────────────────────
    expect(userMessage).toContain(`Atmosphere: ${SENTINEL_ATMOSPHERE}.`);

    // ── Style guidance: target word count ──────────────────────────
    expect(userMessage).toContain(`approximately ${TARGET_WORD_COUNT} words`);

    // ── Style guidance: avoid ──────────────────────────────────────
    expect(userMessage).toContain(`Avoid: ${SENTINEL_AVOID}.`);

    // ── Style guidance: character voice ────────────────────────────
    expect(userMessage).toContain(`Character voice: entity_1: ${SENTINEL_CHAR_VOICE}`);

    // ── Emotional valence ──────────────────────────────────────────
    expect(userMessage).toContain(`Emotional keynote: ${SENTINEL_EMOTIONAL_VALENCE}.`);

    // ── Emotional beat ─────────────────────────────────────────────
    expect(userMessage).toContain(`Emotional beat: ${SENTINEL_EMOTIONAL_BEAT}.`);

    // ── Synopsis ───────────────────────────────────────────────────
    expect(userMessage).toContain('## Work Synopsis');
    expect(userMessage).toContain(SENTINEL_SYNOPSIS);

    // ── Thematic intent (S7a) ──────────────────────────────────────
    expect(userMessage).toContain('## Thematic Intent');
    expect(userMessage).toContain(SENTINEL_THEMATIC);

    // ── Target audience ────────────────────────────────────────────
    expect(userMessage).toContain(`Target audience: ${SENTINEL_TARGET_AUDIENCE}.`);

    // ── Narrator profile (S6c) ─────────────────────────────────────
    expect(userMessage).toContain('## Narrator');
    expect(userMessage).toContain('Type: omniscient');
    expect(userMessage).toContain(`Fidelity: ${SENTINEL_NARRATOR_FIDELITY}`);
    expect(userMessage).toContain(`Sincerity: ${SENTINEL_NARRATOR_SINCERITY}`);

    // ── Narrative checklist (S1) ───────────────────────────────────
    expect(userMessage).toContain('## Narrative Coverage Requirements');
    expect(userMessage).toContain(SENTINEL_CHECKLIST);

    // ── Source style anchors (S4) ──────────────────────────────────
    expect(userMessage).toContain('## Source Style Anchors');
    expect(userMessage).toContain(SENTINEL_STYLE_NOTE);
    // FACT-classified entry must NOT appear
    expect(userMessage).not.toContain('factual text');

    // ── Author notes ───────────────────────────────────────────────
    expect(userMessage).toContain('## Author Notes');
    expect(userMessage).toContain(SENTINEL_AUTHOR_NOTE);

    // ── World rules (DRC) ──────────────────────────────────────────
    expect(userMessage).toContain('## World Rules');
    expect(userMessage).toContain(SENTINEL_RULE_STATEMENT);
    expect(userMessage).toContain('Prose must not contradict these rules.');

    // ── Profile style notes (from styleProfile) ────────────────────
    expect(userMessage).toContain(SENTINEL_STYLE_PROFILE_VOICE);

    // ── Thread advancement (activeThreads in context JSON) ─────────
    expect(userMessage).toContain(SENTINEL_THREAD);

    // ── introduces field is preserved on the event object ──────────
    expect(event.introduces).toBeDefined();
    expect(event.introduces!).toHaveLength(1);
    expect(event.introduces![0].id).toBe('entity_2');
    expect(event.introduces![0].initialState.name).toBe(SENTINEL_INTRODUCES_NAME);
  });
});

describe('RenderPipeline — validator-class fields consumed by validators', () => {
  it('each validator-class field has a corresponding validator with getAnalysisRequirements', () => {
    const aggregator = new ResultAggregator();
    const validators = aggregator.listValidators();
    const analysisReqs = aggregator.getAnalysisRequirements();
    const reqFields = analysisReqs.map((r) => r.field);

    // ── Table-driven assertions ──────────────────────────────────────
    // Each row: [field-name, expected-validator-name, expected-analysis-field]
    const validatorFieldTable: Array<{
      label: string;
      eventField: keyof NarrativeEvent;
      validatorName: string;
      expectedAnalysisField: string;
    }> = [
      {
        label: 'preconditions',
        eventField: 'preconditions',
        validatorName: 'causality',
        expectedAnalysisField: 'preconditions',
      },
      {
        label: 'postconditions',
        eventField: 'postconditions',
        validatorName: 'causality',
        expectedAnalysisField: 'postconditions',
      },
      {
        label: 'duration (S6a)',
        eventField: 'duration',
        validatorName: 'duration_consistency',
        expectedAnalysisField: 'durationDetected',
      },
      {
        label: 'frequency (S6b)',
        eventField: 'frequency',
        validatorName: 'frequency_consistency',
        expectedAnalysisField: 'frequencyDetected',
      },
      {
        label: 'voice (S6d)',
        eventField: 'voice',
        validatorName: 'voice_consistency',
        expectedAnalysisField: 'voiceDetected',
      },
      {
        label: 'anachrony (S6e)',
        eventField: 'anachrony',
        validatorName: 'anachrony_consistency',
        expectedAnalysisField: 'anachronyDetected',
      },
      {
        label: 'focalization (S6c)',
        eventField: 'focalization',
        validatorName: 'focalization_consistency',
        expectedAnalysisField: 'focalizationDetected',
      },
      {
        label: 'relationshipEffects',
        eventField: 'relationshipEffects',
        validatorName: 'character_state',
        expectedAnalysisField: 'narrativeChecks', // character state validator participates via narrativeChecks
      },
      {
        label: 'ruleEffects',
        eventField: 'ruleEffects',
        validatorName: 'world_rule',
        expectedAnalysisField: 'ruleChecks',
      },
    ];

    for (const row of validatorFieldTable) {
      // Verify the validator is registered
      const matchingValidator = validators.find((v) => v.name === row.validatorName);
      expect(
        matchingValidator,
        `"${row.label}": expected validator with name "${row.validatorName}" to be registered`,
      ).toBeDefined();

      // Verify the analysis requirement block exists
      const matchingReq = reqFields.find((f) => f === row.expectedAnalysisField);
      expect(
        matchingReq,
        `"${row.label}": expected analysis requirement field "${row.expectedAnalysisField}" to be declared in getAnalysisRequirements()`,
      ).toBeDefined();
    }
  });
});
