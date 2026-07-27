// ============================================================================
// Novalistically — INTEGRATION-1: Zod Schema Definitions
// Schemas for AbsenceWitness, ReadResolution, BoundaryReference,
// MergePlan, MergePolicy, StorySnapshot, DiscourseSnapshot,
// NarrativeNode, DiscourseNode, CoverageManifest.
// ============================================================================

import { z } from 'zod';

// ─── AbsenceBasis — exactly 4 values ─────────────────────────────────────────

export const absenceBasisSchema = z.enum([
  'never_written',
  'pre_introduction',
  'after_unset',
  'branch_local',
]);

// ─── MergePolicy — exactly 3 values ──────────────────────────────────────────

export const mergePolicySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('requireEqual') }).strict(),
  z.object({ type: z.literal('selectBranch'), branchId: z.string() }).strict(),
  z.object({ type: z.literal('literal') }).strict(),
]);

// ─── AbsenceWitness — immutable absence resolution ───────────────────────────

export const absenceWitnessSchema = z
  .object({
    branch: z
      .object({
        decisions: z.array(
          z
            .object({
              atEventId: z.string(),
              choiceId: z.string(),
              narrativeOrder: z.number(),
            })
            .strict(),
        ),
      })
      .strict(),
    temporalPrefix: z.string(),
    basis: absenceBasisSchema,
    latestUnsetOutput: z.string().optional(),
    resolutionHash: z.string(),
  })
  .strict();

// ─── ProviderOutput — deterministic read from a provider ─────────────────────

export const providerOutputSchema = z
  .object({
    outputId: z.string(),
    provider: z.string(),
    eventId: z.string(),
    branch: z
      .object({
        decisions: z.array(
          z
            .object({
              atEventId: z.string(),
              choiceId: z.string(),
              narrativeOrder: z.number(),
            })
            .strict(),
        ),
      })
      .strict(),
    temporalPrefix: z.string(),
    content: z.unknown(),
    resolutionHash: z.string(),
    causality: z.literal('provider_edge'),
  })
  .strict();

// ─── ReadResolution — exactly one per deterministic read ─────────────────────

export const readResolutionSchema = z.discriminatedUnion('causality', [
  providerOutputSchema,
  // AbsenceWitness has no 'causality' field; discriminatedUnion entries
  // must share a discriminator.  Wrap or use union instead.
]);

// Because AbsenceWitness lacks a 'causality' field, use a plain union.
export const readResolutionUnionSchema = z.union([providerOutputSchema, absenceWitnessSchema]);

// ─── BoundaryReference — one-way snapshot input ──────────────────────────────

export const boundaryReferenceSchema = z
  .object({
    sourceSnapshotHash: z.string(),
    branch: z
      .object({
        decisions: z.array(
          z
            .object({
              atEventId: z.string(),
              choiceId: z.string(),
              narrativeOrder: z.number(),
            })
            .strict(),
        ),
      })
      .strict(),
    propositions: z.array(z.string()),
    truthValues: z.record(z.string(), z.boolean()),
  })
  .strict();

// ─── MergePlan — cross-branch reconciliation ─────────────────────────────────

export const mergePlanProvenanceSchema = z
  .object({
    sourceBranch: z
      .object({
        decisions: z.array(
          z
            .object({
              atEventId: z.string(),
              choiceId: z.string(),
              narrativeOrder: z.number(),
            })
            .strict(),
        ),
      })
      .strict(),
    mergeTimestamp: z.string(),
    source: z.string(),
  })
  .strict();

export const mergePlanSchema = z
  .object({
    incomingSnapshots: z.array(z.string()),
    mergeNode: z.string(),
    effectiveCoordinate: z.string(),
    policies: z.record(z.string(), mergePolicySchema),
    provenance: mergePlanProvenanceSchema,
  })
  .strict();

// ─── NarrativeEllipsis — omitted content record ──────────────────────────────

export const narrativeEllipsisSchema = z
  .object({
    id: z.string(),
    sourceRange: z
      .object({
        start: z.string(),
        end: z.string(),
      })
      .strict(),
    omittedContent: z.string(),
    provenance: z.string(),
  })
  .strict();

// ─── NarrativeNode — union (NarrativeEvent | NarrativeEllipsis) ──────────────

// Note: Full validation of NarrativeEvent is in event.ts; this is the
// structural overlap for coverage manifest purposes.
export const narrativeNodeSchema = z.union([
  z.object({ id: z.string(), event: z.string(), title: z.string() }).passthrough(),
  narrativeEllipsisSchema,
]);

// ─── ScenePresentation — discourse scene presentation ────────────────────────

export const scenePresentationSchema = z
  .object({
    id: z.string(),
    sceneId: z.string(),
    discoursePosition: z.number(),
    plannedActs: z.array(z.string()),
    provenance: z.string(),
  })
  .strict();

// ─── DiscourseBridge — omitted-text disclosure record ────────────────────────

export const discourseBridgeSchema = z
  .object({
    id: z.string(),
    position: z.number(),
    plannedActs: z.array(z.string()),
    provenance: z.string(),
  })
  .strict();

// ─── DiscourseNode — union (ScenePresentation | DiscourseBridge) ─────────────

export const discourseNodeSchema = z.union([scenePresentationSchema, discourseBridgeSchema]);

// ─── CoverageManifest — dual coverage (orthogonal) ───────────────────────────

export const coverageManifestSchema = z
  .object({
    narrativeNodes: z.array(narrativeNodeSchema),
    discourseNodes: z.array(discourseNodeSchema),
  })
  .strict();

// ─── StorySnapshot — selection-independent full replay ───────────────────────

export const storySnapshotTombstonesSchema = z
  .object({
    entities: z.array(z.string()),
    relationships: z.array(z.string()),
    threads: z.array(z.string()),
    ruleEpochs: z.array(z.string()),
    ruleExceptions: z.array(z.string()),
    ruleSpecifications: z.array(z.string()),
    retiredIds: z.array(z.string()),
  })
  .strict();

export const storySnapshotCatalogHashesSchema = z
  .object({
    entityTypes: z.string(),
    entityDeclarations: z.string(),
    threadTypes: z.string(),
    relationshipTypes: z.string(),
  })
  .strict();

export const storySnapshotSchema = z
  .object({
    branch: z
      .object({
        decisions: z.array(
          z
            .object({
              atEventId: z.string(),
              choiceId: z.string(),
              narrativeOrder: z.number(),
            })
            .strict(),
        ),
      })
      .strict(),
    temporalPrefix: z.string(),
    orderedOutputIds: z.array(z.string()),
    worldState: z.record(z.string(), z.unknown()),
    providerIndex: z.record(z.string(), z.string()),
    absenceIndex: z.record(z.string(), absenceWitnessSchema),
    tombstones: storySnapshotTombstonesSchema,
    catalogHashes: storySnapshotCatalogHashesSchema,
    graphHash: z.string(),
    stateHash: z.string(),
  })
  .strict();

// ─── DiscourseSnapshot — planned discourse replay ───────────────────────────

export const discourseSnapshotSchema = z
  .object({
    assemblyId: z.string(),
    branch: z
      .object({
        decisions: z.array(
          z
            .object({
              atEventId: z.string(),
              choiceId: z.string(),
              narrativeOrder: z.number(),
            })
            .strict(),
        ),
      })
      .strict(),
    discoursePosition: z.number(),
    discourseState: z.record(z.string(), z.unknown()),
    narratorProfileHash: z.string(),
    propositionCatalogHash: z.string(),
    selectionHash: z.string(),
    discourseGraphHash: z.string(),
  })
  .strict();

// ─── Sparse run — excerpt disclosure checkpoint ──────────────────────────────

export const excerptDisclosureCheckpointSchema = z
  .object({
    type: z.literal('isolated_excerpt'),
    bridgeIds: z.array(z.string()),
  })
  .strict();

export const fullWorkContextSchema = z
  .object({
    type: z.literal('full_work_context'),
    precedingBridgeCompleteness: z.boolean(),
  })
  .strict();

export const sparseRunDeclarationSchema = z.union([
  excerptDisclosureCheckpointSchema,
  fullWorkContextSchema,
]);
