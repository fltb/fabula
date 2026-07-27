// ============================================================================
// Novalistically — Plugin System Types (§7.4.5)
// ============================================================================

// ——— Plugin Manifest ———

export interface PluginManifest {
  name: string;
  version: string;
  priority: number;
  provides: string[];
  requires: string[];
  conflicts: string[];
  authority: {
    dimensions: string[];
    exclusive: boolean;
  };
  observes: {
    eventTypes: string[];
    stateDomains: string[];
  };
}

// ——— Arbitration Strategy ———

export type ArbitrationStrategy = 'priority' | 'human_arbitration' | 'first_writer_wins' | 'merge';
