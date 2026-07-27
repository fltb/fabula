// ============================================================================
// Schema Validation Tests — Idea IR (S7a)
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  emotionalArcDefinitionSchema,
  ideaIRSchema,
  thematicIntentSchema,
} from '../../src/schemas/idea-ir.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_THEMATIC_INTENT = {
  primaryTheme: 'revolution devours its children',
  subThemes: ['betrayal', 'idealism', 'corruption'],
};

const VALID_EMOTIONAL_ARC = {
  arcType: 'tragedy',
  emotionalBeats: [
    { position: 'opening', emotion: 'hope' },
    { position: 'rising', emotion: 'doubt' },
    { position: 'climax', emotion: 'despair' },
    { position: 'falling', emotion: 'grief' },
    { position: 'denouement', emotion: 'resignation' },
  ],
};

const VALID_IDEA_IR_FULL = {
  thematicIntent: VALID_THEMATIC_INTENT,
  emotionalArc: VALID_EMOTIONAL_ARC,
  targetAudience: 'adult literary fiction readers',
  coreConflict: 'idealism vs. pragmatism in revolutionary struggle',
};

const VALID_IDEA_IR_MINIMAL = {
  thematicIntent: { primaryTheme: 'redemption', subThemes: [] },
  emotionalArc: {
    arcType: 'redemption',
    emotionalBeats: [{ position: 'climax', emotion: 'forgiveness' }],
  },
};

// ---------------------------------------------------------------------------
// ThematicIntent Schema
// ---------------------------------------------------------------------------

describe('thematicIntentSchema', () => {
  it('accepts valid thematic intent', () => {
    const result = thematicIntentSchema.safeParse(VALID_THEMATIC_INTENT);
    expect(result.success).toBe(true);
  });

  it('rejects missing primaryTheme', () => {
    const result = thematicIntentSchema.safeParse({ subThemes: [] });
    expect(result.success).toBe(false);
  });

  it('rejects missing subThemes', () => {
    const result = thematicIntentSchema.safeParse({ primaryTheme: 'power' });
    expect(result.success).toBe(false);
  });

  it('rejects extra unknown fields', () => {
    const result = thematicIntentSchema.safeParse({ ...VALID_THEMATIC_INTENT, extra: 'field' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EmotionalArcDefinition Schema
// ---------------------------------------------------------------------------

describe('emotionalArcDefinitionSchema', () => {
  it('accepts valid emotional arc', () => {
    const result = emotionalArcDefinitionSchema.safeParse(VALID_EMOTIONAL_ARC);
    expect(result.success).toBe(true);
  });

  it('rejects missing arcType', () => {
    const result = emotionalArcDefinitionSchema.safeParse({ emotionalBeats: [] });
    expect(result.success).toBe(false);
  });

  it('rejects missing emotionalBeats', () => {
    const result = emotionalArcDefinitionSchema.safeParse({ arcType: 'tragedy' });
    expect(result.success).toBe(false);
  });

  it('rejects beat without position', () => {
    const result = emotionalArcDefinitionSchema.safeParse({
      arcType: 'tragedy',
      emotionalBeats: [{ emotion: 'fear' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects beat without emotion', () => {
    const result = emotionalArcDefinitionSchema.safeParse({
      arcType: 'tragedy',
      emotionalBeats: [{ position: 'climax' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra unknown fields', () => {
    const result = emotionalArcDefinitionSchema.safeParse({ ...VALID_EMOTIONAL_ARC, bogus: true });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IdeaIR Schema
// ---------------------------------------------------------------------------

describe('ideaIRSchema', () => {
  it('accepts full IdeaIR with all fields', () => {
    const result = ideaIRSchema.safeParse(VALID_IDEA_IR_FULL);
    expect(result.success).toBe(true);
  });

  it('accepts minimal IdeaIR (no optional fields)', () => {
    const result = ideaIRSchema.safeParse(VALID_IDEA_IR_MINIMAL);
    expect(result.success).toBe(true);
  });

  it('rejects missing thematicIntent', () => {
    const result = ideaIRSchema.safeParse({ emotionalArc: VALID_EMOTIONAL_ARC });
    expect(result.success).toBe(false);
  });

  it('rejects missing emotionalArc', () => {
    const result = ideaIRSchema.safeParse({ thematicIntent: VALID_THEMATIC_INTENT });
    expect(result.success).toBe(false);
  });

  it('rejects extra unknown fields', () => {
    const result = ideaIRSchema.safeParse({ ...VALID_IDEA_IR_FULL, unknownField: 42 });
    expect(result.success).toBe(false);
  });

  it('accepts optional targetAudience', () => {
    const result = ideaIRSchema.safeParse(VALID_IDEA_IR_FULL);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targetAudience).toBe('adult literary fiction readers');
    }
  });

  it('accepts optional coreConflict', () => {
    const result = ideaIRSchema.safeParse(VALID_IDEA_IR_FULL);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.coreConflict).toBe('idealism vs. pragmatism in revolutionary struggle');
    }
  });
});
