// ============================================================================
// Novalistically — CAPABILITY-1: Capability Manifest Registry + Gate Validation
//
// Provides:
//   - CapabilityRegistry — register known capabilities from all STATE/GRAPH/
//     DISCOURSE/INTEGRATION domain types
//   - Stage gate validation (stages 1-3)
//   - Uncovered input → hard fail (no implicit downgrade)
//
// Binding constraints from docs/todos/capability-contract.md CAPABILITY-1:
//   (see types/capability.ts header for full list)
// ============================================================================

import type {
  CapabilityManifest,
  CapabilityManifestEntry,
  StageGate,
} from '../types/capability.js';

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown when a manifest entry is missing for a required capability.
 * No manifest entry → input default REJECTED (constraint 2).
 */
export class CapabilityGateError extends Error {
  constructor(
    message: string,
    public readonly code: CapabilityGateErrorCode,
    public readonly capabilityId?: string,
    public readonly stage?: StageGate,
  ) {
    super(message);
    this.name = 'CapabilityGateError';
  }
}

export type CapabilityGateErrorCode =
  | 'MISSING_MANIFEST_ENTRY'
  | 'UNCOVERED_INPUT'
  | 'STAGE_GATE_FAILED'
  | 'DUPLICATE_CAPABILITY_ID'
  | 'RENDER_SURFACE_INCOMPLETE';

// ─── Manifest Registry ───────────────────────────────────────────────────────

/**
 * CapabilityRegistry manages known capabilities and validates stage gates.
 *
 * Register capabilities from all STATE/GRAPH/DISCOURSE/INTEGRATION domain
 * types. Once registered, the registry can validate stage gates and reject
 * uncovered inputs.
 */
export class CapabilityRegistry {
  /** Known manifest entries, keyed by capabilityId. */
  #entries = new Map<string, CapabilityManifestEntry>();

  /** Registered manifest version. */
  #manifestVersion: string = '';

  /** Registry hash. */
  #registryHash: string = '';

  /**
   * Load a CapabilityManifest into the registry.
   * Duplicate capabilityIds cause a hard failure.
   */
  loadManifest(manifest: CapabilityManifest): void {
    this.#entries.clear();
    this.#manifestVersion = manifest.version;
    this.#registryHash = manifest.registryHash;

    for (const entry of manifest.entries) {
      if (this.#entries.has(entry.capabilityId)) {
        throw new CapabilityGateError(
          `Duplicate capabilityId in manifest: ${entry.capabilityId}`,
          'DUPLICATE_CAPABILITY_ID',
          entry.capabilityId,
        );
      }
      this.#entries.set(entry.capabilityId, entry);
    }
  }

  /** Get all registered entries. */
  get entries(): ReadonlyMap<string, CapabilityManifestEntry> {
    return this.#entries;
  }

  /** Get the manifest version. */
  get manifestVersion(): string {
    return this.#manifestVersion;
  }

  /** Get the registry hash. */
  get registryHash(): string {
    return this.#registryHash;
  }

  /**
   * Look up an entry by capabilityId.
   * Returns undefined if no entry exists.
   */
  getEntry(capabilityId: string): CapabilityManifestEntry | undefined {
    return this.#entries.get(capabilityId);
  }

  /**
   * Check whether a capabilityId has a manifest entry.
   * Constraint 2: No manifest entry → input default REJECTED.
   */
  hasEntry(capabilityId: string): boolean {
    return this.#entries.has(capabilityId);
  }

  /**
   * Assert that a capabilityId has an entry. Throws CapabilityGateError
   * if missing — no loader fallback, no docs-implied support.
   */
  assertEntry(capabilityId: string): CapabilityManifestEntry {
    const entry = this.#entries.get(capabilityId);
    if (!entry) {
      throw new CapabilityGateError(
        `No manifest entry for capability "${capabilityId}" — input REJECTED`,
        'MISSING_MANIFEST_ENTRY',
        capabilityId,
      );
    }
    return entry;
  }

  /**
   * Reject uncovered input forms. Throws CapabilityGateError if the
   * input form is not listed in any manifest entry's supportedInputForms.
   */
  assertInputCovered(capabilityId: string, inputForm: string): void {
    const entry = this.assertEntry(capabilityId);
    if (!entry.supportedInputForms.includes(inputForm)) {
      throw new CapabilityGateError(
        `Input form "${inputForm}" is not covered by capability "${capabilityId}" — ` +
          'uncovered input hard fail, no implicit downgrade',
        'UNCOVERED_INPUT',
        capabilityId,
      );
    }
  }

  // ─── Stage Gate Validation ─────────────────────────────────────────────────

  /**
   * Stage 1 gate: all declared S (supported) core capabilities must be
   * manifest-complete.
   *
   * Validates:
   *   - Every entry with status 'S' and stageGate=1 has non-empty
   *     referenceCaseIds, propertyCaseIds, rejectionCaseIds, fixtureIds,
   *     and evidenceArtifactHash.
   *   - Default offline CI runs conformance suites for S capabilities.
   */
  validateStage1(): void {
    for (const [id, entry] of this.#entries) {
      if (entry.status === 'S' && entry.stageGate === 1) {
        const failures: string[] = [];

        if (entry.referenceCaseIds.length === 0) {
          failures.push('referenceCaseIds is empty');
        }
        if (entry.propertyCaseIds.length === 0) {
          failures.push('propertyCaseIds is empty');
        }
        if (entry.rejectionCaseIds.length === 0) {
          failures.push('rejectionCaseIds is empty');
        }
        if (entry.fixtureIds.length === 0) {
          failures.push('fixtureIds is empty');
        }
        if (entry.snapshotCases.length === 0) {
          failures.push('snapshotCases is empty');
        }
        if (!entry.evidenceArtifactHash) {
          failures.push('evidenceArtifactHash is empty');
        }

        if (failures.length > 0) {
          throw new CapabilityGateError(
            `Stage 1 gate failed for capability "${id}": ${failures.join('; ')}`,
            'STAGE_GATE_FAILED',
            id,
            1,
          );
        }
      }
    }
  }

  /**
   * Stage 2 gate: external corpus, C metrics, human annotation,
   * source/legal/provenance, performance/cache/parallel evidence each
   * bound to manifest.
   *
   * Validates:
   *   - Every entry with status 'C' has provenanceRequirements set.
   *   - Every entry with stageGate <= 2 has evidenceArtifactHash.
   */
  validateStage2(): void {
    for (const [id, entry] of this.#entries) {
      if (entry.status === 'C' && entry.provenanceRequirements.length === 0) {
        throw new CapabilityGateError(
          `Stage 2 gate failed for capability "${id}": C status requires provenanceRequirements`,
          'STAGE_GATE_FAILED',
          id,
          2,
        );
      }

      if (entry.stageGate <= 2 && !entry.evidenceArtifactHash) {
        throw new CapabilityGateError(
          `Stage 2 gate failed for capability "${id}": evidenceArtifactHash is required at stage gate ${entry.stageGate}`,
          'STAGE_GATE_FAILED',
          id,
          2,
        );
      }
    }
  }

  /**
   * Stage 3 gate: every project render/assemble records manifest/version/
   * config; X or uncovered YAML/IR combinations hard fail.
   *
   * Validates:
   *   - All entries (including X) have valid schemaVersions and
   *     normalizationVersions.
   *   - RENDER-SURFACE constraint 5: at least 2 rows with specific IDs.
   */
  validateStage3(): void {
    // Every entry must have valid schema/normalization versions
    for (const [id, entry] of this.#entries) {
      if (entry.schemaVersions.length === 0) {
        throw new CapabilityGateError(
          `Stage 3 gate failed for capability "${id}": schemaVersions is empty`,
          'STAGE_GATE_FAILED',
          id,
          3,
        );
      }
      if (entry.normalizationVersions.length === 0) {
        throw new CapabilityGateError(
          `Stage 3 gate failed for capability "${id}": normalizationVersions is empty`,
          'STAGE_GATE_FAILED',
          id,
          3,
        );
      }
    }

    // Constraint 5: RENDER-SURFACE must have at least 2 rows
    this.#checkRenderSurfaceConstraint();
  }

  /**
   * Validate all three stage gates in sequence.
   */
  validateAllStages(): void {
    this.validateStage1();
    this.validateStage2();
    this.validateStage3();
  }

  /**
   * Constraint 5: RENDER-SURFACE must have at least 2 rows:
   *   - surface_scheduler_contract (S candidate)
   *   - surface_prose_continuity_outcome (C)
   */
  #checkRenderSurfaceConstraint(): void {
    let hasScheduler = false;
    let hasProseOutcome = false;

    for (const entry of this.#entries.values()) {
      if (entry.capabilityId === 'surface_scheduler_contract') {
        hasScheduler = true;
        if (entry.status !== 'S') {
          throw new CapabilityGateError(
            'RENDER-SURFACE constraint: surface_scheduler_contract must have S status',
            'RENDER_SURFACE_INCOMPLETE',
            entry.capabilityId,
          );
        }
      }
      if (entry.capabilityId === 'surface_prose_continuity_outcome') {
        hasProseOutcome = true;
        if (entry.status !== 'C') {
          throw new CapabilityGateError(
            'RENDER-SURFACE constraint: surface_prose_continuity_outcome must have C status',
            'RENDER_SURFACE_INCOMPLETE',
            entry.capabilityId,
          );
        }
      }
    }

    if (!hasScheduler || !hasProseOutcome) {
      const missing: string[] = [];
      if (!hasScheduler) missing.push('surface_scheduler_contract');
      if (!hasProseOutcome) missing.push('surface_prose_continuity_outcome');
      throw new CapabilityGateError(
        `RENDER-SURFACE constraint: missing required capabilities: ${missing.join(', ')}`,
        'RENDER_SURFACE_INCOMPLETE',
      );
    }
  }
}
