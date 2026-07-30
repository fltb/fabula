// ============================================================================
// Novalistically — Narrative Technique Contracts
// ============================================================================
// Event-local presentation contracts resolved against canonical graph state.
// Presence of a contract is the only activation mechanism.
// ============================================================================

/** Fixed order for resolved narrative technique contracts. */
export const NARRATIVE_TECHNIQUE_KINDS = [
  'causalDiscontinuity', 'surfaceMode', 'causalMultiplicity',
  'irresolvableIndeterminacy', 'absentApparatus', 'voiceDissonance',
  'multiplicity', 'metanarrativeLevel',
] as const;

/** A narrative technique kind from the fixed set. */
export type NarrativeTechniqueKind = (typeof NARRATIVE_TECHNIQUE_KINDS)[number];

/**
 * A resolved narrative technique contract carrying only kind,
 * instruction, and requiredEvidence. Raw assertion propositions,
 * output values, or future discourse state are never leaked.
 * Pass 1 sees only these fields.
 */
export interface ResolvedNarrativeTechniqueContract {
  kind: NarrativeTechniqueKind;
  instruction: string;
  requiredEvidence: string;
}

export interface CausalDiscontinuity {
  predecessor: string;
  dependent: string;
  instruction: string;
  requiredEvidence: string;
}

export interface SurfaceMode {
  instruction: string;
  requiredEvidence: string;
}

export interface CausalMultiplicity {
  minimumOutgoingEdges: number;
  instruction: string;
  requiredEvidence: string;
}

export interface IrresolvableIndeterminacy {
  assertionIds: [string, ...string[]];
  instruction: string;
  requiredEvidence: string;
}

export interface AbsentApparatus {
  readId: string;
  instruction: string;
  requiredEvidence: string;
}

export interface VoiceDissonance {
  assertionId: string;
  storyOutputId: string;
  instruction: string;
  requiredEvidence: string;
}

export interface Multiplicity {
  assertionIds: [string, string, ...string[]];
  instruction: string;
  requiredEvidence: string;
}

export interface MetanarrativeLevel {
  instruction: string;
  requiredEvidence: string;
}
