// ============================================================================
// PromptAssembler — Thematic Intent (S7a) + Narrator (S6c) prompt sections
// ============================================================================
// Verifies that PromptAssembler.assemble() renders the "## Thematic Intent"
// section when systemContext.thematicIntent is set, the "## Narrator" section
// when context.narratorProfile is set, and omits both when unset.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { PromptAssembler } from '../../src/context/prompt-assembler.ts';
import type {
  ContextPackage,
  KnowledgeBoundary,
  NarratorProfile,
  SceneSpecification,
  SystemContext,
} from '../../src/types/index.ts';

function makeContext(overrides?: Partial<ContextPackage>): ContextPackage {
  return {
    eventId: 'evt_theme',
    systemContext: {
      genre: 'literary',
      style: 'neutral',
      narrativeRules: [],
    } satisfies SystemContext,
    sceneSpec: {
      goal: 'Advance plot',
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
    activeThreads: [],
    previousSceneSummary: '',
    volumeSummary: '',
    markdown: '',
    ...overrides,
  };
}

describe('PromptAssembler — thematic intent section', () => {
  it('renders ## Thematic Intent with primary theme and sub-themes when set', () => {
    const context = makeContext();
    context.systemContext.thematicIntent = {
      primaryTheme: 'ritual as social complicity',
      subThemes: ['moral paralysis', 'the ethics of narration'],
    };

    const { userPrompt } = new PromptAssembler().assemble(context);

    expect(userPrompt).toContain('## Thematic Intent');
    expect(userPrompt).toContain('ritual as social complicity');
    expect(userPrompt).toContain('Sub-themes: moral paralysis, the ethics of narration');
  });

  it('omits the section entirely when thematicIntent is unset', () => {
    const { userPrompt } = new PromptAssembler().assemble(makeContext());
    expect(userPrompt).not.toContain('## Thematic Intent');
  });

  it('omits the Sub-themes line when subThemes is empty', () => {
    const context = makeContext();
    context.systemContext.thematicIntent = {
      primaryTheme: 'ritual as social complicity',
      subThemes: [],
    };

    const { userPrompt } = new PromptAssembler().assemble(context);

    expect(userPrompt).toContain('## Thematic Intent');
    expect(userPrompt).not.toContain('Sub-themes:');
  });
});

describe('PromptAssembler — narrator section', () => {
  it('renders ## Narrator with type, fidelity, and sincerity when set', () => {
    const narratorProfile: NarratorProfile = {
      type: 'retrospective_entity',
      id: 'narrator_wo',
      access: 'full',
      assertion: 'constrained',
      truth: 'limited_knowledge',
      fidelity: 'reliable',
      sincerity: 'sincere',
      knowledgeBoundary: 'narrator_wo_present_day_knowledge',
    };
    const { userPrompt } = new PromptAssembler().assemble(makeContext({ narratorProfile }));

    expect(userPrompt).toContain('## Narrator');
    expect(userPrompt).toContain('Type: retrospective_entity');
    expect(userPrompt).toContain('Fidelity: reliable; Sincerity: sincere');
  });

  it('omits the section entirely when narratorProfile is unset', () => {
    const { userPrompt } = new PromptAssembler().assemble(makeContext());
    expect(userPrompt).not.toContain('## Narrator');
  });
});
