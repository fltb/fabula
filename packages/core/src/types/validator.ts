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

import type {
  EntityId,
  EntityRegistry,
} from './entity.js';
import type { NarrativeEvent, RuleEffectEntry } from './event.js';
import type { KnowledgeState, WorldState } from './world.js';
import type { AnalysisResult } from './analysis.js';

// ——— Pre-Render Input (new) ———

export interface PreRenderInput {
  event: NarrativeEvent;
  worldState: WorldState;
  events: NarrativeEvent[];
  entityRegistry: EntityRegistry;
  chapter: number;
  queryState: (entityId: EntityId, attribute: string) => unknown;
  getKnowledge: (characterId: EntityId) => KnowledgeState;
  getThreadProgress: (threadId: string) => { progress: number; total: number };
  getRuleEvidence: (ruleId: string) => RuleEffectEntry[];
}

// ——— Post-Render Input (new) ———

export interface PostRenderInput {
  event: NarrativeEvent;
  worldState: WorldState;
  prose: string;
  analysis: AnalysisResult | null;
  chapter: number;
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
  getKnowledge: (characterId: EntityId) => KnowledgeState;
  getThreadProgress: (threadId: string) => { progress: number; total: number };
  getRuleEvidence: (ruleId: string) => RuleEffectEntry[];
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
  fixAction: 'add_knowledge' | 'remove_line' | 'change_value' | 'add_precondition' | 'declare_flashback' | 'manual' | 'add_field' | 'create_file' | 'edit_file';
  fixTarget: {
    file: string;
    field?: string;
    value?: unknown;
  };
}

// ——— Validator ———

export interface Validator {
  name: string;
  category: 'characterization' | 'factual_detail' | 'timeline_plot' | 'worldbuilding' | 'narrative_style';

  // ── New methods ──────────────────────────────────────────────────

  /** Pre-render check: run against event definitions + world state. */
  validatePre?(input: PreRenderInput): ValidationIssue[];

  /** Post-render check: run against rendered prose + LLM analysis. */
  validatePost?(input: PostRenderInput): ValidationIssue[];

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
