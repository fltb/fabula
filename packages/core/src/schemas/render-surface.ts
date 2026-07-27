// ============================================================================
// Novalistically — RENDER-SURFACE-1: Zod Schema Definitions
// Schemas for CompiledSceneContract, SurfaceDependencyGraph,
// ValidationGateGraph, RenderGroupManifest, SurfaceReferencePacket,
// StyleProfile, cache key types, and surface planner types.
//
// Binding constraints from docs/todos/graph-discourse-render.md RENDER-SURFACE-1:
//   (see types/render-surface.ts header for full list)
// ============================================================================

import { z } from 'zod';

const branchPathSchema = z.object({
  decisions: z.array(
    z.object({
      atEventId: z.string(),
      choiceId: z.string(),
      narrativeOrder: z.number(),
    }),
  ),
});

import type {
  CompiledSceneContract,
  ContinuityPacket,
  RenderGroupManifest,
  StyleMetrics,
  StyleProfile,
  SurfaceDependencyGraph,
  SurfacePlannerOptions,
  SurfacePlanResult,
  SurfaceReferencePacket,
  SurfaceValidationKey,
  ValidationGate,
  ValidationGateGraph,
} from '../types/render-surface.js';

// ─── StyleProfile ───────────────────────────────────────────────────────────

export const styleResolutionPathSchema = z
  .object({
    projectStyle: z.string(),
    chapterStyle: z.string().optional(),
    narratorPovStyle: z.string().optional(),
    sceneStyle: z.string().optional(),
  })
  .strict();

export const styleProfileSchema = z
  .object({
    profileId: z.string(),
    resolutionPrecedence: styleResolutionPathSchema,
    voice: z.string().optional(),
    diction: z.string().optional(),
    rhythm: z.string().optional(),
    paragraphing: z.string().optional(),
    typography: z.string().optional(),
    dialogue: z.string().optional(),
    avoid: z.array(z.string()).optional(),
  })
  .strict();

export const styleProfileSchemaZ: z.ZodType<StyleProfile> = styleProfileSchema;

// ─── ContinuityPacket ───────────────────────────────────────────────────────

export const sceneTransitionSchema = z.enum([
  'continuous',
  'hard_cut',
  'time_jump',
  'location_jump',
  'pov_shift',
  'chapter',
  'flashback',
]);

export const continuityPacketSchema = z
  .object({
    transition: sceneTransitionSchema,
    motifs: z.array(z.string()).optional(),
    callbacks: z.array(z.string()).optional(),
    openCloseMode: z.enum(['open', 'closed', 'open_close', 'none']).optional(),
  })
  .strict();

export const continuityPacketSchemaZ: z.ZodType<ContinuityPacket> = continuityPacketSchema;

// ─── CompiledSceneContract ──────────────────────────────────────────────────

export const compiledSceneContractSchema = z
  .object({
    sceneId: z.string(),
    branch: branchPathSchema,
    discoursePosition: z.number().int().min(0),
    worldStateHash: z.string(),
    knowledgeStateHash: z.string(),
    narratorProfileHash: z.string(),
    plannedDiscourseHash: z.string(),
    styleProfile: styleProfileSchema,
    continuityPacket: continuityPacketSchema,
    promptContractHash: z.string(),
    promptProviderId: z.string().optional(),
  })
  .strict();

export const compiledSceneContractSchemaZ: z.ZodType<CompiledSceneContract> =
  compiledSceneContractSchema;

// ─── SurfaceDependencyGraph ─────────────────────────────────────────────────

export const serialLaneSchema = z
  .object({
    laneId: z.string(),
    groupIds: z.array(z.string()),
  })
  .strict();

export const surfacePolicySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('parallel') }).strict(),
  z.object({ type: z.literal('serial_surface') }).strict(),
  z.object({ type: z.literal('fallback_without_surface') }).strict(),
]);

export const renderGroupSchema = z
  .object({
    groupId: z.string(),
    sceneIds: z.array(z.string()),
    surfacePolicy: surfacePolicySchema,
  })
  .strict();

export const surfaceDependencyGraphSchema = z
  .object({
    groups: z.array(renderGroupSchema),
    serialLanes: z.array(serialLaneSchema),
    branch: branchPathSchema,
  })
  .strict();

export const surfaceDependencyGraphSchemaZ: z.ZodType<SurfaceDependencyGraph> =
  surfaceDependencyGraphSchema;

// ─── ValidationGateGraph ────────────────────────────────────────────────────

export const validationGateStatusSchema = z.enum([
  'pending',
  'pass1_required',
  'pass1_complete',
  'validation_pending',
  'accepted',
  'retry',
  'blocked',
]);

export const validationGateSchema = z
  .object({
    sceneId: z.string(),
    status: validationGateStatusSchema,
    attemptCount: z.number().int().min(0),
    maxRetries: z.number().int().min(0),
    fallbackWithoutSurface: z.boolean(),
  })
  .strict();

export const validationGateSchemaZ: z.ZodType<ValidationGate> = validationGateSchema;

export const validationPolicySchema = z
  .object({
    maxRetries: z.number().int().min(0),
    allowFallbackWithoutSurface: z.boolean(),
  })
  .strict();

export const validationGateGraphSchema = z
  .object({
    gates: z.record(z.string(), validationGateSchema),
    policy: validationPolicySchema,
    branch: branchPathSchema,
  })
  .strict();

export const validationGateGraphSchemaZ: z.ZodType<ValidationGateGraph> = validationGateGraphSchema;

// ─── RenderGroupManifest ────────────────────────────────────────────────────

export const plannerModeSchema = z.enum(['manual', 'suggest', 'auto']);

export const renderGroupManifestSchema = z
  .object({
    manifestVersion: z.string(),
    sourceDefinitionHash: z.string(),
    groupIds: z.array(z.string()),
    lanes: z.array(serialLaneSchema),
    groupPolicies: z.record(z.string(), surfacePolicySchema),
    plannerMode: plannerModeSchema,
    generatedAt: z.string(),
  })
  .strict();

export const renderGroupManifestSchemaZ: z.ZodType<RenderGroupManifest> = renderGroupManifestSchema;

// ─── SurfaceReferencePacket (non-authoritative) ─────────────────────────────

export const excerptModeSchema = z.enum(['tail', 'full', 'authored_anchor']);

export const styleMetricsSchema = z
  .object({
    avgSentenceLength: z.number().min(0),
    readingLevel: z.number().min(0),
    tokenCount: z.number().int().min(0),
    lexicalDiversity: z.number().min(0).max(1),
    dialogueRatio: z.number().min(0).max(1),
  })
  .strict();

export const styleMetricsSchemaZ: z.ZodType<StyleMetrics> = styleMetricsSchema;

export const surfaceReferencePacketSchema = z
  .object({
    sceneId: z.string(),
    excerptMode: excerptModeSchema,
    excerpt: z.string(),
    styleMetrics: styleMetricsSchema,
    authoredAnchor: z.string().optional(),
    sourceProseHash: z.string(),
    accepted: z.boolean(),
    extractorVersion: z.string(),
  })
  .strict();

export const surfaceReferencePacketSchemaZ: z.ZodType<SurfaceReferencePacket> =
  surfaceReferencePacketSchema;

// ─── Surface Planner Options & Result ───────────────────────────────────────

export const autoGroupConfigSchema = z
  .object({
    maxParallelGroupSize: z.number().int().min(1),
    authorized: z.boolean(),
  })
  .strict();

export const surfacePlannerOptionsSchema = z
  .object({
    mode: plannerModeSchema,
    branch: branchPathSchema,
    sceneIds: z.array(z.string()),
    contracts: z.array(compiledSceneContractSchema),
    authorLanes: z.array(serialLaneSchema).optional(),
    autoConfig: autoGroupConfigSchema.optional(),
  })
  .strict();

export const surfacePlannerOptionsSchemaZ: z.ZodType<SurfacePlannerOptions> =
  surfacePlannerOptionsSchema;

export const surfacePlanResultSchema = z
  .object({
    manifest: renderGroupManifestSchema,
    surfaceDependencyGraph: surfaceDependencyGraphSchema,
    validationGateGraph: validationGateGraphSchema,
    warnings: z.array(z.string()).optional(),
  })
  .strict();

export const surfacePlanResultSchemaZ: z.ZodType<SurfacePlanResult> = surfacePlanResultSchema;

// ─── Cache Keys (§10) ───────────────────────────────────────────────────────

export const logicalRenderKeySchema = z
  .object({
    sceneContractHash: z.string(),
    worldStateHash: z.string(),
    plannedDiscourseHash: z.string(),
    catalogVersionHashes: z.record(z.string(), z.string()),
    graphHash: z.string(),
    styleProfileHash: z.string(),
    promptProviderId: z.string(),
  })
  .strict();

export const surfaceRenderKeySchema = z
  .object({
    logicalKey: logicalRenderKeySchema,
    groupManifestHash: z.string(),
    surfacePolicyHash: z.string(),
    sourceProseHashes: z.array(z.string()),
    extractorVersion: z.string(),
  })
  .strict();

export const surfaceValidationKeySchema = z
  .object({
    surfaceKey: surfaceRenderKeySchema,
    proseHash: z.string(),
    pass2SchemaModelId: z.string(),
    validatorPolicyVersion: z.string(),
  })
  .strict();

export const attemptKeySchema = z
  .object({
    validationKey: surfaceValidationKeySchema,
    attemptNumber: z.number().int().min(1),
    priorProseHash: z.string().optional(),
    retryGuidanceHash: z.string().optional(),
  })
  .strict();

// ─── Error Codes ──────────────────────────────────────────────────────────────

export const surfaceErrorCodeSchema = z.enum([
  'CROSS_BRANCH_SURFACE_EDGE',
  'SURFACE_CYCLE',
  'UNACCEPTED_SOURCE_PROSE',
  'UNVERSIONED_EXTRACTION',
  'UNVERSIONED_BUDGET',
  'MISSING_CONTRACT',
  'INVALID_POLICY',
  'UNAUTHORIZED_AUTO_MODE',
  'BRANCH_MISMATCH',
  'GROUP_SCENE_CONFLICT',
  'FALLBACK_WITHOUT_SURFACE_NOT_ALLOWED',
  'EXHAUSTED_RETRY',
]);
