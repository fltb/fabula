// ============================================================================
// ContextCompiler — Main entry point
// ============================================================================

import { replayDiscourseState } from '../state/discourse-replay.js';
import type {
  ContextPackage,
  EntityRegistry,
  NarrativeEvent,
  NarratorProfile,
  PlannedDiscourseLedger,
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
      narratorProfiles?: Record<string, NarratorProfile>;
      discourseLedger?: PlannedDiscourseLedger | null;
      /** Discourse-ledger branch label to replay; single-branch projects use 'main'. */
      discourseBranch?: string;
      /** Emotional beat to annotate the compiled scene spec */
      emotionalBeat?: string;
    },
  ): ContextPackage {
    const pkg = this.assembler.assemble(
      event,
      state,
      entityRegistry,
      options?.previousSceneSummary ?? '',
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
    // DISCOURSE-1: deterministic replay-integrity check for this event's position.
    // Position is clamped to the ledger length: replaying past the last entry
    // means "everything disclosed so far" and must not be a bounds error.
    if (options?.discourseLedger) {
      try {
        const position = Math.min(event.narrativeOrder, options.discourseLedger.entries.length);
        replayDiscourseState(options.discourseLedger, position, options?.discourseBranch ?? 'main');
      } catch (err) {
        pkg.discourseReplayError = (err as Error).message;
      }
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
