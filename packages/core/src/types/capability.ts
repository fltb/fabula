// ============================================================================
// Novalistically — CAPABILITY-1: Capability Manifest Types
//
// Binding constraints from docs/todos/capability-contract.md CAPABILITY-1:
//   1. Every YAML schema variant, compiled IR variant, runtime domain
//      operation, cross-domain combination belongs to one manifest row
//   2. No manifest entry → input default REJECTED (no loader fallback,
//      no docs-implied support)
//   3. S status requires: finite deterministic semantics, typed rejection,
//      production implementation, independent reference interpreter,
//      property/model tests, human-readable fixtures, applicable
//      snapshot/replay/cache equivalence, stage evidence
//   4. Reference implementation MUST NOT import production helpers
//   5. RENDER-SURFACE must have at least 2 rows:
//      surface_scheduler_contract (S) and
//      surface_prose_continuity_outcome (C)
//   6. Stage 1 gate: all declared S core capabilities manifest-complete
//   7. Stage 2 gate: external corpus, C metrics, human annotation,
//      source/legal/provenance, performance/cache/parallel evidence
//      each bound to manifest
//   8. Stage 3 gate: every project render/assemble records
//      manifest/version/config; X or uncovered YAML/IR combinations
//      hard fail
//   9. Minimum cross-domain conformance suite
// ============================================================================

// ─── CapabilityStatus (§3) ───────────────────────────────────────────────────

/**
 * S = supported (deterministic, prod impl, independent ref interpreter,
 *     property tests, fixtures, evidence)
 * C = capable (structural/contract expressible but prose/Pass 2/human
 *     detection is measurement)
 * X = unsupported
 */
export type CapabilityStatus = 'S' | 'C' | 'X';

// ─── EvidenceClass ───────────────────────────────────────────────────────────

/**
 * Evidence class for capability stage-gate validation.
 * Every capability entry carries an evidenceArtifactHash from one of these
 * evidence classes.
 */
export type EvidenceClass =
  | 'state_replay'
  | 'discourse_replay'
  | 'schema_rejection'
  | 'surface_scheduler'
  | 'validation_measurement';

// ─── StageGate ───────────────────────────────────────────────────────────────

/**
 * Stage gate identifier used to group capabilities by validation stage.
 * Stage 1: core S capabilities manifest-complete.
 * Stage 2: external corpus, C metrics, human annotation,
 *          source/legal/provenance, performance/cache/parallel.
 * Stage 3: every project render/assemble records manifest/version/config.
 */
export type StageGate = 1 | 2 | 3;

// ─── CapabilityManifestEntry ─────────────────────────────────────────────────

/**
 * A single capability manifest entry.
 *
 * Each YAML schema variant, compiled IR variant, runtime domain operation,
 * and cross-domain combination gets one manifest row. No manifest entry →
 * input default REJECTED.
 */
export interface CapabilityManifestEntry {
  /** Capability ID — unique identifier for this capability. */
  capabilityId: string;

  /** S|C|X status. */
  status: CapabilityStatus;

  /** Supported schema versions for this capability. */
  schemaVersions: string[];

  /** Supported normalization versions for this capability. */
  normalizationVersions: string[];

  /** Supported input forms (YAML schema variant, IR, etc.). */
  supportedInputForms: string[];

  /** Reference case IDs for deterministic testing. */
  referenceCaseIds: string[];

  /** Property/model test case IDs. */
  propertyCaseIds: string[];

  /** Rejection case IDs (typed rejection paths). */
  rejectionCaseIds: string[];

  /** Snapshot cases for replay/cache equivalence. */
  snapshotCases: string[];

  /** Human-readable fixture IDs. */
  fixtureIds: string[];

  /** Provenance requirements for this capability. */
  provenanceRequirements: string[];

  /** Stage gate this capability belongs to (1, 2, or 3). */
  stageGate: StageGate;

  /** Hash of the evidence artifact validating this capability. */
  evidenceArtifactHash: string;
}

// ─── CapabilityManifest ──────────────────────────────────────────────────────

/**
 * Versioned registry of all capability manifest entries.
 *
 * Every claimed capability maps to capability ID, S|C|X status,
 * schema/normalization versions, supported input forms,
 * reference/property/rejection cases, evidence artifact hash.
 */
export interface CapabilityManifest {
  /** Manifest version string. */
  version: string;

  /** All capability entries. */
  entries: CapabilityManifestEntry[];

  /** Registry hash — deterministic hash over all entries. */
  registryHash: string;
}
