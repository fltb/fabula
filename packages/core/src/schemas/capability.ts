// ============================================================================
// Novalistically — CAPABILITY-1: Zod Schema Definitions
//
// Binding constraints from docs/todos/capability-contract.md CAPABILITY-1:
//   (see types/capability.ts header for full list)
// ============================================================================

import { z } from 'zod';
import type {
  CapabilityManifest,
  CapabilityManifestEntry,
  CapabilityStatus,
  EvidenceClass,
  StageGate,
} from '../types/capability.js';

// ─── CapabilityStatus ────────────────────────────────────────────────────────

export const capabilityStatusSchema = z.enum(['S', 'C', 'X']);

export const capabilityStatusSchemaZ: z.ZodType<CapabilityStatus> = capabilityStatusSchema;

// ─── EvidenceClass ───────────────────────────────────────────────────────────

export const evidenceClassSchema = z.enum([
  'state_replay',
  'discourse_replay',
  'schema_rejection',
  'surface_scheduler',
  'validation_measurement',
]);

export const evidenceClassSchemaZ: z.ZodType<EvidenceClass> = evidenceClassSchema;

// ─── StageGate ───────────────────────────────────────────────────────────────

export const stageGateSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const stageGateSchemaZ: z.ZodType<StageGate> = stageGateSchema;

// ─── CapabilityManifestEntry ─────────────────────────────────────────────────

export const capabilityManifestEntrySchema = z
  .object({
    capabilityId: z.string().min(1),
    status: capabilityStatusSchema,
    schemaVersions: z.array(z.string().min(1)).min(1),
    normalizationVersions: z.array(z.string().min(1)).min(1),
    supportedInputForms: z.array(z.string().min(1)).min(1),
    referenceCaseIds: z.array(z.string().min(1)),
    propertyCaseIds: z.array(z.string().min(1)),
    rejectionCaseIds: z.array(z.string().min(1)),
    snapshotCases: z.array(z.string().min(1)),
    fixtureIds: z.array(z.string().min(1)),
    provenanceRequirements: z.array(z.string().min(1)),
    stageGate: stageGateSchema,
    evidenceArtifactHash: z.string().min(1),
  })
  .strict();

export const capabilityManifestEntrySchemaZ: z.ZodType<CapabilityManifestEntry> =
  capabilityManifestEntrySchema;

// ─── CapabilityManifest ──────────────────────────────────────────────────────

export const capabilityManifestSchema = z
  .object({
    version: z.string().min(1),
    entries: z.array(capabilityManifestEntrySchema).superRefine((entries, context) => {
      const ids = new Set<string>();
      for (const [index, entry] of entries.entries()) {
        if (ids.has(entry.capabilityId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'capabilityId'],
            message: 'Duplicate capabilityId in manifest',
          });
        }
        ids.add(entry.capabilityId);
      }
    }),
    registryHash: z.string().min(1),
  })
  .strict();

export const capabilityManifestSchemaZ: z.ZodType<CapabilityManifest> = capabilityManifestSchema;
