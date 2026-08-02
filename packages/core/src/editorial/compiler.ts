// Core compiler consumes immutable source snapshots and emits semantic intents only.
// ============================================================================
// Editorial Compiler — Pure transformation of editorial requests into
// immutable execution plans.
//
// The compiler is a pure function: it takes readonly data + the request and
// returns a fully-described plan.  No I/O access, no clock, no provider
// creation, no writes.
//
// Pipeline stages (all side‑effect free):
//   1. Selector preflight  → validated eventIds
//   2. Revision preflight   → validated review applicability & line basis
//   3. Per‑scene identity   → sourceHash, scopeHash, editorialBasisHash,
//                              validationIdentity
//   4. Branch contracts     → story, discourse, surface contracts
//   5. Plan hash            → immutable plan identifier
//   6. Jobs                → semantic execution intents
// ============================================================================

import type { ProjectSourceSnapshotV1 } from '../contracts/source.ts';
import type { BranchPath } from '../types/branch.ts';
import type { EditorialError, EditorialPlanSummaryV1, EditorialRenderRequestV1, SceneSelector } from '../types/editorial.ts';
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
 * This is the entire compile‑time contract — no I/O reference.
 */
export interface EditorialCompileInput {
  readonly request: Omit<EditorialRenderRequestV1, 'mutation'>;
  readonly source: ProjectSourceSnapshotV1;
  readonly catalog: SceneCatalog;
  readonly eventContents: Record<string, string>;
  readonly sourceDocumentContents: Record<string, string>;
  readonly latestRevisions: Record<string, { revisionId: string; proseHash: string } | null>;
  readonly validation: ValidationIdentityInput;
  readonly reviewComments: readonly ReviewComment[];
  readonly chapterByEventId: Record<string, number>;
  readonly requiresProviderByEventId: Record<string, boolean>;
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

/** Top-level compiler output. */
export interface EditorialCompileOutput {
  readonly planHash: string;
  readonly planSummary: EditorialPlanSummaryV1;
  readonly selectedEventIds: readonly string[];
  readonly scenes: readonly CompiledSceneInfo[];
  readonly branchContracts: BranchContracts;
  readonly selectorErrors: readonly EditorialError[];
  readonly intents: readonly EditorialCompileJob[];
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
 *   6. Jobs                 → semantic execution intents
 *
 * The function is PURE — no I/O, no clock, no providers.
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
      input.source.sourceHash,
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

  // ── 6. Jobs ─────────────────────────────────────────────

  // Semantic intents contain no filesystem access or prepared writes.

  // ── Plan summary ──────────────────────────────────────────────────

  const planSummary: EditorialPlanSummaryV1 = {
    version: 1,
    planHash,
    sourceHash: input.source.sourceHash,
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
    intents: Object.freeze(jobs),
  };
}
