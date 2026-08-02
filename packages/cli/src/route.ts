import type { BranchPath } from '@novalistically/core';

export function resolveRoute(options: {
  readonly branchPath?: BranchPath;
  readonly discourseBranch?: string;
}): { branchPath?: BranchPath; discourseBranch?: string } {
  return {
    ...(options.branchPath ? { branchPath: options.branchPath } : {}),
    ...(options.discourseBranch ? { discourseBranch: options.discourseBranch } : {}),
  };
}
