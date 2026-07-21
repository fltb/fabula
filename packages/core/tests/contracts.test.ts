import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { capabilityManifestSchema, responseReferenceSchema } from '../src/schemas/contracts.ts';
import {
  ConfigError,
  DagCycleError,
  PreconditionMismatchError,
} from '../src/errors.ts';
import { preconditionSchema, postconditionSchema } from '../src/schemas/primitives.ts';

describe('Stage 1 contracts', () => {
  const manifest = JSON.parse(readFileSync('capabilities/stage-1.json', 'utf8'));

  it('accepts the versioned capability manifest', () => {
    expect(capabilityManifestSchema.parse(manifest).capabilities).not.toHaveLength(0);
  });

  it('rejects duplicate and unknown capability fields', () => {
    expect(capabilityManifestSchema.safeParse({ ...manifest, capabilities: [manifest.capabilities[0], manifest.capabilities[0]] }).success).toBe(false);
    expect(capabilityManifestSchema.safeParse({ ...manifest, unexpected: true }).success).toBe(false);
  });

  it('requires exactly one fact representation (value XOR narrativeHint) and rejects missing value for operator', () => {
    const base = { entity: 'wife', attribute: 'status' };
    expect(preconditionSchema.safeParse({ ...base, value: 'alive', narrativeHint: 'alive' }).success).toBe(false);
    expect(preconditionSchema.safeParse({ ...base, value: 'alive', operator: 'neq' }).success).toBe(true);
    expect(preconditionSchema.safeParse({ ...base, operator: 'eq' }).success).toBe(false);
    expect(postconditionSchema.safeParse({ ...base }).success).toBe(false);
    expect(postconditionSchema.safeParse({ ...base, value: 'changed' }).success).toBe(false);
  });

  it('rejects unsupported contract versions and mismatched reference IDs', () => {
    expect(capabilityManifestSchema.safeParse({ ...manifest, version: 2 }).success).toBe(false);
    const fixture = JSON.parse(readFileSync('fixtures/zhu-fu/reference/data/E0.json', 'utf8'));
    const result = responseReferenceSchema.safeParse({
      prose: fixture.prose,
      analysis: fixture.analysis,
      metadata: { eventId: 'E1', provider: 'mock', model: 'mock', seed: 42, promptVersion: '1', promptHash: 'h', analysisSchemaVersion: 1, fixtureFormatVersion: 1, generatedAt: '2026-01-01T00:00:00.000Z', reviewStatus: 'approved', attempts: 1, errors: [] },
    });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toContainEqual(expect.objectContaining({ path: ['analysis', 'eventId'] }));
  });

  it('provides stable safe error codes and context', () => {
    for (const error of [new ConfigError('bad config', { path: 'nova.yaml' }), new DagCycleError('cycle', { cycle: ['E0', 'E1'] }), new PreconditionMismatchError('mismatch', { eventId: 'E1', stateKey: 'wife.status' })]) {
      expect(error.code).toMatch(/^[A-Z_]+$/);
      expect(error.context).not.toHaveProperty('prose');
      expect(error.context).not.toHaveProperty('credential');
    }
  });
});
