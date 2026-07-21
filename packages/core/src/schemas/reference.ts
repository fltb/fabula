// ============================================================================
// Novalistically — INTEGRATION-2: Reference Eligibility Zod Schemas
// ============================================================================

import { z } from 'zod';

export const referenceModeSchema = z.enum(['identity', 'live', 'historical']);

export const referenceKindSchema = z.enum([
  'declaration',
  'runtime_foreign_key',
  'relationship_membership',
  'knowledge_subject',
  'proposition_target',
  'thread_binding',
  'rule_scope',
  'scene_participant',
  'pov_focalizer',
  'narrator_subject',
  'discourse_target',
  'causal_output',
  'provenance',
  'historical_boundary',
]);

export const referenceEntrySchema = z.object({
  targetEntityId: z.string(),
  mode: referenceModeSchema,
  kind: referenceKindSchema,
  sourceDomain: z.string(),
  sourceId: z.string(),
  boundary: z.string().optional(),
}).strict();

export const referenceIndexSchema = z.object({
  byEntity: z.record(z.string(), z.array(referenceEntrySchema)),
  hash: z.string(),
}).strict();
