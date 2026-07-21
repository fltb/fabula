import { includesPath } from '../branch/index.js';
import type { BranchPath } from '../types/index.js';
import type { SortedScene } from './types.js';

/** Returns exactly the scenes whose declared branch scope contains the path. */
export function filterScenesByBranchPath(scenes: SortedScene[], branchPath?: BranchPath): SortedScene[] {
  const resolvedPath = branchPath ?? { decisions: [] };
  return scenes.filter((scene) => includesPath(scene.branchExistence, resolvedPath));
}
