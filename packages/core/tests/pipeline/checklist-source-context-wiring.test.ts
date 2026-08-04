// ============================================================================
// RenderPipeline — Checklist + Source Context Prompt Wiring
// ============================================================================
// Verifies that RenderPipeline.renderScene() passes the event's
// narrativeChecklist (S1) and STYLE-classified sourceContext entries (S4)
// into the Pass 1 prompt via PromptAssembler's narrativeChecklistItems /
// sourceContextStyleNotes options.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { MockProvider } from '../../src/ai/providers/mock.ts';
import type { RenderJob } from '../../src/pipeline/render.ts';
import { RenderPipeline } from '../../src/pipeline/render.ts';
import type {
  CompiledSceneContract,
  ContextPackage,
  KnowledgeBoundary,
  NarrativeEvent,
  SceneSpecification,
  SystemContext,
} from '../../src/types/index.ts';
import { makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';
import { createRuntimeServices } from '../fixtures/runtime-services.ts';

const ANALYSIS_PAYLOAD: Record<string, unknown> = {
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
  checklistResults: [],
};

const VALID_ANALYSIS_JSON = JSON.stringify({
  eventId: 'evt_checklist',
  protocol: makeProtocol('This is generated prose.'),
  observations: makeObservations(ANALYSIS_PAYLOAD, 'This is generated prose.'),
  analysis: ANALYSIS_PAYLOAD,
});

function makeEvent(): NarrativeEvent {
  return {
    id: 'evt_checklist',
    event: 'Test event',
    narrativeOrder: 1,
    title: 'Test',
    storyTime: { type: 'absolute' as const, value: 'start' },
    sceneType: 'linear',
    pov: { character: 'entity_1', type: 'third_person_limited' },
    sceneBrief: 'A test scene.',
    beats: ['A test scene.'],
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence: { type: 'all' as const },
    participants: { entities: ['entity_1'] },
    narrativeChecklist: {
      items: [{ dimension: 'imagery', description: 'must reference moonlight', required: true }],
    },
    sourceContext: {
      entries: [
        { excerpt: '月光如水', classification: 'STYLE', styleNote: 'moonlight imagery' },
        { excerpt: 'he opened the door', classification: 'FACT' },
      ],
    },
  };
}

function makeContext(): ContextPackage {
  return {
    eventId: 'evt_checklist',
    systemContext: {
      genre: 'literary',
      style: 'neutral',
      narrativeRules: [],
    } satisfies SystemContext,
    sceneSpec: {
      goal: 'Advance plot',
      beats: ['Advance plot'],
      povType: 'third_person',
      povCharacter: 'narrator',
      conflict: 'none',
      expectedOutcome: 'Scene rendered',
    } satisfies SceneSpecification,
    characterSnapshots: [],
    relationshipContext: [],
    worldFacts: [],
    knowledgeBoundary: {
      entityId: 'narrator',
      knownFacts: [],
      restrictedEntities: [],
    } satisfies KnowledgeBoundary,
    markdown: '',
    narrativeTechniques: [],
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
    sourceContentHash: 'source-checklist',
    graphHash: 'a00',
    chapter: 1,
    contract: {
      sceneId: 'evt_checklist',
      branch: { decisions: [] },
      discoursePosition: 1,
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
    } satisfies CompiledSceneContract,
    surfaceDependency: {
      groupId: 'default',
      policy: 'parallel',
      manifestHash: 'a00',
    },
  };
}

describe('RenderPipeline — checklist + source context Pass 1 wiring', () => {
  it('injects narrativeChecklist items and STYLE-only source context into the Pass 1 prompt', async () => {
    const provider = new MockProvider({
      responses: ['This is generated prose.', VALID_ANALYSIS_JSON],
    });
    const pipeline = new RenderPipeline({
      provider,
      model: 'mock-model',
      runtimeServices: createRuntimeServices({ provider }).services,
      skipCache: true,
      maxRetries: 1,
      validatorPolicyId: 'test-policy-v1',
    });

    await pipeline.renderScene(makeJob());

    const pass1Request = provider.calls[0];
    const userMessage = pass1Request.messages.find((m) => m.role === 'user')?.content;

    expect(userMessage).toContain('## Narrative Coverage Requirements');
    expect(userMessage).toContain('imagery: must reference moonlight');
    expect(userMessage).toContain('## Source Style Anchors');
    expect(userMessage).toContain('月光如水');
    expect(userMessage).not.toContain('he opened the door');
  });
});
