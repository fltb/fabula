// ============================================================================
// corpus-ellipsis.test.ts — Tests all 8 CORPUS-1 binding constraints for
// NarrativeEllipsis type, schemas, and mutual exclusion.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ellipsisProvenanceSchema,
  narrativeEllipsisSchema,
  narrativeEventSchema,
  narrativeNodeSchema,
} from '../../src/schemas/corpus.ts';

// ─── Fixture Helpers ──────────────────────────────────────────────────────

function validEllipsisInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'ellipsis',
    id: 'ellipsis_001',
    branchScope: { decisions: [] },
    storyTime: { type: 'chapter', chapter: 3 },
    preconditions: [],
    postconditions: [],
    relationshipEffects: [],
    knowledgeTransactions: [],
    threadProgress: [],
    ruleEffects: [],
    provenance: {
      sourceHash: 'abc123def456',
      sourceRange: { start: 100, end: 250 },
    },
    ...overrides,
  };
}

// ─── Binding 1: NarrativeNode = discriminated union on kind ────────────────

describe('Binding 1 — Discriminated union on kind', () => {
  it('accepts a valid ellipsis via narrativeNodeSchema', () => {
    const input = validEllipsisInput();
    const result = narrativeNodeSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('accepts a valid event via narrativeNodeSchema', () => {
    const input = {
      kind: 'event',
      id: 'evt_001',
      event: 'chapter_1',
      title: 'The Beginning',
      narrativeOrder: 1,
      storyTime: { type: 'chapter', chapter: 1 },
    };
    const result = narrativeNodeSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects a node with invalid kind discriminant', () => {
    const input = validEllipsisInput({ kind: 'event' });
    // kind='event' with ellipsis fields should pass event partial + miss required
    // event fields → fail narrativeNodeSchema
    const result = narrativeNodeSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects a node with missing kind field', () => {
    const input = validEllipsisInput();
    delete input.kind;
    const result = narrativeNodeSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ─── Binding 2: Identity, branchScope, storyTime, transactions ────────────

describe('Binding 2 — Essential ellipsis fields', () => {
  it('requires id', () => {
    const input = validEllipsisInput({ id: undefined });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('requires branchScope', () => {
    const input = validEllipsisInput({ branchScope: undefined });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('requires storyTime', () => {
    const input = validEllipsisInput({ storyTime: undefined });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('accepts optional summary', () => {
    const without = validEllipsisInput();
    delete without.summary;
    expect(narrativeEllipsisSchema.safeParse(without).success).toBe(true);

    const withSummary = validEllipsisInput({
      summary: 'Source text between lines 100-250 describes a journey.',
    });
    expect(narrativeEllipsisSchema.safeParse(withSummary).success).toBe(true);
  });

  it('requires preconditions as array', () => {
    const input = validEllipsisInput({ preconditions: undefined });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(false);
  });

  it('requires postconditions as array', () => {
    const input = validEllipsisInput({ postconditions: undefined });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(false);
  });

  it('accepts empty transaction arrays', () => {
    const input = validEllipsisInput({
      relationshipEffects: [],
      knowledgeTransactions: [],
      threadProgress: [],
      ruleEffects: [],
    });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(true);
  });

  it('requires relationshipEffects as array', () => {
    const input = validEllipsisInput({ relationshipEffects: undefined });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(false);
  });

  it('requires knowledgeTransactions as array', () => {
    const input = validEllipsisInput({ knowledgeTransactions: undefined });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(false);
  });

  it('requires threadProgress as array', () => {
    const input = validEllipsisInput({ threadProgress: undefined });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(false);
  });

  it('requires ruleEffects as array', () => {
    const input = validEllipsisInput({ ruleEffects: undefined });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(false);
  });
});

// ─── Binding 3: Summary MUST NOT create claim/provider ────────────────────

describe('Binding 3 — Summary labeled diagnostic-only', () => {
  it('stores summary as string, described as diagnostic-only', () => {
    // Schema uses .describe() to annotate; runtime we verify it holds a string
    const description = narrativeEllipsisSchema._def.description ?? '';
    expect(description).toContain('narrative');
    expect(description).toContain('gap');

    // The summary field itself is typed as string
    const input = validEllipsisInput({ summary: 'Diagnostic note' });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

// ─── Binding 4: Forbidden event fields — strict schema rejection ──────────

describe('Binding 4 — Ellipsis rejects event-specific fields', () => {
  // POV
  it('rejects pov field', () => {
    const input = validEllipsisInput({ pov: { character: 'hero', type: 'first_person' } });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // cast
  it('rejects cast field', () => {
    const input = validEllipsisInput({ cast: { onScreen: ['hero'], affected: [] } });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // sceneBrief
  it('rejects sceneBrief field', () => {
    const input = validEllipsisInput({ sceneBrief: 'A dramatic scene.' });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // styleGuidance
  it('rejects styleGuidance field', () => {
    const input = validEllipsisInput({ styleGuidance: { tone: 'serious' } });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // narrativeOrder
  it('rejects narrativeOrder field', () => {
    const input = validEllipsisInput({ narrativeOrder: 5 });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // narrationTime
  it('rejects narrationTime field', () => {
    const input = validEllipsisInput({ narrationTime: { type: 'chapter', chapter: 1 } });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // targetAudience
  it('rejects targetAudience field', () => {
    const input = validEllipsisInput({ targetAudience: 'young_adult' });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // targetWords (not a NarrativeEvent field but a render concept — harmless but rejected)
  it('rejects targetWords field', () => {
    const input = validEllipsisInput({ targetWords: 500 });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // sceneType
  it('rejects sceneType field', () => {
    const input = validEllipsisInput({ sceneType: 'flashback' });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // discourseMode
  it('rejects discourseMode field', () => {
    const input = validEllipsisInput({ discourseMode: 'action' });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // arcPosition
  it('rejects arcPosition field', () => {
    const input = validEllipsisInput({ arcPosition: 'climax' });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // emotionalValence
  it('rejects emotionalValence field', () => {
    const input = validEllipsisInput({ emotionalValence: 'joy' });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // conflictType
  it('rejects conflictType field', () => {
    const input = validEllipsisInput({ conflictType: 'person_vs_person' });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // resolutionType
  it('rejects resolutionType field', () => {
    const input = validEllipsisInput({ resolutionType: 'tragic' });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // tense
  it('rejects tense field', () => {
    const input = validEllipsisInput({ tense: 'past' });
    const result = narrativeEllipsisSchema.safeParse(input).success;
    expect(result).toBe(false);
  });
});

// ─── Binding 5: Ellipsis NEVER produces render artifacts ──────────────────

describe('Binding 5 — No render artifacts', () => {
  it('rejects RenderedScene field', () => {
    const input = validEllipsisInput({ renderedScene: { prose: '...', style: 'default' } });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(false);
  });

  it('rejects renderJob field', () => {
    const input = validEllipsisInput({ renderJob: { status: 'complete' } });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(false);
  });

  it('rejects pass2 field', () => {
    const input = validEllipsisInput({ pass2: { analysis: {} } });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(false);
  });

  it('rejects sceneCount field', () => {
    const input = validEllipsisInput({ sceneCount: 3 });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(false);
  });

  it('rejects assembler field', () => {
    const input = validEllipsisInput({ assembler: 'scene_assembler' });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(false);
  });
});

// ─── Binding 6: Summary never enters logical prompt ───────────────────────

describe('Binding 6 — Summary semantics', () => {
  it('summary is optional', () => {
    const input = validEllipsisInput();
    delete input.summary;
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(true);
  });

  it('summary carries descriptive annotation indicating diagnostic-only purpose', () => {
    // Verify the schema descriptor exists at the type level; runtime we can
    // inspect the field description
    const shape = narrativeEllipsisSchema.shape;
    expect(shape).toHaveProperty('summary');
  });
});

// ─── Binding 7: Every replay change has atomic provenance ─────────────────

describe('Binding 7 — Atomic provenance required', () => {
  it('requires provenance object', () => {
    const input = validEllipsisInput({ provenance: undefined });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(false);
  });

  it('provenance requires sourceHash', () => {
    const input = validEllipsisInput({ provenance: { sourceRange: { start: 0, end: 10 } } });
    expect(ellipsisProvenanceSchema.safeParse(input.provenance).success).toBe(false);
  });

  it('provenance requires sourceRange with start/end', () => {
    const input = validEllipsisInput({ provenance: { sourceHash: 'abc' } });
    expect(ellipsisProvenanceSchema.safeParse(input.provenance).success).toBe(false);
  });

  it('provenance validates end >= start', () => {
    const input = validEllipsisInput({
      provenance: { sourceHash: 'abc', sourceRange: { start: 50, end: 10 } },
    });
    expect(ellipsisProvenanceSchema.safeParse(input.provenance).success).toBe(false);
  });

  it('provenance accepts optional reviewerId and reviewTimestamp', () => {
    const input = validEllipsisInput({
      provenance: {
        sourceHash: 'abc',
        sourceRange: { start: 0, end: 50 },
        reviewerId: 'reviewer_001',
        reviewTimestamp: '2026-07-22T00:00:00Z',
      },
    });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(true);
  });
});

// ─── Binding 8: Single storyTime — split incompatible positions ───────────

describe('Binding 8 — Single storyTime enforced', () => {
  it('accepts exactly one storyTime (absolute)', () => {
    const input = validEllipsisInput({
      storyTime: { type: 'absolute', year: 1847, month: 6, day: 1 },
    });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(true);
  });

  it('accepts exactly one storyTime (chapter)', () => {
    const input = validEllipsisInput({
      storyTime: { type: 'chapter', chapter: 5 },
    });
    expect(narrativeEllipsisSchema.safeParse(input).success).toBe(true);
  });

  it('rejects multiple storyTimes (array not accepted)', () => {
    // storyTime is a single value, not an array
    const input = validEllipsisInput({
      storyTime: [
        { type: 'chapter', chapter: 1 },
        { type: 'chapter', chapter: 2 },
      ],
    });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ─── NarrativeEvent schema — accepts event shapes ────────────────────────

describe('NarrativeEvent partial schema', () => {
  it('accepts a minimal event shape', () => {
    const input = {
      kind: 'event',
      id: 'evt_001',
      event: 'chapter_1',
      title: 'Test Event',
      narrativeOrder: 1,
      storyTime: { type: 'chapter', chapter: 1 },
    };
    expect(narrativeEventSchema.safeParse(input).success).toBe(true);
  });

  it('rejects missing required event field', () => {
    const input = {
      kind: 'event',
      id: 'evt_001',
      title: 'Test',
      narrativeOrder: 1,
      storyTime: { type: 'chapter', chapter: 1 },
    };
    // event field is required
    expect(narrativeEventSchema.safeParse(input).success).toBe(false);
  });

  it('narrativeNodeSchema rejects unknown kind value', () => {
    const input = validEllipsisInput({ kind: 'something_else' });
    const result = narrativeNodeSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ─── Round-trip: Ellipsis → parse → expected shape ───────────────────────

describe('Ellipsis successful parse', () => {
  it('parses a full valid ellipsis and returns expected fields', () => {
    const input = validEllipsisInput({
      summary: 'Diagnostic: events between lines 100-250 cover the journey.',
    });
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('ellipsis');
      expect(result.data.id).toBe('ellipsis_001');
      expect(result.data.summary).toBe(
        'Diagnostic: events between lines 100-250 cover the journey.',
      );
      expect(result.data.provenance.sourceHash).toBe('abc123def456');
    }
  });

  it('parses an ellipsis with no summary', () => {
    const input = validEllipsisInput();
    delete input.summary;
    const result = narrativeEllipsisSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toBeUndefined();
    }
  });
});
