// ============================================================================
// Novalistically — Zod Schemas for Graph Types (GRAPH-1)
//
// NOTE: Schemas with `graph` prefix (graphAbsenceWitnessSchema,
// graphProviderOutputSchema, graphReadResolutionSchema,
// graphBoundaryReferenceSchema) are GRAPH-1 specific and distinct from
// same-name schemas in integration.ts.
// ============================================================================

import { z } from 'zod';
import type { EffectiveCoordinate, GraphReadResolution } from '../types/graph.js';
import type { SceneStoryCoordinate, StoryCoordinate } from '../types/entity.js';

// ——— Coordinates ———

export const initialStoryCoordinateSchema = z
  .object({ type: z.literal('storyTime'), kind: z.literal('initial') })
  .strict();

export const unlocatedStoryCoordinateSchema = z
  .object({ type: z.literal('storyTime'), kind: z.literal('unlocated') })
  .strict();

export const pointStoryCoordinateSchema = z
  .object({
    type: z.literal('storyTime'),
    kind: z.literal('point'),
    clock: z.enum(['story', 'calendar', 'chapter']),
    scalar: z.number().finite(),
  })
  .strict();

export const sceneStoryCoordinateSchema: z.ZodType<SceneStoryCoordinate> = z.union([
  unlocatedStoryCoordinateSchema,
  pointStoryCoordinateSchema,
]);

export const storyCoordinateSchema: z.ZodType<StoryCoordinate> = z.union([
  initialStoryCoordinateSchema,
  sceneStoryCoordinateSchema,
]);

export const discourseCoordinateSchema = z
  .object({
    type: z.literal('discoursePosition'),
    value: z.number().int(),
  })
  .strict();

export const effectiveCoordinateSchema: z.ZodType<EffectiveCoordinate> = z.union([
  storyCoordinateSchema,
  discourseCoordinateSchema,
]) as z.ZodType<EffectiveCoordinate>;

// ——— Edge Class ———

export const edgeClassSchema = z.enum([
  'author_origin',
  'provider',
  'same_coordinate_order',
  'internal',
]);

// ——— OutputValue ———

export const outputValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set'), data: z.unknown() }).strict(),
  z.object({ type: z.literal('unset') }).strict(),
]);

// ——— OutputDescriptor ———

export const outputDescriptorSchema = z
  .object({
    outputId: z.string().min(1),
    canonicalKey: z.string().min(1),
    value: outputValueSchema,
    branchScope: z.string().min(1),
    effectiveCoordinate: effectiveCoordinateSchema,
    provenanceHash: z.string().min(1),
  })
  .strict();

// ——— ReadRequirement ———

export const readPhaseSchema = z.enum(['stateBefore', 'stateAfter']);

export const readOriginSchema = z.enum([
  'precondition',
  'source',
  'rule',
  'scope',
  'lifecycle',
  'merge',
]);

export const presencePredicateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('exists') }).strict(),
  z.object({ type: z.literal('absent') }).strict(),
  z.object({ type: z.literal('equals'), value: z.unknown() }).strict(),
  z.object({ type: z.literal('matches'), pattern: z.string() }).strict(),
]);

export const readRequirementSchema = z
  .object({
    readId: z.string().min(1),
    canonicalKey: z.string().min(1),
    predicate: presencePredicateSchema,
    phase: readPhaseSchema,
    branchScope: z.string().min(1),
    origin: readOriginSchema,
  })
  .strict();

// ——— GraphEdge ———

export const graphEdgeSchema = z
  .object({
    predecessor: z.string().min(1),
    dependent: z.string().min(1),
    edgeClass: edgeClassSchema,
    causalGroupId: z.string().optional(),
  })
  .strict();

// ——— Provider Resolution ———

export const graphProviderOutputSchema = z
  .object({
    type: z.literal('output'),
    outputId: z.string().min(1),
    canonicalKey: z.string().min(1),
    coordinate: effectiveCoordinateSchema,
    provenanceHash: z.string().min(1),
  })
  .strict();

export const graphAbsenceWitnessSchema = z
  .object({
    type: z.literal('absence'),
    readId: z.string().min(1),
    canonicalKey: z.string().min(1),
    coordinate: effectiveCoordinateSchema.optional(),
    reason: z.string().min(1),
  })
  .strict();

export const graphReadResolutionSchema: z.ZodType<GraphReadResolution> = z.discriminatedUnion(
  'type',
  [graphProviderOutputSchema, graphAbsenceWitnessSchema],
);

// ——— BoundaryReference ———

export const graphBoundaryReferenceSchema = z
  .object({
    type: z.literal('boundary'),
    snapshotHash: z.string().min(1),
    sourceGraph: z.enum(['story', 'discourse']),
    targetGraph: z.enum(['discourse', 'story']),
    pinnedOutputs: z.array(z.string().min(1)),
  })
  .strict();

// ——— NarrativeEllipsis ———

export const graphNarrativeEllipsisSchema = z
  .object({
    outputId: z.string().min(1),
    storyCoordinate: sceneStoryCoordinateSchema,
    requiredOutputHash: z.string().min(1),
  })
  .strict();

// ——— DiscourseSceneSequenceEntry ———

export const discourseSceneSequenceEntrySchema = z.object({
  sceneId: z.string().min(1),
  sequence: z.number().int(),
  chapter: z.number().int(),
  actionInterval: z
    .object({
      start: z.number(),
      end: z.number(),
    })
    .optional(),
});

// ——— Graph Structures ———

export const storyGraphSchema = z
  .object({
    type: z.literal('story'),
    edges: z.array(graphEdgeSchema),
    outputs: z.array(outputDescriptorSchema),
    reads: z.array(readRequirementSchema),
    resolutions: z.array(graphReadResolutionSchema),
    hash: z.string().min(1),
    ellipses: z.array(graphNarrativeEllipsisSchema).optional(),
  })
  .strict();

export const discourseGraphSchema = z
  .object({
    type: z.literal('discourse'),
    edges: z.array(graphEdgeSchema),
    outputs: z.array(outputDescriptorSchema),
    hash: z.string().min(1),
    boundaryReferences: z.array(graphBoundaryReferenceSchema).optional(),
    sceneSequence: z.array(discourseSceneSequenceEntrySchema),
  })
  .strict();

// ——— Cache Entry ———

export const graphCacheEntrySchema = z
  .object({
    branchScope: z.string().min(1),
    dependencyHashes: z.array(z.string().min(1)),
    outputHashes: z.array(z.string().min(1)),
    absenceHashes: z.array(z.string().min(1)),
    timestamp: z.number(),
  })
  .strict();

// ——— Graph Types discrimated ———

export const graphSchema = z.discriminatedUnion('type', [storyGraphSchema, discourseGraphSchema]);
