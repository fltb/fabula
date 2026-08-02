// ============================================================================
// SurfaceScheduler — Deterministic dependency-ready wave planning over
// preplanned RenderJob[] using surfaceDependency.predecessorEventId.
//
// Design:
//   §1: WavePlan — topological ordering of jobs into ready waves.
//       Jobs with no predecessor start in wave 0; each successive wave
//       depends only on jobs in prior waves.
//   §2: Cycle detection via predecessor-chain DFS.  Any job in a cycle
//       is excluded from all waves and reported in cycleParticipants.
//   §3: Missing predecessor — predecessorEventId not found in the job set
//       is a hard validation failure; reported in missingPredecessors.
//   §4: AcceptedArtifactResolver reads accepted scene envelopes through the
//       semantic execution repository. Cache entries and Host file layout are
//       never consulted for authoritative predecessor prose.
//
// Binding constraints (RENDER-SURFACE-1):
//   - SurfaceScheduler NEVER reads LLM output, modifies YAML/logic/
//     discourse/causal edges, or reorders by completion timing.
//   - Wave order is purely topological; completion time NEVER affects
//     subsequent wave composition.
//   - Serial lane ordering is defined by predecessor references, never
//     by group ID, story time, or filename.
// ============================================================================

import type { CoreExecutionRepository } from '../ports/execution-repository.ts';
import { sceneRevisionEnvelopeV1Schema } from '../schemas/editorial.ts';
import type { AcceptedSceneArtifact } from '../types/render-surface.ts';
import type { RenderJob } from './render.ts';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * A single scheduled wave indexed from 0.
 * All eventIds in a wave can be rendered in parallel — none depend on
 * a peer within the same wave.
 */
export interface ScheduledWave {
  /** Zero-based wave index (0 = first wave, no dependencies). */
  readonly waveIndex: number;
  /** Event IDs in this wave, sorted deterministically. */
  readonly eventIds: readonly string[];
}

/**
 * Complete deterministic wave plan for a set of preplanned RenderJobs.
 */
export interface WavePlan {
  /** Ordered waves — each wave depends only on earlier waves. */
  readonly waves: readonly ScheduledWave[];
  /** Event IDs whose predecessor was not found in the job set. */
  readonly missingPredecessors: readonly MissingPredecessorEntry[];
  /** Event IDs participating in dependency cycles (excluded from waves). */
  readonly cycleParticipants: readonly string[];
  /** Non-fatal diagnostic messages. */
  readonly warnings: readonly string[];
}

/**
 * Describes a job whose predecessorEventId is not in the job set.
 */
export interface MissingPredecessorEntry {
  /** The job that declares the missing dependency. */
  readonly eventId: string;
  /** The predecessorEventId that was not found. */
  readonly predecessorEventId: string;
}

/**
 * Surface-scheduler specific error for hard validation failures.
 * Reuses SurfaceErrorCode values where applicable.
 */
export class SurfaceSchedulerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SurfaceSchedulerError';
  }
}

// ============================================================================
// SurfaceScheduler — Wave planning
// ============================================================================

export class SurfaceScheduler {
  /**
   * Build a deterministic wave plan from an ordered list of preplanned jobs.
   *
   * Validation performed:
   *   1. Every `predecessorEventId` must reference an event ID in the set.
   *   2. The predecessor graph must be acyclic.
   *
   * Jobs that fail validation are excluded from all waves and reported
   * in `missingPredecessors` / `cycleParticipants`.
   *
   * @param jobs  Preplanned render jobs (order within each wave is
   *              deterministic but NOT guaranteed to match input order).
   * @returns A WavePlan with validated, topologically-ordered waves.
   */
  buildWavePlan(jobs: readonly RenderJob[]): WavePlan {
    const byId = new Map<string, RenderJob>();
    for (const job of jobs) {
      // Last entry wins for duplicate IDs — deterministically stable.
      byId.set(job.event.id, job);
    }

    // ── Phase 1: Missing predecessors ────────────────────────────────
    const missingPredecessors: MissingPredecessorEntry[] = [];
    for (const job of jobs) {
      const predId = job.surfaceDependency.predecessorEventId;
      if (predId !== undefined && !byId.has(predId)) {
        missingPredecessors.push({
          eventId: job.event.id,
          predecessorEventId: predId,
        });
      }
    }
    const missingSet = new Set(missingPredecessors.map((e) => e.eventId));

    // ── Phase 2: Cycle detection (predecessor-chain DFS) ─────────────
    const cycleParticipants = this.detectCycleParticipants(jobs, byId, missingSet);
    const excludedSet = new Set([...missingSet, ...cycleParticipants]);

    // ── Phase 3: Topological wave assignment (Kahn's algorithm) ──────
    const waves = this.assignWaves(jobs, byId, excludedSet);

    return {
      waves,
      missingPredecessors,
      cycleParticipants,
      warnings: [],
    };
  }

  /**
   * Detect jobs that form dependency cycles by following
   * predecessorEventId chains.
   *
   * Each job has at most one predecessor, so a simple chain-based DFS
   * suffices: traverse from each unvisited job up its predecessor chain;
   * if a node is encountered twice in the same traversal, the chain
   * contains a cycle.
   */
  private detectCycleParticipants(
    jobs: readonly RenderJob[],
    byId: ReadonlyMap<string, RenderJob>,
    missingSet: ReadonlySet<string>,
  ): string[] {
    const cycleSet = new Set<string>();
    const globallyVisited = new Set<string>();

    for (const job of jobs) {
      const startId = job.event.id;
      if (globallyVisited.has(startId) || missingSet.has(startId)) {
        continue;
      }

      // Walk the predecessor chain from this job.
      const chain: string[] = [];
      const chainSet = new Set<string>();
      let current: string | undefined = startId;

      while (current !== undefined && byId.has(current) && !globallyVisited.has(current)) {
        chain.push(current);
        chainSet.add(current);
        globallyVisited.add(current);
        const currentJob = byId.get(current);
        if (currentJob === undefined) {
          break;
        }
        current = currentJob.surfaceDependency.predecessorEventId;
      }

      // If current is in the current chain, we found a cycle.
      if (current !== undefined && chainSet.has(current)) {
        const cycleStartIdx = chain.indexOf(current);
        for (let i = cycleStartIdx; i < chain.length; i++) {
          cycleSet.add(chain[i]);
        }
      }
    }

    return [...cycleSet].sort();
  }

  /**
   * Assign jobs to topological waves using Kahn's algorithm.
   * Jobs in `excludedSet` (missing deps or cycles) are skipped.
   *
   * Since each job has at most one predecessor, every valid job's
   * wave is its position in the dependency chain.
   */
  private assignWaves(
    jobs: readonly RenderJob[],
    byId: ReadonlyMap<string, RenderJob>,
    excludedSet: ReadonlySet<string>,
  ): ScheduledWave[] {
    // Build successor map (predecessor → list of dependents).
    const successors = new Map<string, string[]>();
    for (const job of jobs) {
      if (excludedSet.has(job.event.id)) continue;
      const predId = job.surfaceDependency.predecessorEventId;
      // Only link if predecessor is in our set and not excluded.
      if (predId !== undefined && byId.has(predId) && !excludedSet.has(predId)) {
        const list = successors.get(predId);
        if (list) {
          list.push(job.event.id);
        } else {
          successors.set(predId, [job.event.id]);
        }
      }
    }

    // In-degree: 1 if job has an eligible predecessor, else 0.
    const inDegree = new Map<string, number>();
    for (const job of jobs) {
      if (excludedSet.has(job.event.id)) continue;
      const predId = job.surfaceDependency.predecessorEventId;
      if (predId !== undefined && byId.has(predId) && !excludedSet.has(predId)) {
        inDegree.set(job.event.id, 1);
      } else {
        inDegree.set(job.event.id, 0);
      }
    }

    const waves: ScheduledWave[] = [];
    let queue = [...inDegree.keys()].filter((id) => inDegree.get(id) === 0).sort();

    while (queue.length > 0) {
      const wave: ScheduledWave = {
        waveIndex: waves.length,
        eventIds: [...queue],
      };
      waves.push(wave);

      const nextQueue: string[] = [];
      for (const id of queue) {
        for (const depId of successors.get(id) ?? []) {
          // Single predecessor → removing it reduces in-degree to 0.
          inDegree.set(depId, 0);
          nextQueue.push(depId);
        }
      }

      // Deterministic ordering within each wave.
      queue = nextQueue.sort();
    }

    return waves;
  }
}

// ============================================================================
// AcceptedArtifactResolver — typed predecessor material from the semantic
// execution repository, keyed by event ID rather than Host persistence layout.
// ============================================================================
export class AcceptedArtifactResolver {
  constructor(
    private readonly execution: CoreExecutionRepository,
    private readonly projectId: string,
  ) {}

  /**
   * Resolve an accepted scene from the semantic repository. The record and
   * its revision envelope must agree on every identity-bearing field before
   * the prose may become a surface predecessor.
   */
  async resolve(
    eventId: string,
    requestedScopeHash?: string,
  ): Promise<AcceptedSceneArtifact | null> {
    const accepted = await this.execution.readAcceptedScene({
      projectId: this.projectId,
      eventId,
    });
    if (accepted === null) return null;
    const parsed = sceneRevisionEnvelopeV1Schema.safeParse(accepted.value.value);
    if (!parsed.success) return null;
    const envelope = parsed.data;
    if (
      envelope.eventId !== eventId ||
      envelope.revisionId !== accepted.value.revisionId ||
      envelope.prose !== accepted.value.prose ||
      envelope.proseHash !== accepted.value.proseHash ||
      envelope.sceneHash !== accepted.value.sceneHash ||
      envelope.releaseDecision.status !== 'accepted' ||
      envelope.scopeHash !== envelope.releaseDecision.scopeHash ||
      !envelope.sceneHash ||
      !envelope.editorialBasisHash ||
      (requestedScopeHash !== undefined && envelope.scopeHash !== requestedScopeHash)
    ) {
      return null;
    }
    return {
      eventId: envelope.eventId,
      revisionId: envelope.revisionId,
      prose: envelope.prose,
      proseHash: envelope.proseHash,
      sceneHash: envelope.sceneHash,
      editorialBasisHash: envelope.editorialBasisHash,
      scopeHash: envelope.scopeHash,
      releaseDecision: envelope.releaseDecision,
      createdAt: envelope.createdAt,
    };
  }

  /** Resolve all accepted artifacts concurrently while retaining input order. */
  async resolveAll(
    eventIds: readonly string[],
    requestedScopeHash?: string,
  ): Promise<Map<string, AcceptedSceneArtifact>> {
    const resolved = await Promise.all(
      eventIds.map(async (eventId) => [eventId, await this.resolve(eventId, requestedScopeHash)] as const),
    );
    const results = new Map<string, AcceptedSceneArtifact>();
    for (const [eventId, artifact] of resolved) {
      if (artifact !== null) results.set(eventId, artifact);
    }
    return results;
  }
}
