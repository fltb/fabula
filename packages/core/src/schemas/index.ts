// ============================================================================
// Novalistically — Zod Schemas for YAML File Validation (barrel)
// Every exported schema uses .strict() to reject unknown fields.
// ============================================================================

// ── Import all per-entity schemas ────────────────────────────────────────────

import { eventFileSchema } from './event.js';
import { characterDefinitionSchema } from './character.js';
import {
  ruleDefinitionSchema,
  ruleIdSchema,
  ruleEpochIdSchema,
  ruleExceptionIdSchema,
  ruleSpecificationIdSchema,
  ruleTypeDefinitionSchema,
  ruleSpecificationSchema,
  ruleConstraintSchema,
  ruleConstraintKindSchema,
  ruleEnforcementSchema,
  ruleApplicableEffectivenessSchema,
  rulePredicateSchema,
  ruleRuntimeStateSchema,
  ruleActivationSchema,
  ruleEffectivenessSchema,
  ruleEvaluationRecordSchema,
  ruleEvaluationResultSchema,
  ruleExceptionSchema,
  ruleExceptionStatusSchema,
  ruleExceptionEffectSchema,
  ruleExceptionConditionSchema,
  ruleTransactionSchema,
  ruleTransactionOperationSchema,
  ruleEffectEntrySchema,
  ruleClassSchema,
} from './rule.js';
import { locationDefinitionSchema } from './location.js';
import { itemDefinitionSchema } from './item.js';
import { factionDefinitionSchema } from './faction.js';
import { relationshipDefinitionSchema } from './relationship.js';
import { relationshipTypeDefinitionSchema, relationshipTransactionSchema, relationshipRoleDefinitionSchema, membershipSchema, dimensionWriteSchema, dimensionUnsetSchema, identityTransitionCarryEntrySchema, relationshipIdentityTransitionGroupSchema } from './relationship.js';
import { worldInitialStateSchema } from './state-initial.js';
import { chapterMetadataSchema } from './chapter.js';
import { greyLineSchema, greyLineNodeSchema } from './grey-line.js';
import { projectConfigSchema } from './project.js';
import { narrativeChecklistSchema, narrativeChecklistItemSchema, checklistResultSchema } from './narrative-checklist.js';
import { sourceContextSchema, sourceContextEntrySchema } from './source-context.js';
import { durationProfileSchema, durationTypeSchema } from './duration.js';
import { frequencyProfileSchema, frequencyTypeSchema } from './frequency.js';
import { anachronySchema, voiceProfileSchema, anachronyTypeSchema, anachronyScopeSchema, anachronyFunctionSchema, narrativeLevelSchema, diegeticRelationSchema } from './discourse.js';
import {
  modernNovelConfigSchema,
  antiCausalEdgeConfigSchema,
  chapterOrderContestedSchema,
  surfaceModeConfigSchema,
  causalOverloadConfigSchema,
  irresolvableIndeterminacySchema,
  absentApparatusSchema,
  voiceDissonanceSchema,
  multiplicitySchema,
  metanarrativeLevelSchema,
} from './modern-novel.js';
import { ideaIRSchema, thematicIntentSchema, emotionalArcDefinitionSchema, emotionalBeatSchema } from './idea-ir.js';
import { structuralFunctionSchema, actantModelSchema, storyArchetypeSchema } from './story-ir.js';
import { entityTypeCatalogSchema, entityDeclarationCatalogSchema, entityTypeRefSchema, entityRuntimeStateSchema, writePolicySchema, requiredAtSchema, attributeDefinitionSchema, entityTypeDefinitionSchema, entityDeclarationSchema } from './entity-catalog.js';
// ── Re-export all per-entity schemas ─────────────────────────────────────────
export {
  eventFileSchema,
  characterDefinitionSchema,
  ruleDefinitionSchema,
  locationDefinitionSchema,
  itemDefinitionSchema,
  factionDefinitionSchema,
  relationshipDefinitionSchema,
  relationshipTypeDefinitionSchema,
  relationshipTransactionSchema,
  worldInitialStateSchema,
  projectConfigSchema,
  chapterMetadataSchema,
  greyLineSchema,
  greyLineNodeSchema,
  narrativeChecklistSchema,
  narrativeChecklistItemSchema,
  checklistResultSchema,
  sourceContextSchema,
  sourceContextEntrySchema,
  durationProfileSchema,
  durationTypeSchema,
  frequencyProfileSchema,
  frequencyTypeSchema,
  anachronySchema,
  voiceProfileSchema,
  anachronyTypeSchema,
  anachronyScopeSchema,
  anachronyFunctionSchema,
  narrativeLevelSchema,
  diegeticRelationSchema,
  ideaIRSchema,
  thematicIntentSchema,
  emotionalArcDefinitionSchema,
  emotionalBeatSchema,
  structuralFunctionSchema,
  actantModelSchema,
  storyArchetypeSchema,
  modernNovelConfigSchema,
  antiCausalEdgeConfigSchema,
  chapterOrderContestedSchema,
  surfaceModeConfigSchema,
  causalOverloadConfigSchema,
  irresolvableIndeterminacySchema,
  absentApparatusSchema,
  voiceDissonanceSchema,
  multiplicitySchema,
  metanarrativeLevelSchema,
};
export {
  ruleIdSchema,
  ruleEpochIdSchema,
  ruleExceptionIdSchema,
  ruleSpecificationIdSchema,
  ruleTypeDefinitionSchema,
  ruleSpecificationSchema,
  ruleConstraintSchema,
  ruleConstraintKindSchema,
  ruleEnforcementSchema,
  ruleApplicableEffectivenessSchema,
  rulePredicateSchema,
  ruleRuntimeStateSchema,
  ruleActivationSchema,
  ruleEffectivenessSchema,
  ruleEvaluationRecordSchema,
  ruleEvaluationResultSchema,
  ruleExceptionSchema,
  ruleExceptionEffectSchema,
  ruleExceptionConditionSchema,
  ruleTransactionSchema,
  ruleTransactionOperationSchema,
  ruleEffectEntrySchema,
  ruleClassSchema,
};

export {
  entityTypeCatalogSchema,
  entityDeclarationCatalogSchema,
  entityTypeRefSchema,
  entityRuntimeStateSchema,
  writePolicySchema,
  requiredAtSchema,
  attributeDefinitionSchema,
  entityTypeDefinitionSchema,
  entityDeclarationSchema,
};

// ——— STATE-4 Knowledge/Belief Schemas ———
export {
  groundedPropositionSchema,
  epistemicPropositionSchema,
  actPropositionSchema,
  intensionalPropositionSchema,
  propositionSchema,
  propositionCatalogSchema,
  claimGradeSchema,
  claimPolaritySchema,
  settledAssessmentSchema,
  conflictedAssessmentSchema,
  suspendedAssessmentSchema,
  forgottenAssessmentSchema,
  unsetAssessmentSchema,
  claimAssessmentSchema,
  evidenceSourceSchema,
  claimEvidenceRecordSchema,
  claimSchema,
  epistemicLedgerSchema,
  groupEpistemicModeSchema,
  groupEpistemicQueryDefinitionSchema,
  commonGroundRecordSchema,
  narrativeKnowledgeBoundarySchema,
  evaluationResultSchema,
  informationActTypeSchema,
} from './knowledge.js';
// ——— STATE-5 Thread Schemas ———
export {
  threadIdSchema,
  threadRunIdSchema,
  threadLifecycleSchema,
  goalLifecycleSchema,
  milestoneLifecycleSchema,
  goalStateSchema,
  milestoneStateSchema,
  timeDomainSchema,
  threadTypeDefinitionSchema,
  threadTypeCatalogSchema,
  threadDeclarationSchema,
  threadDeclarationCatalogSchema,
  threadRuntimeStateSchema,
  threadTransactionSchema,
  threadMergeStrategySchema,
  threadMergeResultSchema,
} from './thread.js';

// ——— GRAPH-1: Typed Causal Graph Schemas ———
export {
  storyCoordinateSchema,
  discourseCoordinateSchema,
  effectiveCoordinateSchema,
  edgeClassSchema,
  outputValueSchema,
  outputDescriptorSchema,
  readPhaseSchema,
  readOriginSchema,
  presencePredicateSchema,
  readRequirementSchema,
  graphEdgeSchema,
  graphProviderOutputSchema,
  graphAbsenceWitnessSchema,
  graphReadResolutionSchema,
  graphBoundaryReferenceSchema,
  graphNarrativeEllipsisSchema,
  storyGraphSchema,
  discourseGraphSchema,
  graphCacheEntrySchema,
  graphSchema,
} from './graph.js';
// ——— CORPUS-1: NarrativeEllipsis & NarrativeNode Schemas ———
export {
  narrativeEllipsisSchema as corpusNarrativeEllipsisSchema,
  narrativeNodeSchema as corpusNarrativeNodeSchema,
  narrativeEventSchema as corpusNarrativeEventSchema,
  ellipsisProvenanceSchema,
  informationActSchema,
  isNarrativeEllipsis,
  isNarrativeEvent,
  isNarrativeNode,
} from './corpus.js';
// These supersede the integration.ts schemas and carry full binding-constraint validation.

// ——— INTEGRATION-1: Cross-domain resolution, Merge & dual coverage ———
export {
  absenceBasisSchema,
  absenceWitnessSchema,
  providerOutputSchema,
  readResolutionSchema,
  readResolutionUnionSchema,
  boundaryReferenceSchema,
  mergePlanSchema,
  mergePlanProvenanceSchema,
  mergePolicySchema,
  narrativeEllipsisSchema,
  narrativeNodeSchema,
  scenePresentationSchema,
  discourseBridgeSchema,
  discourseNodeSchema,
  coverageManifestSchema,
  storySnapshotSchema,
  storySnapshotTombstonesSchema,
  storySnapshotCatalogHashesSchema,
  discourseSnapshotSchema,
  sparseRunDeclarationSchema,
  excerptDisclosureCheckpointSchema,
  fullWorkContextSchema,
} from './integration.js';

// ——— INTEGRATION-2: ReferenceEligibility & lifecycle closure ———
export {
  referenceModeSchema,
  referenceKindSchema,
  referenceEntrySchema,
  referenceIndexSchema,
} from './reference.js';

// ——— DISCOURSE-1: Discourse State & Narrator Schemas ———
export {
  discoursePositionSchema,
  modelReaderProfileIdSchema,
  audienceSemanticsSchema,
  narrationDisclosurePolicySchema,
  initialExposureContractSchema,
  modelReaderProfileSchema,
  narratorProfileTypeSchema,
  narratorAccessSchema,
  narratorAssertionCapabilitySchema,
  narratorTruthCapabilitySchema,
  narratorFidelitySchema,
  narratorSinceritySchema,
  narratorProfileBaseSchema,
  focalizerBoundProfileSchema,
  retrospectiveEntityProfileSchema,
  explicitLedgerProfileSchema,
  omniscientProfileSchema,
  narratorProfileSchema,
  assertionTypeSchema,
  assertionPolaritySchema,
  truthBoundarySchema,
  narrationBoundarySchema,
  assertionEvidenceSchema,
  narratorAssertionSchema,
  discoursePositionActionSchema,
  revealActionSchema,
  claimActionSchema,
  hintActionSchema,
  retractionActionSchema,
  correctionActionSchema,
  withholdStartActionSchema,
  withholdEndActionSchema,
  disclosureActionSchema,
  hintStateSchema,
  hintSchema,
  withholdingPolicySchema,
  plannedLedgerEntrySchema,
  plannedDiscourseLedgerSchema,
  discourseStateSchema,
  discourseContextProjectionSchema,
  disclosureObservationSchema,
  discourseCacheKeySchema,
  validationKeySchema,
} from './discourse.js';

// ——— RENDER-SURFACE-1: Surface render, group & cache schemas ———
export {
  styleResolutionPathSchema,
  styleProfileSchema,
  sceneTransitionSchema,
  continuityPacketSchema,
  compiledSceneContractSchema,
  serialLaneSchema,
  surfacePolicySchema,
  renderGroupSchema,
  surfaceDependencyGraphSchema,
  validationGateStatusSchema,
  validationGateSchema,
  validationPolicySchema,
  validationGateGraphSchema,
  plannerModeSchema,
  renderGroupManifestSchema,
  excerptModeSchema,
  styleMetricsSchema,
  surfaceReferencePacketSchema,
  autoGroupConfigSchema,
  surfacePlannerOptionsSchema,
  surfacePlanResultSchema,
  logicalRenderKeySchema,
  surfaceRenderKeySchema,
  surfaceValidationKeySchema,
  attemptKeySchema,
  surfaceErrorCodeSchema,
} from './render-surface.js';

// ——— CAPABILITY-1: Capability Manifest schemas ———
export {
  capabilityStatusSchema,
  evidenceClassSchema,
  stageGateSchema,
  capabilityManifestEntrySchema,
  capabilityManifestSchema,
  capabilityStatusSchemaZ,
  evidenceClassSchemaZ,
  stageGateSchemaZ,
  capabilityManifestEntrySchemaZ,
  capabilityManifestSchemaZ,
} from './capability.js';
