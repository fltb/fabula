// ============================================================================
// Novalistically — Zod Schemas for YAML File Validation
// Every exported schema uses .strict() to reject unknown fields.
// ============================================================================

import { z, type ZodTypeAny } from 'zod';

// ────────────────────────────────────────────────────────────────────────────
// 1. Precondition Schema
// ────────────────────────────────────────────────────────────────────────────

export const preconditionSchema = z
  .object({
    entity: z.string(),
    attribute: z.string(),
    value: z.unknown(),
    operator: z.enum(['eq', 'neq', 'gt', 'lt', 'contains']).optional(),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// 2. Postcondition Schema
// ────────────────────────────────────────────────────────────────────────────

export const postconditionSchema = z
  .object({
    entity: z.string(),
    attribute: z.string(),
    value: z.unknown(),
    confidence: z.number().optional(),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// Shared Sub-Schemas
// ────────────────────────────────────────────────────────────────────────────

const styleGuidanceSchema = z
  .object({
    tone: z.string().optional(),
    characterVoice: z.record(z.string(), z.string()).optional(),
    avoid: z.string().optional(),
    scenePacing: z.string().optional(),
    atmosphere: z.string().optional(),
  })
  .strict();

const threadProgressEntrySchema = z
  .object({
    thread: z.string(),
    advancement: z.string(),
    progressAfter: z.number(),
    progressTotal: z.number(),
  })
  .strict();

const foreshadowEntrySchema = z
  .object({
    id: z.string(),
    hint: z.string(),
    targetRevealChapter: z.number(),
    thread: z.string().optional(),
  })
  .strict();

const relationshipChangeSchema = z
  .object({
    participants: z.tuple([z.string(), z.string()]),
    effect: z.enum(['establish', 'change', 'dissolve', 'reinforce', 'complicate']),
    direction: z.string(),
    newState: z
      .object({
        type: z.string(),
        intensity: z.number(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ruleEffectSchema = z
  .object({
    rule: z.string(),
    effect: z.enum(['reinforce', 'weaken', 'introduce_exception', 'nullify']),
    evidence: z.string(),
  })
  .strict();

const introduceEntrySchema = z
  .object({
    type: z.enum(['character', 'location', 'item', 'concept']),
    id: z.string(),
    initialState: z.record(z.string(), z.unknown()),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// 3. Event File Schema
// ────────────────────────────────────────────────────────────────────────────

export const eventFileSchema = z
  .object({
    event: z.string(),
    narrativeOrder: z.number(),
    title: z.string(),
    storyTime: z.string(),
    sceneType: z.enum(['linear', 'flashback', 'flashforward', 'dream', 'parallel']).optional(),
    pov: z
      .object({
        character: z.string(),
        type: z.enum(['first_person', 'third_person_limited', 'omniscient']),
      })
      .strict(),
    sceneBrief: z.string(),
    preconditions: z.array(preconditionSchema),
    expectedPostconditions: z.array(postconditionSchema),
    styleGuidance: styleGuidanceSchema.optional(),
    threadProgress: z.array(threadProgressEntrySchema).optional(),
    foreshadowing: z.array(foreshadowEntrySchema).optional(),
    relationshipEffects: z.array(relationshipChangeSchema).optional(),
    ruleEffects: z.array(ruleEffectSchema).optional(),
    introduces: z.array(introduceEntrySchema).optional(),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// 4. Character Definition Schema
// ────────────────────────────────────────────────────────────────────────────

export const characterDefinitionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    archetype: z.string().optional(),
    faction: z.string().optional(),
    role: z.enum(['minor', 'supporting', 'antagonist', 'background']).optional(),
    description: z.string(),
    initialState: z.record(z.string(), z.unknown()),
    traits: z.array(z.string()),
    voiceNotes: z.string().optional(),
    backstory: z.string().optional(),
    knownSecrets: z.array(z.string()).optional(),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// Logical Consequence (used by Rule Definition)
// ────────────────────────────────────────────────────────────────────────────

const logicalConsequenceSchema = z
  .object({
    description: z.string(),
    check: z
      .object({
        type: z.enum(['state_invariant', 'transition_constraint', 'progression']),
        filter: z.string(),
        assert: z.string(),
        unlessEvent: z.string().optional(),
        direction: z.string().optional(),
        tolerance: z.number().optional(),
        severity: z.enum(['error', 'warning']),
      })
      .strict(),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// 5. Rule Definition Schema
// ────────────────────────────────────────────────────────────────────────────

export const ruleDefinitionSchema = z
  .object({
    ruleId: z.string(),
    name: z.string(),
    category: z.string(),
    type: z.string(),
    statement: z.string(),
    logicalConsequences: z.array(logicalConsequenceSchema),
    exceptions: z
      .array(
        z
          .object({
            condition: z.string(),
            note: z.string(),
          })
          .strict(),
      )
      .optional(),
    evidenceChain: z.array(ruleEffectSchema),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// 6. Location Definition Schema
// ────────────────────────────────────────────────────────────────────────────

export const locationDefinitionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    parent: z.string().optional(),
    description: z.string(),
    initialState: z.record(z.string(), z.unknown()),
    notableFeatures: z.array(z.string()).optional(),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// 7. Item Definition Schema
// ────────────────────────────────────────────────────────────────────────────

export const itemDefinitionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    description: z.string(),
    initialState: z.record(z.string(), z.unknown()),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// 8. Faction Definition Schema
// ────────────────────────────────────────────────────────────────────────────

export const factionDefinitionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    description: z.string(),
    initialState: z.record(z.string(), z.unknown()),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// 9. Relationship Definition Schema
// ────────────────────────────────────────────────────────────────────────────

export const relationshipDefinitionSchema = z
  .object({
    participants: z.tuple([z.string(), z.string()]),
    type: z.string(),
    description: z.string(),
    initialState: z.record(z.string(), z.record(z.string(), z.unknown())),
    establishedEvent: z.string(),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// 10. World Initial State Schema
// ────────────────────────────────────────────────────────────────────────────

export const worldInitialStateSchema = z
  .object({
    info: z
      .object({
        currentEra: z.string(),
        politicalSituation: z.string(),
      })
      .strict(),
    timeAnchors: z
      .array(
        z
          .object({
            id: z.string(),
            day: z.number(),
            description: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    threads: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          type: z.string(),
          targetRevealChapter: z.number(),
          initialProgress: z.string(),
        })
        .strict(),
    ),
    worldFacts: z.array(
      z
        .object({
          id: z.string(),
          value: z.unknown(),
          description: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// 11. Chapter Metadata Schema
// ────────────────────────────────────────────────────────────────────────────

export const chapterMetadataSchema = z
  .object({
    chapter: z.number(),
    title: z.string(),
    summary: z.string(),
    intent: z.string(),
    plannedScenes: z.number(),
    styleGuidance: styleGuidanceSchema.optional(),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// 12. Project Config Schema (nova.yaml)
// ────────────────────────────────────────────────────────────────────────────

export const projectConfigSchema = z
  .object({
    project: z.string(),
    title: z.string(),
    author: z.string(),
    defaultModel: z.string().optional(),
    defaultLanguage: z.string().optional(),
    validatorOverrides: z.record(z.string(), z.enum(['off', 'warning', 'error'])).optional(),
    circuitBreaker: z
      .object({
        maxRetries: z.number(),
      })
      .strict()
      .optional(),
    reviewExpiry: z
      .object({
        blockingChaptersBeforeDowngrade: z.number(),
      })
      .strict()
      .optional(),
    snapshotInterval: z.number().optional(),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// 13. Scene Metadata Schema
// ────────────────────────────────────────────────────────────────────────────

export const sceneMetadataSchema = z
  .object({
    event: z.string(),
    proseSource: z.enum(['llm', 'human_edited', 'human_locked']),
    modelUsed: z.string().optional(),
    renderedAt: z.string().optional(),
    wordCount: z.number().optional(),
    editHistory: z.array(
      z
        .object({
          timestamp: z.string(),
          notes: z.string(),
        })
        .strict(),
    ),
    quality: z
      .object({
        proseQuality: z.number().optional(),
        voiceAdherence: z.number().optional(),
        pacingScore: z.number().optional(),
        continuityScore: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// 14. Render Request Schema
// ────────────────────────────────────────────────────────────────────────────

export const renderRequestSchema = z
  .object({
    event: z.string(),
    mode: z.enum(['draft', 'revise', 'retry']),
    revisionNotes: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    temperature: z.number().optional(),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// 15. Branch Points File Schema
// ────────────────────────────────────────────────────────────────────────────

export const branchPointsFileSchema = z
  .object({
    branchPoints: z.array(
      z
        .object({
          id: z.string(),
          atEvent: z.string(),
          description: z.string(),
          choices: z.array(
            z
              .object({
                path: z.string(),
                label: z.string(),
                branchId: z.string(),
                description: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// Schema Registry
// ────────────────────────────────────────────────────────────────────────────

export const schemas: Record<string, ZodTypeAny> = {
  precondition: preconditionSchema,
  postcondition: postconditionSchema,
  eventFile: eventFileSchema,
  characterDefinition: characterDefinitionSchema,
  ruleDefinition: ruleDefinitionSchema,
  locationDefinition: locationDefinitionSchema,
  itemDefinition: itemDefinitionSchema,
  factionDefinition: factionDefinitionSchema,
  relationshipDefinition: relationshipDefinitionSchema,
  worldInitialState: worldInitialStateSchema,
  chapterMetadata: chapterMetadataSchema,
  projectConfig: projectConfigSchema,
  sceneMetadata: sceneMetadataSchema,
  renderRequest: renderRequestSchema,
  branchPointsFile: branchPointsFileSchema,
} as const;

// ────────────────────────────────────────────────────────────────────────────
// validateYaml — Parse and validate unknown data against a named schema
// ────────────────────────────────────────────────────────────────────────────

export function validateYaml<T extends ZodTypeAny>(
  schemaName: string,
  data: unknown,
): z.SafeParseReturnType<unknown, z.infer<T>> {
  const schema = schemas[schemaName];
  if (!schema) {
    throw new Error(`Unknown schema: "${schemaName}". Available schemas: ${Object.keys(schemas).join(', ')}`);
  }
  return schema.safeParse(data) as z.SafeParseReturnType<unknown, z.infer<T>>;
}
