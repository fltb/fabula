// ============================================================================
// Validator System — Barrel exports
// ============================================================================

// ============================================================================
// Validator System — Barrel exports
// ============================================================================

export { TimelineValidator } from './timeline.js';
export { CharacterStateValidator } from './character-state.js';
export { KnowledgeValidator } from './knowledge.js';
export { WorldRuleValidator } from './world-rule.js';
export { CausalityValidator } from './causality.js';
export { ForeshadowingValidator } from './foreshadowing.js';
export { GreyLineValidator } from './grey-line.js';
export { POVValidator } from './pov.js';
export { FactualDetailValidator } from './factual-detail.js';
export { VoiceDriftDetector } from './voice-drift.js';
export { BranchMergeValidator } from './branch-merge.js';
export { ReachabilityValidator } from './reachability.js';
export { PacingValidator } from './pacing.js';
export { TenseConsistencyValidator } from './tense-consistency.js';
export { DiscourseBalanceValidator } from './discourse-balance.js';
export { AliasValidator } from './alias.js';
export { PronounValidator } from './pronoun.js';
export { AppearanceValidator } from './appearance.js';
export { ConflictValidator } from './conflict.js';
export { ChecklistValidator } from './checklist.js';
export { ResultAggregator } from './aggregator.js';
export { resolveDeferredFacts } from './deferred-resolver.js';
export { AntiCausalEdgeValidator } from './anti-causal.js';
export { ChapterOrderValidator } from './chapter-order.js';
export { SurfaceModeValidator } from './surface-mode.js';
export { CausalOverloadValidator } from './causal-overload.js';
// ============================================================================
// Aggregated analysis schema — built from built-in validator schemas
// ============================================================================
import { z } from 'zod';

import { postconditionBlockSchema, preconditionBlockSchema } from './causality.js';
import { povBlockSchema } from './pov.js';
import { inventedDetailSchema } from './factual-detail.js';
import { qualityBlockSchema } from './quality.js';
import { threadProgressAchievedSchema } from './thread-progress.js';
import { foreshadowingDeployedSchema } from './foreshadowing.js';
import { narrativeCheckSchema } from './schemas.js';
import { appearanceCheckSchema } from './appearance.js';
import { characterReferenceSchema } from './alias.js';
import { tenseDetectedSchema } from './tense-consistency.js';
import { conflictAnalysisSchema } from './conflict.js';
import { checklistResultSchema } from '../schemas/narrative-checklist.js';
import { ruleCheckSchema } from './world-rule.js';
import { knowledgeCheckSchema } from './knowledge.js';
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
});

export type AnalysisContent = z.infer<typeof analysisContentSchema>;
