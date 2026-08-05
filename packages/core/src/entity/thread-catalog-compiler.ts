// ============================================================================
// Novalistically — Thread Catalog Compiler
// ============================================================================
//
// Validates the versionless thread-types.yaml catalog together with the
// canonical state_initial.threads declaration list. Runtime materialization is
// deliberately owned by the project compiler; this module only enforces source
// identity and cross-reference invariants.
// ============================================================================

import { ConfigError } from '../errors.js';
import type {
  ThreadDeclaration,
  ThreadDeclarationCatalog,
  ThreadTypeCatalog,
  ThreadTypeDefinition,
} from '../types/thread.js';

export interface CompiledThreadCatalog {
  readonly typeCatalog: ThreadTypeCatalog;
  readonly declarations: ThreadDeclarationCatalog;
}

function duplicateId(kind: string, id: string, path: string): never {
  throw new ConfigError(`Duplicate ${kind} id "${id}"`, { path });
}

function checkUnique(values: readonly string[], kind: string, path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicateId(kind, value, path);
    seen.add(value);
  }
}

function checkStableMetadata(typeId: string, definition: ThreadTypeDefinition): void {
  checkUnique(definition.allowedPhases, 'phase', `types.${typeId}.allowedPhases`);
  checkUnique(
    definition.stableGoals.map((goal) => goal.goalId),
    'goal',
    `types.${typeId}.stableGoals`,
  );
  checkUnique(
    definition.stableMilestones.map((milestone) => milestone.milestoneId),
    'milestone',
    `types.${typeId}.stableMilestones`,
  );
}

function checkInitialStates(
  declaration: ThreadDeclaration,
  definition: ThreadTypeDefinition,
): void {
  const goalIds = new Set(definition.stableGoals.map((goal) => goal.goalId));
  const milestoneIds = new Set(
    definition.stableMilestones.map((milestone) => milestone.milestoneId),
  );

  const initialGoals = declaration.initialGoalStates ?? [];
  checkUnique(
    initialGoals.map((goal) => goal.goalId),
    'initial goal',
    `threads.${declaration.threadId}.initialGoalStates`,
  );
  for (const goal of initialGoals) {
    if (!goalIds.has(goal.goalId)) {
      throw new ConfigError(
        `Thread "${declaration.threadId}" references unknown goal "${goal.goalId}" for type "${definition.typeId}"`,
        { path: `threads.${declaration.threadId}.initialGoalStates.${goal.goalId}` },
      );
    }
  }

  const initialMilestones = declaration.initialMilestoneStates ?? [];
  checkUnique(
    initialMilestones.map((milestone) => milestone.milestoneId),
    'initial milestone',
    `threads.${declaration.threadId}.initialMilestoneStates`,
  );
  for (const milestone of initialMilestones) {
    if (!milestoneIds.has(milestone.milestoneId)) {
      throw new ConfigError(
        `Thread "${declaration.threadId}" references unknown milestone "${milestone.milestoneId}" for type "${definition.typeId}"`,
        {
          path: `threads.${declaration.threadId}.initialMilestoneStates.${milestone.milestoneId}`,
        },
      );
    }
  }
}

/**
 * Validate the canonical thread type catalog and declaration list.
 *
 * The function intentionally does not invent a phase, goal, milestone, or
 * declaration. Every authored reference must resolve to a catalog entry.
 */
export function compileThreadCatalog(
  typeCatalog: ThreadTypeCatalog,
  declarations: readonly ThreadDeclaration[],
): CompiledThreadCatalog {
  const types = typeCatalog.types;
  for (const [typeId, definition] of Object.entries(types)) {
    if (definition.typeId !== typeId) {
      throw new ConfigError(
        `Thread type key "${typeId}" does not match declared typeId "${definition.typeId}"`,
        { path: `types.${typeId}.typeId` },
      );
    }
    checkStableMetadata(typeId, definition);
  }

  const seenDeclarations = new Set<string>();
  for (const declaration of declarations) {
    if (seenDeclarations.has(declaration.threadId)) {
      duplicateId('thread declaration', declaration.threadId, `threads.${declaration.threadId}`);
    }
    seenDeclarations.add(declaration.threadId);

    const definition = types[declaration.typeId];
    if (!definition) {
      throw new ConfigError(
        `Thread "${declaration.threadId}" references unknown thread type "${declaration.typeId}"`,
        { path: `threads.${declaration.threadId}.typeId` },
      );
    }

    if (
      declaration.initialPhase !== undefined &&
      !definition.allowedPhases.includes(declaration.initialPhase)
    ) {
      throw new ConfigError(
        `Thread "${declaration.threadId}" references unknown initial phase "${declaration.initialPhase}" for type "${definition.typeId}"`,
        { path: `threads.${declaration.threadId}.initialPhase` },
      );
    }
    checkInitialStates(declaration, definition);
  }

  return { typeCatalog, declarations };
}
