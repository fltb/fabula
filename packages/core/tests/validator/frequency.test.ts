// ============================================================================
// Frequency — Schema Validation Tests (S6b)
// ============================================================================

import { describe, it, expect } from 'vitest';
import { frequencyTypeSchema, frequencyProfileSchema } from '../../src/schemas/frequency.js';

describe('FrequencyType schema', () => {
  it('should accept all 3 valid frequency types', () => {
    expect(frequencyTypeSchema.parse('singulative')).toBe('singulative');
    expect(frequencyTypeSchema.parse('repeating')).toBe('repeating');
    expect(frequencyTypeSchema.parse('iterative')).toBe('iterative');
  });

  it('should reject invalid frequency types', () => {
    expect(() => frequencyTypeSchema.parse('daily')).toThrow();
    expect(() => frequencyTypeSchema.parse('')).toThrow();
    expect(() => frequencyTypeSchema.parse('occasional')).toThrow();
  });
});

describe('FrequencyProfile schema', () => {
  it('should accept a minimal singulative profile', () => {
    const result = frequencyProfileSchema.parse({
      type: 'singulative',
    });
    expect(result.type).toBe('singulative');
  });

  it('should accept a repeating profile with source event count', () => {
    const result = frequencyProfileSchema.parse({
      type: 'repeating',
      sourceEventCount: 2,
      otherOccurrences: ['E5_retold', 'E5_third'],
    });
    expect(result.type).toBe('repeating');
    expect(result.sourceEventCount).toBe(2);
    expect(result.otherOccurrences).toHaveLength(2);
  });

  it('should accept an iterative profile with iteration scope', () => {
    const result = frequencyProfileSchema.parse({
      type: 'iterative',
      occurrenceCount: 30,
      iterationScope: { start: 'day_1', end: 'day_30' },
    });
    expect(result.type).toBe('iterative');
    expect(result.occurrenceCount).toBe(30);
    expect(result.iterationScope?.start).toBe('day_1');
    expect(result.iterationScope?.end).toBe('day_30');
  });

  it('should reject invalid frequency type', () => {
    expect(() => frequencyProfileSchema.parse({ type: 'invalid' })).toThrow();
  });

  it('should reject extra unknown fields (strict)', () => {
    expect(() =>
      frequencyProfileSchema.parse({ type: 'singulative', unknownField: true }),
    ).toThrow();
  });

  it('should reject negative sourceEventCount', () => {
    expect(() =>
      frequencyProfileSchema.parse({ type: 'singulative', sourceEventCount: -1 }),
    ).toThrow();
  });

  it('should reject missing type field', () => {
    expect(() => frequencyProfileSchema.parse({})).toThrow();
  });
});
