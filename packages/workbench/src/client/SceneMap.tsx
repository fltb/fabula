import { createEffect, createSignal, For, Show } from 'solid-js';
import YAML from 'yaml';
import type {
  ProjectAccessRole,
  SceneAdoptionViewV1,
  SceneDetailViewV1,
  SceneMapViewV1,
  SceneRowRenderStatusV1,
  SceneSummaryRowV1,
  SceneThreadProgressPointV1,
} from '../contracts/index.js';
import { SceneInspector } from './SceneInspector';
import { replaceWorkingDocumentText } from './yjs-editor.js';

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
  /** Transient browser session for the scene-card Yjs writeback. */
  readonly sourceSessionId?: string | null;
}

/** Render-pipeline tone of one row: committed+adopted, rendered-draft, or never rendered. */
type RowRenderTone = 'released' | 'draft' | 'blocked';

const RENDER_TONE_LABEL: Record<RowRenderTone, string> = {
  released: '✓ 已发布',
  draft: '◷ 草稿',
  blocked: '✗ 未渲染',
};

const RENDER_TONE_TITLE: Record<RowRenderTone, string> = {
  released: '已有已提交的渲染并被收下到作品清单。',
  draft: '已有已提交的渲染，但尚未被收下。',
  blocked: '该场景还没有已提交的渲染。',
};

const ADOPT_LABEL: Record<SceneRowRenderStatusV1, string> = {
  unadopted: '未收下',
  adopted_current: '已收下',
  adopted_stale: '已过期（内容变了）',
};

/** Curated emotional-valence vocabulary drawn from the authoring fixtures (schema-free string). */
const VALENCE_OPTIONS: readonly string[] = [
  'tension',
  'wonder_anxiety',
  'fear_resentment',
  'lonely_then_protected',
  'grief_abandonment',
  'desperate_then_hopeful',
  'hopeful_earnest',
  'restless_discovery',
  'warm_then_ominous',
  'ecstatic_infatuation',
  'comic_romantic',
  'sorrow_reflection',
  'shock_resolve',
  'compassionate_solemn',
  'bittersweet_grief',
  'mysterious_anticipation',
  'triumphant_justice',
  'catastrophic_tragedy',
  'desolate_grief',
];

/** Valid sceneType values from the EventFile schema. */
const SCENE_TYPE_OPTIONS: readonly string[] = [
  'linear',
  'flashback',
  'flashforward',
  'dream',
  'parallel',
];

/** One scene-card edit draft: the 6 editable fields of the event YAML. */
interface SceneEditDraft {
  readonly title: string;
  /** sceneBrief block plus `- beat` lines, edited as one textarea. */
  readonly body: string;
  /** emotionalValence; '' = unset/clear. */
  readonly valence: string;
  /** storyTime; '' = keep the parsed value untouched. */
  readonly storyTime: string;
  readonly sceneType: string;
}

/** Split the body textarea back into sceneBrief + beats (non-`- ` lines = brief). */
function parseSceneBody(body: string): { readonly brief: string; readonly beats: string[] } {
  const beats: string[] = [];
  const briefLines: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) beats.push(trimmed.slice(2).trim());
    else briefLines.push(line);
  }
  return { brief: briefLines.join('\n').trim(), beats };
}

/** Draft derived from the map row (title/sceneType/storyTime only; body needs the detail). */
function draftFromRow(scene: SceneSummaryRowV1): SceneEditDraft {
  return {
    title: scene.title,
    body: '',
    valence: '',
    storyTime: scene.storyTime,
    sceneType: scene.sceneType,
  };
}

/** Draft derived from the detail's working event YAML; null when it cannot be read. */
function draftFromDetail(detail: SceneDetailViewV1): SceneEditDraft | null {
  const eventYaml = detail.eventYaml;
  if (typeof eventYaml !== 'string' || eventYaml.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = YAML.parse(eventYaml);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const event = parsed as Record<string, unknown>;
  const title = typeof event.title === 'string' ? event.title : '';
  const brief = typeof event.sceneBrief === 'string' ? event.sceneBrief : '';
  const beats = Array.isArray(event.beats)
    ? event.beats.filter((beat): beat is string => typeof beat === 'string')
    : [];
  const body = [brief, ...beats.map((beat) => `- ${beat}`)]
    .filter((part) => part.length > 0)
    .join('\n');
  const storyTimeRaw = event.storyTime;
  return {
    title,
    body,
    valence: typeof event.emotionalValence === 'string' ? event.emotionalValence : '',
    // Structured story times are kept as-is; only plain-string anchors are editable.
    storyTime: typeof storyTimeRaw === 'string' ? storyTimeRaw : '',
    sceneType: typeof event.sceneType === 'string' ? event.sceneType : 'linear',
  };
}

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
  const first = chapter.scenes[0]?.eventId;
  const last = chapter.scenes[chapter.scenes.length - 1]?.eventId;
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

function SceneMapEmpty(props: {
  readonly mapError?: string | null;
  readonly onRefresh?: () => void;
}) {
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

  // ── Scene card editor state (plan Step 5) ──────────────────────────────
  const [editingEventId, setEditingEventId] = createSignal<string | null>(null);
  const [editDraft, setEditDraft] = createSignal<SceneEditDraft | null>(null);
  const [editBusy, setEditBusy] = createSignal(false);
  const [editError, setEditError] = createSignal<string | null>(null);
  const [editSaved, setEditSaved] = createSignal(false);
  /** True once the author types in the form; the detail-prefill then stands down. */
  let draftTouched = false;

  const storyTimeOptions = (): string[] => {
    const options: string[] = [];
    for (const scene of allScenes()) {
      if (scene.storyTime.length > 0 && !options.includes(scene.storyTime))
        options.push(scene.storyTime);
    }
    const current = editDraft()?.storyTime ?? '';
    if (current.length > 0 && !options.includes(current)) options.push(current);
    return options;
  };

  const valenceOptions = (): string[] => {
    const options = [...VALENCE_OPTIONS];
    const current = editDraft()?.valence ?? '';
    if (current.length > 0 && !options.includes(current)) options.push(current);
    return options;
  };

  const sceneTypeOptions = (): string[] => {
    const options = [...SCENE_TYPE_OPTIONS];
    const current = editDraft()?.sceneType ?? '';
    if (current.length > 0 && !options.includes(current)) options.push(current);
    return options;
  };

  const updateDraft = (patch: Partial<SceneEditDraft>): void => {
    draftTouched = true;
    setEditDraft((current) => (current === null ? current : { ...current, ...patch }));
  };

  const openEdit = (scene: SceneSummaryRowV1): void => {
    draftTouched = false;
    setEditingEventId(scene.eventId);
    setEditError(null);
    setEditSaved(false);
    setEditBusy(false);
    const detail = props.detail;
    setEditDraft(
      detail !== null && detail !== undefined && detail.eventId === scene.eventId
        ? (draftFromDetail(detail) ?? draftFromRow(scene))
        : draftFromRow(scene),
    );
    // Ensure the detail (eventYaml + working document id) loads for prefill
    // and the writeback; the prefill effect upgrades the draft when it lands.
    selectScene(scene.eventId);
  };

  const cancelEdit = (): void => {
    draftTouched = false;
    setEditingEventId(null);
    setEditDraft(null);
    setEditError(null);
    setEditSaved(false);
    setEditBusy(false);
  };

  // Upgrade the draft from the working event YAML once the detail arrives.
  createEffect(() => {
    const eventId = editingEventId();
    const detail = props.detail;
    if (eventId === null || detail === null || detail === undefined || detail.eventId !== eventId) {
      return;
    }
    if (draftTouched) return;
    const fromDetail = draftFromDetail(detail);
    if (fromDetail !== null) setEditDraft(fromDetail);
  });

  const saveEdit = async (eventId: string): Promise<void> => {
    const draft = editDraft();
    const detail = props.detail;
    if (draft === null) return;
    if (detail === null || detail === undefined || detail.eventId !== eventId) {
      setEditError('场景数据尚未载入，请稍候再试。');
      return;
    }
    const { eventYaml, eventDocumentId } = detail;
    if (
      typeof eventYaml !== 'string' ||
      eventYaml.length === 0 ||
      typeof eventDocumentId !== 'string'
    ) {
      setEditError('该场景没有可编辑的工作区文档（可用 Source Studio 创建）。');
      return;
    }
    if (typeof props.sourceSessionId !== 'string' || props.sourceSessionId.length === 0) {
      setEditError('工作区会话不可用，无法写回。');
      return;
    }
    if (props.projectId === null) {
      setEditError('项目不可用。');
      return;
    }
    if (draft.title.trim().length === 0) {
      setEditError('标题不能为空。');
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      const raw = YAML.parse(eventYaml);
      if (typeof raw !== 'object' || raw === null) throw new Error('not an object');
      parsed = raw as Record<string, unknown>;
    } catch {
      setEditError('当前场景 YAML 无法解析，请先在 Source Studio 修复。');
      return;
    }
    const { brief, beats } = parseSceneBody(draft.body);
    // Merge exactly the 6 editable fields; every other field stays untouched.
    const merged: Record<string, unknown> = { ...parsed };
    merged.title = draft.title.trim();
    merged.sceneBrief = brief.length > 0 ? brief : (parsed.sceneBrief ?? '');
    merged.beats =
      beats.length > 0 ? beats : Array.isArray(parsed.beats) ? (parsed.beats as unknown[]) : [];
    if (draft.valence.length > 0) merged.emotionalValence = draft.valence;
    else delete merged.emotionalValence;
    if (draft.storyTime.length > 0) merged.storyTime = draft.storyTime;
    merged.sceneType =
      draft.sceneType.length > 0 ? draft.sceneType : (parsed.sceneType ?? 'linear');
    const nextYaml = YAML.stringify(merged);
    setEditBusy(true);
    setEditError(null);
    try {
      await replaceWorkingDocumentText({
        projectId: props.projectId,
        documentId: eventDocumentId,
        sessionId: props.sourceSessionId,
        text: nextYaml,
      });
      setEditSaved(true);
      // Refresh the map + detail; the detail re-reads the new working YAML.
      await props.onRefresh?.();
      await selectScene(eventId);
      draftTouched = true;
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEditBusy(false);
    }
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
              when={(props.map?.chapters?.length ?? 0) > 0}
              fallback={
                <section class="screen-empty" aria-live="polite">
                  <h3>No scenes compiled</h3>
                  <p>The accepted source compiles to no chapters or scenes yet.</p>
                </section>
              }
            >
              <For each={props.map?.chapters}>
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
                                role="option"
                                tabIndex={0}
                                aria-selected={selected}
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
                                        {scene.changedCount} 处变更
                                      </span>
                                      <span class="scene-badge scene-badge-intro">
                                        {scene.introCount} 次引入
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
                                      <span class="scene-hash-label">哈希</span>{' '}
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
                                    <button
                                      type="button"
                                      class="btn btn-ghost scene-edit-toggle"
                                      aria-label={`编辑 ${scene.eventId}`}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        openEdit(scene);
                                      }}
                                    >
                                      编辑
                                    </button>
                                  </div>
                                </div>
                              </div>
                              <Show when={editingEventId() === scene.eventId ? editDraft() : null}>
                                {(draft) => (
                                  <section
                                    class="scene-edit-form"
                                    aria-label={`编辑场景 ${scene.eventId}`}
                                  >
                                    <div class="scene-edit-grid">
                                      <label class="scene-edit-field">
                                        <span>标题</span>
                                        <input
                                          type="text"
                                          value={draft().title}
                                          onInput={(event) =>
                                            updateDraft({ title: event.currentTarget.value })
                                          }
                                          aria-label={`标题 ${scene.eventId}`}
                                        />
                                      </label>
                                      <label class="scene-edit-field scene-edit-field-wide">
                                        <span>正文（sceneBrief + beats）</span>
                                        <textarea
                                          rows={6}
                                          value={draft().body}
                                          onInput={(event) =>
                                            updateDraft({ body: event.currentTarget.value })
                                          }
                                          aria-label={`正文 ${scene.eventId}`}
                                          placeholder="第一段为场景概述；以 - 开头的行作为 beats。"
                                        />
                                      </label>
                                      <label class="scene-edit-field">
                                        <span>情绪</span>
                                        <select
                                          onInput={(event) =>
                                            updateDraft({ valence: event.currentTarget.value })
                                          }
                                          aria-label={`情绪 ${scene.eventId}`}
                                        >
                                          <option value="">（不指定）</option>
                                          {valenceOptions().map((option) => (
                                            <option
                                              value={option}
                                              selected={option === draft().valence}
                                            >
                                              {option}
                                            </option>
                                          ))}
                                        </select>
                                      </label>
                                      <label class="scene-edit-field">
                                        <span>时间</span>
                                        <select
                                          onInput={(event) =>
                                            updateDraft({ storyTime: event.currentTarget.value })
                                          }
                                          aria-label={`时间 ${scene.eventId}`}
                                        >
                                          <option value="">（保留原值）</option>
                                          {storyTimeOptions().map((option) => (
                                            <option
                                              value={option}
                                              selected={option === draft().storyTime}
                                            >
                                              {option}
                                            </option>
                                          ))}
                                        </select>
                                      </label>
                                      <label class="scene-edit-field">
                                        <span>场景类型</span>
                                        <select
                                          onInput={(event) =>
                                            updateDraft({ sceneType: event.currentTarget.value })
                                          }
                                          aria-label={`场景类型 ${scene.eventId}`}
                                        >
                                          {sceneTypeOptions().map((option) => (
                                            <option
                                              value={option}
                                              selected={option === draft().sceneType}
                                            >
                                              {option}
                                            </option>
                                          ))}
                                        </select>
                                      </label>
                                    </div>
                                    <div class="scene-edit-actions">
                                      <button
                                        type="button"
                                        class="btn btn-primary"
                                        disabled={editBusy()}
                                        onClick={() => void saveEdit(scene.eventId)}
                                      >
                                        {editBusy() ? '保存中…' : '保存'}
                                      </button>
                                      <button
                                        type="button"
                                        class="btn"
                                        disabled={editBusy()}
                                        onClick={cancelEdit}
                                      >
                                        取消
                                      </button>
                                    </div>
                                    <Show when={editSaved()}>
                                      <p class="scene-edit-note" role="status">
                                        已写入工作区（尚未提交；可在 Source Studio 提交生效）。
                                      </p>
                                    </Show>
                                    <Show when={editError() !== null}>
                                      <p class="scene-edit-error" role="alert">
                                        {editError()}
                                      </p>
                                    </Show>
                                  </section>
                                )}
                              </Show>
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
                  (props.map?.strips.threadProgress?.length ?? 0) +
                    (props.map?.strips.emotionalValence?.length ?? 0) +
                    (props.map?.strips.greyLines?.length ?? 0) >
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
                                  {point.eventId}{' '}
                                  {stripText(point.advancement ?? point.phase ?? point.status)}
                                </span>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </For>

                  <Show when={(props.map?.strips.emotionalValence?.length ?? 0) > 0}>
                    <div class="scene-strip">
                      <div class="scene-strip-head">
                        <h4>情感弧线</h4>
                        <span class="scene-strip-desc">emotionalValence 全书序列</span>
                      </div>
                      <div class="scene-strip-track">
                        <For each={props.map?.strips.emotionalValence}>
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

                  <For each={props.map?.strips.greyLines}>
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
