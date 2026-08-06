// ============================================================================
// CanonicalStateProjectionService — derived per-source/route state stream
// (plan Step 8.1-8.3)
//
// Per project session, per IMMUTABLE source/route, this service builds the
// canonical derived stream once (lazily on the first status/diff query) and
// persists snapshots through the injected Core state repositories (the Host's
// derived runtime area — never AuthoringManifest/native revision):
//
//   StateStreamKey { projectId, streamId: sourceHash, branchId: sha256(route) }
//
// `sequence` is the canonical graph replay position (1-based, contiguous) from
// the compiled runtime's topological order — NEVER `narrativeOrder`. A
// sourceHash change naturally produces a NEW stream key (no invalidation or
// rewrite of the accepted source).
//
// Read path: nearest VERIFIED snapshot → canonical suffix (Core
// ReplayEngine.replayFromNearest) → full-replay fallback. Corrupt snapshots
// are quarantined (never hydrated as empty state) and the state is rebuilt
// from the immutable source; valid snapshots are re-saved best-effort.
//
// This service is a DERIVED CACHE, never a second authority: every value it
// returns is reconstructible from the immutable source through the same
// compile the render/validation paths use, and the equivalence gate
// (tests/state-projection-equivalence.test.ts) pins its per-event states to
// `compileCanonicalRuntime().boundaries` before any production caller may
// read through it.
// ============================================================================

import { createHash } from 'node:crypto';
import type {
  CompileProjectOptions,
  NarrativeEvent,
  ProjectCompilation,
  ProjectSourceSnapshotV1,
  ReplayOptions,
  StateEvent,
  StateSnapshotRecord,
  StateStreamKey,
  WorldState,
} from '@novalistically/core';
import {
  CANONICAL_WORLD_SCHEMA,
  CANONICAL_WORLD_SCHEMA_VERSION,
  narrativeEventToStateEvent,
  ReplayEngine,
  verifySnapshotRecord,
  worldStateToSnapshotRecord,
} from '@novalistically/core';
import type { DiffResult } from '@novalistically/core/tooling';
import type { WorkbenchRouteSelectorV1 } from '../../contracts/graph.js';
import type { ProjectCoreRuntime } from '../core-runtime.js';

/** Default snapshot cadence when the project config omits `snapshotInterval`. */
export const DEFAULT_SNAPSHOT_INTERVAL = 10;

export interface CanonicalStateProjectionOptions {
  readonly projectId: string;
  /**
   * The shared per-session Core runtime. Its `compileDetached` is used for
   * route-specific compiles so the sourceHash-keyed memo of `compile` is
   * never polluted by route options.
   */
  readonly runtime: ProjectCoreRuntime;
  /**
   * How often (in canonical events) a durable snapshot is saved. Defaults to
   * {@link DEFAULT_SNAPSHOT_INTERVAL}; the launch wires the project config's
   * `nova.yaml.snapshotInterval` here.
   */
  readonly snapshotInterval?: number;
  /**
   * The session's current route selector. Defaults to the canonical route
   * (empty branch path, resolved discourse branch) — the same default the
   * graph projector uses when no selector is supplied.
   */
  readonly route?: WorkbenchRouteSelectorV1;
}

/** One fully built derived stream for an immutable source under one route. */
interface BuiltStream {
  readonly key: StateStreamKey;
  /** Detached compile for this source/route; the stream's authoritative base. */
  readonly compilation: ProjectCompilation;
  /** Derived StateEvents in canonical replay order, sequences 1..N. */
  readonly events: readonly StateEvent[];
  readonly sequenceByEventId: ReadonlyMap<string, number>;
  readonly eventById: ReadonlyMap<string, NarrativeEvent>;
  /** Replay machinery reconstructed from the compile's replay context. */
  readonly engine: ReplayEngine;
  readonly replayOptions: ReplayOptions;
  /** Canonical snapshot positions (interval multiples) for this stream. */
  readonly snapshotPositions: readonly number[];
  /** How many snapshots this session has saved for the key (rebuild CAS). */
  snapshotVersion: number;
}

/**
 * Canonical route → Core compile options. The canonical default (no selector,
 * or an explicitly empty branch path without a discourse branch) compiles as
 * the no-route case, exactly like the graph projector's default; any real
 * branch path or discourse branch is forwarded.
 */
function toCompileOptions(
  route: WorkbenchRouteSelectorV1 | undefined,
): CompileProjectOptions | undefined {
  if (route === undefined) return undefined;
  const decisions = route.branchPath.decisions;
  if (decisions.length === 0 && route.discourseBranch === undefined) return undefined;
  const options: CompileProjectOptions = {
    branchPath: { decisions: decisions.map((decision) => ({ ...decision })) },
  };
  if (route.discourseBranch !== undefined) options.discourseBranch = route.discourseBranch;
  return options;
}

/**
 * Deterministic route identity for the branchId: the ordered decision chain
 * plus the discourse branch. Built explicitly so key order can never shift
 * the hash; narrativeOrder is authored metadata and is deliberately included
 * only as part of the decision identity the compiler itself uses.
 */
function routeIdentity(route: WorkbenchRouteSelectorV1 | undefined): string {
  const decisions = (route?.branchPath.decisions ?? [])
    .map((decision) => `${decision.atEventId}:${decision.choiceId}:${decision.narrativeOrder}`)
    .join(',');
  return `branchPath=[${decisions}];discourseBranch=${route?.discourseBranch ?? 'main'}`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Mirror of Core `diffEvent`'s keyed compare over two world states. */
function compareStates(
  beforeState: WorldState,
  afterState: WorldState,
): { before: Record<string, unknown>; after: Record<string, unknown>; changed: string[] } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const changed: string[] = [];
  const compare = (
    prefix: string,
    left: Record<string, unknown>,
    right: Record<string, unknown>,
  ) => {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
        const name = `${prefix}:${key}`;
        before[name] = left[key] ?? null;
        after[name] = right[key] ?? null;
        changed.push(name);
      }
    }
  };
  compare('entity', beforeState.entities, afterState.entities);
  compare('thread', beforeState.threads, afterState.threads);
  compare(
    'relationship',
    beforeState.relationships as Record<string, unknown>,
    afterState.relationships as Record<string, unknown>,
  );
  return { before, after, changed };
}

export interface CanonicalStateProjectionService {
  readonly projectId: string;
  /** The route this service projects; undefined = the canonical default. */
  readonly route: WorkbenchRouteSelectorV1 | undefined;
  /** Durable stream key for one immutable source under this service's route. */
  streamKey(snapshot: ProjectSourceSnapshotV1): StateStreamKey;
  /**
   * The full derived stream (canonical replay order, sequences 1..N). Builds
   * once per sourceHash, then persists events + interval snapshots through
   * the injected repositories.
   */
  events(snapshot: ProjectSourceSnapshotV1): Promise<readonly StateEvent[]>;
  /** Canonical replay sequence of one event, or null when not in the stream. */
  sequenceOf(snapshot: ProjectSourceSnapshotV1, eventId: string): Promise<number | null>;
  /** WorldState immediately before the event (canonical suffix replay). */
  stateBefore(snapshot: ProjectSourceSnapshotV1, eventId: string): Promise<WorldState | null>;
  /** WorldState immediately after the event (canonical suffix replay). */
  stateAfter(snapshot: ProjectSourceSnapshotV1, eventId: string): Promise<WorldState | null>;
  /** before/after/changed diff for one event, or null when not in the stream. */
  diff(snapshot: ProjectSourceSnapshotV1, eventId: string): Promise<DiffResult | null>;
  /** Release compiled streams; safe to call more than once. */
  dispose(): Promise<void>;
}

export function createCanonicalStateProjectionService(
  options: CanonicalStateProjectionOptions,
): CanonicalStateProjectionService {
  const { projectId, runtime } = options;
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new TypeError('CanonicalStateProjectionService requires a non-empty projectId');
  }
  if (runtime === null || typeof runtime !== 'object') {
    throw new TypeError('CanonicalStateProjectionService requires the injected Core runtime');
  }
  const snapshotInterval = Math.max(
    1,
    Math.floor(options.snapshotInterval ?? DEFAULT_SNAPSHOT_INTERVAL),
  );
  const route = options.route;
  const streams = new Map<string, BuiltStream>();

  function streamKey(snapshot: ProjectSourceSnapshotV1): StateStreamKey {
    return {
      projectId,
      streamId: snapshot.sourceHash,
      branchId: sha256Hex(routeIdentity(route)),
    };
  }

  function snapshotPositionsFor(eventCount: number): number[] {
    const positions: number[] = [];
    for (let sequence = snapshotInterval; sequence <= eventCount; sequence += snapshotInterval) {
      positions.push(sequence);
    }
    return positions;
  }

  async function build(snapshot: ProjectSourceSnapshotV1): Promise<BuiltStream> {
    const existing = streams.get(snapshot.sourceHash);
    if (existing !== undefined) return existing;

    const key = streamKey(snapshot);
    const compilation = runtime.compileDetached(snapshot, toCompileOptions(route));
    const order = compilation.boundaries.orderedEventIds;
    const eventById = new Map<string, NarrativeEvent>(
      compilation.runtimeEvents.map((event) => [event.id, event]),
    );
    const events: StateEvent[] = [];
    const sequenceByEventId = new Map<string, number>();
    order.forEach((eventId, index) => {
      const event = eventById.get(eventId);
      if (event === undefined) {
        throw new Error(
          `Canonical stream references unknown event "${eventId}" in the compiled runtime.`,
        );
      }
      const sequence = index + 1;
      events.push(narrativeEventToStateEvent(event, sequence));
      sequenceByEventId.set(eventId, sequence);
    });

    const replayContext = compilation.replay;
    const branchPath = toCompileOptions(route)?.branchPath ?? { decisions: [] };
    const replayOptions: ReplayOptions = {
      branchPath,
      initialFacts: compilation.initialFacts,
      initialThreads: (compilation.data.worldInitialState?.threads ?? []).map((thread) => ({
        id: thread.threadId,
      })),
      timeAnchors: compilation.data.timeAnchors,
      ...(replayContext.relationshipReplayContext === undefined
        ? {}
        : { relationshipReplayContext: replayContext.relationshipReplayContext }),
      ...(replayContext.baseline === undefined ? {} : { baseline: replayContext.baseline }),
    };
    const engine = new ReplayEngine(
      replayContext.catalogContext,
      replayContext.relationshipReplayContext,
    );

    const stream: BuiltStream = {
      key,
      compilation,
      events,
      sequenceByEventId,
      eventById,
      engine,
      replayOptions,
      snapshotPositions: snapshotPositionsFor(events.length),
      snapshotVersion: 0,
    };

    await persistEvents(stream);
    await persistSnapshots(stream);

    streams.set(snapshot.sourceHash, stream);
    return stream;
  }

  /** Append the derived stream to the durable state log (best-effort cache). */
  async function persistEvents(stream: BuiltStream): Promise<void> {
    const { key, events } = stream;
    const log = await runtime.services.stateLog.read({ key });
    if (log.version >= events.length) return; // full (or stale) log — compile is authoritative
    await runtime.services.stateLog.append({
      key,
      expectedVersion: log.version,
      events: events.slice(log.version),
    });
  }

  /**
   * Save durable snapshots at every snapshotInterval-th canonical position.
   * When a valid snapshot already exists for the key (previous session over
   * the same immutable source) the cache is left untouched; snapshots are
   * derived caches, never rewritten. A corrupt pre-existing record is
   * re-verified here and re-saved from the immutable source (rebuild).
   */
  async function persistSnapshots(stream: BuiltStream): Promise<void> {
    const { key, compilation, snapshotPositions } = stream;
    if (snapshotPositions.length === 0) return;
    const existing = await runtime.services.stateSnapshots.readNearestValid({
      key,
      atOrBeforeSequence: compilation.boundaries.orderedEventIds.length,
      schema: CANONICAL_WORLD_SCHEMA,
      schemaVersion: CANONICAL_WORLD_SCHEMA_VERSION,
    });
    if (existing !== null && verifySnapshotRecord(existing).valid) {
      stream.snapshotVersion = 1; // cache populated by a previous session
      return;
    }
    let expectedVersion: number | null = null;
    for (const sequence of snapshotPositions) {
      const eventId = compilation.boundaries.orderedEventIds[sequence - 1];
      if (eventId === undefined) continue;
      const state = compilation.boundaries.stateAfterByEventId.get(eventId);
      if (state === undefined) continue;
      const result = await runtime.services.stateSnapshots.save({
        snapshot: worldStateToSnapshotRecord(state, { key, sequence }),
        expectedVersion,
      });
      if (result.kind === 'conflict') break; // another writer owns the cache
      expectedVersion = result.version;
      stream.snapshotVersion = result.version;
    }
  }

  /**
   * Collect snapshot candidates for one replay target: probe the store at
   * every canonical snapshot position at or before the target (snapshots are
   * only ever saved at interval multiples), then let ReplayEngine verify and
   * quarantine. Hash integrity is never trusted to the store.
   */
  async function snapshotCandidates(
    stream: BuiltStream,
    targetCount: number,
  ): Promise<StateSnapshotRecord[]> {
    const { key, snapshotPositions } = stream;
    const collected = new Map<number, StateSnapshotRecord>();
    for (const position of snapshotPositions) {
      if (position > targetCount) break;
      const record = await runtime.services.stateSnapshots.readNearestValid({
        key,
        atOrBeforeSequence: position,
        schema: CANONICAL_WORLD_SCHEMA,
        schemaVersion: CANONICAL_WORLD_SCHEMA_VERSION,
      });
      if (record !== null) collected.set(record.sequence, record);
    }
    return [...collected.values()];
  }

  /**
   * Reconstruct the world state at `targetCount` canonical events (0 =
   * baseline): nearest verified snapshot → suffix, full replay fallback.
   * Corrupt snapshots are quarantined by ReplayEngine and valid replacements
   * re-saved from the immutable source (best-effort rebuild).
   */
  async function stateAt(stream: BuiltStream, targetCount: number): Promise<WorldState> {
    const candidates = await snapshotCandidates(stream, targetCount);
    const result = stream.engine.replayFromNearest(
      candidates,
      targetCount,
      [...stream.compilation.runtimeEvents],
      stream.replayOptions,
    );
    if (result.corrupt.length > 0) {
      await rebuildSnapshots(stream, result.corrupt);
    }
    return result.state;
  }

  /**
   * Best-effort rebuild: re-save valid snapshots at the quarantined
   * positions, derived from the immutable source. Conflicts with a store
   * this session does not own are ignored — correctness never depends on it.
   */
  async function rebuildSnapshots(
    stream: BuiltStream,
    corrupt: readonly StateSnapshotRecord[],
  ): Promise<void> {
    const { key, compilation, snapshotPositions } = stream;
    let expectedVersion: number | null =
      stream.snapshotVersion === 0 ? null : stream.snapshotVersion;
    const corruptSequences = new Set(corrupt.map((record) => record.sequence));
    for (const sequence of snapshotPositions) {
      if (!corruptSequences.has(sequence)) continue;
      const eventId = compilation.boundaries.orderedEventIds[sequence - 1];
      if (eventId === undefined) continue;
      const state = compilation.boundaries.stateAfterByEventId.get(eventId);
      if (state === undefined) continue;
      const result = await runtime.services.stateSnapshots.save({
        snapshot: worldStateToSnapshotRecord(state, { key, sequence }),
        expectedVersion,
      });
      if (result.kind === 'conflict') return;
      expectedVersion = result.version;
      stream.snapshotVersion = result.version;
    }
  }

  async function requireEvent(
    snapshot: ProjectSourceSnapshotV1,
    eventId: string,
  ): Promise<{ stream: BuiltStream; sequence: number } | null> {
    const stream = await build(snapshot);
    const sequence = stream.sequenceByEventId.get(eventId);
    if (sequence === undefined) return null;
    return { stream, sequence };
  }

  return {
    projectId,
    route,
    streamKey,
    async events(snapshot) {
      return (await build(snapshot)).events;
    },
    async sequenceOf(snapshot, eventId) {
      const found = await requireEvent(snapshot, eventId);
      return found === null ? null : found.sequence;
    },
    async stateBefore(snapshot, eventId) {
      const found = await requireEvent(snapshot, eventId);
      if (found === null) return null;
      return stateAt(found.stream, found.sequence - 1);
    },
    async stateAfter(snapshot, eventId) {
      const found = await requireEvent(snapshot, eventId);
      if (found === null) return null;
      return stateAt(found.stream, found.sequence);
    },
    async diff(snapshot, eventId) {
      const found = await requireEvent(snapshot, eventId);
      if (found === null) return null;
      const beforeState = await stateAt(found.stream, found.sequence - 1);
      const afterState = await stateAt(found.stream, found.sequence);
      return compareStates(beforeState, afterState);
    },
    async dispose() {
      streams.clear();
    },
  };
}
