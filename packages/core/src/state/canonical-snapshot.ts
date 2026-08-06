// ============================================================================
// Canonical Snapshot Bridge — pure NarrativeEvent / WorldState mapping for the
// derived state stream (plan 8.2-8.3)
//
// The derived stream is the single canonical representation of a sourceHash-
// scoped state log: `sequence` is the canonical graph replay position (1-based,
// contiguous) and NEVER `narrativeOrder`. Snapshots are derived caches keyed
// by that same sequence. Their `snapshotHash` is the sha256 of the canonical
// JSON of the snapshot value, so any tamper is detectable without trusting the
// store: a mismatching record is corrupt and must be quarantined by the caller
// (see ReplayEngine.replayFromNearest), never hydrated as an empty state.
//
// This module is pure (no I/O): durable persistence is the StateLogRepository /
// StateSnapshotRepository ports' job (see ports/state-repository.ts).
// ============================================================================

import { sha256Canonical } from '../cache/render-cache.ts';
import type { JsonValue } from '../contracts/json.ts';
import { ConfigError } from '../errors.ts';
import type { StateEvent, StateSnapshotRecord, StateStreamKey } from '../ports/index.ts';
import type { NarrativeEvent, WorldState } from '../types/index.ts';

/** Canonical schema identity stamped on every world-state snapshot. */
export const CANONICAL_WORLD_SCHEMA = 'canonical-world';
/** Default schema version stamped by SnapshotEngine and the bridge. */
export const CANONICAL_WORLD_SCHEMA_VERSION = 1;

/** sha256 of the canonical JSON of a world state (the snapshot value hash). */
export function computeSnapshotStateHash(state: WorldState): string {
  return sha256Canonical(state);
}

/**
 * Map one NarrativeEvent to its derived StateEvent at `sequence` (the canonical
 * graph replay position, 1-based contiguous). The caller owns the assignment:
 * iterate the canonical topological order and pass 1..N. `narrativeOrder` is
 * deliberately ignored — it is an authored hint, not replay order.
 */
export function narrativeEventToStateEvent(event: NarrativeEvent, sequence: number): StateEvent {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new ConfigError(`StateEvent sequence must be a positive integer, got ${sequence}`, {
      eventId: event.id,
      phase: 'canonical-snapshot',
    });
  }
  return {
    eventId: event.id,
    sequence,
    type: event.event,
    payload: JSON.parse(JSON.stringify(event)) as JsonValue,
  };
}

export interface WorldStateSnapshotInput {
  readonly key: StateStreamKey;
  /** Canonical replay position captured by this snapshot (1-based). */
  readonly sequence: number;
  /** Canonical schema version; defaults to CANONICAL_WORLD_SCHEMA_VERSION. */
  readonly schemaVersion?: number;
  /**
   * Optional hash override. When absent the hash is computed as sha256 of the
   * canonical JSON of the snapshot value. Overrides exist for callers that
   * must pin a deterministic hash (fixtures, hand-rolled records); tamper
   * detection still recomputes and compares.
   */
  readonly snapshotHash?: string;
}

/**
 * Wrap a WorldState as a durable StateSnapshotRecord for the canonical-world
 * schema. The state is deep-cloned (JSON round trip) into the record, exactly
 * like SnapshotEngine does, so the stored value is always JSON-safe.
 */
export function worldStateToSnapshotRecord(
  state: WorldState,
  input: WorldStateSnapshotInput,
): StateSnapshotRecord {
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new ConfigError(`Snapshot sequence must be a positive integer, got ${input.sequence}`, {
      phase: 'canonical-snapshot',
    });
  }
  const value = JSON.parse(JSON.stringify(state)) as JsonValue;
  return {
    version: 1,
    key: input.key,
    schema: CANONICAL_WORLD_SCHEMA,
    schemaVersion: input.schemaVersion ?? CANONICAL_WORLD_SCHEMA_VERSION,
    sequence: input.sequence,
    state: value,
    snapshotHash: input.snapshotHash ?? sha256Canonical(value),
  };
}

export type SnapshotVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/**
 * Verify a snapshot record against its stored hash. Recomputes the sha256 of
 * the canonical JSON of the snapshot value; any mismatch (or a foreign schema)
 * is corrupt. A corrupt snapshot must never be hydrated as an empty state —
 * quarantine it and rebuild from the immutable source.
 */
export function verifySnapshotRecord(record: StateSnapshotRecord): SnapshotVerification {
  if (record.schema !== CANONICAL_WORLD_SCHEMA) {
    return { valid: false, reason: `unexpected snapshot schema "${record.schema}"` };
  }
  if (typeof record.state !== 'object' || record.state === null || Array.isArray(record.state)) {
    return { valid: false, reason: 'snapshot state is not a world-state object' };
  }
  const expected = sha256Canonical(record.state);
  if (record.snapshotHash !== expected) {
    return {
      valid: false,
      reason: `snapshot hash mismatch: recorded "${record.snapshotHash}", recomputed "${expected}"`,
    };
  }
  return { valid: true };
}
