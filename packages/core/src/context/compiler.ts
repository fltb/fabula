// ============================================================================
// ContextCompiler — Main entry point
// ============================================================================

import { projectDiscourseContext, replayDiscourseState } from '../state/discourse-replay.js';
import type {
  ContextPackage,
  EntityRegistry,
  NarrativeEvent,
  NarratorAssertion,
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
      /** Assertion catalog loaded from definitions/assertions/. */
      narratorAssertions?: Record<string, NarratorAssertion>;
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
    // DISCOURSE-1: replay and project the disclosure state for Pass 1.
    if (options?.discourseLedger) {
      try {
        const branch = options.discourseBranch ?? 'main';
        const sceneEntries = options.discourseLedger.entries.filter(
          (entry) => entry.branch === branch && entry.sceneId === event.id,
        );
        const position = Math.min(
          Math.max(event.narrativeOrder, ...sceneEntries.map((entry) => entry.discoursePosition)),
          options.discourseLedger.entries.length,
        );
        const discourseState = replayDiscourseState(
          options.discourseLedger,
          position,
          branch,
          options.narratorAssertions,
        );
        const authorizedAssertions = sceneEntries.flatMap((entry) =>
          entry.action.type === 'reveal' || entry.action.type === 'claim'
            ? [entry.action.assertionId]
            : [],
        );
        pkg.discourseProjection = projectDiscourseContext(
          discourseState,
          pkg.narratorProfile,
          event.pov.character,
          authorizedAssertions,
        );
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
