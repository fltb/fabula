// ============================================================================
// Novalistically — STATE-5: Thread Schema Definitions (Zod)
// ============================================================================

import { z } from 'zod';

// ─── Identities ──────────────────────────────────────────────────────────────

export const threadIdSchema = z.string().min(1);
export const threadRunIdSchema = z.string().min(1);

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export const threadLifecycleSchema = z.enum([
  'planned', 'active', 'blocked', 'completed', 'abandoned', 'retired',
]);

// ─── Goal / Milestone ────────────────────────────────────────────────────────

export const goalLifecycleSchema = z.enum([
  'pending', 'active', 'achieved', 'failed', 'waived',
]);

export const milestoneLifecycleSchema = z.enum([
  'pending', 'achieved', 'failed', 'waived', 'invalidated',
]);

export const goalStateSchema = z.object({
  goalId: z.string(),
  status: goalLifecycleSchema,
}).strict();

export const milestoneStateSchema = z.object({
  milestoneId: z.string(),
  status: milestoneLifecycleSchema,
}).strict();

// ─── Time domain ─────────────────────────────────────────────────────────────

export const timeDomainSchema = z.enum(['story', 'discourse']);

// ─── ThreadTypeDefinition ────────────────────────────────────────────────────

export const threadTypeDefinitionSchema = z.object({
  typeId: z.string(),
  description: z.string(),
  allowedPhases: z.array(z.string()),
  lifecyclePolicy: z.object({
    reopenPolicy: z.enum(['forbidden', 'allowed', 'requiresExplicitReason']),
  }).strict(),
  timeDomain: timeDomainSchema,
  stableGoals: z.array(goalStateSchema),
  stableMilestones: z.array(milestoneStateSchema),
  narrativeHints: z.array(z.string()).optional(),
  provenance: z.string().optional(),
}).strict();

export const threadTypeCatalogSchema = z.object({
  types: z.record(z.string(), threadTypeDefinitionSchema),
}).strict();

// ─── ThreadDeclaration ───────────────────────────────────────────────────────

export const threadDeclarationSchema = z.object({
  threadId: z.string(),
  name: z.string(),
  description: z.string(),
  typeId: z.string(),
  initialPhase: z.string().optional(),
  initialBindings: z.record(z.string(), z.string()).optional(),
  initialGoalStates: z.array(goalStateSchema).optional(),
  initialMilestoneStates: z.array(milestoneStateSchema).optional(),
  provenance: z.string().optional(),
}).strict();

export const threadDeclarationCatalogSchema = z.object({
  declarations: z.record(z.string(), threadDeclarationSchema),
}).strict();

// ─── ThreadRuntimeState ──────────────────────────────────────────────────────

export const threadRuntimeStateSchema = z.object({
  threadId: threadIdSchema,
  status: threadLifecycleSchema,
  currentRunId: threadRunIdSchema,
  phase: z.string(),
  bindings: z.record(z.string(), z.string()),
  goalStates: z.record(z.string(), goalLifecycleSchema),
  milestoneStates: z.record(z.string(), milestoneLifecycleSchema),
  semanticStateHash: z.string(),
}).strict();

// ─── ThreadTransaction ───────────────────────────────────────────────────────

export const threadTransactionSchema = z.object({
  thread: z.string(),
  runId: threadRunIdSchema,
  status: threadLifecycleSchema.optional(),
  phase: z.string().optional(),
  bindingsAfter: z.record(z.string(), z.string()).optional(),
  goalSet: z.array(goalStateSchema).optional(),
  milestoneSet: z.array(milestoneStateSchema).optional(),
  provenance: z.string(),
  advancement: z.string().optional(),
}).strict();

// ─── Branch merge ────────────────────────────────────────────────────────────

export const threadMergeStrategySchema = z.enum([
  'requireEqual', 'selectBranch', 'literal', 'newRun',
]);

export const threadMergeResultSchema = z.object({
  threadId: threadIdSchema,
  strategy: threadMergeStrategySchema,
  mergedState: threadRuntimeStateSchema,
  newRunId: threadRunIdSchema.optional(),
}).strict();
