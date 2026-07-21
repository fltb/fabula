// ============================================================================
// Novalistically — Assembler Module
// Collects committed scene prose, sorts by narrativeOrder, and concatenates
// into a readable novel.md file. This is the module that produces the final
// book output.
// ============================================================================

export type {
  SceneEntry,
  SortedScene,
  AssembleOptions,
  AssembleResult,
} from './types.js';
export {
  AssemblyError,
  AssemblyErrorCode,
} from './types.js';
export { countNarrativeText, countWords, NARRATIVE_TEXT_COUNT_VERSION } from './count.js';
export { SceneCollector } from './collector.js';
export { NarrativeSorter } from './sorter.js';
export { ProseConcatenator } from './concatenator.js';
export { loadChapterMetadata } from './chapter.js';
export { filterScenesByBranchPath } from './branch-filter.js';
export { assembleNovel } from './novel.js';
