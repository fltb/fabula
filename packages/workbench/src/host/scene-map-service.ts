/**
 * Host Scene Map service (plan 9.2): derives the browser-safe Scene Map view
 * (chapter-grouped summary rows + cross-chapter strips) and the scene-detail
 * view (canonical diff, affected entities, graph position, boundary hashes,
 * discourse projection) from the accepted source of one open project session.
 *
 * Every value is derived from the immutable accepted source and the session's
 * Core execution repository — never from Git, never from caller-supplied
 * bytes, and never from render-time material (which is why the render-only
 * `promptContractHash` is absent from the hashes DTO). The context-fingerprint
 * stale flag (plan 9.2.5) compares the `context.sceneHash` written into each
 * adopted `scenes/<eventId>.md` frontmatter against the execution-repo
 * sceneHash of the current committed render.
 */

import { createHash } from 'node:crypto';
import {
  type AcceptedSceneRecord,
  type CoreExecutionRepository,
  type EntityDetail,
  type NarrativeEvent,
  type ProjectCompilation,
  type ProjectSourceSnapshotV1,
  type ReadResult,
  type StoryTimestamp,
  showEntity,
} from '@novalistically/core';
import type { DiffResult } from '@novalistically/core/tooling';
import YAML from 'yaml';
import type { WorkbenchGraphEdgeV1 } from '../contracts/graph.js';
import type {
  SceneContractHashesV1,
  SceneDetailViewV1,
  SceneDiscourseAssertionV1,
  SceneDiscourseProjectionV1,
  SceneEmotionalValencePointV1,
  SceneGreyLineAppearanceV1,
  SceneMapChapterV1,
  SceneMapStripsV1,
  SceneMapViewV1,
  SceneSummaryRowV1,
  SceneThreadProgressPointV1,
} from '../contracts/scene.js';
import { projectCanonicalGraphRuntime } from './graph-projection.js';
import type { ProjectSession } from './project-session.js';
import type { CanonicalStateProjectionService } from './state/canonical-state-projection.js';
/** One accepted-scene read from the execution repository (record + CAS revision). */
export type AcceptedSceneRead = ReadResult<AcceptedSceneRecord> | null;

/** One scene-detail load outcome: the projected view or a typed host failure. */
export type SceneDetailLoadResult =
  | { readonly ok: true; readonly view: SceneDetailViewV1 }
  | {
      readonly ok: false;
      readonly code: 'SCENE_NOT_FOUND' | 'SCENE_UNAVAILABLE';
      readonly message: string;
    };

export interface SceneMapServiceInput {
  readonly projectId: string;
  /** The open project session; its accepted source and runtime are the only inputs. */
  readonly session: ProjectSession;
  /** Canonical state projection service (per-project, diff counts + entity states). */
  readonly projection: CanonicalStateProjectionService;
  /** Core execution repository (accepted scenes, scene hashes, prose hashes). */
  readonly execution: CoreExecutionRepository;
  /**
   * Authoring-layer source carrying the `scenes/<eventId>.md` documents whose
   * frontmatter holds the adoption context fingerprint (plan 9.2.5). Defaults
   * to the session's accepted source; when the accepted source is the compiled
   * snapshot (no scene-md documents), every adopted scene reads as stale
   * (no readable fingerprint) — the honest state for an authoring-less view.
   */
  readonly authoringSource?: ProjectSourceSnapshotV1;
  /** Timestamp source for the generatedAt field; defaults to the system clock. */
  readonly now?: () => string;
  /**
   * Working-layer content of one document, by working-document id. For event
   * files the seeded working id equals the manifest logical path. Absent or
   * null means no working document is available; the scene-detail route uses
   * this port to carry the raw event YAML the scene card edits.
   */
  readonly workingContent?: (documentId: string) => Promise<string | null>;
}

export interface SceneDetailServiceInput extends SceneMapServiceInput {
  readonly eventId: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Deterministic key-sorted canonical JSON — the same algorithm the editorial
 * and render pipelines hash with, so boundary hashes match what a render
 * would compute for the same state.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Render a story timestamp to a stable display string. */
function formatStoryTime(timestamp: StoryTimestamp): string {
  switch (timestamp.type) {
    case 'absolute':
      return timestamp.value;
    case 'relative':
      return `after ${timestamp.anchor} ${timestamp.offset.amount} ${timestamp.offset.unit}`;
    case 'chapter':
      return `chapter ${timestamp.chapter}`;
    case 'offset':
      return `${timestamp.amount} ${timestamp.unit}`;
    case 'indeterminate':
      return 'indeterminate';
  }
}

/**
 * Read the context fingerprint (`context.sceneHash`) from a scene-md
 * frontmatter block. A missing or malformed block yields null — the caller
 * treats an adopted scene without a readable fingerprint as stale.
 */
export function sceneFingerprint(content: string): string | null {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (match === null) return null;
  try {
    const parsed = YAML.parse(match[1]) as { context?: { sceneHash?: unknown } } | null;
    const sceneHash = parsed?.context?.sceneHash;
    return typeof sceneHash === 'string' && sceneHash.length > 0 ? sceneHash : null;
  } catch {
    return null;
  }
}

/** Adoption state of one scene: adopted iff the execution repo holds an
 * accepted scene; the context fingerprint comes from the scene-md frontmatter
 * when the accepted source carries that document (authoring snapshot), else
 * null — an adopted scene without a readable fingerprint is stale. */
function adoptedSceneFor(
  snapshot: ProjectSourceSnapshotV1,
  eventId: string,
): { readonly adopted: boolean; readonly fingerprint: string | null } {
  const document = snapshot.documents.find(
    (candidate) => candidate.logicalPath === `scenes/${eventId}.md`,
  );
  if (document === undefined) return { adopted: false, fingerprint: null };
  return { adopted: true, fingerprint: sceneFingerprint(document.content) };
}

/** Canonical diff key prefix of one world-state entity. */
const ENTITY_DIFF_PREFIX = 'entity:';

/** Story-graph edges adjacent to one scene. */
function graphEdgesFor(
  source: ProjectSourceSnapshotV1,
  eventId: string,
): readonly WorkbenchGraphEdgeV1[] {
  try {
    return projectCanonicalGraphRuntime(source).story.edges.filter(
      (edge) => edge.predecessor === eventId || edge.dependent === eventId,
    );
  } catch {
    // The graph projection is a derived compile artifact; an unavailable
    // graph degrades only the detail view's edges, never the whole scene.
    return [];
  }
}

/** Deterministic boundary hashes of one scene plus the execution hash chain. */
function hashesFor(
  compilation: ProjectCompilation,
  source: ProjectSourceSnapshotV1,
  eventId: string,
  record: AcceptedSceneRead,
): SceneContractHashesV1 {
  const before = compilation.boundaries.stateBeforeByEventId.get(eventId) ?? {};
  const after = compilation.boundaries.stateAfterByEventId.get(eventId) ?? {};
  const beforeState = before as {
    epistemicLedger?: unknown;
    propositionCatalog?: unknown;
    commonGround?: unknown;
  };
  const worldStateHash = sha256Hex(canonicalJson(before));
  const knowledgeStateHash = sha256Hex(
    canonicalJson({
      ledger: beforeState.epistemicLedger,
      propositions: beforeState.propositionCatalog,
      commonGround: beforeState.commonGround,
    }),
  );
  return {
    // The world boundary of a scene IS its state-before (render contract §2).
    stateBeforeHash: worldStateHash,
    stateAfterHash: sha256Hex(canonicalJson(after)),
    worldStateHash,
    knowledgeStateHash,
    narratorProfileHash: sha256Hex(canonicalJson(compilation.data.narratorProfiles)),
    discourseHash: compilation.data.discourseLedger.hash,
    sourceHash: source.sourceHash,
    sceneHash: record?.value.sceneHash ?? null,
    proseHash: record?.value.proseHash ?? null,
  };
}

/** Safe discourse projection of one scene from the planned discourse ledger. */
function discourseFor(
  compilation: ProjectCompilation,
  source: ProjectSourceSnapshotV1,
  event: NarrativeEvent,
): SceneDiscourseProjectionV1 {
  const ledger = compilation.data.discourseLedger;
  const entries = ledger.entries.filter((entry) => entry.sceneId === event.id);
  const assertions: SceneDiscourseAssertionV1[] = entries.map((entry) => ({
    assertionId: entry.id,
    action: String(entry.action),
    discoursePosition: entry.discoursePosition,
  }));
  return {
    ledgerId: source.documents.some(
      (document) => document.logicalPath === 'definitions/discourse-ledger.yaml',
    )
      ? ledger.id
      : null,
    discourseMode: event.discourseMode ?? null,
    discoursePosition:
      assertions.length === 0
        ? null
        : Math.min(...assertions.map((assertion) => assertion.discoursePosition)),
    assertions,
  };
}

/**
 * Build the Scene Map view for one project session. Returns null when the
 * session has no accepted source or the accepted source fails to compile.
 * A canonical-projection failure propagates: the changed counts are sourced
 * from the projection service, so an unavailable projection must not produce
 * a silently empty map.
 */
export async function loadSceneMap(input: SceneMapServiceInput): Promise<SceneMapViewV1 | null> {
  const { projectId, session, projection, execution } = input;
  const source = session.source;
  if (source === null) return null;
  const adoptionSource = input.authoringSource ?? source;
  let compilation: ProjectCompilation;
  try {
    compilation = session.runtime.compile(source);
  } catch {
    return null;
  }
  const eventById = new Map<string, NarrativeEvent>(
    compilation.events.map((event) => [event.id, event]),
  );

  // Per-scene canonical diff counts. The projection builds its derived stream
  // once per sourceHash; the per-event replays are snapshot-backed.
  const changedCounts = new Map<string, number>();
  for (const event of compilation.events) {
    const diff: DiffResult | null = await projection.diff(source, event.id);
    changedCounts.set(event.id, diff === null ? 0 : diff.changed.length);
  }

  const chapters: SceneMapChapterV1[] = [];
  for (const [chapterNum, chapter] of [...compilation.data.chapters.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    const metadata = chapter.metadata;
    const chapterEvents = chapter.events
      .map((eventFile) => eventById.get(eventFile.event))
      .filter((event): event is NarrativeEvent => event !== undefined)
      .sort((left, right) => left.narrativeOrder - right.narrativeOrder);
    const scenes: SceneSummaryRowV1[] = [];
    for (const event of chapterEvents) {
      const record = await execution.readAcceptedScene({ projectId, eventId: event.id });
      const sourceAdoption = adoptedSceneFor(adoptionSource, event.id);
      const adopted = record?.value !== undefined || sourceAdoption.adopted;
      const fingerprint = sourceAdoption.adopted
        ? sourceAdoption.fingerprint
        : (record?.value.sceneHash ?? null);
      const currentSceneHash = record?.value.sceneHash ?? null;
      const stale =
        adopted &&
        (fingerprint === null || currentSceneHash === null || currentSceneHash !== fingerprint);
      scenes.push({
        eventId: event.id,
        title: event.title,
        sceneType: event.sceneType,
        discourseMode: event.discourseMode ?? null,
        storyTime: formatStoryTime(event.storyTime),
        coordinate: { chapter: chapterNum, narrativeOrder: event.narrativeOrder },
        changedCount: changedCounts.get(event.id) ?? 0,
        introCount: event.introduces?.length ?? 0,
        renderStatus: adopted ? (stale ? 'adopted_stale' : 'adopted_current') : 'unadopted',
        stale,
        adoptedSceneHash: fingerprint,
        currentSceneHash,
        proseHash: record?.value.proseHash ?? null,
        revisionId: record?.value.revisionId ?? null,
      });
    }
    chapters.push({
      chapterId: `chapter_${String(chapterNum).padStart(2, '0')}`,
      chapter: chapterNum,
      title: metadata?.title ?? `Chapter ${chapterNum}`,
      summary: metadata?.summary ?? '',
      plannedScenes: metadata?.plannedScenes ?? 0,
      scenes,
    });
  }

  // Cross-chapter strips over the canonical scene sequence.
  const canonicalEvents: NarrativeEvent[] = [];
  for (const eventId of compilation.boundaries.orderedEventIds) {
    const event = eventById.get(eventId);
    if (event !== undefined) canonicalEvents.push(event);
  }
  const threadProgress: SceneThreadProgressPointV1[] = [];
  const emotionalValence: SceneEmotionalValencePointV1[] = [];
  const greyLineById = new Map<
    string,
    { greyLineId: string; imagery: string; appearances: SceneGreyLineAppearanceV1[] }
  >();
  const seenAppearances = new Map<string, Set<string>>();
  for (const event of canonicalEvents) {
    for (const transaction of event.threadProgress ?? []) {
      threadProgress.push({
        eventId: event.id,
        thread: transaction.thread,
        runId: transaction.runId,
        status: transaction.status ?? null,
        phase: transaction.phase ?? null,
        advancement: transaction.advancement ?? null,
      });
    }
    if (event.emotionalValence !== undefined && event.emotionalValence.length > 0) {
      emotionalValence.push({ eventId: event.id, valence: event.emotionalValence });
    }
    for (const greyLine of event.greyLines ?? []) {
      let series = greyLineById.get(greyLine.id);
      if (series === undefined) {
        series = {
          greyLineId: greyLine.id,
          imagery: greyLine.imagery,
          appearances: [] as SceneGreyLineAppearanceV1[],
        };
        greyLineById.set(greyLine.id, series);
        seenAppearances.set(greyLine.id, new Set());
      }
      const seen = seenAppearances.get(greyLine.id) ?? new Set<string>();
      for (const node of greyLine.nodes) {
        if (seen.has(node.eventId)) continue;
        seen.add(node.eventId);
        series.appearances.push({
          eventId: node.eventId,
          narrativeOrder: node.narrativeOrder,
          semanticAccumulation: node.semanticAccumulation,
        });
      }
    }
  }
  const strips: SceneMapStripsV1 = {
    threadProgress,
    emotionalValence,
    greyLines: [...greyLineById.values()],
  };

  return {
    version: 1,
    projectId,
    chapters,
    strips,
    generatedAt: (input.now ?? (() => new Date().toISOString()))(),
  };
}

/**
 * Build the scene-detail view for one project session and event. The event
 * must be part of the compiled project and the canonical stream; anything
 * else returns a typed `SCENE_NOT_FOUND` / `SCENE_UNAVAILABLE` failure.
 */
export async function loadSceneDetail(
  input: SceneDetailServiceInput,
): Promise<SceneDetailLoadResult> {
  const { projectId, session, projection, execution, eventId } = input;
  const source = session.source;
  if (source === null) {
    return {
      ok: false,
      code: 'SCENE_UNAVAILABLE',
      message: 'The project session has no accepted source.',
    };
  }
  const adoptionSource = input.authoringSource ?? source;
  let compilation: ProjectCompilation;
  try {
    compilation = session.runtime.compile(source);
  } catch {
    return {
      ok: false,
      code: 'SCENE_UNAVAILABLE',
      message: 'The accepted source could not be compiled.',
    };
  }
  const event = compilation.events.find((candidate) => candidate.id === eventId);
  if (event === undefined) {
    return {
      ok: false,
      code: 'SCENE_NOT_FOUND',
      message: `Scene "${eventId}" is not in the compiled project.`,
    };
  }
  const diff = await projection.diff(source, eventId);
  if (diff === null) {
    return {
      ok: false,
      code: 'SCENE_NOT_FOUND',
      message: `Scene "${eventId}" is not in the canonical stream.`,
    };
  }

  const entityIds = [
    ...new Set(
      diff.changed
        .map((key) =>
          key.startsWith(ENTITY_DIFF_PREFIX) ? key.slice(ENTITY_DIFF_PREFIX.length) : null,
        )
        .filter((id): id is string => id !== null && id.length > 0),
    ),
  ];
  const entities: EntityDetail[] = [];
  for (const id of entityIds) {
    const detail = showEntity(source, id);
    if (detail !== null) entities.push(detail);
  }

  const record = await execution.readAcceptedScene({ projectId, eventId });
  // The scene's event file document: the working layer the scene card form
  // edits (documentId === manifest logical path for seeded event documents).
  let eventDocumentId: string | null = null;
  outer: for (const chapter of compilation.data.chapters.values()) {
    for (const eventFile of chapter.events) {
      if (eventFile.event === eventId) {
        eventDocumentId = eventFile.logicalPath ?? null;
        break outer;
      }
    }
  }
  const eventYaml =
    eventDocumentId === null ? null : ((await input.workingContent?.(eventDocumentId)) ?? null);
  const hashes = hashesFor(compilation, source, eventId, record);
  const adopted = adoptedSceneFor(adoptionSource, eventId);
  const stale =
    adopted.adopted &&
    (adopted.fingerprint === null ||
      hashes.sceneHash === null ||
      hashes.sceneHash !== adopted.fingerprint);

  return {
    ok: true,
    view: {
      version: 1,
      projectId,
      eventId,
      diff,
      entities,
      graphEdges: graphEdgesFor(source, eventId),
      hashes,
      discourse: discourseFor(compilation, source, event),
      renderStatus: adopted.adopted ? (stale ? 'adopted_stale' : 'adopted_current') : 'unadopted',
      stale,
      adoptedSceneHash: adopted.fingerprint,
      eventYaml,
      eventDocumentId,
    },
  };
}
