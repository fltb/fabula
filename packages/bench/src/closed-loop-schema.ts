// ============================================================================
// Closed-Loop Spec Schema — Zod .strict() for frozen-spec validation
// ============================================================================

import { z } from 'zod/v3';

// ─── Primitives ─────────────────────────────────────────────────────────────

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'Must be 64-character lowercase hex');
const nonEmptyString = z.string().min(1, 'Must not be empty');

// ─── Conditions ─────────────────────────────────────────────────────────────

const conditionMode = z.enum(['live-all', 'live-event', 'offline-assembly']);

const conditionSpecSchema = z
  .object({
    fixture: nonEmptyString,
    mode: conditionMode,
    eventId: z.string().optional(),
  })
  .strict();

// ─── Models ─────────────────────────────────────────────────────────────────

const modelsSchema = z
  .object({
    primary: nonEmptyString,
    fallback: nonEmptyString,
  })
  .strict();

// ─── Render config ──────────────────────────────────────────────────────────

const renderConfigSchema = z
  .object({
    fullRuns: z.number().int().min(1).default(3),
    concurrency: z.number().int().min(1).default(3),
    maxRounds: z.number().int().min(1).default(1),
    maxNetworkReplacementRuns: z.number().int().min(0).default(1),
  })
  .strict();

// ─── Coverage ───────────────────────────────────────────────────────────────

const requiredCodeCoverageSchema = z
  .object({
    lines: z.number().min(0).max(100).default(90),
    statements: z.number().min(0).max(100).default(90),
    functions: z.number().min(0).max(100).default(90),
    branches: z.number().min(0).max(100).default(85),
  })
  .strict();

const coverageSchema = z
  .object({
    requiredLayers: z.array(nonEmptyString).min(1),
    requiredConditions: z.array(nonEmptyString).min(1),
    requiredGates: z.array(nonEmptyString).min(1),
    requiredCodeCoverage: requiredCodeCoverageSchema,
  })
  .strict();

// ─── Thresholds ─────────────────────────────────────────────────────────────

const thresholdsSchema = z
  .object({
    maxPass2CallsPerEvent: z.number().min(0).default(4),
    medianChecklistCoverage: z.number().min(0).max(1).default(0.9),
    minimumRunChecklistCoverage: z.number().min(0).max(1).default(0.8),
    maxMajorInventedDetails: z.number().min(0).default(0),
    medianWordCountAPE: z.number().min(0).max(1).default(0.25),
    maxSceneWordCountAPE: z.number().min(0).max(1).default(0.5),
    minimumChecklistJaccard: z.number().min(0).max(1).default(0.85),
    memorizationOverlap24: z.number().min(0).max(1).default(0.2),
    memorizationMaxMatchedWindow: z.number().min(0).default(80),
    humanFullMedian: z.number().min(1).max(4).default(3),
    humanMaxPoorScenes: z.number().min(0).default(0),
    humanMinimumLiftOverMinimal: z.number().min(0).max(4).default(0.5),
  })
  .strict();

// ─── Full spec schema ───────────────────────────────────────────────────────

const expectedEventIdsSchema = z.array(z.string()).min(1);

export const closedLoopSpecSchema = z
  .object({
    version: z.number().int().min(1),
    // Legacy closed-loop specs are quality evaluations. Workflow fixtures must
    // opt in explicitly so changing the acceptance contract is versioned in the
    // spec rather than inferred from the fixture name.
    evaluationMode: z.enum(['quality', 'workflow']).default('quality'),
    changeReason: nonEmptyString,
    fixture: nonEmptyString,
    fixtureHash: hex64,
    sourceText: nonEmptyString,
    expectedEvents: expectedEventIdsSchema,
    models: modelsSchema,
    render: renderConfigSchema,
    conditions: z
      .object({
        full: conditionSpecSchema,
        'layer-minimal': conditionSpecSchema,
        'pov-switch': conditionSpecSchema,
        'discourse-reorder': conditionSpecSchema,
      })
      .strict(),
    coverage: coverageSchema,
    thresholds: thresholdsSchema,
  })
  .strict();
