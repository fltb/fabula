// ============================================================================
// Novalistically — DURATION-1: Genette Duration Types (S6a)
//
// Binding constraints from docs/todos/base-narratology-2026-07-26.md §S6a:
//   1. DurationType has exactly 5 enum values
//   2. DurationProfile captures story time / narrative time relationship
//   3. DurationProfile.type === 'ellipsis' is Genette discourse-level
//      (text exists, tells you time passed), NOT corpus NarrativeEllipsis
//      (non-rendering gap)
//   4. MUST NOT conflate with NarrativeEllipsis
// ============================================================================

/**
 * Genette's five narrative duration types.
 *
 * - `scene`: story time ≈ narrative time (dialogue, moment-by-moment)
 * - `summary`: story time > narrative time (compressed)
 * - `ellipsis`: story time passes, narrative time = 0 (text exists,
 *   but indicates time passed — Genette ellipsis)
 * - `pause`: story time = 0, narrative time > 0 (description,
 *   reflection)
 * - `stretch`: narrative time > story time (slow-motion, detailed
 *   analysis)
 */
export type DurationType = 'scene' | 'summary' | 'ellipsis' | 'pause' | 'stretch';

/**
 * Genette duration profile for a narrative segment.
 *
 * Describes the relationship between story time (duration of events)
 * and narrative time (text length/duration of telling).
 */
export interface DurationProfile {
  /** The duration type. */
  type: DurationType;
  /**
   * Story time span — human-readable description of the time covered
   * by the narrated events (e.g., "2 hours", "3 days", "10 years").
   */
  storyDuration?: string;
  /**
   * Narrative time length — word count or byte count of the text
   * devoted to this segment.
   */
  narrativeLength?: number;
  /**
   * Clarity of ellipsis indication. Only meaningful when
   * `type === 'ellipsis'`.
   *
   * - `explicit`: narrator explicitly states time passed
   *     ("Three years later...")
   * - `implicit`: time passage is implied by context or chapter break
   * - `hypothetical`: narrator speculates about untold events
   */
  ellipsisClarity?: 'explicit' | 'implicit' | 'hypothetical';
  /**
   * Compression ratio — story time / narrative time.
   * Meaningful for `summary` type. Higher values = more compression.
   */
  compressionRatio?: number;
}
