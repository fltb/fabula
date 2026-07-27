// ============================================================================
// comparefact-deferred.test.ts — compareFact returns 'deferred' for
// narrativeHint-only facts, 'match'/'mismatch' for value facts.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { compareFact } from '../../src/entity/compare.js';
import type { Fact } from '../../src/types/entity.js';

function makeFact(overrides: Partial<Fact> & { entityId: string; attribute: string }): Fact {
  return {
    id: 'fact_test',
    value: undefined,
    confidence: 1,
    validity: {
      temporal: { start: { type: 'absolute', value: 'day_1' }, end: null },
      branches: { type: 'all' },
    },
    ...overrides,
  };
}

describe('compareFact returns deferred for narrativeHint-only', () => {
  it('returns deferred when fact has narrativeHint but no value', () => {
    const fact = makeFact({
      entityId: 'hero',
      attribute: 'status',
      value: undefined,
      narrativeHint: 'Hero is alive and well',
    });
    expect(compareFact(fact, undefined)).toBe('deferred');
  });

  it('returns deferred regardless of stateValue', () => {
    const fact = makeFact({
      entityId: 'hero',
      attribute: 'status',
      value: undefined,
      narrativeHint: 'Some hint',
    });
    expect(compareFact(fact, 'anything')).toBe('deferred');
  });
});

describe('compareFact returns match/mismatch for value facts', () => {
  it('returns match when values are equal', () => {
    const fact = makeFact({ entityId: 'hero', attribute: 'name', value: 'Alice' });
    expect(compareFact(fact, 'Alice')).toBe('match');
  });

  it('returns mismatch when values differ', () => {
    const fact = makeFact({ entityId: 'hero', attribute: 'name', value: 'Alice' });
    expect(compareFact(fact, 'Bob')).toBe('mismatch');
  });

  it('returns mismatch when stateValue is undefined', () => {
    const fact = makeFact({ entityId: 'hero', attribute: 'name', value: 'Alice' });
    expect(compareFact(fact, undefined)).toBe('mismatch');
  });

  it('handles numeric values', () => {
    const fact = makeFact({ entityId: 'hero', attribute: 'level', value: 42 });
    expect(compareFact(fact, 42)).toBe('match');
    expect(compareFact(fact, 0)).toBe('mismatch');
  });

  it('handles boolean values', () => {
    const fact = makeFact({ entityId: 'hero', attribute: 'active', value: true });
    expect(compareFact(fact, true)).toBe('match');
    expect(compareFact(fact, false)).toBe('mismatch');
  });

  it('handles null values', () => {
    const fact = makeFact({ entityId: 'hero', attribute: 'data', value: null });
    expect(compareFact(fact, null)).toBe('match');
    expect(compareFact(fact, undefined)).toBe('mismatch');
  });
});

describe('compareFact throws for invalid facts', () => {
  it('throws when fact has neither value nor narrativeHint', () => {
    const fact = makeFact({ entityId: 'hero', attribute: 'empty' });
    // After removing value in overrides, fact has no value and no narrativeHint
    expect(() => compareFact(fact, undefined)).toThrow();
  });
});
