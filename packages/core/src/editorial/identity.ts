// ============================================================================
// Editorial Identity — Pure hash computations for scene provenance,
// validation identity, and immutable plan identity.
//
// None of these functions touch I/O, clock, actors, or providers.
// They are deterministic — identical inputs always produce identical outputs.
// ============================================================================

import { sha256 } from '../cache/pure-sha256.ts';
import type { BranchPath } from '../types/branch.ts';
import type { SceneSelector } from '../types/editorial.ts';

// ─── Canonical JSON ──────────────────────────────────────────────────────────

/**
 * Recursive sorted‑key canonical JSON serialization.
 * Arrays preserve original order; object keys are sorted lexicographically;
 * `undefined` members are omitted; primitives serialize normally.
 * This is the same algorithm used in `render/scene-contract.ts` but kept
 * independent so the editorial module never imports render internals.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

// ─── Scene Hashing ───────────────────────────────────────────────────────────

/** Source hash — covers the event definition + source documents content. */
export function computeSceneSourceHash(
  eventId: string,
  eventContent: string,
  sourceDocumentContents: Record<string, string>,
): string {
  const payload = {
    eventId,
    eventContent,
    sources: { ...sourceDocumentContents },
  };
  return sha256(canonicalJson(payload));
}

/**
 * Scope hash — the event's branch‑dependent scope.
 * Identical events on different branches produce different scope hashes.
 */
export function computeScopeHash(eventId: string, branchPath: BranchPath | undefined): string {
  return sha256(canonicalJson({ eventId, branchPath: branchPath ?? null }));
}

/**
 * Editorial basis covers content identity, branch, and revision basis. */
export function computeEditorialBasisHash(
  eventId: string,
  branchPath: BranchPath | undefined,
  sourceHash: string | null,
  latestRevisionId: string | null,
  latestProseHash: string | null,
): string {
  return sha256(
    canonicalJson({
      eventId,
      branchPath: branchPath ?? null,
      sourceHash,
      latestRevisionId,
      latestProseHash,
    }),
  );
}

// ─── Validation Identity ─────────────────────────────────────────────────────

export const BUILT_IN_VALIDATOR_IMPLEMENTATION_VERSION = '1';

export interface ValidatorIdentity {
  readonly name: string;
  readonly version: string;
}

export interface PluginValidationIdentity {
  readonly name: string;
  readonly version: string;
  readonly validators: readonly ValidatorIdentity[];
  readonly promptHookIdentity: string;
}

/** Exact deterministic input for the validation contract identity. */
export interface ValidationIdentityInput {
  readonly analysisContractHash: string;
  readonly builtInValidatorImplementationVersion: string;
  readonly effectiveOverrides: Readonly<Record<string, 'off' | 'warning' | 'error'>>;
  readonly validators: readonly ValidatorIdentity[];
  readonly plugins: readonly PluginValidationIdentity[];
}

export function computeValidationIdentity(input: ValidationIdentityInput): string {
  const validators = [...input.validators]
    .map((validator) => ({ ...validator }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    );
  const plugins = [...input.plugins]
    .map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      validators: [...plugin.validators]
        .map((validator) => ({ ...validator }))
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
        ),
      promptHookIdentity: plugin.promptHookIdentity,
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    );

  return sha256(
    canonicalJson({
      analysisContractHash: input.analysisContractHash,
      builtInValidatorImplementationVersion: input.builtInValidatorImplementationVersion,
      effectiveOverrides: input.effectiveOverrides,
      validators,
      plugins,
    }),
  );
}

// ─── Plan Hash ───────────────────────────────────────────────────────────────

/** Per‑scene compile output that feeds into the plan hash. */
export interface CompiledSceneIdentity {
  readonly eventId: string;
  readonly sourceHash: string;
  readonly scopeHash: string;
  readonly editorialBasisHash: string;
  readonly validationIdentity: string;
  readonly requiresProvider: boolean;
}

/** Input for computing the immutable plan hash. */
export interface PlanHashInput {
  readonly selectedEventIds: readonly string[];
  readonly scenes: readonly CompiledSceneIdentity[];
  readonly branchPath: BranchPath | undefined;
  readonly discourseBranch: string | undefined;
  readonly model: string | undefined;
  readonly providerProfile: string | undefined;
  readonly waiverHashes: readonly string[];
  readonly feedbackHashes: readonly string[];
  readonly batch:
    | { readonly batchSize?: number; readonly windowSize?: number; readonly failFast?: boolean }
    | undefined;
  readonly maxRounds: number | undefined;
}

/**
 * Compute the immutable plan hash.
 *
 * The plan hash covers everything that affects the output content:
 * - Selected event IDs + per‑scene identities
 * - Branch path and discourse branch
 * - Model and provider profile (these affect the LLM output)
 * - Waiver hashes and canonical feedback identities
 *
 * It EXCLUDES everything that is purely operational:
 * - actorId, operationId (auth / routing)
 * - timestamp, createdAt (clock‑dependent)
 * - credential fields, signal, concurrency, trace flags
 *
 * Two compiles with the same plan hash will produce byte‑identical output
 * given the same provider state.
 */
export function computePlanHash(input: PlanHashInput): string {
  const payload = {
    selectedEventIds: [...input.selectedEventIds],
    scenes: input.scenes.map((s) => ({
      eventId: s.eventId,
      sourceHash: s.sourceHash,
      scopeHash: s.scopeHash,
      editorialBasisHash: s.editorialBasisHash,
      validationIdentity: s.validationIdentity,
      requiresProvider: s.requiresProvider,
    })),
    branchPath: input.branchPath ?? null,
    discourseBranch: input.discourseBranch ?? null,
    model: input.model ?? null,
    providerProfile: input.providerProfile ?? null,
    waivers: input.waiverHashes,
    feedback: input.feedbackHashes,
    batch: input.batch ?? null,
    maxRounds: input.maxRounds ?? null,
  };
  return sha256(canonicalJson(payload));
}

// ─── Selector Hash ───────────────────────────────────────────────────────────

/**
 * Hash a SceneSelector for inclusion in a request hash or cache key.
 */
export function computeSelectorHash(selector: SceneSelector | undefined): string {
  return sha256(canonicalJson(selector ?? null));
}
