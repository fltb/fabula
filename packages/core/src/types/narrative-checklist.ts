// ============================================================================
// Narrative Checklist Types — Self-checking outline system
// ============================================================================
// Each event can declare which narrative dimensions must be covered
// (poetry, dialogue personality, ironic distance, foreshadowing threads, etc.).
// Pass 2 analysis produces per-dimension coverage results; the ChecklistValidator
// checks that all required items are covered.
// ============================================================================

/**
 * A single narrative checklist item declaring a dimension to cover.
 */
export interface NarrativeChecklistItem {
  /** Dimension identifier, e.g. "诗词", "对话个性", "反讽距离", "草蛇灰线" */
  dimension: string;
  /** Human-readable description of what to cover in this scene */
  description: string;
  /** true = mandatory coverage required; false = recommended but optional */
  required: boolean;
}

/**
 * A narrative checklist attached to an event, declaring which narrative
 * dimensions the prose should cover.
 */
export interface NarrativeChecklist {
  items: NarrativeChecklistItem[];
}
