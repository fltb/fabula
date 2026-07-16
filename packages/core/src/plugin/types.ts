// ============================================================================
// Plugin System — Local Types
// ============================================================================

export interface ConflictReport {
  pluginA: string;
  pluginB: string;
  reason: string;
  dimension?: string;
}

export type ResolutionResult = string | null;
