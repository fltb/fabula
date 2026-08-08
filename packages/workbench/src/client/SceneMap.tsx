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
import { BUTTON, BUTTON_GHOST, BUTTON_PRIMARY, KICKER, ScreenEmpty } from './ui/primitives';
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

/** Row node dot base classes; each row appends exactly one tone class. */
const NODE_DOT =
  "relative pl-4 before:absolute before:left-0 before:top-[0.85rem] before:size-[0.625rem] before:rounded-full before:border-[0.125rem] before:border-surface before:box-content before:content-['']";

/** Row node dot tone colors (the base dot has no color of its own). */
const NODE_DOT_TONE: Record<RowRenderTone, string> = {
  released: 'before:bg-success',
  draft: 'before:bg-warning',
  blocked: 'before:bg-danger',
};

/** Scene-chip base; each chip appends exactly one text color class. */
const SCENE_CHIP =
  'inline-flex w-max items-center gap-1 whitespace-nowrap rounded-full border border-line bg-surface px-2 py-1 text-[0.625rem] font-extrabold leading-[1.3] tracking-[0.03em]';

/** Strip cell base classes. */
const STRIP_CELL =
  'min-w-[7.5rem] flex-[1_0_7.5rem] rounded-[0.375rem] border border-line border-t-2 border-t-accent-deep bg-surface px-2 py-1 text-center text-[0.625rem]';

/** Strip cell value line base classes. */
const STRIP_VAL = 'mt-0.5 block text-[0.625rem] font-bold break-words';

/** Thread-lifecycle border tones for the thread strip cells. */
const THREAD_CELL_TONE: Record<string, string> = {
  blocked: ' border-danger! border-t-danger',
  abandoned: ' border-danger! border-t-danger',
  retired: ' border-danger! border-t-danger',
  completed: ' border-success border-t-success',
};

/** Thread-lifecycle value tones for the thread strip cells. */
const THREAD_VAL_TONE: Record<string, string> = {
  blocked: ' text-danger',
  abandoned: ' text-danger',
  retired: ' text-danger',
  planned: ' text-success',
};

function SceneMapEmpty(props: {
  readonly mapError?: string | null;
  readonly onRefresh?: () => void;
}) {
  return (
    <ScreenEmpty
      title={props.mapError ? '场景地图加载失败' : '暂无场景地图投影'}
      body={props.mapError || '在 Host 中打开已认证的项目以加载章节分组的场景地图。'}
    >
      <Show when={Boolean(props.mapError) && props.onRefresh !== undefined}>
        <button class={BUTTON} type="button" onClick={() => props.onRefresh?.()}>
          重试
        </button>
      </Show>
    </ScreenEmpty>
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
    <section class="mx-auto grid max-w-[78rem] gap-6" aria-labelledby="scene-map-heading">
      <header class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class={KICKER}>场景地图 · 章节分组场景建模总览</p>
          <h2 class="m-0" id="scene-map-heading">
            {props.projectId ?? '场景地图'}
          </h2>
        </div>
        <div class="flex flex-wrap gap-2">
          <span class={`${SCENE_CHIP} text-ink-soft`}>
            {props.map?.chapters.length ?? 0} 章 / {allScenes().length} 场
          </span>
          <span class={`${SCENE_CHIP} text-success`}>{toneCounts().released} 已发布</span>
          <span class={`${SCENE_CHIP} text-warning`}>{toneCounts().draft} 草稿</span>
          <span class={`${SCENE_CHIP} text-danger`}>{toneCounts().blocked} 未渲染</span>
        </div>
      </header>

      <Show
        when={props.map !== null && props.map !== undefined}
        fallback={<SceneMapEmpty mapError={props.mapError} onRefresh={props.onRefresh} />}
      >
        <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div class="grid min-w-0 gap-5">
            <Show
              when={(props.map?.chapters?.length ?? 0) > 0}
              fallback={
                <ScreenEmpty title="暂无已编译场景" body="已接受的源尚未编译出章节或场景。" />
              }
            >
              <For each={props.map?.chapters}>
                {(chapter) => (
                  <section
                    class="overflow-hidden rounded-[0.625rem] border border-line bg-surface shadow-[var(--wb-shadow-panel)]"
                    aria-labelledby={`chapter-${chapter.chapterId}`}
                  >
                    <header class="flex items-baseline gap-3 border-b border-line bg-surface-muted px-4 py-3">
                      <span class="whitespace-nowrap font-mono text-[0.8125rem] font-extrabold text-accent-deep">
                        CH.{chapter.chapter}
                      </span>
                      <span class="text-sm font-bold" id={`chapter-${chapter.chapterId}`}>
                        {chapter.title}
                      </span>
                      <span class="ml-auto whitespace-nowrap font-mono text-[0.6875rem] text-muted">
                        {chapterEventRange(chapter)} · {chapter.scenes.length} 场 · 计划{' '}
                        {chapter.plannedScenes}
                      </span>
                    </header>
                    <Show when={chapter.summary.length > 0}>
                      <p class="m-0 border-b border-line px-4 py-2 text-xs leading-[1.55] text-muted">
                        {chapter.summary}
                      </p>
                    </Show>
                    <ol class="m-0 grid list-none gap-2 px-4 py-3">
                      <For each={chapter.scenes}>
                        {(scene) => {
                          const tone = rowTone(scene);
                          const selected = selectedEventId() === scene.eventId;
                          return (
                            <li
                              class={`${NODE_DOT} ${NODE_DOT_TONE[tone]}${selected ? ' before:shadow-[0_0_0_0.1875rem_var(--wb-accent-wash)]' : ''}`}
                            >
                              <div
                                class="cursor-pointer rounded-[0.375rem] border border-line bg-surface hover:border-line-strong hover:bg-surface-muted aria-selected:border-accent aria-selected:shadow-[inset_0_0_0_0.0625rem_var(--wb-accent)]"
                                role="option"
                                tabIndex={0}
                                aria-selected={selected}
                                aria-label={`场景 ${scene.eventId} ${scene.title}`}
                                onClick={() => selectScene(scene.eventId)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    selectScene(scene.eventId);
                                  }
                                }}
                              >
                                <div class="flex items-start gap-3 px-3 py-2">
                                  <span class="min-w-8 pt-0.5 font-mono text-[0.6875rem] font-extrabold text-accent-deep">
                                    {scene.eventId}
                                  </span>
                                  <div class="min-w-0 flex-1">
                                    <div class="text-[0.8125rem] font-bold leading-[1.35]">
                                      {scene.title}
                                    </div>
                                    <div class="mt-0.5 text-[0.6875rem] text-muted">
                                      {scene.sceneType}
                                      {scene.discourseMode !== null
                                        ? ` · ${scene.discourseMode}`
                                        : ''}{' '}
                                      · {scene.storyTime}
                                    </div>
                                    <div class="mt-1 flex flex-wrap gap-1">
                                      <span class="whitespace-nowrap rounded-full border border-line px-1.5 py-px font-mono text-[0.5625rem] leading-[1.3] text-muted text-success border-ready-border">
                                        {scene.changedCount} 处变更
                                      </span>
                                      <span class="whitespace-nowrap rounded-full border border-line px-1.5 py-px font-mono text-[0.5625rem] leading-[1.3] text-muted text-warning border-loading-border">
                                        {scene.introCount} 次引入
                                      </span>
                                      <span
                                        classList={{
                                          'whitespace-nowrap rounded-full border border-line px-1.5 py-px font-mono text-[0.5625rem] leading-[1.3] text-muted': true,
                                          'text-success border-ready-border bg-ready-surface':
                                            scene.renderStatus === 'adopted_current',
                                          'text-warning border-loading-border bg-loading-surface':
                                            scene.renderStatus === 'adopted_stale',
                                        }}
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
                                  <div class="ml-auto min-w-[9.5rem] text-right">
                                    <div
                                      class="break-words font-mono text-[0.625rem] text-muted"
                                      title={`adoptedSceneHash=${scene.adoptedSceneHash ?? '—'} · currentSceneHash=${scene.currentSceneHash ?? '—'} · proseHash=${scene.proseHash ?? '—'} · revision=${scene.revisionId ?? '—'}`}
                                    >
                                      <span class="text-muted">哈希</span>{' '}
                                      {shortHash(scene.adoptedSceneHash)}
                                      <span class="text-muted">→</span>
                                      {shortHash(scene.currentSceneHash)}
                                    </div>
                                    <div
                                      class="mt-1 inline-flex items-center gap-1 text-[0.625rem] font-bold data-[tone=released]:text-success data-[tone=draft]:text-warning data-[tone=blocked]:text-danger"
                                      data-tone={tone}
                                      title={RENDER_TONE_TITLE[tone]}
                                    >
                                      <span
                                        class="inline-block size-2 rounded-full bg-current"
                                        aria-hidden="true"
                                      />
                                      {RENDER_TONE_LABEL[tone]}
                                    </div>
                                    <button
                                      type="button"
                                      class={`${BUTTON} ${BUTTON_GHOST} mt-2 px-2! py-0.5! text-[0.6875rem]`}
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
                                    class="mt-2 rounded-[0.375rem] border border-line bg-surface-muted p-3"
                                    aria-label={`编辑场景 ${scene.eventId}`}
                                  >
                                    <div class="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(10rem,1fr))]">
                                      <label class="flex flex-col gap-1 text-xs text-ink-soft">
                                        <span>标题</span>
                                        <input
                                          class="w-full rounded-[0.375rem] border border-line bg-surface px-2 py-1.5 text-ink"
                                          type="text"
                                          value={draft().title}
                                          onInput={(event) =>
                                            updateDraft({ title: event.currentTarget.value })
                                          }
                                          aria-label={`标题 ${scene.eventId}`}
                                        />
                                      </label>
                                      <label class="col-span-full flex flex-col gap-1 text-xs text-ink-soft">
                                        <span>正文（sceneBrief + beats）</span>
                                        <textarea
                                          class="w-full rounded-[0.375rem] border border-line bg-surface px-2 py-1.5 text-ink"
                                          rows={6}
                                          value={draft().body}
                                          onInput={(event) =>
                                            updateDraft({ body: event.currentTarget.value })
                                          }
                                          aria-label={`正文 ${scene.eventId}`}
                                          placeholder="第一段为场景概述；以 - 开头的行作为 beats。"
                                        />
                                      </label>
                                      <label class="flex flex-col gap-1 text-xs text-ink-soft">
                                        <span>情绪</span>
                                        <select
                                          class="w-full rounded-[0.375rem] border border-line bg-surface px-2 py-1.5 text-ink"
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
                                      <label class="flex flex-col gap-1 text-xs text-ink-soft">
                                        <span>时间</span>
                                        <select
                                          class="w-full rounded-[0.375rem] border border-line bg-surface px-2 py-1.5 text-ink"
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
                                      <label class="flex flex-col gap-1 text-xs text-ink-soft">
                                        <span>场景类型</span>
                                        <select
                                          class="w-full rounded-[0.375rem] border border-line bg-surface px-2 py-1.5 text-ink"
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
                                    <div class="mt-3 flex gap-2">
                                      <button
                                        type="button"
                                        class={`${BUTTON} ${BUTTON_PRIMARY}`}
                                        disabled={editBusy()}
                                        onClick={() => void saveEdit(scene.eventId)}
                                      >
                                        {editBusy() ? '保存中…' : '保存'}
                                      </button>
                                      <button
                                        type="button"
                                        class={BUTTON}
                                        disabled={editBusy()}
                                        onClick={cancelEdit}
                                      >
                                        取消
                                      </button>
                                    </div>
                                    <Show when={editSaved()}>
                                      <p class="mt-2 text-xs text-success" role="status">
                                        已写入工作区（尚未提交；可在 Source Studio 提交生效）。
                                      </p>
                                    </Show>
                                    <Show when={editError() !== null}>
                                      <p class="mt-2 text-xs text-danger" role="alert">
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
                <section class="grid gap-4" aria-labelledby="scene-strips-heading">
                  <h3 class="m-0 text-sm" id="scene-strips-heading">
                    跨章节条带
                  </h3>
                  <For each={threadGroups()}>
                    {(group) => (
                      <div class="grid gap-2">
                        <div class="flex items-baseline gap-3">
                          <h4 class="m-0 text-[0.8125rem]">{group.thread}</h4>
                          <span class="text-[0.6875rem] text-muted">跨章节线程推进</span>
                        </div>
                        <div class="flex items-stretch gap-1 overflow-x-auto pb-1">
                          <For each={group.points}>
                            {(point) => (
                              <div
                                class={`${STRIP_CELL}${THREAD_CELL_TONE[point.status ?? ''] ?? ''}`}
                                title={`${point.thread} · ${point.runId} · ${point.status ?? ''} ${point.phase ?? ''} ${point.advancement ?? ''}`}
                              >
                                <span class="block font-mono text-[0.5625rem] text-muted">
                                  CH.{chapterByEventId().get(point.eventId) ?? '—'}
                                </span>
                                <span
                                  class={`${STRIP_VAL}${THREAD_VAL_TONE[point.status ?? ''] ?? ''}`}
                                >
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
                    <div class="grid gap-2">
                      <div class="flex items-baseline gap-3">
                        <h4 class="m-0 text-[0.8125rem]">情感弧线</h4>
                        <span class="text-[0.6875rem] text-muted">emotionalValence 全书序列</span>
                      </div>
                      <div class="flex items-stretch gap-1 overflow-x-auto pb-1">
                        <For each={props.map?.strips.emotionalValence}>
                          {(point) => (
                            <div
                              class={`${STRIP_CELL}${/high/.test(point.valence) ? ' border-danger! border-t-danger' : ''}`}
                              title={point.valence}
                            >
                              <span class="block font-mono text-[0.5625rem] text-muted">
                                CH.{chapterByEventId().get(point.eventId) ?? '—'}
                              </span>
                              <span
                                class={`${STRIP_VAL}${
                                  /high/.test(point.valence)
                                    ? ' text-danger'
                                    : /low/.test(point.valence)
                                      ? ' text-success'
                                      : ''
                                }`}
                              >
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
                      <div class="grid gap-2">
                        <div class="flex items-baseline gap-3">
                          <h4 class="m-0 text-[0.8125rem]">
                            {series.greyLineId} · {series.imagery}
                          </h4>
                          <span class="text-[0.6875rem] text-muted">灰线跨场景累积</span>
                        </div>
                        <div class="flex items-stretch gap-1 overflow-x-auto pb-1">
                          <For each={series.appearances}>
                            {(appearance) => (
                              <div class={STRIP_CELL} title={appearance.semanticAccumulation}>
                                <span class="block font-mono text-[0.5625rem] text-muted">
                                  CH.{chapterByEventId().get(appearance.eventId) ?? '—'}
                                </span>
                                <span class={STRIP_VAL}>
                                  {appearance.eventId} {stripText(appearance.semanticAccumulation)}
                                </span>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </For>

                  <div class="flex flex-wrap items-center gap-4 text-[0.6875rem] text-muted">
                    <span>
                      <span class="mr-1 inline-block size-2 rounded-full bg-success align-baseline" />{' '}
                      已发布
                    </span>
                    <span>
                      <span class="mr-1 inline-block size-2 rounded-full bg-warning align-baseline" />{' '}
                      草稿
                    </span>
                    <span>
                      <span class="mr-1 inline-block size-2 rounded-full bg-danger align-baseline" />{' '}
                      未渲染
                    </span>
                    <span>
                      <span class="mr-1 inline-block h-2 w-2.5 rounded-[0.125rem] bg-accent-deep align-baseline" />{' '}
                      章节边界
                    </span>
                    <span class="text-muted">点击场景行打开场景详情</span>
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
