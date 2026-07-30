// ============================================================================
// Discourse Ledger Compiler
// ============================================================================
//
// Compiles a `PlannedDiscourseLedgerSource` (authored YAML, no hash) into a
// `PlannedDiscourseLedger` with a runtime-derived SHA-256 hash.
//
// The mapper loads the YAML through the source schema, then calls this
// compiler to produce the non-null runtime ledger that carries the hash.
// ============================================================================

import { sha256Canonical } from '../cache/render-cache.js';
import type { PlannedDiscourseLedger, PlannedDiscourseLedgerSource } from '../types/discourse.js';

/**
 * Compile a `PlannedDiscourseLedgerSource` into a complete runtime
 * `PlannedDiscourseLedger` with a derived SHA-256 hash.
 *
 * The hash is computed from the canonical JSON serialization of the source
 * object (sorted keys, no undefined values). This makes the hash
 * deterministic and verifiable across compilations.
 */
export function compilePlannedDiscourseLedger(
  source: PlannedDiscourseLedgerSource,
): PlannedDiscourseLedger {
  return {
    ...source,
    hash: sha256Canonical(source),
  };
}
