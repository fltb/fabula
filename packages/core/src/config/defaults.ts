// ============================================================================
// Default Configuration — built-in values for all configurable parameters
// ============================================================================

export const DEFAULT_CONFIG = {
  /** How often (in events) to write a snapshot */
  snapshotInterval: 10,
  concurrency: 5,
  /** Minimum log level to emit */
  logLevel: 'info' as const,
  /** Trace level: 'off' | 'basic' | 'detailed' */
  traceLevel: 'off' as const,
  /** Default target word/character count for scene prose */
  defaultSceneTextTarget: 400,
  /** Whether to use render cache */
  cacheEnabled: true,
};

export type DefaultConfig = typeof DEFAULT_CONFIG;
