// ============================================================================
// Novalistically — STATE-4 Knowledge/Belief Zod Schemas
// ============================================================================

import { z } from 'zod';

// ─── Proposition Schemas ─────────────────────────────────────────────────────

export const informationActTypeSchema = z.enum([
  'perception', 'thought', 'testimony', 'assertion',
  'inference', 'reading', 'recall', 'revelation',
]);

const propositionQuantifierSchema = z.enum(['identity', 'all', 'any', 'not']).optional();

export const groundedPropositionSchema = z.object({
  kind: z.literal('grounded'),
  id: z.string().min(1),
  entityId: z.string().min(1),
  attribute: z.string().min(1),
  value: z.unknown(),
  quantifier: propositionQuantifierSchema,
  factId: z.string().optional(),
}).strict();

export const epistemicPropositionSchema = z.object({
  kind: z.literal('epistemic'),
  id: z.string().min(1),
  subject: z.string().min(1),
  propositionId: z.string().min(1),
  attitude: z.enum(['knows', 'believes', 'suspects', 'denies', 'doubts']),
}).strict();

export const actPropositionSchema = z.object({
  kind: z.literal('act'),
  id: z.string().min(1),
  actType: informationActTypeSchema,
  actor: z.string().min(1),
  recipients: z.array(z.string().min(1)).default([]),
  contentPropositions: z.array(z.string().min(1)).default([]),
  storyBoundary: z.string().optional(),
  inWorldSource: z.string().optional(),
  corpusProvenance: z.string().optional(),
}).strict();

export const intensionalPropositionSchema = z.object({
  kind: z.literal('intensional'),
  id: z.string().min(1),
  content: z.string().min(1),
  domain: z.enum(['plan', 'dream', 'prophecy', 'theory', 'moral_judgment', 'counterfactual']),
}).strict();

export const propositionSchema = z.discriminatedUnion('kind', [
  groundedPropositionSchema,
  epistemicPropositionSchema,
  actPropositionSchema,
  intensionalPropositionSchema,
]);

export const propositionCatalogSchema = z.object({
  version: z.number().int().nonnegative(),
  propositions: z.record(z.string(), propositionSchema),
  dependencyGraph: z.record(z.string(), z.array(z.string())),
}).strict();

// ─── Claim Schemas ───────────────────────────────────────────────────────────

export const claimGradeSchema = z.enum(['know', 'believe', 'suspect']);

export const claimPolaritySchema = z.enum(['affirmative', 'negative']);

export const settledAssessmentSchema = z.object({
  type: z.literal('settled'),
  grade: claimGradeSchema,
  polarity: claimPolaritySchema,
});

export const conflictedAssessmentSchema = z.object({
  type: z.literal('conflicted'),
  affirmations: z.number().int().nonnegative(),
  rejections: z.number().int().nonnegative(),
});

export const suspendedAssessmentSchema = z.object({
  type: z.literal('suspended'),
});

export const forgottenAssessmentSchema = z.object({
  type: z.literal('forgotten'),
});

export const unsetAssessmentSchema = z.object({
  type: z.literal('unset'),
});

export const claimAssessmentSchema = z.discriminatedUnion('type', [
  settledAssessmentSchema,
  conflictedAssessmentSchema,
  suspendedAssessmentSchema,
  forgottenAssessmentSchema,
  unsetAssessmentSchema,
]);

export const evidenceSourceSchema = z.enum([
  'direct_experience', 'testimony', 'inference', 'revelation', 'default',
]);

export const claimEvidenceRecordSchema = z.object({
  source: evidenceSourceSchema,
  warrant: z.string().optional(),
  provider: z.string().optional(),
  provenance: z.array(z.string()).default([]),
  acquiredAt: z.object({
    type: z.enum(['absolute', 'relative', 'chapter']),
    value: z.union([z.string(), z.number()]),
    anchor: z.string().optional(),
    chapter: z.number().optional(),
    offset: z.object({
      amount: z.number(),
      unit: z.enum(['minute', 'hour', 'day', 'week', 'month']),
    }).optional(),
  }),
}).strict();

export const claimSchema = z.object({
  subject: z.string().min(1),
  propositionId: z.string().min(1),
  assessment: claimAssessmentSchema,
  evidence: z.array(claimEvidenceRecordSchema).default([]),
}).strict();

export const epistemicLedgerSchema = z.object({
  claims: z.record(z.string(), claimSchema),
  bySubject: z.record(z.string(), z.array(z.string())),
  byProposition: z.record(z.string(), z.array(z.string())),
  actLog: z.array(z.object({
    type: informationActTypeSchema,
    actor: z.string().min(1),
    recipients: z.array(z.string().min(1)).default([]),
    contentPropositions: z.array(z.string().min(1)).default([]),
    storyBoundary: z.string().optional(),
    inWorldSource: z.string().optional(),
    corpusProvenance: z.string().optional(),
    timestamp: z.object({
      type: z.enum(['absolute', 'relative', 'chapter']),
      value: z.union([z.string(), z.number()]),
      anchor: z.string().optional(),
      chapter: z.number().optional(),
      offset: z.object({
        amount: z.number(),
        unit: z.enum(['minute', 'hour', 'day', 'week', 'month']),
      }).optional(),
    }),
    eventId: z.string().min(1),
    warrantJustification: z.string().optional(),
  })).default([]),
}).strict();

// ─── Group Epistemic Schemas ─────────────────────────────────────────────────

export const groupEpistemicModeSchema = z.enum(['institutional', 'distributed', 'mutual']);

export const groupEpistemicQueryDefinitionSchema = z.object({
  groupId: z.string().min(1),
  mode: groupEpistemicModeSchema,
  propositionId: z.string().min(1),
  audience: z.array(z.string()).default([]),
}).strict();

export const commonGroundRecordSchema = z.object({
  propositionId: z.string().min(1),
  participants: z.array(z.string().min(1)),
  establishedAt: z.object({
    type: z.enum(['absolute', 'relative', 'chapter']),
    value: z.union([z.string(), z.number()]),
    anchor: z.string().optional(),
    chapter: z.number().optional(),
    offset: z.object({
      amount: z.number(),
      unit: z.enum(['minute', 'hour', 'day', 'week', 'month']),
    }).optional(),
  }),
  establishedBy: z.string().min(1),
}).strict();

// ─── NarrativeKnowledgeBoundary Schema ───────────────────────────────────────

export const narrativeKnowledgeBoundarySchema = z.object({
  focalizer: z.string().min(1),
  allowlistedClaims: z.array(z.string()).default([]),
  boundaryTime: z.object({
    type: z.enum(['absolute', 'relative', 'chapter']),
    value: z.union([z.string(), z.number()]),
    anchor: z.string().optional(),
    chapter: z.number().optional(),
    offset: z.object({
      amount: z.number(),
      unit: z.enum(['minute', 'hour', 'day', 'week', 'month']),
    }).optional(),
  }),
}).strict();

// ─── Evaluation Result Schema ────────────────────────────────────────────────

export const evaluationResultSchema = z.enum(['true', 'false', 'indeterminate']);
