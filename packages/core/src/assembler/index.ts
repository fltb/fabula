// ============================================================================
// Novalistically — Assembler Module
// Pure semantic assembly over an immutable AssemblySource snapshot. Host code
// materializes scenes and chapter metadata; Core only produces strings.
// ============================================================================

export { filterScenesByBranchPath } from './branch-filter.js';
export { ProseConcatenator } from './concatenator.js';
export { countNarrativeText, NARRATIVE_TEXT_COUNT_VERSION } from './count.js';
export { assembleNovel } from './novel.js';
export type {
  AssembleOptions,
  AssembleResult,
  SceneEntry,
  SortedScene,
} from './types.js';
export {
  AssemblyError,
  AssemblyErrorCode,
} from './types.js';
