// ============================================================================
// ContextCompiler — Main entry point
// ============================================================================

import type {
  ContextPackage,
  EntityRegistry,
  NarrativeEvent,
  SystemContext,
  WorldState,
} from '../types/index.js';

import { ContextAssembler } from './assembler.ts';

export class ContextCompiler {
  private assembler: ContextAssembler;

  constructor() {
    this.assembler = new ContextAssembler();
  }

  /**
   * Compile a context package for a given event.
   */
  compile(
    event: NarrativeEvent,
    state: WorldState,
    entityRegistry: EntityRegistry,
    options?: {
      previousSceneSummary?: string;
      volumeSummary?: string;
      systemContext?: SystemContext;
      activeThreadIds?: string[];
    },
  ): ContextPackage {
    return this.assembler.assemble(
      event,
      state,
      entityRegistry,
      options?.previousSceneSummary ?? '',
      options?.volumeSummary ?? '',
      options?.systemContext,
      options?.activeThreadIds,
    );
  }

  /**
   * Export context package as inspector JSON (for debugging).
   */
  inspect(pkg: ContextPackage): string {
    return JSON.stringify(
      {
        eventId: pkg.eventId,
        characterCount: pkg.characterSnapshots.length,
        relationshipCount: pkg.relationshipContext.length,
        worldFactCount: pkg.worldFacts.length,
        threadCount: pkg.activeThreads.length,
        knownFacts: pkg.knowledgeBoundary.knownFacts.length,
      },
      null,
      2,
    );
  }
}
