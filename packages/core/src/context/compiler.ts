// ============================================================================
// ContextCompiler — Main entry point
// ============================================================================

import type { CompiledDiscourseRenderContext } from '../state/discourse-context.js';
import type {
  ContextPackage,
  EntityRegistry,
  NarrativeEvent,
  NarratorProfile,
  ResolvedNarrativeTechniqueContract,
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
      volumeSummary?: string;
      systemContext?: SystemContext;
      activeThreadIds?: string[];
      narratorProfiles?: Record<string, NarratorProfile>;
      /** Precompiled strict discourse context for this event. */
      discourseContext?: CompiledDiscourseRenderContext;
      /** Emotional beat to annotate the compiled scene spec */
      emotionalBeat?: string;
      /** Resolved narrative technique contracts to override onto the package. */
      narrativeTechniques?: readonly ResolvedNarrativeTechniqueContract[];
    },
  ): ContextPackage {
    const pkg = this.assembler.assemble(
      event,
      state,
      entityRegistry,
      options?.volumeSummary ?? '',
      options?.systemContext,
      options?.activeThreadIds,
    );
    // Apply emotional beat from compile options
    if (options?.emotionalBeat) {
      pkg.sceneSpec.emotionalBeat = options.emotionalBeat;
    }
    // S6c: resolve the event's narrator profile reference, if any
    if (event.narratorProfileRef && options?.narratorProfiles) {
      pkg.narratorProfile = options.narratorProfiles[event.narratorProfileRef];
    }
    // DISCOURSE-1: use precompiled strict discourse context's safe projection for Pass 1.
    if (options?.discourseContext) {
      pkg.discourseProjection = options.discourseContext.projection;
    }
    // STEP-6: override resolved narrative technique contracts onto the package.
    if (options?.narrativeTechniques) {
      pkg.narrativeTechniques = options.narrativeTechniques;
    }
    return pkg;
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
