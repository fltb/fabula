// ============================================================================
// Novalistically — S7b: Story IR — Propp 31 functions + Greimas actant model
// ============================================================================

/**
 * Propp 31 structural functions (subset, extensible).
 * Labels the narrative function a thread or event performs within the
 * overarching morphology.
 */
export type StructuralFunction =
  | 'absentation'
  | 'interdiction'
  | 'violation'
  | 'departure'
  | 'first_function_of_donor'
  | 'hero_reaction'
  | 'acquisition'
  | 'spatial_translocation'
  | 'villainy'
  | 'mediation'
  | 'beginning_counteraction'
  | 'first_villainy'
  | 'hero_departure'
  | 'donor_test'
  | 'hero_reaction_donor'
  | 'receipt_of_agent'
  | 'guidance'
  | 'arrival'
  | 'unrecognized_arrival'
  | 'unfounded_claims'
  | 'difficult_task'
  | 'solution'
  | 'recognition'
  | 'exposure'
  | 'punishment'
  | 'wedding';

/**
 * Greimas actant model — structural roles assigned to narrative agents.
 * Each role maps to a named entity (by entity ID or character name).
 */
export interface ActantModel {
  /** Hero / protagonist — the subject of the quest */
  subject: string;
  /** Quest / goal — the object pursued */
  object: string;
  /** Dispatcher — the sender who initiates the quest */
  sender: string;
  /** Beneficiary — the receiver who benefits from the quest */
  receiver: string;
  /** Ally — the helper who assists the hero */
  helper: string;
  /** Villain / obstacle — the opponent who opposes the hero */
  opponent: string;
}

/**
 * High-level story archetype classification.
 * Maps to conventional narrative macro-structures.
 */
export type StoryArchetype =
  | 'hero_journey'
  | 'tragedy'
  | 'quest'
  | 'descent'
  | 'rebirth'
  | 'comedy';
