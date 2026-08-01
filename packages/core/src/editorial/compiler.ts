// ============================================================================
// Editorial Compiler — Pure transformation of editorial requests into
// immutable execution plans.
//
// The compiler is a pure function: it takes readonly data + the request and
// returns a fully-described plan.  No storage access, no clock, no provider
// creation, no writes.
//
// Pipeline stages (all side‑effect free):
//   1. Selector preflight  → validated eventIds
//   2. Revision preflight   → validated review applicability & line basis
//   3. Per‑scene identity   → sourceHash, scopeHash, editorialBasisHash,
//                              validationIdentity
//   4. Branch contracts     → story, discourse, surface contracts
//   5. Plan hash            → immutable plan identifier
//   6. Read set & jobs      → what reads to verify, what work to execute
// ============================================================================

import type { StorageWrite, TransactionReadExpectation } from '../storage/types.ts';
import type { BranchPath } from '../types/branch.ts';
import type { EditorialError, EditorialPlanSummaryV1, SceneSelector } from '../types/editorial.ts';
import type { ReviewComment } from '../types/review.ts';
import {
  type CompiledSceneIdentity,
  canonicalJson,
  computeEditorialBasisHash,
  computePlanHash,
  computeSceneSourceHash,
  computeScopeHash,
  computeValidationIdentity,
  type ValidationIdentityInput,
} from './identity.ts';
import type { SceneCatalog, SelectorPreflightResult } from './selector.ts';
import { preflightSelector } from './selector.ts';

// ============================================================================
// Compile Input
// ============================================================================

/**
 * Everything the compiler needs to produce a plan.
 * This is the entire compile‑time contract — no storage reference.
 */
export interface EditorialCompileInput {
  /** The editorial request (version, projectDir, selector, revision, model, etc.). */
  readonly request: {
    readonly version: 1;
    readonly projectDir: string;
    readonly selector?: SceneSelector;
    readonly revision?: {
      readonly reviewIds?: readonly string[];
      readonly instruction?: string;
    };
    readonly model?: string;
    readonly providerProfile?: string;
    readonly branchPath?: BranchPath;
    readonly discourseBranch?: string;
    readonly waivers?: ReadonlyArray<{
      readonly gateId: string;
      readonly signedBy: string;
      readonly signedAt: string;
      readonly reason: string;
    }>;
    readonly batch?: {
      readonly batchSize?: number;
      readonly windowSize?: number;
      readonly failFast?: boolean;
    };
    readonly maxRounds?: number;
  };
  /** Branch‑scoped event catalog (all authored events reachable on this branch). */
  readonly catalog: SceneCatalog;
  /**
   * Per‑event source content and document contents for source hash computation.
   * Key = eventId, value = full serialized event content (e.g. YAML source).
   */
  readonly eventContents: Record<string, string>;
  /**
   * Source document contents for hash computation.
   * Key = source document path, value = full content.
   */
  readonly sourceDocumentContents: Record<string, string>;
  /** Current source head hash (projectSourceHash from SourceHeadV1). */
  readonly sourceHeadHash: string | null;
  /**
   * Per‑event latest revision metadata (if any).
   * Key = eventId, value = { revisionId, proseHash } or null.
   */
  readonly latestRevisions: Record<string, { revisionId: string; proseHash: string } | null>;
  /** Validation identity input — determines which validators are active. */
  readonly validation: ValidationIdentityInput;
  /** Current review ledger comments (for revision preflight). */
  readonly reviewComments: readonly ReviewComment[];
  /** Chapter number for each eventId (for revision applicability checks). */
  readonly chapterByEventId: Record<string, number>;
  /** Whether each eventId requires an LLM provider call. */
  readonly requiresProviderByEventId: Record<string, boolean>;
  /** Response files directory (formerly hardcoded as `${projectDir}/.nova/responses`). */
  readonly responsesDir: string;
  /** Path to the source-head file (formerly hardcoded as `${projectDir}/.nova/work/source-head.json`). */
  readonly sourceHeadPath: string;
}

// ============================================================================
// Compile Output
// ============================================================================

/** Per‑scene compiled info (full identity for revision store envelopes). */
export interface CompiledSceneInfo {
  readonly eventId: string;
  readonly sourceHash: string;
  readonly scopeHash: string;
  readonly editorialBasisHash: string;
  readonly validationIdentity: string;
  readonly requiresProvider: boolean;
  readonly state: CompiledSceneState;
  readonly editorialErrors: readonly EditorialError[];
}

export type CompiledSceneState =
  | 'will_render'
  | 'cache_hit'
  | 'head_reused'
  | 'locked_reused'
  | 'no_revision_needed'
  | 'preflight_failed';

/** A single job within the compiled plan. */
export interface EditorialCompileJob {
  /** Unique job ID within this plan (eventId‑based). */
  readonly jobId: string;
  /** The event this job processes. */
  readonly eventId: string;
  /** Job kind — only render for now. */
  readonly kind: 'render';
  /** Whether this job requires an LLM provider. */
  readonly requiresProvider: boolean;
  /** Pre‑computed hashes for the resulting envelope. */
  readonly identities: CompiledSceneIdentity;
}

/**
 * Full branch contracts — compiled from the catalog and request.
 * These are the story (events in narrative order), discourse (ledger actions
 * for the branch), and surface (grouping / dependency graph).
 */
export interface BranchContracts {
  /** The full event catalog sorted by narrative order (the story). */
  readonly story: {
    readonly eventIds: readonly string[];
    readonly narrativeOrderMap: Record<string, number>;
  };
  /**
   * Discourse contract — branch‑scoped planned discourse cursor info.
   * In a full implementation this would include the planned discourse ledger
   * entries filtered to events in scope.
   */
  readonly discourse: {
    readonly branchPath: BranchPath | undefined;
    readonly discourseBranch: string | undefined;
  };
  /**
   * Surface contract — render group / dependency information.
   * For now a flat list — surface planner would enrich this.
   */
  readonly surface: {
    readonly groupIds: readonly string[];
    readonly serialLanes: readonly string[][];
  };
}

/** Top‑level compiler output. */
export interface EditorialCompileOutput {
  /** Immutable plan hash (excludes actor/operation/time/credentials/runtime). */
  readonly planHash: string;
  /** Plan summary conforming to the v1 API. */
  readonly planSummary: EditorialPlanSummaryV1;
  /** Resolved event ids (deduplicated, narrative‑order sorted). */
  readonly selectedEventIds: readonly string[];
  /** Per‑scene compile info. */
  readonly scenes: readonly CompiledSceneInfo[];
  /** Branch contracts (story, discourse, surface). */
  readonly branchContracts: BranchContracts;
  /** Selector preflight result (errors only). */
  readonly selectorErrors: readonly EditorialError[];
  /** Jobs to execute. */
  readonly jobs: readonly EditorialCompileJob[];
  /**
   * Read set — the set of files/directories that must be verified
   * (via expected hashes) before the plan can be executed.
   */
  readonly readSet: readonly TransactionReadExpectation[];
  /**
   * Prepared external changes — StorageWrites that the caller MUST apply
   * as part of this compile (e.g. review application records, operation
   * journals).  The array is empty for a pure dry‑run compile.
   */
  readonly preparedExternalChanges: readonly StorageWrite[];
}

// ============================================================================
// Revision Preflight
// ============================================================================

export interface RevisionPreflightError {
  readonly reviewId: string;
  readonly eventId: string;
  readonly code: 'INVALID_REVIEW_SELECTION' | 'NO_ACCEPTED_BASE';
  readonly message: string;
}

export interface ReviewFeedbackProjection {
  readonly target: {
    readonly type: ReviewComment['target']['type'];
    readonly id: string;
    readonly lineRange?: readonly [number, number];
    readonly lineBasis?: {
      readonly revisionId: string;
      readonly proseHash: string;
    };
  };
  readonly severity: ReviewComment['severity'];
  readonly category: ReviewComment['category'];
  readonly trimmedContent: string;
}

const REVIEW_SCOPE_ORDER: Readonly<Record<ReviewComment['target']['type'], number>> = {
  novel: 0,
  chapter: 1,
  scene: 2,
  line: 3,
  character: 4,
  worldrule: 5,
};

/** Stable feedback order: scope, creation time, then immutable review ID. */
export function sortReviewFeedback(reviews: readonly ReviewComment[]): ReviewComment[] {
  return [...reviews].sort((left, right) => {
    const scopeOrder = REVIEW_SCOPE_ORDER[left.target.type] - REVIEW_SCOPE_ORDER[right.target.type];
    if (scopeOrder !== 0) return scopeOrder;
    const createdOrder = left.createdAt.localeCompare(right.createdAt);
    return createdOrder !== 0 ? createdOrder : left.id.localeCompare(right.id);
  });
}

/** Canonical feedback identity excludes lifecycle, actor, applications, and time. */
export function reviewFeedbackProjection(review: ReviewComment): ReviewFeedbackProjection {
  return {
    target: {
      type: review.target.type,
      id: review.target.id,
      ...(review.target.lineRange
        ? { lineRange: [review.target.lineRange[0], review.target.lineRange[1]] as const }
        : {}),
      ...(review.target.lineBasis
        ? {
            lineBasis: {
              revisionId: review.target.lineBasis.revisionId,
              proseHash: review.target.lineBasis.proseHash,
            },
          }
        : {}),
    },
    severity: review.severity,
    category: review.category,
    trimmedContent: review.content.trim(),
  };
}

/** Stable identity shared by preview and execution before the real comment ID exists. */
export function inlineInstructionFeedbackProjection(
  eventId: string,
  instruction: string,
): ReviewFeedbackProjection & { readonly key: 'inline_instruction' } {
  return {
    key: 'inline_instruction',
    target: { type: 'scene', id: eventId },
    severity: 'suggestion',
    category: 'style',
    trimmedContent: instruction.trim(),
  };
}

/** Validate review references against the ledger and event set. */
export function preflightRevision(
  reviewIds: readonly string[] | undefined,
  reviewComments: readonly ReviewComment[],
  selectedEventIds: readonly string[],
  chapterByEventId: Record<string, number>,
  instruction?: string,
): readonly RevisionPreflightError[] {
  const errors: RevisionPreflightError[] = [];

  if (instruction !== undefined && selectedEventIds.length !== 1) {
    errors.push({
      reviewId: 'inline_instruction',
      eventId: '',
      code: 'INVALID_REVIEW_SELECTION',
      message: 'Inline revision instruction requires exactly one selected scene.',
    });
  }

  if (!reviewIds || reviewIds.length === 0) return errors;

  const commentById: Record<string, ReviewComment> = {};
  for (const comment of reviewComments) {
    commentById[comment.id] = comment;
  }

  for (const reviewId of reviewIds) {
    const comment = commentById[reviewId];
    if (!comment) {
      errors.push({
        reviewId,
        eventId: '',
        code: 'INVALID_REVIEW_SELECTION',
        message: `Review "${reviewId}" was not found in the review ledger.`,
      });
      continue;
    }
    if (comment.status !== 'open') {
      errors.push({
        reviewId,
        eventId: '',
        code: 'INVALID_REVIEW_SELECTION',
        message: `Review "${reviewId}" is not open (status: ${comment.status}).`,
      });
      continue;
    }

    const applicableEvents = selectedEventIds.filter((eventId) => {
      const chapter = chapterByEventId[eventId] ?? 1;
      if (comment.target.type === 'novel') return true;
      if (comment.target.type === 'chapter') {
        return comment.target.id === `chapter:${chapter}`;
      }
      if (comment.target.type === 'scene' || comment.target.type === 'line') {
        return comment.target.id === eventId;
      }
      return false;
    });

    if (applicableEvents.length === 0) {
      errors.push({
        reviewId,
        eventId: '',
        code: 'INVALID_REVIEW_SELECTION',
        message: `Review "${reviewId}" (target: ${comment.target.type}:${comment.target.id}) does not apply to any selected scene.`,
      });
      continue;
    }

    if (comment.target.type === 'line' && comment.target.lineBasis === undefined) {
      for (const eventId of applicableEvents) {
        errors.push({
          reviewId,
          eventId,
          code: 'INVALID_REVIEW_SELECTION',
          message: `Line-review "${reviewId}" is missing lineBasis for event "${eventId}".`,
        });
      }
    }
  }

  return errors;
}

// ============================================================================
// Branch Contract Compilation
// ============================================================================

/**
 * Compile the full‑branch story/discourse/surface contracts from the
 * catalog and request.  Pure — no side effects.
 */
export function compileBranchContracts(
  catalog: SceneCatalog,
  branchPath: BranchPath | undefined,
  discourseBranch: string | undefined,
): BranchContracts {
  // Story contract: the full event catalog, ordered by narrative order.
  const sorted = [...catalog.events].sort((a, b) => a.narrativeOrder - b.narrativeOrder);
  const narrativeOrderMap: Record<string, number> = {};
  for (const entry of sorted) {
    narrativeOrderMap[entry.eventId] = entry.narrativeOrder;
  }

  // Discourse contract: branch + discourse branch identifiers.
  const discourse: BranchContracts['discourse'] = {
    branchPath,
    discourseBranch,
  };

  // Surface contract: flat single group (all events in one parallel group).
  // A full surface planner would produce groups from the surface config.
  const surface: BranchContracts['surface'] = {
    groupIds: ['default'],
    serialLanes: [],
  };

  return {
    story: {
      eventIds: Object.freeze(sorted.map((e) => e.eventId)),
      narrativeOrderMap,
    },
    discourse,
    surface,
  };
}

// ============================================================================
// Read Set Compilation
// ============================================================================

/**
 * Build the read set — the set of storage expectations that must hold
 * before the plan can be executed.  Pure — no storage access.
 */
export function compileReadSet(
  sourceHeadPath: string,
  responsesDir: string,
  sourceHeadHash: string | null,
  eventIds: readonly string[],
): readonly TransactionReadExpectation[] {
  const readSet: TransactionReadExpectation[] = [];

  // Source head file expectation.
  readSet.push({
    kind: 'file',
    path: sourceHeadPath,
    expectedHash: sourceHeadHash,
  });

  // Scene response files for each event.
  for (const eventId of eventIds) {
    readSet.push({
      kind: 'file',
      path: `${responsesDir}/${eventId}.json`,
      expectedHash: null, // may not exist yet
    });
  }

  return Object.freeze(readSet);
}

// ============================================================================
// Compile Editorial Run — main entry point
// ============================================================================

/**
 * Compile an editorial request into an immutable execution plan.
 *
 * This is the heart of the editorial pipeline:
 *   1. Selector preflight     → resolve eventIds, validate errors
 *   2. Revision preflight     → validate review applicability
 *   3. Per‑scene identities   → compute all hashes
 *   4. Branch contracts       → story / discourse / surface
 *   5. Plan hash              → immutable identity
 *   6. Read set & jobs        → execution scaffolding
 *
 * The function is PURE — no storage, no clock, no providers.
 * Two identical inputs ALWAYS produce two identical outputs (deep‑equal
 * and planHash‑equal).
 */
export function compileEditorialRun(input: EditorialCompileInput): EditorialCompileOutput {
  // ── 1. Selector preflight ──────────────────────────────────────────

  const preflight: SelectorPreflightResult = preflightSelector(
    input.request.selector,
    input.catalog,
  );
  const selectedEventIds = preflight.eventIds;
  const selectorErrors = preflight.errors;

  // ── 2. Revision preflight ──────────────────────────────────────────

  const revisionErrors = preflightRevision(
    input.request.revision?.reviewIds,
    input.reviewComments,
    selectedEventIds,
    input.chapterByEventId,
    input.request.revision?.instruction,
  );

  // Merge revision errors into preflight errors.  Any invalid or
  // inapplicable explicit review ID blocks the entire plan.
  const preflightErrors: readonly EditorialError[] = Object.freeze([
    ...selectorErrors,
    ...revisionErrors.map((e) => ({
      code: e.code,
      message: e.message,
      eventId: e.eventId || undefined,
    })),
  ]);
  const hasGlobalBlock = revisionErrors.length > 0;
  // ── 3. Per‑scene identities ────────────────────────────────────────

  const scenes: CompiledSceneInfo[] = [];
  const sceneIdentities: CompiledSceneIdentity[] = [];
  const jobs: EditorialCompileJob[] = [];

  const validationIdentity = computeValidationIdentity(input.validation);

  for (const eventId of selectedEventIds) {
    const eventContent = input.eventContents[eventId] ?? '';
    const sourceHash = computeSceneSourceHash(eventId, eventContent, input.sourceDocumentContents);
    const scopeHash = computeScopeHash(eventId, input.request.branchPath);
    const latestRev = input.latestRevisions[eventId] ?? null;
    const editorialBasisHash = computeEditorialBasisHash(
      eventId,
      input.request.branchPath,
      input.sourceHeadHash,
      latestRev?.revisionId ?? null,
      latestRev?.proseHash ?? null,
    );
    const requiresProvider = input.requiresProviderByEventId[eventId] ?? true;

    // Fatal if scene‑specific preflight error OR any revision error blocks globally
    const sceneErrors = preflightErrors.filter((e) => e.eventId === eventId);
    const hasFatalError = sceneErrors.length > 0 || hasGlobalBlock;

    const state: CompiledSceneState = hasFatalError
      ? 'preflight_failed'
      : requiresProvider
        ? 'will_render'
        : 'no_revision_needed';

    const identity: CompiledSceneIdentity = {
      eventId,
      sourceHash,
      scopeHash,
      editorialBasisHash,
      validationIdentity,
      requiresProvider,
    };

    sceneIdentities.push(identity);
    scenes.push({
      eventId,
      sourceHash,
      scopeHash,
      editorialBasisHash,
      validationIdentity,
      requiresProvider,
      state,
      editorialErrors: Object.freeze(sceneErrors),
    });

    if (!hasFatalError && requiresProvider) {
      jobs.push({
        jobId: `render:${eventId}`,
        eventId,
        kind: 'render',
        requiresProvider: true,
        identities: identity,
      });
    }
  }

  // ── 4. Branch contracts ────────────────────────────────────────────

  const branchContracts = compileBranchContracts(
    input.catalog,
    input.request.branchPath,
    input.request.discourseBranch,
  );

  // ── 5. Plan hash ───────────────────────────────────────────────────

  const waiverHashes = (input.request.waivers ?? []).map((waiver) => canonicalJson(waiver)).sort();
  const feedbackHashes = (input.request.revision?.reviewIds ?? []).map((reviewId) => {
    const review = input.reviewComments.find((candidate) => candidate.id === reviewId);
    return canonicalJson({
      reviewId,
      feedback: review ? reviewFeedbackProjection(review) : null,
    });
  });
  if (input.request.revision?.instruction && selectedEventIds.length === 1) {
    feedbackHashes.push(
      canonicalJson(
        inlineInstructionFeedbackProjection(
          selectedEventIds[0],
          input.request.revision.instruction,
        ),
      ),
    );
  }
  feedbackHashes.sort();

  const planHash = computePlanHash({
    selectedEventIds,
    scenes: sceneIdentities,
    branchPath: input.request.branchPath,
    discourseBranch: input.request.discourseBranch,
    model: input.request.model,
    providerProfile: input.request.providerProfile,
    waiverHashes,
    feedbackHashes,
    batch: input.request.batch,
    maxRounds: input.request.maxRounds,
  });

  // ── 6. Read set & jobs ─────────────────────────────────────────────

  const readSet = compileReadSet(
    input.sourceHeadPath,
    input.responsesDir,
    input.sourceHeadHash,
    selectedEventIds,
  );

  // ── Plan summary ──────────────────────────────────────────────────

  const planSummary: EditorialPlanSummaryV1 = {
    version: 1,
    planHash,
    projectSourceHash: input.sourceHeadHash ?? '',
    scopeHash: sceneIdentities.length > 0 ? sceneIdentities[0].scopeHash : '',
    validationIdentity,
    selectedEventIds: [...selectedEventIds],
    scenes: scenes.map((s) => ({
      eventId: s.eventId,
      editorialBasisHash: s.editorialBasisHash,
      state: s.state,
      requiresProvider: s.requiresProvider,
      editorialErrors: [...s.editorialErrors],
    })),
  };
  return {
    planHash,
    planSummary,
    selectedEventIds,
    scenes: Object.freeze(scenes),
    branchContracts,
    selectorErrors: preflightErrors,
    jobs: Object.freeze(jobs),
    readSet,
    preparedExternalChanges: Object.freeze([]),
  };
}
