// ============================================================================
// Grey Line Types — Multi-point motif tracking
// ============================================================================
// A greyLine tracks a recurring motif/image that appears across multiple events,
// accumulating different semantic meaning at each appearance. Unlike the binary
// foreshadowing model (seed → fulfillment), grey lines grow indefinitely.

export interface GreyLineNode {
  /** The event where this appearance occurs */
  eventId: string;
  /** What new meaning or nuance this appearance adds to the imagery */
  semanticAccumulation: string;
  /** Order of this appearance within the story's narrative sequence */
  narrativeOrder: number;
}

export interface GreyLine {
  /** Unique identifier for this grey line (e.g. "gl_flower", "gl_mirror") */
  id: string;
  /** The recurring motif/image (e.g. "花", "镜", "玉") */
  imagery: string;
  /** Appearances across events, growing list — closure not required */
  nodes: GreyLineNode[];
}
