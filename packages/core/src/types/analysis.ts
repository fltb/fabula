// ============================================================================
// Analysis Result Type — Structure for LLM Pass 2 JSON output
// ============================================================================
//
// Analysis payload types used by Pass 2 validators.
//
// Pass 2 is an external measurement, NOT story-world knowledge:
// - `AnalysisResult.analysis` keeps the existing dynamic domain payload.
// - `AnalysisResult.observations` records, per active top-level analysis
//   field, whether the measurement was produced, abstained, or ambiguous.
// - `AnalysisResult.protocol` pins the exact measurement configuration.
// Observations never enter WorldState, DiscourseState, the epistemic
// ledger/catalog, or the reference index.

import type { ValidationKey } from './discourse.js';

// ── Block level types ─────────────────────────────────────────────────────────

export type MatchLevel = 'exact' | 'similar' | 'absent' | 'contradicted';

export interface NarrativeCheck {
  entityId: string;
  attribute: string;
  hint: string;
  evidence: string;
  matchLevel: MatchLevel;
}

export interface AppearanceCheck {
  entityId: string;
  feature: string;
  declared: string;
  evidence: string;
  matchLevel: MatchLevel;
}

export interface CharacterReference {
  entityId: string;
  namesUsed: string[];
}

export type TenseDetected = 'past' | 'present' | 'mixed';

export interface ConflictAnalysis {
  primaryType: string;
  resolutionAchieved: boolean;
}

// ── Existing block types ──────────────────────────────────────────────────────

interface ViolatedPrecondition {
  entityId: string;
  attribute: string;
  expectedValue: string;
  issue: string;
}

export interface PreconditionAnalysis {
  violated: ViolatedPrecondition[];
}

export interface POVAnalysis {
  consistent: boolean;
  leaks: string[];
}

export interface InventedDetail {
  detail: string;
  severity: 'minor' | 'major';
}

export interface QualityAnalysis {
  proseScore: number;
  maxScore: number;
  strengths: string[];
  weaknesses: string[];
  estimatedWordCount: number;
}

/**
 * Per-field block types are still available as z.infer<typeof validatorSchema>.
 * The `analysis` field is intentionally `Record<string, unknown>` because
 * plugin validators can add fields at runtime beyond the built-in set.
 */

// ── Pass 2 measurement observation ────────────────────────────────────────────

/**
 * One plausible interpretation of the prose for an ambiguous field.
 * `evidence` holds exact verbatim quotes from the rendered prose.
 */
export interface AnalysisAlternative {
  summary: string;
  /** Exact prose quotes — non-empty tuple, every entry a verbatim substring. */
  evidence: [string, ...string[]];
}

/**
 * Per-field measurement record for Pass 2. The map key in
 * `AnalysisResult.observations` is the active top-level analysis field.
 *
 * - `produced`: the field's measurement payload exists in `analysis[field]`
 *   and passed the block schema. It records that the measurement ran, not
 *   that every contained judgment is true.
 * - `abstained`: the field could not be measured; no canonical payload.
 * - `ambiguous`: a single evaluation found at least two textually-supported
 *   reasonable interpretations; no canonical payload. Not a multi-evaluator
 *   consensus and never called `contested`.
 */
export type AnalysisObservation =
  | {
      disposition: 'produced';
      evidence: [string, ...string[]];
    }
  | {
      disposition: 'abstained';
      reason: string;
      evidence: string[];
    }
  | {
      disposition: 'ambiguous';
      alternatives: [AnalysisAlternative, AnalysisAlternative, ...AnalysisAlternative[]];
      evidence: string[];
    };

/** Literal union of the three observation dispositions. */
export type AnalysisDisposition = AnalysisObservation['disposition'];

/**
 * Pass 2 structured analysis — the external measurement record for a scene.
 *
 * `observations` pairs each active top-level analysis field with exactly one
 * disposition: `produced` requires the canonical payload in `analysis[field]`;
 * `abstained`/`ambiguous` require that payload to be absent. `protocol` pins
 * the exact measurement configuration (prose, schema, model, prompts,
 * sampling, validator/reference policy).
 */
export interface AnalysisResult {
  eventId: string;
  /** Exact measurement protocol the analysis was produced under. */
  protocol: ValidationKey;
  /** Per active field measurement disposition, keyed by analysis field. */
  observations: Record<string, AnalysisObservation>;
  /** Existing dynamic domain payload — original block shapes unchanged. */
  analysis: Record<string, unknown>;
}
