// ============================================================================
// AI Provider — Prompt Builders — Unit Tests
// ============================================================================

import { describe, expect, it } from 'vitest';
import { buildSceneRenderPrompt } from '../../src/ai/prompts/scene-render.ts';
import type { ThreadStatusInput } from '../../src/ai/prompts/thread-status.ts';
import { buildThreadStatusPrompt } from '../../src/ai/prompts/thread-status.ts';
import type { ContextPackage, StyleGuidance } from '../../src/types/index.ts';

// ============================================================================
// Factory helpers
// ============================================================================

function minimalContext(): ContextPackage {
  return {
    eventId: 'evt_001',
    systemContext: {
      genre: 'Literary Fiction',
      style: 'Third-person limited, present tense',
      narrativeRules: ['Maintain POV consistency', 'No authorial intrusion'],
    },
    sceneSpec: {
      goal: 'Introduce the protagonist in her daily routine',
      beats: ['Introduce the protagonist in her daily routine'],
      povType: 'third-person limited',
      povCharacter: 'protagonist_001',
      conflict: 'Internal dissatisfaction',
      expectedOutcome: 'Reader understands the protagonist ennui',
    },
    characterSnapshots: [],
    relationshipContext: [],
    worldFacts: [],
    knowledgeBoundary: {
      characterId: 'protagonist_001',
      knownFacts: [],
    },
    activeThreads: [],
    markdown: '',
    narrativeTechniques: [],
  };
}

function simpleStyleGuidance(): StyleGuidance {
  return {
    tone: 'melancholic, introspective',
    characterVoice: { protagonist_001: 'reserved, analytical' },
    avoid: 'melodrama, exposition dumps',
    scenePacing: 'slow, deliberate',
    atmosphere: 'rainy afternoon, muted light',
  };
}

function sampleThreadInput(): ThreadStatusInput {
  return {
    threads: [
      { id: 't1', name: 'Protagonist arc', progress: 0.6, lastEvent: 'Discovers hidden letter' },
      { id: 't2', name: 'Antagonist plot', progress: 0.3, lastEvent: 'Receives orders' },
    ],
    currentChapter: 5,
    currentEvent: 'Protagonist confronts the truth',
  };
}

// ============================================================================
// buildSceneRenderPrompt
// ============================================================================

describe('buildSceneRenderPrompt', () => {
  it('returns a system message and a user message', () => {
    const messages = buildSceneRenderPrompt({ context: minimalContext() });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('includes the default system content about narrative prose writing', () => {
    const messages = buildSceneRenderPrompt({ context: minimalContext() });
    const sys = messages[0].content;
    expect(sys).toContain('narrative prose writer');
    expect(sys).toContain('long-form literary novel');
    expect(sys).toContain('Do not invent facts');
  });

  it('includes the context package as JSON in the user message', () => {
    const ctx = minimalContext();
    ctx.eventId = 'evt_unique_999';
    const messages = buildSceneRenderPrompt({ context: ctx });
    const user = messages[1].content;

    expect(user).toContain('Narrative Context Package');
    expect(user).toContain('evt_unique_999');
    // The context should be stringified JSON
    expect(user).toContain('"eventId": "evt_unique_999"');
  });

  it('includes style guidance fields when provided', () => {
    const messages = buildSceneRenderPrompt({
      context: minimalContext(),
      styleGuidance: simpleStyleGuidance(),
    });
    const sys = messages[0].content;

    expect(sys).toContain('Tone:');
    expect(sys).toContain('melancholic, introspective');
    expect(sys).toContain('Pacing:');
    expect(sys).toContain('slow, deliberate');
    expect(sys).toContain('Atmosphere:');
    expect(sys).toContain('rainy afternoon');
    expect(sys).toContain('Avoid:');
    expect(sys).toContain('melodrama');
  });

  it('partially applies style guidance when only some fields are set', () => {
    const messages = buildSceneRenderPrompt({
      context: minimalContext(),
      styleGuidance: { tone: 'urgent' },
    });
    const sys = messages[0].content;

    expect(sys).toContain('Tone: urgent');
    expect(sys).not.toContain('Pacing:');
    expect(sys).not.toContain('Atmosphere:');
    expect(sys).not.toContain('Avoid:');
  });

  it('includes character voice when provided', () => {
    const messages = buildSceneRenderPrompt({
      context: minimalContext(),
      characterVoice: 'protagonist speaks in short, clipped sentences',
    });
    const sys = messages[0].content;

    expect(sys).toContain('Character voice notes:');
    expect(sys).toContain('short, clipped sentences');
  });

  it('includes POV voice when provided', () => {
    const messages = buildSceneRenderPrompt({
      context: minimalContext(),
      povVoice: 'close third-person with free indirect discourse',
    });
    const sys = messages[0].content;

    expect(sys).toContain('POV voice:');
    expect(sys).toContain('free indirect discourse');
  });

  it('uses the provided target length', () => {
    const messages = buildSceneRenderPrompt({
      context: minimalContext(),
      targetLengthWords: 800,
    });
    const user = messages[1].content;

    expect(user).toContain('~800');
  });

  it('defaults target length to 1200 words when not specified', () => {
    const messages = buildSceneRenderPrompt({ context: minimalContext() });
    const user = messages[1].content;

    expect(user).toContain('~1200');
  });

  it('accepts zero as a target length', () => {
    const messages = buildSceneRenderPrompt({
      context: minimalContext(),
      targetLengthWords: 0,
    });
    const user = messages[1].content;

    expect(user).toContain('~0');
  });

  it('includes writing instructions in the user message', () => {
    const messages = buildSceneRenderPrompt({ context: minimalContext() });
    const user = messages[1].content;

    expect(user).toContain('Writing Instructions');
    expect(user).toContain('third-person limited POV');
    expect(user).toContain('Show, do not tell');
    expect(user).toContain('Output ONLY the prose');
  });

  it('combines all optional fields in system prompt', () => {
    const messages = buildSceneRenderPrompt({
      context: minimalContext(),
      styleGuidance: { tone: 'dark', atmosphere: 'oppressive' },
      characterVoice: 'terse',
      povVoice: 'omniscient',
    });
    const sys = messages[0].content;

    expect(sys).toContain('Tone: dark');
    expect(sys).toContain('Atmosphere: oppressive');
    expect(sys).toContain('Character voice notes: terse');
    expect(sys).toContain('POV voice: omniscient');
  });

  it('does not modify the input context object', () => {
    const ctx = minimalContext();
    const original = JSON.stringify(ctx);
    buildSceneRenderPrompt({ context: ctx });
    expect(JSON.stringify(ctx)).toBe(original);
  });
});

// ============================================================================
// buildThreadStatusPrompt
// ============================================================================

describe('buildThreadStatusPrompt', () => {
  it('returns a system message and a user message', () => {
    const messages = buildThreadStatusPrompt(sampleThreadInput());
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('sets the system message to narrative continuity analyst', () => {
    const messages = buildThreadStatusPrompt(sampleThreadInput());
    expect(messages[0].content).toContain('narrative continuity analyst');
    expect(messages[0].content).toContain('status report');
    expect(messages[0].content).toContain('1-3');
  });

  it('includes current chapter and event in the user message', () => {
    const messages = buildThreadStatusPrompt(sampleThreadInput());
    const user = messages[1].content;

    expect(user).toContain('Current chapter: 5');
    expect(user).toContain('Current event: Protagonist confronts the truth');
  });

  it('formats each thread with progress percentage', () => {
    const messages = buildThreadStatusPrompt(sampleThreadInput());
    const user = messages[1].content;

    expect(user).toContain('[t1] Protagonist arc — progress 60%');
    expect(user).toContain('[t2] Antagonist plot — progress 30%');
    expect(user).toContain('last event: Discovers hidden letter');
    expect(user).toContain('last event: Receives orders');
  });

  it('handles empty threads array', () => {
    const input: ThreadStatusInput = {
      threads: [],
      currentChapter: 1,
      currentEvent: 'Opening',
    };
    const messages = buildThreadStatusPrompt(input);
    const user = messages[1].content;

    expect(user).not.toContain('progress');
    expect(messages).toHaveLength(2);
  });

  it('handles a single thread', () => {
    const input: ThreadStatusInput = {
      threads: [{ id: 't1', name: 'Solo thread', progress: 1.0, lastEvent: 'End' }],
      currentChapter: 10,
      currentEvent: 'Final act',
    };
    const messages = buildThreadStatusPrompt(input);
    const user = messages[1].content;

    expect(user).toContain('[t1] Solo thread — progress 100%');
  });

  it('handles zero progress', () => {
    const input: ThreadStatusInput = {
      threads: [{ id: 't_new', name: 'New thread', progress: 0, lastEvent: 'Initiated' }],
      currentChapter: 1,
      currentEvent: 'Prologue',
    };
    const messages = buildThreadStatusPrompt(input);
    const user = messages[1].content;

    expect(user).toContain('progress 0%');
  });

  it('includes task instructions (3 numbered items)', () => {
    const messages = buildThreadStatusPrompt(sampleThreadInput());
    const user = messages[1].content;

    expect(user).toContain('1. Identify any thread that is stalled');
    expect(user).toContain('2. Suggest 1-3 concrete next actions');
    expect(user).toContain('3. Flag any internal consistency concerns');
  });

  it('handles many threads without error', () => {
    const manyThreads = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      name: `Thread ${i}`,
      progress: i / 20,
      lastEvent: `Event ${i}`,
    }));
    const input: ThreadStatusInput = {
      threads: manyThreads,
      currentChapter: 3,
      currentEvent: 'Midpoint',
    };
    const messages = buildThreadStatusPrompt(input);
    const user = messages[1].content;

    expect(user).toContain('[t0]');
    expect(user).toContain('[t19]');
  });
});
