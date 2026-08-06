// ============================================================================
// Novalistically — Validator System Types (§7.4.15)
// ============================================================================
import type { z } from 'zod';
import type { SourceDiagnosticV1 } from '../contracts/source.js';
import type { StoryOrderIndex } from '../state/dag.js';
import type { AnalysisResult } from './analysis.js';
import type { ContextPackage } from './context.js';
import type { EntityId, EntityLookup, SceneStoryCoordinate } from './entity.js';
import type { EntityTypeCatalog } from './entity-catalog.js';
import type { NarrativeEvent } from './event.js';
import type { ISSSnapshot } from './iss.js';
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
  schema: z.ZodTypeAny;
  /** LLM instruction: MUST start with the field name. e.g. "narrativeChecks[pacing]: check..." */
  instruction: string;
}

// ——— Story Validation Context (optional, supplied by compiled graph) ———

/**
 * Resolved story coordinates and order for selected events, provided by the
 * compiled story graph. When absent, validators that depend on story chronology
 * skip coordinate-based checks rather than re-compiling the graph themselves.
 */
export interface StoryValidationContext {
  /** Event ID to resolved story coordinate map for selected ordinary events. */
  coordinatesByEventId: ReadonlyMap<string, SceneStoryCoordinate>;
  /** Proven-before order index for selected events. */
  order: StoryOrderIndex;
}

// ——— Validation Run Options ———

/**
 * Options for aggregator validate/validateAll calls. Each field is optional;
 * default behaviour matches the legacy positional API.
 */
export interface ValidationRunOptions {
  /** Per-validator severity overrides. */
  overrides?: Record<string, 'off' | 'warning' | 'error'>;
  /** Pre-computed state before each event (validateAll). */
  stateBeforeByEventId?: ReadonlyMap<string, WorldState>;
  /** Story context from compiled graph (timeline/plot validators). */
  story?: StoryValidationContext;
}

// ——— Pre-Render Input (new) ———

export interface PreRenderInput {
  event: NarrativeEvent;
  worldState: WorldState;
  events: NarrativeEvent[];
  entities: EntityLookup;
  chapter: number;
  queryState: (entityId: EntityId, attribute: string) => unknown;
  getKnowledge: (characterId: EntityId) => EpistemicLedger;
  getThreadProgress: (threadId: string) => ThreadRuntimeState | null;
  /** Story context from compiled graph. Optional — when absent, chronology checks are skipped. */
  story?: StoryValidationContext;
  /**
   * The project's compiled entity type catalog for semanticRole/writePolicy
   * lookups. No default catalog fallback — absent means checks are skipped.
   */
  entityTypeCatalog?: EntityTypeCatalog;
}

// ——— Post-Render Input (new) ———

export interface PostRenderInput {
  event: NarrativeEvent;
  worldState: WorldState;
  prose: string;
  analysis: AnalysisResult | null;
  chapter: number;
  entities?: EntityLookup;
  /** Project compiled entity type catalog for semanticRole/writePolicy lookups. */
  entityTypeCatalog?: EntityTypeCatalog;
  /** Discourse-layer context package (S6c/DISCOURSE-1), when available. */
  context?: ContextPackage;
}

/**
 * Kinds of validation findings. Severity remains independent (`error|warning|info`).
 *
 * - `compiler_invariant`: deterministic checks against authored source / compiled
 *   world state. Never carries an `observationRef`.
 * - `evidence_mismatch`: a produced Pass 2 verification payload (narrativeChecks,
 *   knowledgeChecks, appearanceChecks, ruleChecks, checklistResults, pre/postcondition
 *   blocks, …) contradicts or fails to cover the authored contract.
 * - `interpretive_assessment`: a finding derived from an assessment/quality payload
 *   (quality, pov, conflict, tense/voice/anachrony/duration/frequency/focalization
 *   detection) — an interpretive measurement, not a verified fact.
 * - `analysis_uncertainty`: the required Pass 2 field was `abstained` or `ambiguous`;
 *   produced by the aggregator preflight, default severity `warning`.
 */
export type ValidationIssueKind =
  | 'compiler_invariant'
  | 'evidence_mismatch'
  | 'interpretive_assessment'
  | 'analysis_uncertainty';

/**
 * Minimal reference from a finding to its measurement — never a copy of the
 * observation payload. `field` is the top-level analysis field key in
 * `AnalysisResult.observations`; `analysisPointer` is an RFC 6901 pointer into
 * `AnalysisResult.analysis` pointing at the atomic payload actually consumed.
 */
export interface ObservationRef {
  field: string;
  /** RFC 6901 JSON pointer into AnalysisResult.analysis (e.g. `/narrativeChecks/2`) */
  analysisPointer?: string;
}

export interface ValidationIssue {
  validator: string;
  severity: 'error' | 'warning' | 'info';
  kind: ValidationIssueKind;
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
  /** Optional reference to the Pass 2 observation this finding consumes. */
  observationRef?: ObservationRef;
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
}

// ——— Validation Result ———

export interface ValidationResult {
  passed: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  infos: ValidationIssue[];
}

// ——— Novel Validation Result (public contract) ———

/**
 * Result of running the full validation suite over a novel project:
 * aggregate pass/fail, per-event validator results, and the ISS snapshot.
 */
export interface NovelValidationResult {
  readonly passed: boolean;
  readonly results: ReadonlyMap<string, ValidationResult>;
  readonly iss: ISSSnapshot;
  /**
   * Source-level diagnostics produced by the validation path's optional
   * enabled-plugin extension gate (`SOURCE_EXTENSION_*`). Present only when a
   * registrar was supplied; an error-severity entry flips `passed` false.
   */
  readonly sourceDiagnostics?: readonly SourceDiagnosticV1[];
}
