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
//   §4: AcceptedArtifactResolver reads persisted response files from
//       .nova/responses/{eventId}.json and reconstructs
//       AcceptedSceneArtifact only when releaseDecision.status is
//       'accepted'.  Never uses filename patterns or prose conventions.
//
// Binding constraints (RENDER-SURFACE-1):
//   - SurfaceScheduler NEVER reads LLM output, modifies YAML/logic/
//     discourse/causal edges, or reorders by completion timing.
//   - Wave order is purely topological; completion time NEVER affects
//     subsequent wave composition.
//   - Serial lane ordering is defined by predecessor references, never
//     by group ID, story time, or filename.
// ============================================================================

import { sceneRevisionEnvelopeV1Schema } from '../schemas/editorial.ts';
import type { Storage } from '../storage/index.ts';
import type { SceneRevisionEnvelopeV1 } from '../types/editorial.ts';
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
        current = byId.get(current)!.surfaceDependency.predecessorEventId;
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
// AcceptedArtifactResolver — Typed predecessor material from persisted
// response files, keyed by event ID (never filename/prose convention).
// ============================================================================

/**
 * Resolves persisted accepted-scene artifacts from `.nova/responses/`
 * storage.  Only artifacts whose `releaseDecision.status` is `'accepted'`
 * are returned; all others (blocked, pending_waiver, missing) yield null.
 */
export class AcceptedArtifactResolver {
  private readonly storage: Storage;
  private readonly headDir: string;
  private readonly archiveDir: string;

  constructor(storage: Storage, headDir: string, archiveDir: string) {
    this.storage = storage;
    this.headDir = headDir;
    this.archiveDir = archiveDir;
  }

  /**
   * Resolve a single event's accepted artifact.
   *
   * Resolution flow:
   *  1. Read head pointer from `{headDir}/{eventId}.json` → `{ revisionId, proseHash }`
   *  2. If head pointer has both revisionId and proseHash, load the full
   *     SceneRevisionEnvelopeV1 from `{archiveDir}/{eventId}/{revisionId}.json`
   *  3. Validate internal consistency: envelope scopeHash must match
   *     releaseDecision.scopeHash; envelope proseHash must match head proseHash.
   *  4. If requestedScopeHash is provided, validate envelope scopeHash matches it.
   *  5. Validate sceneHash and editorialBasisHash are non-empty.
   *
   * Backward-compatible inline prose is NOT supported — the head pointer MUST
   * contain revisionId + proseHash.  Legacy migration is handled by workspace
   * inspection, not the scheduler.
   *
   * @param eventId  The event/scene identifier.
   * @param requestedScopeHash  If provided, the envelope's scopeHash must match.
   * @returns AcceptedSceneArtifact if found and accepted, or null if the
   *          response file is missing, malformed, scopes differ, or not accepted.
   */
  resolve(eventId: string, requestedScopeHash?: string): AcceptedSceneArtifact | null {
    const headPath = [this.headDir, `${eventId}.json`].join('/');

    let headRaw: string;
    try {
      const maybe = this.storage.readOptional(headPath);
      if (maybe === null) return null;
      headRaw = maybe;
    } catch {
      return null;
    }

    let head: Record<string, unknown>;
    try {
      head = JSON.parse(headRaw) as Record<string, unknown>;
    } catch {
      return null;
    }

    const revisionId = typeof head.revisionId === 'string' ? head.revisionId : null;
    const proseHash = typeof head.proseHash === 'string' ? head.proseHash : null;

    // Head pointer must contain both revisionId and proseHash
    if (revisionId === null || proseHash === null) return null;

    return this.resolveFromArchive(eventId, revisionId, proseHash, requestedScopeHash);
  }

  /**
   * Resolve full artifact from archive envelope, validating consistency.
   *
   * Validates:
   *  - releaseDecision is present and status is 'accepted'
   *  - envelope scopeHash matches releaseDecision scopeHash (internal consistency)
   *  - envelope proseHash matches the head pointer proseHash
   *  - sceneHash and editorialBasisHash are non-empty
   *  - if requestedScopeHash is provided, envelope scopeHash must match it
   */
  private resolveFromArchive(
    eventId: string,
    revisionId: string,
    proseHash: string,
    requestedScopeHash?: string,
  ): AcceptedSceneArtifact | null {
    const archivePath = [this.archiveDir, eventId, `${revisionId}.json`].join('/');

    let raw: string;
    try {
      const maybe = this.storage.readOptional(archivePath);
      if (maybe === null) return null;
      raw = maybe;
    } catch {
      return null;
    }

    let envelope: SceneRevisionEnvelopeV1;
    try {
      const parsed = sceneRevisionEnvelopeV1Schema.safeParse(JSON.parse(raw));
      if (!parsed.success) return null;
      envelope = parsed.data as SceneRevisionEnvelopeV1;
    } catch {
      return null;
    }

    // Validate release decision status
    if (typeof envelope.releaseDecision !== 'object' || envelope.releaseDecision === null)
      return null;
    if (envelope.releaseDecision.status !== 'accepted') return null;

    // Mismatched scope → missing-source failure (internal consistency check)
    if (envelope.scopeHash !== envelope.releaseDecision.scopeHash) return null;

    // Verify proseHash matches head pointer
    if (envelope.proseHash !== proseHash) return null;

    // Verify required hashes are present
    if (!envelope.sceneHash || typeof envelope.sceneHash !== 'string') return null;
    if (!envelope.editorialBasisHash || typeof envelope.editorialBasisHash !== 'string')
      return null;

    // If a requested scopeHash is provided, enforce exact match
    if (requestedScopeHash !== undefined && envelope.scopeHash !== requestedScopeHash) return null;

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

  /**
   * Batch-resolve multiple event IDs.
   * Only accepted artifacts are included in the result map.
   *
   * @param eventIds  Event/scene identifiers to resolve.
   * @param requestedScopeHash  If provided, only accept artifacts whose scopeHash matches.
   * @returns Map of eventId → AcceptedSceneArtifact for accepted results.
   */
  resolveAll(
    eventIds: readonly string[],
    requestedScopeHash?: string,
  ): Map<string, AcceptedSceneArtifact> {
    const results = new Map<string, AcceptedSceneArtifact>();
    for (const eventId of eventIds) {
      const artifact = this.resolve(eventId, requestedScopeHash);
      if (artifact !== null) {
        results.set(eventId, artifact);
      }
    }
    return results;
  }
}
