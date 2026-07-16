// ============================================================================
// ISS — Input Structure Score
// Evaluates the structural quality of YAML input files for the narrative engine.
// Not literary quality — whether the system can actually use the data.
// Low ISS = the system is running "empty" with nothing to validate.
// ============================================================================

export { type ISSOptions, type StrictValidationContext } from './types.js';
export { calculateISS } from './score.js';
export { detectAntiPatterns } from './anti-patterns.js';
export { validateStrict } from './strict.js';
// Re-export ISSDimension type for consumers
export type { ISSDimension } from '../types/iss.js';
