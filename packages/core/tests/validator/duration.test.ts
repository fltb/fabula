// ============================================================================
// Duration — Schema Validation Tests (S6a)
// ============================================================================

import { describe, expect, it } from 'vitest';
import { durationProfileSchema, durationTypeSchema } from '../../src/schemas/duration.js';

describe('DurationType schema', () => {
  it('should accept all 5 valid duration types', () => {
    expect(durationTypeSchema.parse('scene')).toBe('scene');
    expect(durationTypeSchema.parse('summary')).toBe('summary');
    expect(durationTypeSchema.parse('ellipsis')).toBe('ellipsis');
    expect(durationTypeSchema.parse('pause')).toBe('pause');
    expect(durationTypeSchema.parse('stretch')).toBe('stretch');
  });

  it('should reject invalid duration types', () => {
    expect(() => durationTypeSchema.parse('flashback')).toThrow();
    expect(() => durationTypeSchema.parse('')).toThrow();
    expect(() => durationTypeSchema.parse('linear')).toThrow();
  });
});

describe('DurationProfile schema', () => {
  it('should accept a minimal scene profile', () => {
    const result = durationProfileSchema.parse({
      type: 'scene',
    });
    expect(result.type).toBe('scene');
  });

  it('should accept a full summary profile with compression ratio', () => {
    const result = durationProfileSchema.parse({
      type: 'summary',
      storyDuration: '3 days',
      narrativeLength: 500,
      compressionRatio: 86.4,
    });
    expect(result.type).toBe('summary');
    expect(result.storyDuration).toBe('3 days');
    expect(result.narrativeLength).toBe(500);
    expect(result.compressionRatio).toBe(86.4);
  });

  it('should accept an ellipsis with clarity', () => {
    const result = durationProfileSchema.parse({
      type: 'ellipsis',
      storyDuration: '2 years',
      ellipsisClarity: 'explicit',
    });
    expect(result.type).toBe('ellipsis');
    expect(result.ellipsisClarity).toBe('explicit');
  });

  it('should accept a pause profile', () => {
    const result = durationProfileSchema.parse({
      type: 'pause',
      narrativeLength: 1000,
    });
    expect(result.type).toBe('pause');
    expect(result.narrativeLength).toBe(1000);
  });

  it('should accept a stretch profile', () => {
    const result = durationProfileSchema.parse({
      type: 'stretch',
      storyDuration: '5 seconds',
      narrativeLength: 3000,
    });
    expect(result.type).toBe('stretch');
  });

  it('should reject invalid duration type', () => {
    expect(() => durationProfileSchema.parse({ type: 'invalid' })).toThrow();
  });

  it('should reject extra unknown fields (strict)', () => {
    expect(() => durationProfileSchema.parse({ type: 'scene', unknownField: true })).toThrow();
  });

  it('should reject negative narrative length', () => {
    expect(() => durationProfileSchema.parse({ type: 'scene', narrativeLength: -1 })).toThrow();
  });

  it('should reject negative compression ratio', () => {
    expect(() => durationProfileSchema.parse({ type: 'summary', compressionRatio: -1 })).toThrow();
  });

  it('should reject invalid ellipsis clarity', () => {
    expect(() =>
      durationProfileSchema.parse({
        type: 'ellipsis',
        ellipsisClarity: 'vague',
      }),
    ).toThrow();
  });

  it('should reject missing type field', () => {
    expect(() => durationProfileSchema.parse({})).toThrow();
  });
});
