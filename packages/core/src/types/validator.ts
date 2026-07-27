// ============================================================================
// Novalistically — Validator System Types (§7.4.15)
// ============================================================================
//
// Migration status:
//   Currently supports two parallel interfaces:
//     - Old: validate(event, context: ValidatorContext) + validateRender(...) + requiresLLM
//     - New: validatePre?(input: PreRenderInput) + validatePost?(input: PostRenderInput)
//   Phased migration: aggregator learns new methods first, validators migrate one by one,
//   then old methods and types are deleted.
// ============================================================================

import type { EventStore } from '../state/event-store.js';
import type { AnalysisResult } from './analysis.js';
import type { ContextPackage } from './context.js';
import type { EntityId, EntityRegistry } from './entity.js';
import type { NarrativeEvent } from './event.js';
import type { EpistemicLedger } from './knowledge.js';
import type { ThreadRuntimeState } from './thread.js';
import type { WorldState } from './world.js';

// ——— AnalysisBlockRequirement ———

/**
 * Declares what a Pass 2 consumer validator needs from the LLM analysis output.
 * Validators returning these in getAnalysisRequirements() drive the dynamic
 * construction of the Pass 2 JSON template + instructions.
 */
export interface AnalysisBlockRequirement {
  /** JSON field path, e.g. 'narrativeChecks', 'ruleChecks', 'pov.leaks', 'postconditions' */
  field: string;
  /** Only for narrativeChecks-style keyed blocks: attribute values LLM should produce */
  attributes?: string[];
  /** Zod schema for this analysis block — auto-generates the JSON example in the prompt */
  schema: import('zod').ZodTypeAny;
  /** LLM instruction: MUST start with the field name. e.g. "narrativeChecks[pacing]: check..." */
  instruction: string;
}

// ——— Pre-Render Input (new) ———

export interface PreRenderInput {
  event: NarrativeEvent;
  worldState: WorldState;
  events: NarrativeEvent[];
  entityRegistry: EntityRegistry;
  chapter: number;
  eventStore?: EventStore;
  queryState: (entityId: EntityId, attribute: string) => unknown;
  getKnowledge: (characterId: EntityId) => EpistemicLedger;
  getThreadProgress: (threadId: string) => ThreadRuntimeState | null;
}

// ——— Post-Render Input (new) ———

export interface PostRenderInput {
  event: NarrativeEvent;
  worldState: WorldState;
  prose: string;
  analysis: AnalysisResult | null;
  chapter: number;
  entityRegistry?: EntityRegistry;
  /** Discourse-layer context package (S6c/DISCOURSE-1), when available. */
  context?: ContextPackage;
}

// ——— Validator Context (legacy) ———
// Kept as-is for backward compat with existing validators and PluginValidator.
// @deprecated Use PreRenderInput for new validators.

export interface ValidatorContext {
  worldState: WorldState;
  events: NarrativeEvent[];
  entityRegistry: EntityRegistry;
  currentEvent: NarrativeEvent;
  currentChapter: number;
  narrativeOrder: number;
  queryState: (entityId: EntityId, attribute: string) => unknown;
  getKnowledge: (characterId: EntityId) => EpistemicLedger;
  getThreadProgress: (threadId: string) => ThreadRuntimeState | null;
}

// ——— Validation Issue ———

export interface ValidationIssue {
  validator: string;
  severity: 'error' | 'warning' | 'info';
  event: string;
  entity: string;
  attribute?: string;
  message: string;
  fixSuggestion: string;
  fixAction:
    | 'add_knowledge'
    | 'remove_line'
    | 'change_value'
    | 'add_precondition'
    | 'declare_flashback'
    | 'manual'
    | 'add_field'
    | 'create_file'
    | 'edit_file';
  fixTarget: {
    file: string;
    field?: string;
    value?: unknown;
  };
}

// ——— Validator ———

export interface Validator {
  name: string;
  category:
    | 'characterization'
    | 'factual_detail'
    | 'timeline_plot'
    | 'worldbuilding'
    | 'narrative_style'
    | 'prose_quality';

  // ── New methods ──────────────────────────────────────────────────

  /** Pre-render check: run against event definitions + world state. */
  validatePre?(input: PreRenderInput): ValidationIssue[];

  /** Post-render check: run against rendered prose + LLM analysis. */
  validatePost?(input: PostRenderInput): ValidationIssue[];

  /**
   * Returns prompt guidance for the LLM to produce the analysis JSON that this validator consumes.
   * Only implement on validators that use validatePost with AnalysisResult.
   * Return an empty array if no instructions are needed.
   * Each requirement drives dynamic construction of the Pass 2 JSON template + instructions.
   */
  getAnalysisRequirements?(): AnalysisBlockRequirement[];

  // ── Legacy methods (deprecated, will be removed) ─────────────────

  /** @deprecated Implement validatePre instead. */
  validate?: (event: NarrativeEvent, context: ValidatorContext) => ValidationIssue[];

  /** @deprecated Implement validatePost instead. */
  validateRender?: (
    prose: string,
    event: NarrativeEvent,
    state: WorldState,
    analysis?: AnalysisResult,
  ) => ValidationIssue[];

  /** @deprecated Not needed — phase is determined by which method is implemented. */
  requiresLLM?: boolean;
}

// ——— Validation Result ———

export interface ValidationResult {
  passed: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  infos: ValidationIssue[];
}
