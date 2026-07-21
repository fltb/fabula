// ============================================================================
// Novalistically — DISCOURSE-1: Zod Schema Definitions
// Schemas for DiscourseState, ModelReaderProfile, NarratorProfile,
// NarratorAssertion, disclosure action types, PlannedDiscourseLedger,
// DiscourseContextProjection, hint lifecycle, withholding, cache types.
//
// Binding constraints from docs/todos/graph-discourse-render.md DISCOURSE-1:
//   (see types/discourse.ts header for full list)
// ============================================================================


import { z } from 'zod';
import type { NarratorProfile, DisclosureAction } from '../types/discourse.js';


// ─── Discourse Position ──────────────────────────────────────────────────────

export const discoursePositionSchema = z.number().int().min(0);

// ─── ModelReaderProfile (§2) ─────────────────────────────────────────────────

export const modelReaderProfileIdSchema = z.literal('default_model_reader_v1');

export const audienceSemanticsSchema = z.object({
  narrativeInterpretation: z.literal('default'),
  disclosureInterpretation: z.literal('default'),
}).strict();

export const narrationDisclosurePolicySchema = z.object({
  allowPrivateThoughtDisclosure: z.boolean(),
  allowDirectAddress: z.boolean(),
}).strict();

export const initialExposureContractSchema = z.object({
  initialReveals: z.array(z.string()),
  initialClaims: z.array(z.string()),
  initialWithholds: z.array(z.string()),
}).strict();

export const modelReaderProfileSchema = z.object({
  id: modelReaderProfileIdSchema,
  hash: z.string(),
  audienceSemantics: audienceSemanticsSchema,
  narrationDisclosurePolicy: narrationDisclosurePolicySchema,
  initialExposureContract: initialExposureContractSchema,
}).strict();

// ─── NarratorProfile (§10) ──────────────────────────────────────────────────

export const narratorProfileTypeSchema = z.enum([
  'focalizer_bound',
  'retrospective_entity',
  'explicit_ledger',
  'omniscient',
]);

export const narratorAccessSchema = z.enum(['full', 'focalizer_only', 'limited']);
export const narratorAssertionCapabilitySchema = z.enum(['full', 'constrained', 'minimal']);
export const narratorTruthCapabilitySchema = z.enum(['full_knowledge', 'limited_knowledge', 'opaque']);
export const narratorFidelitySchema = z.enum(['reliable', 'unreliable', 'ambiguous']);
export const narratorSinceritySchema = z.enum(['sincere', 'deceptive', 'ambiguous']);

export const narratorProfileBaseSchema = z.object({
  id: z.string(),
  access: narratorAccessSchema,
  assertion: narratorAssertionCapabilitySchema,
  truth: narratorTruthCapabilitySchema,
  fidelity: narratorFidelitySchema,
  sincerity: narratorSinceritySchema,
});

export const focalizerBoundProfileSchema = narratorProfileBaseSchema.extend({
  type: z.literal('focalizer_bound'),
}).strict();

export const retrospectiveEntityProfileSchema = narratorProfileBaseSchema.extend({
  type: z.literal('retrospective_entity'),
  knowledgeBoundary: z.string(),
}).strict();

export const explicitLedgerProfileSchema = narratorProfileBaseSchema.extend({
  type: z.literal('explicit_ledger'),
}).strict();

export const omniscientProfileSchema = narratorProfileBaseSchema.extend({
  type: z.literal('omniscient'),
  autoReveal: z.literal(false),
}).strict();

export const narratorProfileSchema: z.ZodType<NarratorProfile> = z.discriminatedUnion('type', [
  focalizerBoundProfileSchema,
  retrospectiveEntityProfileSchema,
  explicitLedgerProfileSchema,
  omniscientProfileSchema,
]);

// ─── NarratorAssertion (§11) ────────────────────────────────────────────────

export const assertionTypeSchema = z.enum([
  'authoritative_reveal',
  'claim',
  'conjecture',
  'quotation',
  'implication',
]);

export const assertionPolaritySchema = z.enum(['affirmative', 'negative']);

export const truthBoundarySchema = z.boolean();

export const narrationBoundarySchema = z.object({
  narratorId: z.string(),
  focalizerId: z.string().optional(),
  narrationTime: z.string().optional(),
}).strict();

export const assertionEvidenceSchema = z.object({
  type: z.enum(['direct_observation', 'testimony', 'inference', 'documented', 'knowledge_boundary']),
  source: z.string(),
  confidence: z.enum(['certain', 'probable', 'speculative']).optional(),
}).strict();

export const narratorAssertionSchema = z.object({
  id: z.string(),
  narrator: z.string(),
  proposition: z.string(),
  polarity: assertionPolaritySchema,
  type: assertionTypeSchema,
  truthBoundary: truthBoundarySchema,
  narrationBoundary: narrationBoundarySchema,
  evidence: assertionEvidenceSchema.optional(),
}).strict();

// ─── Disclosure Actions (§4) ────────────────────────────────────────────────

export const discoursePositionActionSchema = z.object({
  discoursePosition: discoursePositionSchema,
});

export const revealActionSchema = z.object({
  type: z.literal('reveal'),
  assertionId: z.string(),
  discoursePosition: discoursePositionSchema,
}).strict();

export const claimActionSchema = z.object({
  type: z.literal('claim'),
  assertionId: z.string(),
  discoursePosition: discoursePositionSchema,
}).strict();

export const hintActionSchema = z.object({
  type: z.literal('hint'),
  hintId: z.string(),
  surfaceProposition: z.string(),
  targetProposition: z.string(),
  threadId: z.string().optional(),
  discoursePosition: discoursePositionSchema,
}).strict();

export const retractionActionSchema = z.object({
  type: z.literal('retraction'),
  assertionId: z.string(),
  discoursePosition: discoursePositionSchema,
}).strict();

export const correctionActionSchema = z.object({
  type: z.literal('correction'),
  priorAssertionId: z.string(),
  newAssertionId: z.string(),
  discoursePosition: discoursePositionSchema,
}).strict();

export const withholdStartActionSchema = z.object({
  type: z.literal('withhold_start'),
  policyId: z.string(),
  reason: z.string().optional(),
  discoursePosition: discoursePositionSchema,
}).strict();

export const withholdEndActionSchema = z.object({
  type: z.literal('withhold_end'),
  policyId: z.string(),
  discoursePosition: discoursePositionSchema,
}).strict();

export const disclosureActionSchema: z.ZodType<DisclosureAction> = z.discriminatedUnion('type', [
  revealActionSchema,
  claimActionSchema,
  hintActionSchema,
  retractionActionSchema,
  correctionActionSchema,
  withholdStartActionSchema,
  withholdEndActionSchema,
]);

// ─── Hint Lifecycle (§7) ────────────────────────────────────────────────────

export const hintStateSchema = z.enum([
  'planned',
  'contract_planted',
  'contract_reinforced',
  'contract_fulfilled',
  'contract_subverted',
  'retracted',
]);

export const hintSchema = z.object({
  hintId: z.string(),
  state: hintStateSchema,
  surfaceProposition: z.string(),
  targetProposition: z.string(),
  threadId: z.string().optional(),
  discoursePosition: discoursePositionSchema,
}).strict();

// ─── Withholding Policy ──────────────────────────────────────────────────────

export const withholdingPolicySchema = z.object({
  policyId: z.string(),
  reason: z.string().optional(),
  startPosition: discoursePositionSchema,
  endPosition: discoursePositionSchema.nullable(),
  active: z.boolean(),
}).strict();

// ─── PlannedDiscourseLedger (§3) ────────────────────────────────────────────

export const plannedLedgerEntrySchema = z.object({
  id: z.string(),
  action: disclosureActionSchema,
  sceneId: z.string(),
  branch: z.string(),
  discoursePosition: discoursePositionSchema,
}).strict();

export const plannedDiscourseLedgerSchema = z.object({
  id: z.string(),
  entries: z.array(plannedLedgerEntrySchema),
  hash: z.string(),
}).strict();

// ─── DiscourseState (§1) — NOT part of WorldState ──────────────────────────

export const discourseStateSchema = z.object({
  position: discoursePositionSchema,
  reveals: z.array(z.string()),
  openClaims: z.array(z.string()),
  retractions: z.array(z.object({
    assertionId: z.string(),
    discoursePosition: discoursePositionSchema,
  }).strict()),
  corrections: z.array(z.object({
    priorAssertionId: z.string(),
    newAssertionId: z.string(),
    discoursePosition: discoursePositionSchema,
  }).strict()),
  hints: z.array(hintSchema),
  activeWithholds: z.array(withholdingPolicySchema),
  narratorProfiles: z.record(z.string(), narratorProfileSchema),
  assertions: z.record(z.string(), narratorAssertionSchema),
  providerIndex: z.record(z.string(), z.string()),
  branch: z.string(),
  ledgerHash: z.string(),
}).strict();

// ─── DiscourseContextProjection (§12) — Pass 1 only ─────────────────────────

export const discourseContextProjectionSchema = z.object({
  plannedReveals: z.array(z.string()),
  openClaims: z.array(z.string()),
  visibleHints: z.array(z.object({
    hintId: z.string(),
    surfaceProposition: z.string(),
    state: hintStateSchema,
  }).strict()),
  accessibleClaims: z.array(z.object({
    assertionId: z.string(),
    narrator: z.string(),
    type: assertionTypeSchema,
    surface: z.string(),
  }).strict()),
  authorizedTargets: z.array(z.object({
    assertionId: z.string(),
    actionType: z.enum(['reveal', 'claim']),
    discoursePosition: discoursePositionSchema,
  }).strict()),
  activeWithholdingPolicies: z.array(withholdingPolicySchema),
}).strict();

// ─── Pass 2 Observation (§17) ───────────────────────────────────────────────

export const disclosureObservationSchema = z.object({
  plannedEffectId: z.string(),
  observationType: z.enum(['reveal', 'claim', 'hint', 'retraction', 'correction', 'unplanned_exposure']),
  proposition: z.string(),
  polarity: assertionPolaritySchema,
  assertion: z.string(),
  evidence: z.string().optional(),
  matchLevel: z.enum(['exact_match', 'partial_match', 'mismatch', 'unobserved']),
  authorityPresentation: z.string().optional(),
  suspectedWithholding: z.string().optional(),
  suspectedLeak: z.string().optional(),
}).strict();

// ─── Sparse Corpus Modes (§16) ──────────────────────────────────────────────

export const excerptDisclosureCheckpointSchema = z.object({
  type: z.literal('isolated_excerpt'),
  bridgeIds: z.array(z.string()),
}).strict();

export const fullWorkContextSchema = z.object({
  type: z.literal('full_work_context'),
  precedingBridgeCompleteness: z.boolean(),
}).strict();

export const sparseRunDeclarationSchema = z.discriminatedUnion('type', [
  excerptDisclosureCheckpointSchema,
  fullWorkContextSchema,
]);

// ─── Cache Types (§18) ──────────────────────────────────────────────────────

export const discourseCacheKeySchema = z.object({
  runKey: z.string(),
  cursor: z.string(),
  plannedStateHash: z.string(),
  assertionHintHash: z.string(),
  policyHash: z.string(),
  providerIndexHash: z.string(),
  branch: z.string(),
  narratorProfileHash: z.string(),
  propositionCatalogHash: z.string(),
  selectionHash: z.string(),
  provenanceHash: z.string(),
}).strict();

export const validationKeySchema = z.object({
  proseHash: z.string(),
  analysisSchema: z.string(),
  model: z.string(),
  validatorPolicy: z.string(),
  referencePolicy: z.string(),
}).strict();
