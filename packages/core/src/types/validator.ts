// ============================================================================
// Novalistically — Validator System Types (§7.4.15)
// ============================================================================

import type {
  EntityId,
  EntityRegistry,
} from './entity.js';
import type { NarrativeEvent, RuleEffectEntry } from './event.js';
import type { KnowledgeState, WorldState } from './world.js';
import type { AnalysisResult } from './analysis.js';

// ——— Validator Context ———

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
  requiresLLM: boolean;

  /** Check structured YAML input for logical issues (pre-render). */
  validate: (event: NarrativeEvent, context: ValidatorContext) => ValidationIssue[];

  /**
   * Check the rendered prose against the source event and world state.
   * This is the PRIMARY quality gate — run AFTER LLM rendering.
   *
   * The `analysis` parameter provides structured metadata from the LLM's
   * second pass (self-analysis). Validators should PREFER using this
   * structured data over regex-parsing the raw prose, as it is
   * language-agnostic and more reliable.
   *
   * Default no-op; override in concrete validators.
   */
  validateRender: (
    prose: string,
    event: NarrativeEvent,
    state: WorldState,
    analysis?: AnalysisResult,
  ) => ValidationIssue[];
}

// ——— Validation Result ———

export interface ValidationResult {
  passed: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  infos: ValidationIssue[];
}
