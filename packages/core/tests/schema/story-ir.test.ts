// ============================================================================
// Schema Validation Tests — Story IR (S7b)
// ============================================================================

import { describe, it, expect } from 'vitest';
import { structuralFunctionSchema, actantModelSchema, storyArchetypeSchema } from '../../src/schemas/story-ir.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_ACTANT_MODEL = {
  subject: 'sun-wukong',
  object: 'journey-to-the-west-quest',
  sender: 'bodhisattva-guanyin',
  receiver: 'tang-sanzang',
  helper: 'zhu-bajie',
  opponent: 'various-demons',
};

// ---------------------------------------------------------------------------
// StructuralFunction Schema
// ---------------------------------------------------------------------------

describe('structuralFunctionSchema', () => {
  it('accepts each of the 26 Propp function values', () => {
    const functions = [
      'absentation', 'interdiction', 'violation', 'departure',
      'first_function_of_donor', 'hero_reaction', 'acquisition',
      'spatial_translocation', 'villainy', 'mediation', 'beginning_counteraction',
      'first_villainy', 'hero_departure', 'donor_test', 'hero_reaction_donor',
      'receipt_of_agent', 'guidance', 'arrival', 'unrecognized_arrival',
      'unfounded_claims', 'difficult_task', 'solution', 'recognition',
      'exposure', 'punishment', 'wedding',
    ] as const;
    for (const fn of functions) {
      const result = structuralFunctionSchema.safeParse(fn);
      expect(result.success).toBe(true);
    }
  });

  it('rejects an invalid function name', () => {
    const result = structuralFunctionSchema.safeParse('nonexistent_function');
    expect(result.success).toBe(false);
  });

  it('rejects empty string', () => {
    const result = structuralFunctionSchema.safeParse('');
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ActantModel Schema
// ---------------------------------------------------------------------------

describe('actantModelSchema', () => {
  it('accepts valid actant model', () => {
    const result = actantModelSchema.safeParse(VALID_ACTANT_MODEL);
    expect(result.success).toBe(true);
  });

  it('rejects missing subject', () => {
    const { subject, ...partial } = VALID_ACTANT_MODEL;
    const result = actantModelSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it('rejects missing object', () => {
    const { object, ...partial } = VALID_ACTANT_MODEL;
    const result = actantModelSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it('rejects missing sender', () => {
    const { sender, ...partial } = VALID_ACTANT_MODEL;
    const result = actantModelSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it('rejects missing receiver', () => {
    const { receiver, ...partial } = VALID_ACTANT_MODEL;
    const result = actantModelSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it('rejects missing helper', () => {
    const { helper, ...partial } = VALID_ACTANT_MODEL;
    const result = actantModelSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it('rejects missing opponent', () => {
    const { opponent, ...partial } = VALID_ACTANT_MODEL;
    const result = actantModelSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it('rejects extra unknown fields', () => {
    const result = actantModelSchema.safeParse({ ...VALID_ACTANT_MODEL, extra: 'field' });
    expect(result.success).toBe(false);
  });

  it('preserves all 6 actant roles on success', () => {
    const result = actantModelSchema.safeParse(VALID_ACTANT_MODEL);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subject).toBe('sun-wukong');
      expect(result.data.object).toBe('journey-to-the-west-quest');
      expect(result.data.sender).toBe('bodhisattva-guanyin');
      expect(result.data.receiver).toBe('tang-sanzang');
      expect(result.data.helper).toBe('zhu-bajie');
      expect(result.data.opponent).toBe('various-demons');
    }
  });
});

// ---------------------------------------------------------------------------
// StoryArchetype Schema
// ---------------------------------------------------------------------------

describe('storyArchetypeSchema', () => {
  it('accepts each of the 6 archetype values', () => {
    const archetypes = ['hero_journey', 'tragedy', 'quest', 'descent', 'rebirth', 'comedy'] as const;
    for (const archetype of archetypes) {
      const result = storyArchetypeSchema.safeParse(archetype);
      expect(result.success).toBe(true);
    }
  });

  it('rejects an invalid archetype', () => {
    const result = storyArchetypeSchema.safeParse('fantasy');
    expect(result.success).toBe(false);
  });
});
