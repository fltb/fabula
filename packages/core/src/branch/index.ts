// ============================================================================
// Novalistically — Branch System
// ============================================================================

export type { CompiledGameDialogueTree } from './game-dialogue-tree.ts';
export { compileGameDialogueTree } from './game-dialogue-tree.ts';
export {
  branchPathsEqual,
  branchPathToString,
  createEmptyBranchPath,
  isLinearNarrative,
} from './path.ts';
export { createBranchPoint, evaluateCondition, getAvailableChoices, includesPath } from './set.ts';
