import { createSignal, For, Show } from 'solid-js';
import type {
  ProjectAccessRole,
  SceneAdoptionViewV1,
  SceneDetailViewV1,
  SceneMapViewV1,
  SceneRowRenderStatusV1,
  SceneThreadProgressPointV1,
} from '../contracts/index.js';
import { SceneInspector } from './SceneInspector';

export interface SceneMapProps {
  readonly projectId: string | null;
  /** Chapter-grouped Scene Map projection; null renders an honest empty state. */
  readonly map: SceneMapViewV1 | null;
  /** Map load failure from the workspace wiring; non-null renders a retry state. */
  readonly mapError?: string | null;
  /** Detail projection of the selected scene (Scene Inspector data). */
  readonly detail: SceneDetailViewV1 | null;
  readonly detailError?: string | null;
  /** Host-derived adoption preview for the selected scene revision (plan 5.2). */
  readonly adoption?: SceneAdoptionViewV1 | null;
  readonly sessionRole?: ProjectAccessRole | null;
  readonly renderBusy?: boolean;
  readonly renderNotice?: string | null;
  readonly renderError?: string | null;
  /** Row click handler; the workspace wiring loads the scene detail. */
  readonly onSelectScene?: (eventId: string) => void | Promise<void>;
  /** Author+ render trigger forwarded to the Inspector. */
  readonly onRenderScene?: (eventId: string) => void | Promise<void>;
  /** Adoption request forwarded to the Inspector. */
  readonly onRequestAdoption?: (candidate: SceneAdoptionViewV1) => void;
  /** Re-requests the Host scene map after a mutation. */
  readonly onRefresh?: () => void | Promise<void>;
}

/** Render-pipeline tone of one row: committed+adopted, rendered-draft, or never rendered. */
type RowRenderTone = 'released' | 'draft' | 'blocked';

const RENDER_TONE_LABEL: Record<RowRenderTone, string> = {
  released: '✓ released',
  draft: '◷ draft',
  blocked: '✗ blocked',
};

const RENDER_TONE_TITLE: Record<RowRenderTone, string> = {
  released: 'A committed render exists and is adopted into the manifest.',
  draft: 'A committed render exists but is not adopted yet.',
  blocked: 'No committed render exists for this scene.',
};

const ADOPT_LABEL: Record<SceneRowRenderStatusV1, string> = {
  unadopted: 'unadopted',
  adopted_current: 'adopted · current',
  adopted_stale: 'adopted · stale',
};

/** Short hash display; the full value stays in the title tooltip. */
function shortHash(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return '—';
  return value.length <= 8 ? value : `${value.slice(0, 8)}…`;
}

/** The render dot is a pipeline axis; the adoption badge is a lifecycle axis. */
function rowTone(row: SceneSummaryRowV1): RowRenderTone {
  if (row.revisionId === null) return 'blocked';
  return row.renderStatus === 'unadopted' ? 'draft' : 'released';
}

/** First–last event ids of a chapter's rows, e.g. `E01–E09`. */
function chapterEventRange(chapter: SceneMapViewV1['chapters'][number]): string {
  if (chapter.scenes.length === 0) return '—';
  const first = chapter.scenes[0]!.eventId;
  const last = chapter.scenes[chapter.scenes.length - 1]!.eventId;
  return first === last ? first : `${first}–${last}`;
}

/** Truncate long strip text for a compact cell; full text stays in the title. */
function stripText(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return '';
  return value.length <= 40 ? value : `${value.slice(0, 40)}…`;
}

/** Thread-lifecycle tone classes for the thread strips. */
function threadTone(status: string | null | undefined): string {
  if (status === 'blocked' || status === 'abandoned' || status === 'retired') return ' high';
  if (status === 'planned') return ' low';
  if (status === 'completed') return ' milestone';
  return '';
}

function SceneMapEmpty(props: { readonly mapError?: string | null; readonly onRefresh?: () => void }) {
  return (
    <section class="screen-empty" aria-live="polite">
      <Show
        when={props.mapError}
        fallback={
          <>
            <h3>No scene map projection</h3>
            <p>Open an authenticated project in the Host to load its chapter-grouped scene map.</p>
          </>
        }
      >
        <h3>Scene map could not be loaded</h3>
        <p>{props.mapError}</p>
        <Show when={props.onRefresh !== undefined}>
          <button class="btn" type="button" onClick={() => props.onRefresh?.()}>
            Try again
          </button>
        </Show>
      </Show>
    </section>
  );
}

/**
 * Scene Map (plan 9.2.1): chapter-grouped scene rows plus cross-chapter
 * strips, with the inline Scene Inspector (plan 9.2.2) as the right-hand
 * detail panel. All data crosses the browser boundary as `SceneMapViewV1` /
 * `SceneDetailViewV1` projections; mutations stay wired through the
 * workspace host callbacks.
 */
export function SceneMap(props: SceneMapProps) {
  const [selectedEventId, setSelectedEventId] = createSignal<string | null>(null);

  const chapterByEventId = (): Map<string, number> => {
    const chapterByEvent = new Map<string, number>();
    for (const chapter of props.map?.chapters ?? []) {
      for (const scene of chapter.scenes) chapterByEvent.set(scene.eventId, chapter.chapter);
    }
    return chapterByEvent;
  };

  const selectedRow = (): SceneSummaryRowV1 | null => {
    const eventId = selectedEventId();
    if (eventId === null) return null;
    for (const chapter of props.map?.chapters ?? []) {
      const found = chapter.scenes.find((scene) => scene.eventId === eventId);
      if (found !== undefined) return found;
    }
    return null;
  };

  const selectScene = (eventId: string): void => {
    setSelectedEventId(eventId);
    props.onSelectScene?.(eventId);
  };

  const allScenes = () => props.map?.chapters.flatMap((chapter) => chapter.scenes) ?? [];
  const toneCounts = () => {
    const counts: Record<RowRenderTone, number> = { released: 0, draft: 0, blocked: 0 };
    for (const scene of allScenes()) counts[rowTone(scene)] += 1;
    return counts;
  };

  const threadGroups = () => {
    const groups: Array<{
      readonly thread: string;
      readonly points: SceneThreadProgressPointV1[];
    }> = [];
    for (const point of props.map?.strips.threadProgress ?? []) {
      let group = groups.find((candidate) => candidate.thread === point.thread);
      if (group === undefined) {
        group = { thread: point.thread, points: [] };
        groups.push(group);
      }
      group.points.push(point);
    }
    return groups;
  };

  return (
    <section class="scene-map" aria-labelledby="scene-map-heading">
      <header class="scene-map-header">
        <div>
          <p class="region-kicker">Scene Map · 章节分组 scene 建模总览</p>
          <h2 id="scene-map-heading">{props.projectId ?? 'Scene Map'}</h2>
        </div>
        <div class="scene-map-chips">
          <span class="scene-chip">
            {props.map?.chapters.length ?? 0} 章 / {allScenes().length} scenes
          </span>
          <span class="scene-chip scene-chip-green">{toneCounts().released} released</span>
          <span class="scene-chip scene-chip-amber">{toneCounts().draft} draft</span>
          <span class="scene-chip scene-chip-red">{toneCounts().blocked} blocked</span>
        </div>
      </header>

      <Show
        when={props.map !== null && props.map !== undefined}
        fallback={<SceneMapEmpty mapError={props.mapError} onRefresh={props.onRefresh} />}
      >
        <div class="scene-map-layout">
          <div class="scene-map-main">
            <Show
              when={props.map!.chapters.length > 0}
              fallback={
                <section class="screen-empty" aria-live="polite">
                  <h3>No scenes compiled</h3>
                  <p>The accepted source compiles to no chapters or scenes yet.</p>
                </section>
              }
            >
              <For each={props.map!.chapters}>
                {(chapter) => (
                  <section class="scene-chapter" aria-labelledby={`chapter-${chapter.chapterId}`}>
                    <header class="scene-chapter-head">
                      <span class="scene-chapter-id">CH.{chapter.chapter}</span>
                      <span class="scene-chapter-title" id={`chapter-${chapter.chapterId}`}>
                        {chapter.title}
                      </span>
                      <span class="scene-chapter-meta">
                        {chapterEventRange(chapter)} · {chapter.scenes.length} scenes · planned{' '}
                        {chapter.plannedScenes}
                      </span>
                    </header>
                    <Show when={chapter.summary.length > 0}>
                      <p class="scene-chapter-summary">{chapter.summary}</p>
                    </Show>
                    <ol class="scene-timeline">
                      <For each={chapter.scenes}>
                        {(scene) => {
                          const tone = rowTone(scene);
                          const selected = selectedEventId() === scene.eventId;
                          return (
                            <li
                              class={`scene-node scene-node-${tone}${selected ? ' scene-node-selected' : ''}`}
                            >
                              <div
                                class="scene-row"
                                role="button"
                                tabindex="0"
                                aria-pressed={selected}
                                aria-label={`Scene ${scene.eventId} ${scene.title}`}
                                onClick={() => selectScene(scene.eventId)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    selectScene(scene.eventId);
                                  }
                                }}
                              >
                                <div class="scene-row-main">
                                  <span class="scene-id">{scene.eventId}</span>
                                  <div class="scene-row-body">
                                    <div class="scene-title">{scene.title}</div>
                                    <div class="scene-sub">
                                      {scene.sceneType}
                                      {scene.discourseMode !== null
                                        ? ` · ${scene.discourseMode}`
                                        : ''}{' '}
                                      · {scene.storyTime}
                                    </div>
                                    <div class="scene-badges">
                                      <span class="scene-badge scene-badge-changed">
                                        {scene.changedCount} changed
                                      </span>
                                      <span class="scene-badge scene-badge-intro">
                                        {scene.introCount} intro
                                      </span>
                                      <span
                                        class={`scene-badge scene-badge-adopt scene-badge-adopt-${scene.renderStatus}`}
                                        title={
                                          scene.renderStatus === 'adopted_stale'
                                            ? 'frontmatter sceneHash 与当前编译 sceneHash 不一致'
                                            : undefined
                                        }
                                      >
                                        {ADOPT_LABEL[scene.renderStatus]}
                                      </span>
                                    </div>
                                  </div>
                                  <div class="scene-row-right">
                                    <div
                                      class="scene-hash-chain"
                                      title={`adoptedSceneHash=${scene.adoptedSceneHash ?? '—'} · currentSceneHash=${scene.currentSceneHash ?? '—'} · proseHash=${scene.proseHash ?? '—'} · revision=${scene.revisionId ?? '—'}`}
                                    >
                                      <span class="scene-hash-label">hash</span>{' '}
                                      {shortHash(scene.adoptedSceneHash)}
                                      <span class="scene-hash-arrow">→</span>
                                      {shortHash(scene.currentSceneHash)}
                                    </div>
                                    <div
                                      class="scene-render-state"
                                      data-tone={tone}
                                      title={RENDER_TONE_TITLE[tone]}
                                    >
                                      <span class="scene-render-dot" aria-hidden="true" />
                                      {RENDER_TONE_LABEL[tone]}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </li>
                          );
                        }}
                      </For>
                    </ol>
                  </section>
                )}
              </For>

              <Show
                when={
                  props.map!.strips.threadProgress.length +
                    props.map!.strips.emotionalValence.length +
                    props.map!.strips.greyLines.length >
                  0
                }
              >
                <section class="scene-strips" aria-labelledby="scene-strips-heading">
                  <h3 id="scene-strips-heading">跨章节条带</h3>
                  <For each={threadGroups()}>
                    {(group) => (
                      <div class="scene-strip">
                        <div class="scene-strip-head">
                          <h4>{group.thread}</h4>
                          <span class="scene-strip-desc">跨章节线程推进</span>
                        </div>
                        <div class="scene-strip-track">
                          <For each={group.points}>
                            {(point) => (
                              <div
                                class={`scene-strip-cell scene-strip-ch-group${threadTone(point.status)}`}
                                title={`${point.thread} · ${point.runId} · ${point.status ?? ''} ${point.phase ?? ''} ${point.advancement ?? ''}`}
                              >
                                <span class="scene-strip-ev">
                                  CH.{chapterByEventId().get(point.eventId) ?? '—'}
                                </span>
                                <span class="scene-strip-val">
                                  {point.eventId} {stripText(point.advancement ?? point.phase ?? point.status)}
                                </span>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </For>

                  <Show when={props.map!.strips.emotionalValence.length > 0}>
                    <div class="scene-strip">
                      <div class="scene-strip-head">
                        <h4>情感弧线</h4>
                        <span class="scene-strip-desc">emotionalValence 全书序列</span>
                      </div>
                      <div class="scene-strip-track">
                        <For each={props.map!.strips.emotionalValence}>
                          {(point) => (
                            <div
                              class={`scene-strip-cell scene-strip-ch-group${
                                /high/.test(point.valence)
                                  ? ' high'
                                  : /low/.test(point.valence)
                                    ? ' low'
                                    : ''
                              }`}
                              title={point.valence}
                            >
                              <span class="scene-strip-ev">
                                CH.{chapterByEventId().get(point.eventId) ?? '—'}
                              </span>
                              <span class="scene-strip-val">
                                {point.eventId} · {point.valence}
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  <For each={props.map!.strips.greyLines}>
                    {(series) => (
                      <div class="scene-strip">
                        <div class="scene-strip-head">
                          <h4>
                            {series.greyLineId} · {series.imagery}
                          </h4>
                          <span class="scene-strip-desc">灰线跨场景累积</span>
                        </div>
                        <div class="scene-strip-track">
                          <For each={series.appearances}>
                            {(appearance) => (
                              <div
                                class="scene-strip-cell scene-strip-ch-group"
                                title={appearance.semanticAccumulation}
                              >
                                <span class="scene-strip-ev">
                                  CH.{chapterByEventId().get(appearance.eventId) ?? '—'}
                                </span>
                                <span class="scene-strip-val">
                                  {appearance.eventId} {stripText(appearance.semanticAccumulation)}
                                </span>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </For>

                  <div class="scene-legend">
                    <span>
                      <span class="scene-legend-dot scene-legend-released" /> released
                    </span>
                    <span>
                      <span class="scene-legend-dot scene-legend-draft" /> draft
                    </span>
                    <span>
                      <span class="scene-legend-dot scene-legend-blocked" /> blocked
                    </span>
                    <span>
                      <span class="scene-legend-dot scene-legend-chapter" /> 章节边界
                    </span>
                    <span class="scene-legend-hint">点击 scene 行打开 Scene Inspector</span>
                  </div>
                </section>
              </Show>
            </Show>
          </div>

          <SceneInspector
            row={selectedRow()}
            detail={props.detail}
            detailError={props.detailError}
            adoption={props.adoption}
            sessionRole={props.sessionRole}
            renderBusy={props.renderBusy}
            renderNotice={props.renderNotice}
            renderError={props.renderError}
            onRenderScene={props.onRenderScene}
            onRequestAdoption={props.onRequestAdoption}
          />
        </div>
      </Show>
    </section>
  );
}
