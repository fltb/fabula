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
import { worldInitialStateSchema } from './state-initial.js';
import { chapterMetadataSchema } from './chapter.js';
import { projectConfigSchema } from './project.js';

// ── Re-export all per-entity schemas ─────────────────────────────────────────

export {
  eventFileSchema,
  characterDefinitionSchema,
  ruleDefinitionSchema,
  locationDefinitionSchema,
  itemDefinitionSchema,
  factionDefinitionSchema,
  relationshipDefinitionSchema,
  worldInitialStateSchema,
  projectConfigSchema,
  chapterMetadataSchema,
};
