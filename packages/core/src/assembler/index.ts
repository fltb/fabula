// ============================================================================
// Novalistically — Assembler Module
// Collects committed scene prose, sorts by narrativeOrder, and concatenates
// into a readable novel.md file. This is the module that produces the final
// book output.
// ============================================================================

export { filterScenesByBranchPath } from './branch-filter.js';
export { loadChapterMetadata } from './chapter.js';
export { SceneCollector } from './collector.js';
export { ProseConcatenator } from './concatenator.js';
export { countNarrativeText, countWords, NARRATIVE_TEXT_COUNT_VERSION } from './count.js';
export type {
  AssembleGameDialogueTreeOptions,
  AssembleGameDialogueTreeResult,
} from './game-dialogue-tree.ts';
export { assembleGameDialogueTree } from './game-dialogue-tree.ts';
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
