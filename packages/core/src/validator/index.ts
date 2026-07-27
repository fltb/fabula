// ============================================================================
// Validator System — Barrel exports
// ============================================================================

// ============================================================================
// Validator System — Barrel exports
// ============================================================================

export { ResultAggregator } from './aggregator.js';
export { AliasValidator } from './alias.js';
export { AnachronyConsistencyValidator } from './anachrony-consistency.js';
export { AntiCausalEdgeValidator } from './anti-causal.js';
export { AppearanceValidator } from './appearance.js';
export { BranchMergeValidator } from './branch-merge.js';
export { CausalOverloadValidator } from './causal-overload.js';
export { CausalityValidator } from './causality.js';
export { ChapterOrderValidator } from './chapter-order.js';
export { CharacterStateValidator } from './character-state.js';
export { ChecklistValidator } from './checklist.js';
export { ConflictValidator } from './conflict.js';
export { resolveDeferredFacts } from './deferred-resolver.js';
export { DiscourseValidator } from './discourse.js';
export { DiscourseBalanceValidator } from './discourse-balance.js';
export { DurationConsistencyValidator } from './duration-consistency.js';
export { FactualDetailValidator } from './factual-detail.js';
export { FocalizationConsistencyValidator } from './focalization-consistency.js';
export { ForeshadowingValidator } from './foreshadowing.js';
export { FrequencyConsistencyValidator } from './frequency-consistency.js';
export { GreyLineValidator } from './grey-line.js';
export { KnowledgeValidator } from './knowledge.js';
export { PacingValidator } from './pacing.js';
export { POVValidator } from './pov.js';
export { PronounValidator } from './pronoun.js';
export { ReachabilityValidator } from './reachability.js';
export { SurfaceModeValidator } from './surface-mode.js';
export { TenseConsistencyValidator } from './tense-consistency.js';
export { TimelineValidator } from './timeline.js';
export { VoiceConsistencyValidator } from './voice-consistency.js';
export { VoiceDriftDetector } from './voice-drift.js';
export { WorldRuleValidator } from './world-rule.js';

// ============================================================================
// Aggregated analysis schema — built from built-in validator schemas
// ============================================================================
import { z } from 'zod';
import { checklistResultSchema } from '../schemas/narrative-checklist.js';
import { characterReferenceSchema } from './alias.js';
import { anachronyDetectedSchema } from './anachrony-consistency.js';
import { appearanceCheckSchema } from './appearance.js';
import { postconditionBlockSchema, preconditionBlockSchema } from './causality.js';
import { conflictAnalysisSchema } from './conflict.js';
import { durationDetectedSchema } from './duration-consistency.js';
import { inventedDetailSchema } from './factual-detail.js';
import { focalizationDetectedSchema } from './focalization-consistency.js';
import { foreshadowingDeployedSchema } from './foreshadowing.js';
import { frequencyDetectedSchema } from './frequency-consistency.js';
import { knowledgeCheckSchema } from './knowledge.js';
import { povBlockSchema } from './pov.js';
import { qualityBlockSchema } from './quality.js';
import { narrativeCheckSchema } from './schemas.js';
import { tenseDetectedSchema } from './tense-consistency.js';
import { threadProgressAchievedSchema } from './thread-progress.js';
import { voiceDetectedSchema } from './voice-consistency.js';
import { ruleCheckSchema } from './world-rule.js';
/**
 * Static schema built from all built-in validator analysis blocks.
 * Plugin validators add fields dynamically through `ResultAggregator.getCombinedValidationSchema()`.
 */
export const analysisContentSchema = z.object({
  postconditions: postconditionBlockSchema,
  preconditions: preconditionBlockSchema,
  pov: povBlockSchema,
  inventedDetails: z.array(inventedDetailSchema),
  quality: qualityBlockSchema,
  threadProgressAchieved: threadProgressAchievedSchema,
  foreshadowingDeployed: foreshadowingDeployedSchema,
  narrativeChecks: z.array(narrativeCheckSchema),
  appearanceChecks: z.array(appearanceCheckSchema),
  characterReferences: z.array(characterReferenceSchema),
  tenseDetected: tenseDetectedSchema,
  conflictAnalysis: conflictAnalysisSchema,
  ruleChecks: z.array(ruleCheckSchema),
  knowledgeChecks: z.array(knowledgeCheckSchema),
  checklistResults: z.array(checklistResultSchema).optional(),
  // S6 Genette dimension blocks — optional: pre-existing reference analysis
  // data (mock-pass2 fixtures) predates them, and each consumer validator
  // no-ops gracefully when its block is absent.
  durationDetected: durationDetectedSchema.optional(),
  frequencyDetected: frequencyDetectedSchema.optional(),
  voiceDetected: voiceDetectedSchema.optional(),
  anachronyDetected: anachronyDetectedSchema.optional(),
  focalizationDetected: focalizationDetectedSchema.optional(),
});

export type AnalysisContent = z.infer<typeof analysisContentSchema>;
