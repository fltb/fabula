// ============================================================================
// Novalistically — Event-local game dialogue choices
// ============================================================================

/** A state mutation applied only after a player selects its owning choice. */
export interface GameDialogueEffect {
  entity: string;
  attribute: string;
  value?: unknown;
  narrativeHint?: string;
  confidence?: number;
  operation?: 'set' | 'unset';
}

/** An authored player choice leading from one event directly to its target event. */
export interface GameDialogueChoice {
  id: string;
  label: string;
  description: string;
  targetEvent: string;
  effects: GameDialogueEffect[];
}
