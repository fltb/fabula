// ============================================================================
// Novalistically — Zod Schemas for YAML File Validation (barrel)
// Every exported schema uses .strict() to reject unknown fields.
// ============================================================================

import { z, type ZodTypeAny } from 'zod';

// ── Import all per-entity schemas (local bindings needed for registry) ───────

import {
  preconditionSchema,
  postconditionSchema,
} from './primitives.js';
import { eventFileSchema } from './event.js';
import { characterDefinitionSchema } from './character.js';
import { ruleDefinitionSchema } from './rule.js';
import { locationDefinitionSchema } from './location.js';
import { itemDefinitionSchema } from './item.js';
import { factionDefinitionSchema } from './faction.js';
import { relationshipDefinitionSchema, relationshipEventSchema } from './relationship.js';
import { knowledgeDefinitionSchema, knowledgeEventSchema } from './knowledge.js';
import { worldInitialStateSchema } from './state-initial.js';
import { chapterMetadataSchema, sceneMetadataSchema } from './chapter.js';
import { projectConfigSchema } from './project.js';
import { branchPointsFileSchema } from './branch-points.js';

import { analysisResultSchema, parseAnalysisJSON, parseAnalysisJSONWithErrors } from './analysis.js';

// ── Re-export all per-entity schemas ─────────────────────────────────────────

export {
  analysisResultSchema,
  parseAnalysisJSON,
  parseAnalysisJSONWithErrors,
  preconditionSchema,
  postconditionSchema,
  eventFileSchema,
  characterDefinitionSchema,
  ruleDefinitionSchema,
  locationDefinitionSchema,
  itemDefinitionSchema,
  factionDefinitionSchema,
  relationshipDefinitionSchema,
  relationshipEventSchema,
  knowledgeDefinitionSchema,
  knowledgeEventSchema,
  worldInitialStateSchema,
  chapterMetadataSchema,
  sceneMetadataSchema,
  projectConfigSchema,
  branchPointsFileSchema,
};

// ────────────────────────────────────────────────────────────────────────────
// Render Request Schema (standalone)
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
  relationshipEvent: relationshipEventSchema,
  knowledgeDefinition: knowledgeDefinitionSchema,
  knowledgeEvent: knowledgeEventSchema,
  worldInitialState: worldInitialStateSchema,
  chapterMetadata: chapterMetadataSchema,
  projectConfig: projectConfigSchema,
  sceneMetadata: sceneMetadataSchema,
  renderRequest: renderRequestSchema,
  branchPointsFile: branchPointsFileSchema,
  analysisResult: analysisResultSchema,
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
