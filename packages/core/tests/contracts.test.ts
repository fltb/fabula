import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { responseReferenceSchema } from '../src/schemas/contracts.ts';
import { postconditionSchema, preconditionSchema } from '../src/schemas/primitives.ts';

describe('response reference contracts', () => {
  it('rejects mismatched reference IDs', () => {
    const fixture = JSON.parse(readFileSync('fixtures/zhu-fu/reference/data/E0.json', 'utf8'));
    const result = responseReferenceSchema.safeParse({
      prose: fixture.prose,
      analysis: fixture.analysis,
      metadata: {
        eventId: 'E1',
        provider: 'mock',
        model: 'mock',
        seed: 42,
        promptVersion: '1',
        promptHash: 'h',
        analysisSchemaVersion: 1,
        fixtureFormatVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        reviewStatus: 'approved',
        attempts: 1,
        errors: [],
      },
    });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toContainEqual(
      expect.objectContaining({ path: ['analysis', 'eventId'] }),
    );
  });
});

describe('precondition/postcondition primitives', () => {
  it('requires exactly one fact representation (value XOR narrativeHint) and rejects missing value for operator', () => {
    const base = { entity: 'wife', attribute: 'status' };
    expect(
      preconditionSchema.safeParse({ ...base, value: 'alive', narrativeHint: 'alive' }).success,
    ).toBe(false);
    expect(preconditionSchema.safeParse({ ...base, value: 'alive', operator: 'neq' }).success).toBe(
      true,
    );
    expect(preconditionSchema.safeParse({ ...base, operator: 'eq' }).success).toBe(false);
    expect(postconditionSchema.safeParse({ ...base }).success).toBe(false);
    expect(postconditionSchema.safeParse({ ...base, value: 'changed' }).success).toBe(false);
  });
});
