// ============================================================================
// Novalistically — FREQUENCY-1: Genette Frequency Types (S6b)
//
// Binding constraints from docs/todos/base-narratology-2026-07-26.md §S6b:
//   1. FrequencyType has exactly 3 enum values
//   2. FrequencyProfile captures narrative frequency relationships
//      between story events and narrative statements
//   3. Added to both NarrativeEvent and EventFile for consistency
// ============================================================================

/**
 * Genette's three narrative frequency types.
 *
 * - `singulative`: narrating once what happened once
 * - `repeating`: narrating multiple times what happened once
 * - `iterative`: narrating once what happened multiple times
 */
export type FrequencyType = 'singulative' | 'repeating' | 'iterative';

/**
 * Genette frequency profile for a narrative segment.
 *
 * Describes the relationship between how many times an event
 * occurred in the story and how many times it is narrated.
 */
export interface FrequencyProfile {
  /** The frequency type. */
  type: FrequencyType;
  /**
   * For `singulative` type: always 1 (one narrative for one event).
   * For `repeating` type: which occurrence this narrative covers
   * (1 = first telling, 2 = second retelling, etc.).
   * For `iterative` type: always 1 (one narrative covers N occurrences).
   */
  sourceEventCount?: number;
  /**
   * For `repeating` type: always 1 (one narrative).
   * For `iterative` type: how many actual story occurrences are
   * covered by this single narrative statement.
   */
  occurrenceCount?: number;
  /**
   * For `iterative` type: the time range over which the repeated
   * occurrences take place.
   */
  iterationScope?: {
    start: string;
    end: string;
  };
  /**
   * For `repeating` type: event IDs of related repeating narrative
   * events that describe the same story event.
   */
  otherOccurrences?: string[];
}
