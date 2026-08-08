import type { EntityDetail } from '@novalistically/core';
import type { DiffResult } from '@novalistically/core/tooling';
import type { WorkbenchGraphEdgeV1 } from './graph.js';

/** Browser-safe Scene Canvas adoption state. It is an explicit preview, never a Git claim. */
export interface SceneAdoptionViewV1 {
  readonly version: 1;
  readonly eventId: string;
  readonly revisionId: string;
  readonly proseHash: string;
  readonly released: boolean;
  /** Fixed disclosure shown before an explicit authoring adoption command. */
  readonly disclosure: 'accepted generated prose will enter the authoring manifest';
}

// ─── Scene Map ───────────────────────────────────────────────────────────────
// Browser-safe Scene Map DTOs (plan 9.2.4): chapter-grouped scene summary rows
// plus cross-chapter strips. The boundary rules are absolute: no scene prose
// bytes, no filesystem paths, no Git material, and no operation internals ever
// cross this boundary. `sceneHash`/`proseHash` values are identity only —
// never content.

/** Story-clock coordinate of one scene row: chapter + authored narrative order. */
export interface SceneCoordinateV1 {
  readonly chapter: number;
  readonly narrativeOrder: number;
}

/**
 * Lifecycle badge of one scene row (plan 9.2.5): never adopted, adopted with a
 * matching context fingerprint, or adopted whose fingerprint is stale.
 */
export type SceneRowRenderStatusV1 = 'unadopted' | 'adopted_current' | 'adopted_stale';

/** One scene summary row of the Scene Map. */
export interface SceneSummaryRowV1 {
  readonly eventId: string;
  readonly title: string;
  readonly sceneType: string;
  readonly discourseMode: string | null;
  readonly storyTime: string;
  readonly coordinate: SceneCoordinateV1;
  /** Number of changed world-state keys (entity/thread/relationship) at this scene. */
  readonly changedCount: number;
  /** Number of entities introduced by this scene. */
  readonly introCount: number;
  readonly renderStatus: SceneRowRenderStatusV1;
  /**
   * Context fingerprint (9.2.5): true when the scene is adopted and the
   * frontmatter `context.sceneHash` written at adoption no longer matches the
   * execution-repo sceneHash of the current committed render.
   */
  readonly stale: boolean;
  /** Frontmatter context fingerprint (`scenes/<eventId>.md` `context.sceneHash`); null when never adopted. */
  readonly adoptedSceneHash: string | null;
  /** sceneHash of the last committed render, from the execution repository; null when never rendered. */
  readonly currentSceneHash: string | null;
  /** sha256 of the accepted prose at the last committed render; null when never rendered. */
  readonly proseHash: string | null;
  /** Revision id of the last committed render; null when never rendered. */
  readonly revisionId: string | null;
}

/** One chapter group of the Scene Map. */
export interface SceneMapChapterV1 {
  /** Authoring directory name of the chapter (e.g. `chapter_01`). */
  readonly chapterId: string;
  readonly chapter: number;
  readonly title: string;
  readonly summary: string;
  readonly plannedScenes: number;
  readonly scenes: readonly SceneSummaryRowV1[];
}

/** One thread-progress point in the canonical scene sequence. */
export interface SceneThreadProgressPointV1 {
  readonly eventId: string;
  readonly thread: string;
  readonly runId: string;
  readonly status: string | null;
  readonly phase: string | null;
  readonly advancement: string | null;
}

/** One emotional-valence point in the canonical scene sequence. */
export interface SceneEmotionalValencePointV1 {
  readonly eventId: string;
  readonly valence: string;
}

/** One grey-line appearance (the series accumulates across scenes). */
export interface SceneGreyLineAppearanceV1 {
  readonly eventId: string;
  readonly narrativeOrder: number;
  readonly semanticAccumulation: string;
}

/** One recurring grey line with its cumulative appearance list. */
export interface SceneGreyLineSeriesV1 {
  readonly greyLineId: string;
  readonly imagery: string;
  readonly appearances: readonly SceneGreyLineAppearanceV1[];
}

/** Cross-chapter strips of the Scene Map (plan 9.2.4). */
export interface SceneMapStripsV1 {
  readonly threadProgress: readonly SceneThreadProgressPointV1[];
  readonly emotionalValence: readonly SceneEmotionalValencePointV1[];
  readonly greyLines: readonly SceneGreyLineSeriesV1[];
}

/** Scene Map view: chapter-grouped scene rows plus cross-chapter strips. */
export interface SceneMapViewV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly chapters: readonly SceneMapChapterV1[];
  readonly strips: SceneMapStripsV1;
  readonly generatedAt: string;
}

// ─── Scene detail (Scene Inspector) ──────────────────────────────────────────

/**
 * Compiled boundary hashes of one scene: the deterministic subset of the
 * CompiledSceneContract plus the execution-repo hash chain. `promptContractHash`
 * is render-time-only (it includes the prompt provider) and is deliberately
 * absent; every other value is derived from the immutable accepted source and
 * matches what the render pipeline computes for the same boundary.
 */
export interface SceneContractHashesV1 {
  /** sha256 of canonical stateBefore JSON. */
  readonly stateBeforeHash: string;
  /** sha256 of canonical stateAfter JSON. */
  readonly stateAfterHash: string;
  /** CompiledSceneContract.worldStateHash — the world boundary at the scene. */
  readonly worldStateHash: string;
  /** CompiledSceneContract.knowledgeStateHash — knowledge boundary at the scene. */
  readonly knowledgeStateHash: string;
  /** CompiledSceneContract.narratorProfileHash — narrator profile configuration. */
  readonly narratorProfileHash: string;
  /** Planned discourse boundary hash (the compiled ledger hash); always present. */
  readonly discourseHash: string;
  /** Accepted source identity the boundary hashes derive from. */
  readonly sourceHash: string;
  /** sceneHash of the last committed render from the execution repository; null when never rendered. */
  readonly sceneHash: string | null;
  /** sha256 of the accepted prose at the last committed render; null when never rendered. */
  readonly proseHash: string | null;
}

/** One ledger entry bound to the scene (browser-safe disclosure projection). */
export interface SceneDiscourseAssertionV1 {
  readonly assertionId: string;
  readonly action: string;
  readonly discoursePosition: number;
}

/** Safe discourse projection of one scene from the planned discourse ledger. */
export interface SceneDiscourseProjectionV1 {
  /** Ledger id; null when the project authors no discourse ledger. */
  readonly ledgerId: string | null;
  /** Authored discourse mode of the scene (`action`, `dialogue`, …); null when absent. */
  readonly discourseMode: string | null;
  /** Scene position in the branch's planned discourse sequence; null when the ledger omits it. */
  readonly discoursePosition: number | null;
  readonly assertions: readonly SceneDiscourseAssertionV1[];
}

/** Scene detail view consumed by the inline Scene Inspector (plan 9.2.2). */
export interface SceneDetailViewV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly eventId: string;
  /** Canonical state projection diff of the scene (before/after/changed). */
  readonly diff: DiffResult;
  /** Full state of every entity changed by the scene. */
  readonly entities: readonly EntityDetail[];
  /** Story-graph position edges (provider / author_origin / internal classes). */
  readonly graphEdges: readonly WorkbenchGraphEdgeV1[];
  readonly hashes: SceneContractHashesV1;
  readonly discourse: SceneDiscourseProjectionV1;
  readonly renderStatus: SceneRowRenderStatusV1;
  /** Context fingerprint state of the adopted scene (9.2.5); false when never adopted. */
  readonly stale: boolean;
  /** Frontmatter context fingerprint; null when never adopted. */
  readonly adoptedSceneHash: string | null;
  /**
   * Raw working-layer YAML of the scene's event document — the exact text
   * the scene card form edits and rewrites through the Yjs working channel
   * (`getText('prose')`). Null when no working document is available.
   */
  readonly eventYaml?: string | null;
  /**
   * Working-document identity of the scene's event file (the Yjs ticket
   * scope); null when unavailable. For event files the seeded working
   * document id equals the manifest logical path.
   */
  readonly eventDocumentId?: string | null;
}

// ─── Scene render trigger ────────────────────────────────────────────────────

/**
 * Immediate result of `POST /scenes/:eventId/render` (plan 9.2.3): the durable
 * operation id to track in the Operation Center, plus — when a released
 * revision already exists for the current source — the adoption preview the
 * author may act on while the queued render runs.
 */
export interface SceneRenderTriggerResultV1 {
  readonly version: 1;
  /** Durable operation id; track status through the Operation Center. */
  readonly operationId: string;
  /** Present when a released revision exists for the current accepted source. */
  readonly adoption?: SceneAdoptionViewV1;
}
