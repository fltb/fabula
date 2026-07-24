// ============================================================================
// Novalistically — Modern Novel Structural Fields (S3)
// ============================================================================
// 9 field types across two classes:
//   A-class (4): Structural metadata with deterministic validators
//   B-class (5): Semantic effects evaluated via Pass 2 checklist channel
// ============================================================================

// ── A-class: Structural metadata ─────────────────────────────────────────

/**
 * Anti-causal edge detection: event postconditions not referenced by any
 * later preconditions. When the ratio exceeds threshold across the project,
 * the story exhibits a structural anti-causal pattern (modern novel signal).
 * Default threshold: 0.5 (50%).
 */
export interface AntiCausalEdgeConfig {
  enabled: boolean;
  threshold: number;
}

/**
 * Chapter order contested: metadata flag + multiple rendering variants.
 * Assembler picks per render config. Validator requires >= 2 variants
 * when orderContested is true.
 */
export interface ChapterOrderContested {
  orderContested: boolean;
  renderingVariants?: string[];
}

/**
 * Surface mode: scene marked for surface-only description (Robbe-Grillet).
 * Validator warns if narrativeChecks reveal internal POV or psychological
 * activity markers in a surface-mode scene.
 */
export interface SurfaceModeConfig {
  enabled: boolean;
}

/**
 * Causal overload: thread branching factor exceeds threshold.
 * Default threshold: 5 (Pynchon-style event with too many consequences).
 */
export interface CausalOverloadConfig {
  enabled: boolean;
  branchingThreshold: number;
}

// ── B-class: Semantic effects (Pass 2 checklist passthrough) ──────────────

/**
 * Irresolvable indeterminacy: Fact value structurally undecidable.
 * Derrida différance — deferral is terminal, not temporary.
 * Authors add matching narrativeChecklist items; Pass 2 evaluates them.
 */
export interface IrresolvableIndeterminacy {
  enabled: boolean;
  description?: string;
}

/**
 * Absent apparatus: entity produces structural effect through absence.
 * Deleuze & Guattari — the absence IS a production apparatus, not a deficit.
 */
export interface AbsentApparatus {
  enabled: boolean;
  entityId?: string;
  description?: string;
}

/**
 * Voice dissonance: narrator tone conflicts with content narrated.
 * Kafka mode — narrowed to cases where the structural contradiction
 * between narrator voice and narrated events is the primary effect.
 */
export interface VoiceDissonance {
  enabled: boolean;
  description?: string;
}

/**
 * Multiplicity: multiple valid values simultaneously legitimate;
 * system does not require choosing one (Borges, Barthes S/Z).
 */
export interface Multiplicity {
  enabled: boolean;
  description?: string;
}

/**
 * Metanarrative level: narrative takes its own construction as content.
 * Calvino — extends Genette narrative level but structural self-reference
 * is a modern/postmodern-specific phenomenon.
 */
export interface MetanarrativeLevel {
  enabled: boolean;
  description?: string;
}

// ── Unified modern-novel config ──────────────────────────────────────────

import type { NarrativeChecklistItem } from './narrative-checklist.js';

/**
 * Modern-novel structural extension for an event.
 * All 9 fields; traditional novels simply omit these.
 * A-class fields drive deterministic validators.
 * B-class fields ride on the S1 ChecklistValidator — authors pair them
 * with matching narrativeChecklist items evaluated by Pass 2.
 */
export interface ModernNovelConfig {
  antiCausalEdge?: AntiCausalEdgeConfig;
  chapterOrder?: ChapterOrderContested;
  surfaceMode?: SurfaceModeConfig;
  causalOverload?: CausalOverloadConfig;
  irresolvableIndeterminacy?: IrresolvableIndeterminacy;
  absentApparatus?: AbsentApparatus;
  voiceDissonance?: VoiceDissonance;
  multiplicity?: Multiplicity;
  metanarrativeLevel?: MetanarrativeLevel;
}
