// ============================================================================
// Novalistically — STATE-5: Thread Schema Definitions (Zod)
// ============================================================================

import { z } from 'zod/v3';

import { actantModelSchema, structuralFunctionSchema } from './story-ir.js';
// ─── Identities ──────────────────────────────────────────────────────────────

export const threadIdSchema = z.string().min(1);
export const threadRunIdSchema = z.string().min(1);

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export const threadLifecycleSchema = z.enum([
  'planned',
  'active',
  'blocked',
  'completed',
  'abandoned',
  'retired',
]);

// ─── Goal / Milestone ────────────────────────────────────────────────────────

export const goalLifecycleSchema = z.enum(['pending', 'active', 'achieved', 'failed', 'waived']);

export const milestoneLifecycleSchema = z.enum([
  'pending',
  'achieved',
  'failed',
  'waived',
  'invalidated',
]);

export const goalStateSchema = z
  .object({
    goalId: z.string().min(1),
    status: goalLifecycleSchema,
  })
  .strict();

export const milestoneStateSchema = z
  .object({
    milestoneId: z.string().min(1),
    status: milestoneLifecycleSchema,
  })
  .strict();

// ─── Time domain ─────────────────────────────────────────────────────────────

export const timeDomainSchema = z.enum(['story', 'discourse']);

// ─── ThreadTypeDefinition ────────────────────────────────────────────────────

export const threadTypeDefinitionSchema = z
  .object({
    typeId: z.string().min(1),
    description: z.string().min(1),
    allowedPhases: z.array(z.string().min(1)).min(1),
    lifecyclePolicy: z
      .object({
        reopenPolicy: z.enum(['forbidden', 'allowed', 'requiresExplicitReason']),
      })
      .strict(),
    timeDomain: timeDomainSchema,
    stableGoals: z.array(goalStateSchema),
    stableMilestones: z.array(milestoneStateSchema),
    narrativeHints: z.array(z.string()).optional(),
    provenance: z.string().min(1).optional(),
    structuralFunction: structuralFunctionSchema.optional(),
    actantModel: actantModelSchema.optional(),
  })
  .strict();

export const threadTypeCatalogSchema = z
  .object({
    types: z.record(z.string().min(1), threadTypeDefinitionSchema),
  })
  .strict();

// ─── ThreadDeclaration ───────────────────────────────────────────────────────

export const threadDeclarationSchema = z
  .object({
    threadId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    typeId: z.string().min(1),
    initialPhase: z.string().min(1).optional(),
    initialBindings: z.record(z.string().min(1), z.string().min(1)).optional(),
    initialGoalStates: z.array(goalStateSchema).optional(),
    initialMilestoneStates: z.array(milestoneStateSchema).optional(),
    provenance: z.string().min(1).optional(),
    targetRevealChapter: z.number().int().nonnegative().optional(),
    initialProgress: z.string().min(1).optional(),
    structuralFunction: structuralFunctionSchema.optional(),
  })
  .strict();

/** Canonical state_initial.threads list; declarations are not keyed in YAML. */
export const threadDeclarationCatalogSchema = z.array(threadDeclarationSchema);

// ─── ThreadRuntimeState ──────────────────────────────────────────────────────

export const threadRuntimeStateSchema = z
  .object({
    threadId: threadIdSchema,
    status: threadLifecycleSchema,
    currentRunId: threadRunIdSchema,
    phase: z.string(),
    bindings: z.record(z.string(), z.string()),
    goalStates: z.record(z.string(), goalLifecycleSchema),
    milestoneStates: z.record(z.string(), milestoneLifecycleSchema),
    semanticStateHash: z.string(),
  })
  .strict();

// ─── ThreadTransaction ───────────────────────────────────────────────────────

export const threadTransactionSchema = z
  .object({
    thread: z.string(),
    runId: threadRunIdSchema,
    status: threadLifecycleSchema.optional(),
    phase: z.string().optional(),
    bindingsAfter: z.record(z.string(), z.string()).optional(),
    goalSet: z.array(goalStateSchema).optional(),
    milestoneSet: z.array(milestoneStateSchema).optional(),
    provenance: z.string(),
    advancement: z.string().optional(),
  })
  .strict();

// ─── Branch merge ────────────────────────────────────────────────────────────

export const threadMergeStrategySchema = z.enum([
  'requireEqual',
  'selectBranch',
  'literal',
  'newRun',
]);

export const threadMergeResultSchema = z
  .object({
    threadId: threadIdSchema,
    strategy: threadMergeStrategySchema,
    mergedState: threadRuntimeStateSchema,
    newRunId: threadRunIdSchema.optional(),
  })
  .strict();
