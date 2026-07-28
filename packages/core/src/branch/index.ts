// ============================================================================
// Novalistically — Branch System
// ============================================================================

export {
  branchPathsEqual,
  branchPathToString,
  createEmptyBranchPath,
  isLinearNarrative,
} from './path.ts';
export { createBranchPoint, evaluateCondition, getAvailableChoices, includesPath } from './set.ts';
export { compileGameDialogueTree } from './game-dialogue-tree.ts';
export type { CompiledGameDialogueTree } from './game-dialogue-tree.ts';
