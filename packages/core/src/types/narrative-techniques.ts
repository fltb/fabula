// ============================================================================
// Novalistically — Narrative Technique Contracts
// ============================================================================
// Event-local presentation contracts resolved against canonical graph state.
// Presence of a contract is the only activation mechanism.
// ============================================================================

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
