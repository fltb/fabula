import type { EntityId } from './entity.js';

// ============================================================================
// Novalistically — DISCOURSE-1: Discourse State, Model Reader, Narrator &
// spoiler-safe context types.
//
// Binding constraints from docs/todos/graph-discourse-render.md DISCOURSE-1:
//   1. DiscourseState NOT part of WorldState
//   2. ModelReaderProfile only immutable default_model_reader_v1
//   3. Canonical = PlannedDiscourseLedger only; Pass 2 NEVER writes
//   4. 7 disclosure actions
//   5. reveal truth-boundary hard rule
//   6. claim exposes assertion without truth commitment
//   7. 6 hint contract states
//   8. retraction no fake forget
//   9. correction NEVER retcons WorldState
//  10. 4 narrator profile types with independent capabilities
//  11. NarratorAssertion with truthBoundary/narrationBoundary/evidence
//  12. Pass 1 DiscourseContextProjection capability-separated
//  13. flashback/flashforward rules
//  14. branch-independent; shared post-merge only if identical projection
//  15. NarrativeEllipsis no discourse position, no disclosure
//  16. sparse corpus modes
//  17. Pass 2 observation non-mutation
//  18. ValidationKey independence
//  19. REJECTED hard fails
// ============================================================================

// ─── Discourse Position ──────────────────────────────────────────────────────
/** Built-in cardinal type for discourse ordering. */
export type DiscoursePosition = number;

// ─── ModelReaderProfile (§2) ─────────────────────────────────────────────────

/** Only immutable versioned built-in reader profile. */
export type ModelReaderProfileId = 'default_model_reader_v1';

export interface AudienceSemantics {
  /** How the reader audience interprets narrative presentation. */
  narrativeInterpretation: 'default';
  /** How the reader audience interprets disclosure acts. */
  disclosureInterpretation: 'default';
}

export interface NarrationDisclosurePolicy {
  /** Whether the narrator may disclose character-private thoughts. */
  allowPrivateThoughtDisclosure: boolean;
  /** Whether the narrator may directly address the reader. */
  allowDirectAddress: boolean;
}

/**
 * Initial exposure contract — empty/defined by compiler (never inferred
 * from prose, reader telemetry, or runtime).
 */
export interface InitialExposureContract {
  /** Initial planned reveals (empty for default profile). */
  initialReveals: string[];
  /** Initial planned claims (empty for default profile). */
  initialClaims: string[];
  /** Initial withholding policies (empty for default profile). */
  initialWithholds: string[];
}

/**
 * ModelReaderProfile v1 — the sole built-in, immutable reader profile.
 * Profile NEVER inferred from prose/reader telemetry/runtime.
 * CANNOT rewrite StoryState.
 */
export interface ModelReaderProfile {
  id: ModelReaderProfileId;
  /** Content hash of the full profile definition. */
  hash: string;
  audienceSemantics: AudienceSemantics;
  narrationDisclosurePolicy: NarrationDisclosurePolicy;
  initialExposureContract: InitialExposureContract;
}

// ─── NarratorProfile (§10) ──────────────────────────────────────────────────

export type NarratorProfileType =
  | 'focalizer_bound'
  | 'retrospective_entity'
  | 'explicit_ledger'
  | 'omniscient';

/**
 * Independent narrator capabilities (constraint #10). Omniscience grants
 * truth read access ONLY, NEVER auto-reveal. Retrospective narrator uses
 * explicit later Knowledge boundary.
 */
export type NarratorAccess = 'full' | 'focalizer_only' | 'limited';
export type NarratorAssertionCapability = 'full' | 'constrained' | 'minimal';
export type NarratorTruthCapability = 'full_knowledge' | 'limited_knowledge' | 'opaque';
export type NarratorFidelity = 'reliable' | 'unreliable' | 'ambiguous';
export type NarratorSincerity = 'sincere' | 'deceptive' | 'ambiguous';

/** Base fields for all narrator profile types. */
export interface NarratorProfileBase {
  type: NarratorProfileType;
  /** Identifier/hash of this profile. */
  id: string;
  /** INDEPENDENT capabilities (constraint #10). */
  access: NarratorAccess;
  assertion: NarratorAssertionCapability;
  truth: NarratorTruthCapability;
  fidelity: NarratorFidelity;
  sincerity: NarratorSincerity;
  /**
   * Narrative voice (level and relation) for this narrator profile.
   * Orthogonal to narrator capabilities — an omniscient narrator can be
   * extradiegetic (traditional omniscient) or intradiegetic (Scheherazade).
   */
  voice?: VoiceProfile;
}

/** Focalizer-bound narrator — limited to focalizer's POV. */
export interface FocalizerBoundProfile extends NarratorProfileBase {
  type: 'focalizer_bound';
}

/**
 * Retrospective entity narrator — uses explicit later Knowledge boundary
 * (constraint #10).
 */
export interface RetrospectiveEntityProfile extends NarratorProfileBase {
  type: 'retrospective_entity';
  /** Explicit later Knowledge boundary reference. */
  knowledgeBoundary: string;
}

/** Explicit ledger narrator — assertion-based disclosure. */
export interface ExplicitLedgerProfile extends NarratorProfileBase {
  type: 'explicit_ledger';
}

/**
 * Omniscient narrator — truth read access ONLY, NEVER auto-reveal
 * (constraint #10).
 */
export interface OmniscientProfile extends NarratorProfileBase {
  type: 'omniscient';
  /** Omniscience grants truth read access ONLY. */
  autoReveal: false;
}

/** Union of all narrator profile types. */
export type NarratorProfile =
  | FocalizerBoundProfile
  | RetrospectiveEntityProfile
  | ExplicitLedgerProfile
  | OmniscientProfile;

// ─── Voice: NarrativeLevel & DiegeticRelation (S6d) ─────────────────────────

/**
 * Narrative level — Genette's diegetic levels.
 *
 * - `extradiegetic`: outside the story world (first-level narrator)
 * - `intradiegetic`: inside the story world (character-narrator)
 * - `metadiegetic`: a story within the story (second-level narrative)
 * - `hypodiegetic`: a story within a story within the story (third-level)
 */
export type NarrativeLevel =
  | 'extradiegetic'
  | 'intradiegetic'
  | 'metadiegetic'
  | 'hypodiegetic';

/**
 * Diegetic relation — narrator's relationship to the story.
 *
 * - `heterodiegetic`: narrator is absent from the story (tells others' story)
 * - `homodiegetic`: narrator is present in the story (tells own story)
 */
export type DiegeticRelation = 'heterodiegetic' | 'homodiegetic';

/**
 * VoiceProfile — Genette narrative voice (who speaks, at what level).
 *
 * Combines narrative level and diegetic relation with optional
 * embedding context for embedded stories.
 */
export interface VoiceProfile {
  /** Narrative level of the narrator. */
  level: NarrativeLevel;
  /** Narrator's relationship to the story. */
  relation: DiegeticRelation;
  /** Nesting depth (0 = extradiegetic primary, 1 = intradiegetic, etc.). */
  nestingDepth?: number;
  /** Context for embedded stories (metadiegetic/hypodiegetic). */
  embeddedStory?: {
    /** Character who narrates the embedded story. */
    narratingCharacter: EntityId;
    /** Character who is the audience for the embedded story. */
    audienceCharacter?: EntityId;
  };
}

// ─── NarratorAssertion (§11) ────────────────────────────────────────────────

export type AssertionType =
  | 'authoritative_reveal'
  | 'claim'
  | 'conjecture'
  | 'quotation'
  | 'implication';

export type AssertionPolarity = 'affirmative' | 'negative';

/**
 * Truth boundary: true = authoritative truth the narrator knows;
 * false/indeterminate = claim/conjecture only (constraint #5).
 * Determines whether a disclosure action may be a reveal (truthBoundary=true)
 * or only a claim/conjecture (truthBoundary=false/indeterminate).
 */
export type TruthBoundary = boolean;

export interface NarrationBoundary {
  /** Narrator at the time of assertion. */
  narratorId: string;
  /** Optional focalizer. */
  focalizerId?: string;
  /** Narration time boundary reference. */
  narrationTime?: string;
}

export interface AssertionEvidence {
  /** Type of evidence supporting the assertion. */
  type: 'direct_observation' | 'testimony' | 'inference' | 'documented' | 'knowledge_boundary';
  /** Reference to the evidence source. */
  source: string;
  /** Confidence level. */
  confidence?: 'certain' | 'probable' | 'speculative';
}

/**
 * NarratorAssertion (§11): narrator/proposition/polarity,
 * authoritative_reveal|claim|conjecture|quotation|implication,
 * truthBoundary, narrationBoundary/evidence.
 */
export interface NarratorAssertion {
  /** Unique assertion ID. */
  id: string;
  /** Narrator profile or character ID. */
  narrator: string;
  /** Proposition ID or reference. */
  proposition: string;
  /** Polarity of the assertion. */
  polarity: AssertionPolarity;
  /** Assertion type. */
  type: AssertionType;
  /**
   * Truth boundary: true → authoritative truth (reveal-capable).
   * false/indeterminate → claim/conjecture ONLY (hard rule, §5).
   */
  truthBoundary: TruthBoundary;
  /** Narration boundary: narrator/focalizer. */
  narrationBoundary: NarrationBoundary;
  /** Optional evidence. */
  evidence?: AssertionEvidence;
}

// ─── Disclosure Actions (§4) ────────────────────────────────────────────────

export type DisclosureActionType =
  | 'reveal'
  | 'claim'
  | 'hint'
  | 'retraction'
  | 'correction'
  | 'withhold_start'
  | 'withhold_end';

/** Reveal — exposes assertion with truthBoundary=true (§5). */
export interface RevealAction {
  type: 'reveal';
  assertionId: string;
  discoursePosition: DiscoursePosition;
}

/** Claim — exposes assertion without truth commitment (§6). */
export interface ClaimAction {
  type: 'claim';
  assertionId: string;
  discoursePosition: DiscoursePosition;
}

/**
 * Hint — exposes surface proposition + author-only target proposition
 * linkage. Target NEVER enters model-reader/Pass1 projection (§7).
 * Can link to discourse Thread.
 */
export interface HintAction {
  type: 'hint';
  hintId: string;
  /** Surface proposition visible to the reader. */
  surfaceProposition: string;
  /** Target proposition (author-only, NEVER in Pass 1 projection). */
  targetProposition: string;
  /** Optional thread reference (suspense/foreshadowing progress). */
  threadId?: string;
  discoursePosition: DiscoursePosition;
}

/** Retraction — does NOT make planned reader contract fake forget (§8). */
export interface RetractionAction {
  type: 'retraction';
  assertionId: string;
  discoursePosition: DiscoursePosition;
}

/**
 * Correction — ONLY supersedes prior discourse assertion contract.
 * NEVER retcons WorldState (§9).
 */
export interface CorrectionAction {
  type: 'correction';
  priorAssertionId: string;
  newAssertionId: string;
  discoursePosition: DiscoursePosition;
}

/** Withhold start — begins a withholding policy. */
export interface WithholdStartAction {
  type: 'withhold_start';
  policyId: string;
  /** Reason for withholding. */
  reason?: string;
  discoursePosition: DiscoursePosition;
}

/** Withhold end — ends a withholding policy. */
export interface WithholdEndAction {
  type: 'withhold_end';
  policyId: string;
  discoursePosition: DiscoursePosition;
}

/** Union of all 7 disclosure action types (§4). */
export type DisclosureAction =
  | RevealAction
  | ClaimAction
  | HintAction
  | RetractionAction
  | CorrectionAction
  | WithholdStartAction
  | WithholdEndAction;

// ─── Hint Lifecycle (§7) ────────────────────────────────────────────────────

/**
 * Hint contract states — all 6 are contract status, NOT prose observation
 * (§7, constraint #7).
 */
export type HintState =
  | 'planned'
  | 'contract_planted'
  | 'contract_reinforced'
  | 'contract_fulfilled'
  | 'contract_subverted'
  | 'retracted';

export interface Hint {
  hintId: string;
  /** Current contract state. */
  state: HintState;
  /** Surface proposition the reader sees. */
  surfaceProposition: string;
  /** Author-only target proposition (NEVER in Pass 1 projection). */
  targetProposition: string;
  /** Optional thread reference for suspense/foreshadowing progress. */
  threadId?: string;
  /** Discourse position when hint was introduced. */
  discoursePosition: DiscoursePosition;
}

// ─── Withholding Policy ──────────────────────────────────────────────────────

export interface WithholdingPolicy {
  policyId: string;
  reason?: string;
  /** Discourse position when withholding started. */
  startPosition: DiscoursePosition;
  /** Discourse position when withholding ended (null if active). */
  endPosition: DiscoursePosition | null;
  /** Whether the withholding is currently active. */
  active: boolean;
}

// ─── PlannedDiscourseLedger (§3) — Canonical truth ──────────────────────────

/**
 * The canonical planned disclosure ledger. YAML/corpus source-verified
 * contract is the ONLY reader/narrator/disclosure truth (§3). All scene
 * contracts determined before any prose generation.
 */
export interface PlannedDiscourseLedger {
  id: string;
  /** Ordered entries by discourse position. */
  entries: PlannedLedgerEntry[];
  /** Hash of the full ledger for cache/validation. */
  hash: string;
}

export interface PlannedLedgerEntry {
  /** Entry ID. */
  id: string;
  /** The planned action. */
  action: DisclosureAction;
  /** Associated scene ID. */
  sceneId: string;
  /** Branch this entry belongs to. */
  branch: string;
  /** Discourse position (index into the ledger). */
  discoursePosition: DiscoursePosition;
}

// ─── DiscourseState (§1) — NOT part of WorldState ──────────────────────────

/**
 * The replayed discourse state at a given position. Independent from
 * WorldState — CANNOT satisfy story precondition, provide WorldState
 * provider, or cross story/discourse clock edges (§1).
 */
export interface DiscourseState {
  /** Current discourse position. */
  position: DiscoursePosition;
  /** All reveals up to this position. */
  reveals: string[];
  /** All open (unretracted/unsubstituted) claims up to this position. */
  openClaims: string[];
  /** Retraction records. */
  retractions: Array<{ assertionId: string; discoursePosition: DiscoursePosition }>;
  /** Correction records (prior → new). */
  corrections: Array<{
    priorAssertionId: string;
    newAssertionId: string;
    discoursePosition: DiscoursePosition;
  }>;
  /** Active hints at this position. */
  hints: Hint[];
  /** Active withholding policies at this position. */
  activeWithholds: WithholdingPolicy[];
  /** Narrator profiles. */
  narratorProfiles: Record<string, NarratorProfile>;
  /** Assertion catalog. */
  assertions: Record<string, NarratorAssertion>;
  /** Discourse-specific provider index (NOT WorldState). */
  providerIndex: Record<string, string>;
  /** Current branch. */
  branch: string;
  /** Ledger hash this state was derived from. */
  ledgerHash: string;
}

// ─── DiscourseContextProjection (§12) — Pass 1 only ─────────────────────────

/**
 * Pass 1 DiscourseContextProjection — capability-separated.
 *
 * ONLY (§12):
 * - previous planned reader reveals
 * - open claims
 * - visible hint surfaces
 * - focalizer/narrator accessible claims
 * - current-scene explicitly authorized reveal/claim targets
 * - active withholding policies
 *
 * FORBIDDEN:
 * - future/unrelated truth
 * - hint target
 * - raw generated previous-scene summary
 * - catalog metadata
 * - unauthorized WorldState truth
 */
export interface DiscourseContextProjection {
  /** Previous planned reader reveals (assertion IDs). */
  plannedReveals: string[];
  /** Open claims (assertion IDs). */
  openClaims: string[];
  /** Visible hint surfaces — surface proposition only, NEVER target. */
  visibleHints: Array<{
    hintId: string;
    surfaceProposition: string;
    state: HintState;
  }>;
  /** Assertions accessible by focalizer/narrator. */
  accessibleClaims: Array<{
    assertionId: string;
    narrator: string;
    type: AssertionType;
    surface: string;
  }>;
  /** Current-scene explicitly authorized targets. */
  authorizedTargets: Array<{
    assertionId: string;
    actionType: 'reveal' | 'claim';
    discoursePosition: DiscoursePosition;
  }>;
  /** Active withholding policies. */
  activeWithholdingPolicies: WithholdingPolicy[];
}

// ─── Pass 2 Observation (§17) ───────────────────────────────────────────────

/**
 * Structured disclosure observation from Pass 2 prose review.
 * NEVER writes/revises canonical discourse ledger, never becomes
 * downstream logical provider, never changes scene precondition/reveal
 * contract (§3, §17).
 */
export interface DisclosureObservation {
  plannedEffectId: string;
  observationType: 'reveal' | 'claim' | 'hint' | 'retraction' | 'correction' | 'unplanned_exposure';
  proposition: string;
  polarity: AssertionPolarity;
  assertion: string;
  evidence?: string;
  matchLevel: 'exact_match' | 'partial_match' | 'mismatch' | 'unobserved';
  authorityPresentation?: string;
  suspectedWithholding?: string;
  suspectedLeak?: string;
}

// ─── Sparse Corpus Modes (§16) ──────────────────────────────────────────────

export type SparseCorpusMode = 'isolated_excerpt' | 'full_work_context';

export interface ExcerptDisclosureCheckpoint {
  type: 'isolated_excerpt';
  bridgeIds: string[];
}

export interface FullWorkContext {
  type: 'full_work_context';
  precedingBridgeCompleteness: boolean;
}

export type SparseRunDeclaration = ExcerptDisclosureCheckpoint | FullWorkContext;

// ─── Cache Types (§18) ──────────────────────────────────────────────────────

/**
 * Discourse cache key — independent from logical/discourse cache (§18).
 */
export interface DiscourseCacheKey {
  runKey: string;
  cursor: string;
  plannedStateHash: string;
  assertionHintHash: string;
  policyHash: string;
  providerIndexHash: string;
  branch: string;
  narratorProfileHash: string;
  propositionCatalogHash: string;
  selectionHash: string;
  provenanceHash: string;
}

/**
 * ValidationKey — independent from logical/discourse cache (§18).
 */
export interface ValidationKey {
  proseHash: string;
  analysisSchema: string;
  model: string;
  validatorPolicy: string;
  referencePolicy: string;
}

// ─── Order: Anachrony types (S6e) ───────────────────────────────────────────

/**
 * Anachrony type — Genette's temporal order deviations.
 *
 * - `analepsis`: flashback (movement backward in time)
 * - `prolepsis`: flashforward (movement forward in time)
 */
export type AnachronyType = 'analepsis' | 'prolepsis';

/**
 * Anachrony scope — the reach of the temporal deviation relative to the
 * primary narrative's temporal frame.
 *
 * - `internal`: within the primary narrative's time span
 * - `external`: outside the primary narrative's time span
 * - `mixed`: both internal and external elements
 */
export type AnachronyScope = 'internal' | 'external' | 'mixed';

/**
 * Anachrony function — the narrative purpose of the temporal deviation.
 *
 * - `completing`: fills in a gap in the primary narrative
 * - `repeating`: recounts an event already narrated (re-narration)
 */
export type AnachronyFunction = 'completing' | 'repeating';

/**
 * Anachrony — Genette's refined classification for temporal deviations.
 *
 * Refines but does NOT replace `sceneType` (backward compat).
 * A `flashback` scene with an `anachrony.type = 'analepsis'` provides
 * richer Genette classification.
 */
export interface Anachrony {
  /** Analepsis (flashback) or prolepsis (flashforward). */
  type: AnachronyType;
  /** Scope relative to primary narrative's temporal frame. */
  scope: AnachronyScope;
  /** Narrative purpose of the deviation. */
  function: AnachronyFunction;
  /**
   * Temporal distance from the primary narrative's present,
   * e.g. "2 years earlier", "3 months later".
   */
  distance: string;
  /**
   * Time span covered by the anachrony, e.g. "6 months".
   * Meaningful for extended analepsis/prolepsis.
   */
  amplitude?: string;
  /**
   * Anchor event ID — the primary narrative event from which the
   * anachrony departs.
   */
  anchorEventId?: string;
}
