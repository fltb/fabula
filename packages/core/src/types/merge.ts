// ============================================================================
// MergeConflictReport + SceneQuality — spec §7.4.8, §7.4.12
// ============================================================================

/** Detected conflict between two branch paths at a merge point */
export interface MergeConflict {
  entityId: string;
  attribute: string;
  branchAValue: unknown;
  branchBValue: unknown;
  resolution: 'auto_resolved' | 'needs_manual' | 'deferred';
  resolutionNote?: string;
}

/** Full merge conflict report for a branch merge point */
export interface MergeConflictReport {
  mergePointEventId: string;
  branchA: string;
  branchB: string;
  conflicts: MergeConflict[];
  resolvedCount: number;
  unresolvedCount: number;
}

/** Quality score for a rendered scene */
export interface SceneQuality {
  eventId: string;
  proseScore: number; // 1-10
  consistencyScore: number; // 1-10
  completenessScore: number; // 1-10
  overallScore: number; // weighted average
  issues: string[];
}
