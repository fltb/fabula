// ============================================================================
// Novalistically — Zod Schemas for YAML File Validation (barrel)
// Every exported schema uses .strict() to reject unknown fields.
// ============================================================================

// ── Import all per-entity schemas ────────────────────────────────────────────

import { eventFileSchema } from './event.js';
import { characterDefinitionSchema } from './character.js';
import { ruleDefinitionSchema } from './rule.js';
import { locationDefinitionSchema } from './location.js';
import { itemDefinitionSchema } from './item.js';
import { factionDefinitionSchema } from './faction.js';
import { relationshipDefinitionSchema } from './relationship.js';
import { relationshipTypeDefinitionSchema, relationshipTransactionSchema, relationshipRoleDefinitionSchema, membershipSchema, dimensionWriteSchema, dimensionUnsetSchema, identityTransitionCarryEntrySchema, relationshipIdentityTransitionGroupSchema } from './relationship.js';
import { worldInitialStateSchema } from './state-initial.js';
import { chapterMetadataSchema } from './chapter.js';
import { projectConfigSchema } from './project.js';

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
