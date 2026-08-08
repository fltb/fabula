import type { DiffResult } from '@novalistically/core/tooling';
import { For, Show } from 'solid-js';
import { PROJECT_ACCESS_ROLE_GRANTS } from '../contracts/configuration.js';
import type {
  ProjectAccessRole,
  SceneAdoptionViewV1,
  SceneDetailViewV1,
  SceneSummaryRowV1,
} from '../contracts/index.js';
import { BUTTON, BUTTON_PRIMARY, KICKER } from './ui/primitives';

export interface SceneInspectorProps {
  /** Display metadata of the selected row; the detail DTO carries no title/sceneType. */
  readonly row: SceneSummaryRowV1 | null;
  readonly detail: SceneDetailViewV1 | null;
  /** Detail load failure from the workspace wiring; non-null renders an error panel. */
  readonly detailError?: string | null;
  /** Host-derived adoption preview for the selected scene revision (plan 5.2). */
  readonly adoption?: SceneAdoptionViewV1 | null;
  readonly sessionRole?: ProjectAccessRole | null;
  /** True while the workspace wiring is running the render trigger. */
  readonly renderBusy?: boolean;
  /** Render queue notice (operation id) after a successful trigger. */
  readonly renderNotice?: string | null;
  /** Render trigger failure message. */
  readonly renderError?: string | null;
  /** Author+ render trigger; the Host enforces the scope grant. */
  readonly onRenderScene?: (eventId: string) => void | Promise<void>;
  /** Explicit adoption request; the Host derives the manifest claim. */
  readonly onRequestAdoption?: (candidate: SceneAdoptionViewV1) => void;
}

/** Short hash display: 8 chars + ellipsis; full value stays in the title. */
function shortHash(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return '—';
  return value.length <= 8 ? value : `${value.slice(0, 8)}…`;
}

/** Replaces `.scene-chip` (+ the `.scene-chip-discourse` tint). */
const SCENE_CHIP =
  'inline-flex w-max items-center gap-1 whitespace-nowrap rounded-full border border-line bg-surface px-2 py-1 text-[0.625rem] font-extrabold leading-[1.3] tracking-[0.03em] text-ink-soft';

/** Replaces `.scene-inspector-card` (+ `mx-3 mb-3` when nested in technical details). */
const SCENE_CARD = 'grid gap-2 rounded-[0.625rem] border border-line bg-surface p-3';

/** Replaces `.scene-adopt-badge`; the status tint is appended at use. */
const ADOPT_BADGE =
  'rounded-full border border-line px-1.5 py-px font-mono text-[0.5625rem] leading-[1.3] text-muted';

/** Replaces `.scene-adopt-badge-adopted_current` / `-adopted_stale`. */
const ADOPT_BADGE_TONE: Readonly<Record<string, string>> = {
  adopted_current: 'text-success bg-ready-surface border-ready-border',
  adopted_stale: 'text-warning bg-loading-surface border-loading-border',
};

function roleRank(role: ProjectAccessRole | null | undefined): number {
  if (role === null || role === undefined) return 0;
  return PROJECT_ACCESS_ROLE_GRANTS[role].rank;
}

/** Mutations require BOTH a wired callback and author rank+ (unknown role defers to wiring). */
function canMutate(
  rank: number,
  wired: boolean,
  requiredRank: number = PROJECT_ACCESS_ROLE_GRANTS.author.rank,
): boolean {
  return wired && (rank === 0 || rank >= requiredRank);
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** `entity:stone` → { kind: 'entity', id: 'stone' }. */
function splitDiffKey(key: string): { readonly kind: string; readonly id: string } {
  const colon = key.indexOf(':');
  if (colon === -1) return { kind: 'state', id: key };
  return { kind: key.slice(0, colon), id: key.slice(colon + 1) };
}

/** Attribute-level rows of one changed entry (entity/thread/relationship state). */
interface DiffAttributeRow {
  readonly entityId: string;
  readonly attribute: string;
  readonly before: unknown;
  readonly after: unknown;
}

/** Flatten one changed key into display rows: object states become per-attribute rows. */
function diffRows(key: string, diff: DiffResult): DiffAttributeRow[] {
  const { kind, id } = splitDiffKey(key);
  const beforeValue = diff.before[key] ?? null;
  const afterValue = diff.after[key] ?? null;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isRecord(beforeValue) && !isRecord(afterValue)) {
    return [{ entityId: id, attribute: kind, before: beforeValue, after: afterValue }];
  }
  const left = isRecord(beforeValue) ? beforeValue : {};
  const right = isRecord(afterValue) ? afterValue : {};
  const rows: DiffAttributeRow[] = [];
  for (const attribute of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const before = left[attribute] ?? null;
    const after = right[attribute] ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    rows.push({ entityId: id, attribute, before, after });
  }
  return rows;
}

/**
 * Collect every narrative hint disclosed by the changed states. WorldState
 * records carry `narrativeHint` / `narrativeHints` on thread and entity
 * states; the amber box renders only what the projection actually discloses.
 */
function narrativeHints(diff: DiffResult): string[] {
  const hints: string[] = [];
  for (const key of diff.changed) {
    for (const side of ['before', 'after'] as const) {
      const value = diff[side][key];
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (typeof record.narrativeHint === 'string') hints.push(record.narrativeHint);
      if (Array.isArray(record.narrativeHints)) {
        for (const item of record.narrativeHints) {
          if (typeof item === 'string') hints.push(item);
        }
      }
    }
  }
  return hints;
}

function EmptyInspector(props: { readonly detailError?: string | null }) {
  return (
    <div
      class="grid gap-2 rounded-[0.625rem] border border-dashed border-line-strong bg-surface p-5"
      aria-live="polite"
    >
      <Show
        when={props.detailError}
        fallback={
          <>
            <h3 class="m-0 text-sm">未选择场景</h3>
            <p class="m-0 text-xs leading-[1.55] text-muted">
              在场景地图中选择一个场景行以查看其编译契约。
            </p>
          </>
        }
      >
        <h3 class="m-0 text-sm">场景详情加载失败</h3>
        <p class="m-0 text-xs leading-[1.55] text-muted">{props.detailError}</p>
      </Show>
    </div>
  );
}

function SceneInspectorBody(props: {
  readonly row: SceneSummaryRowV1 | null;
  readonly detail: SceneDetailViewV1;
  readonly adoption?: SceneAdoptionViewV1 | null;
  readonly sessionRole?: ProjectAccessRole | null;
  readonly renderBusy?: boolean;
  readonly renderNotice?: string | null;
  readonly renderError?: string | null;
  readonly onRenderScene?: (eventId: string) => void | Promise<void>;
  readonly onRequestAdoption?: (candidate: SceneAdoptionViewV1) => void;
}) {
  const detail = () => props.detail;
  const row = () => props.row;
  const hints = () => narrativeHints(detail().diff);
  const rank = () => roleRank(props.sessionRole);
  const canRender = () => canMutate(rank(), props.onRenderScene !== undefined);
  const renderStatusLabel = () => {
    const status = detail().renderStatus;
    if (status === 'adopted_stale') return '已过期（内容变了）';
    if (status === 'adopted_current') return '已收下';
    return '未收下';
  };
  const adoptionCandidate = () =>
    props.adoption !== null &&
    props.adoption !== undefined &&
    props.adoption.eventId === detail().eventId
      ? props.adoption
      : null;
  const canAdopt = () =>
    detail().renderStatus === 'unadopted' &&
    adoptionCandidate() !== null &&
    adoptionCandidate()?.released &&
    props.onRequestAdoption !== undefined;

  return (
    <>
      <div class="grid gap-1">
        <p class={KICKER}>场景详情</p>
        <div class="flex flex-wrap items-baseline gap-2">
          <span class="font-mono text-sm font-extrabold text-accent-deep">{detail().eventId}</span>
          <h3 class="m-0 text-[0.9375rem]">{row()?.title ?? detail().eventId}</h3>
        </div>
        <div class="flex flex-wrap gap-1">
          <Show when={(row()?.sceneType?.length ?? 0) > 0}>
            <span class={SCENE_CHIP}>{row()?.sceneType}</span>
          </Show>
          <Show when={detail().discourse.discourseMode !== null}>
            <span class={`${SCENE_CHIP} text-focus`}>{detail().discourse.discourseMode}</span>
          </Show>
          <Show when={(row()?.storyTime?.length ?? 0) > 0}>
            <span class={SCENE_CHIP}>{row()?.storyTime}</span>
          </Show>
          <Show when={row() !== null}>
            <span class={SCENE_CHIP}>
              CH.{row()?.coordinate.chapter} · #{row()?.coordinate.narrativeOrder}
            </span>
          </Show>
        </div>
      </div>

      <section class={SCENE_CARD} aria-label="渲染状态">
        <div class="flex items-center justify-between gap-2">
          <h4 class="m-0 text-[0.6875rem] uppercase tracking-[0.06em] text-muted">渲染状态</h4>
          <span
            class={`${ADOPT_BADGE} ${ADOPT_BADGE_TONE[detail().renderStatus] ?? ''}`}
            data-status={detail().renderStatus}
          >
            {renderStatusLabel()}
          </span>
        </div>
        <Show when={detail().stale}>
          <p class="m-0 rounded-[0.375rem] border border-loading-border bg-loading-surface p-2 text-[0.6875rem] leading-[1.5] text-warning">
            该场景的上下文指纹已变化（frontmatter sceneHash ≠ 当前编译
            sceneHash）。重新渲染不会静默覆盖手改散文。
          </p>
        </Show>
        <dl class="m-0 grid gap-1">
          <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
            <dt class="text-[0.625rem] font-extrabold text-muted">sceneHash</dt>
            <dd
              class="m-0 font-mono text-[0.6875rem] [overflow-wrap:anywhere]"
              title={detail().hashes.sceneHash ?? undefined}
            >
              {shortHash(detail().hashes.sceneHash)}
            </dd>
          </div>
          <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
            <dt class="text-[0.625rem] font-extrabold text-muted">proseHash</dt>
            <dd
              class="m-0 font-mono text-[0.6875rem] [overflow-wrap:anywhere]"
              title={detail().hashes.proseHash ?? undefined}
            >
              {shortHash(detail().hashes.proseHash)}
            </dd>
          </div>
        </dl>
        <div class="flex flex-wrap gap-2">
          <button
            class={`${BUTTON} ${BUTTON_PRIMARY}`}
            type="button"
            disabled={!canRender() || props.renderBusy === true}
            onClick={() => props.onRenderScene?.(detail().eventId)}
          >
            {props.renderBusy === true ? '排队中…' : '渲染场景'}
          </button>
          <Show when={detail().renderStatus === 'unadopted'}>
            <button
              class={BUTTON}
              type="button"
              disabled={!canAdopt() || props.renderBusy === true}
              onClick={() => {
                const candidate = adoptionCandidate();
                if (candidate !== null) props.onRequestAdoption?.(candidate);
              }}
            >
              收下这版
            </button>
          </Show>
        </div>
        <Show when={detail().renderStatus === 'unadopted' && adoptionCandidate() === null}>
          <p class="m-0 text-[0.6875rem] leading-[1.5] text-muted">
            渲染该场景以产生 released revision 后再采纳；若已存在 released
            revision，选中行后会显示采纳预览。
          </p>
        </Show>
        <Show when={props.renderError !== null && props.renderError !== undefined}>
          <p
            class="m-0 rounded-[0.375rem] border border-error-border bg-error-surface p-2 text-[0.6875rem] leading-[1.5] text-danger"
            aria-live="polite"
          >
            {props.renderError}
          </p>
        </Show>
        <Show when={props.renderNotice !== null && props.renderNotice !== undefined}>
          <p class="m-0 text-[0.6875rem] leading-[1.5] text-muted" aria-live="polite">
            {props.renderNotice}
          </p>
        </Show>
      </section>

      <section class={SCENE_CARD} aria-label="WorldState diff">
        <div class="flex items-center justify-between gap-2">
          <h4 class="m-0 text-[0.6875rem] uppercase tracking-[0.06em] text-muted">
            WorldState 差异
          </h4>
          <span class="font-mono text-[0.625rem] text-muted">
            {detail().diff.changed.length} 处变化
          </span>
        </div>
        <Show
          when={detail().diff.changed.length > 0}
          fallback={
            <p class="m-0 text-[0.6875rem] leading-[1.5] text-muted">
              该场景没有 world-state 变化。
            </p>
          }
        >
          <table class="w-full border-collapse font-mono text-[0.6875rem]">
            <thead>
              <tr>
                <th class="border-b border-line px-2 py-1 text-left text-[0.5625rem] uppercase tracking-[0.06em] text-muted">
                  实体
                </th>
                <th class="border-b border-line px-2 py-1 text-left text-[0.5625rem] uppercase tracking-[0.06em] text-muted">
                  属性
                </th>
                <th class="border-b border-line px-2 py-1 text-left text-[0.5625rem] uppercase tracking-[0.06em] text-muted">
                  变化
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={detail().diff.changed}>
                {(key) => (
                  <For each={diffRows(key, detail().diff)}>
                    {(attributeRow) => (
                      <tr>
                        <td class="border-b border-dashed border-line px-2 py-1 align-top [overflow-wrap:anywhere] font-bold">
                          {attributeRow.entityId}
                        </td>
                        <td class="border-b border-dashed border-line px-2 py-1 align-top [overflow-wrap:anywhere] text-muted">
                          {attributeRow.attribute}
                        </td>
                        <td class="border-b border-dashed border-line px-2 py-1 align-top [overflow-wrap:anywhere]">
                          <Show
                            when={attributeRow.before !== null}
                            fallback={
                              <span class="font-bold text-success">
                                + {formatValue(attributeRow.after)}
                              </span>
                            }
                          >
                            <span class="text-danger opacity-75 line-through">
                              {formatValue(attributeRow.before)}
                            </span>
                            <Show when={attributeRow.after !== null}>
                              <span class="px-1 text-muted">→</span>
                              <span class="font-bold text-success">
                                {formatValue(attributeRow.after)}
                              </span>
                            </Show>
                            <Show when={attributeRow.after === null}>
                              <span class="italic text-danger"> (移除)</span>
                            </Show>
                          </Show>
                        </td>
                      </tr>
                    )}
                  </For>
                )}
              </For>
            </tbody>
          </table>
        </Show>
        <Show when={hints().length > 0}>
          <div
            class="mt-2 grid gap-1 rounded-[0.375rem] border border-loading-border bg-loading-surface p-2"
            role="note"
            aria-label="叙述提示"
          >
            <span class="w-max text-[0.5625rem] font-extrabold uppercase tracking-[0.06em] text-warning">
              narrativeHint
            </span>
            <ul class="m-0 space-y-1 pl-[1.1rem] text-[0.6875rem] leading-[1.5] text-ink-soft">
              <For each={hints()}>{(hint) => <li>{hint}</li>}</For>
            </ul>
          </div>
        </Show>
      </section>

      <section class={SCENE_CARD} aria-label="实体状态">
        <div class="flex items-center justify-between gap-2">
          <h4 class="m-0 text-[0.6875rem] uppercase tracking-[0.06em] text-muted">实体状态</h4>
          <span class="font-mono text-[0.625rem] text-muted">{detail().entities.length}</span>
        </div>
        <Show
          when={detail().entities.length > 0}
          fallback={
            <p class="m-0 text-[0.6875rem] leading-[1.5] text-muted">该场景没有受影响的实体。</p>
          }
        >
          <ul class="m-0 grid list-none gap-1 p-0">
            <For each={detail().entities}>
              {(entity) => (
                <li>
                  <details class="rounded-[0.375rem] border border-line bg-surface">
                    <summary class="flex cursor-pointer items-baseline gap-2 px-2 py-1 text-[0.6875rem]">
                      <span class="rounded-full bg-surface-deep px-1.5 text-[0.5625rem] font-extrabold text-focus">
                        {entity.kind}
                      </span>
                      <span class="font-mono font-bold">{entity.id}</span>
                      <span class="text-muted">{entity.name}</span>
                    </summary>
                    <dl class="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 border-t border-dashed border-line p-2 text-[0.625rem]">
                      <For each={Object.entries(entity.state)}>
                        {([attribute, value]) => (
                          <>
                            <dt class="font-mono text-muted">{attribute}</dt>
                            <dd class="m-0 font-mono [overflow-wrap:anywhere]">
                              {formatValue(value)}
                            </dd>
                          </>
                        )}
                      </For>
                    </dl>
                  </details>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section class={SCENE_CARD} aria-label="Discourse 投影">
        <div class="flex items-center justify-between gap-2">
          <h4 class="m-0 text-[0.6875rem] uppercase tracking-[0.06em] text-muted">
            Discourse 投影
          </h4>
          <span class="font-mono text-[0.625rem] text-muted">已规划</span>
        </div>
        <dl class="m-0 grid gap-1">
          <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
            <dt class="text-[0.625rem] font-extrabold text-muted">ledger</dt>
            <dd class="m-0 font-mono text-[0.6875rem] [overflow-wrap:anywhere]">
              {detail().discourse.ledgerId ?? '—'}
            </dd>
          </div>
          <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
            <dt class="text-[0.625rem] font-extrabold text-muted">discourseMode</dt>
            <dd class="m-0 font-mono text-[0.6875rem] [overflow-wrap:anywhere]">
              {detail().discourse.discourseMode ?? '—'}
            </dd>
          </div>
          <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
            <dt class="text-[0.625rem] font-extrabold text-muted">discoursePosition</dt>
            <dd class="m-0 font-mono text-[0.6875rem] [overflow-wrap:anywhere]">
              {detail().discourse.discoursePosition ?? '—'}
            </dd>
          </div>
        </dl>
        <Show when={detail().discourse.assertions.length > 0}>
          <ul class="m-0 grid list-none gap-1 p-0">
            <For each={detail().discourse.assertions}>
              {(assertion) => (
                <li class="flex items-baseline gap-2 text-[0.6875rem]">
                  <span class="font-mono text-muted">{assertion.assertionId}</span>
                  <span class="font-bold">{assertion.action}</span>
                  <span class="ml-auto font-mono text-muted">
                    pos {assertion.discoursePosition}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section class={SCENE_CARD} aria-label="因果图位置">
        <div class="flex items-center justify-between gap-2">
          <h4 class="m-0 text-[0.6875rem] uppercase tracking-[0.06em] text-muted">因果图位置</h4>
          <span class="font-mono text-[0.625rem] text-muted">{detail().graphEdges.length}</span>
        </div>
        <Show
          when={detail().graphEdges.length > 0}
          fallback={
            <p class="m-0 text-[0.6875rem] leading-[1.5] text-muted">该场景没有已投影的图边。</p>
          }
        >
          <ul class="m-0 grid list-none gap-1 p-0">
            <For each={detail().graphEdges}>
              {(edge) => (
                <li class="flex flex-wrap items-baseline gap-2 text-[0.6875rem]">
                  <span class="rounded-full bg-accent-wash px-1.5 text-[0.5625rem] font-extrabold text-accent-deep">
                    {edge.edgeClass}
                  </span>
                  <span class="font-mono">{edge.predecessor}</span>
                  <span class="text-muted">→</span>
                  <span class="font-mono">{edge.dependent}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <details class="mt-3 rounded-[0.375rem] border border-line bg-surface-muted" open={false}>
        <summary class="cursor-pointer select-none px-3 py-2 text-[0.6875rem] font-extrabold uppercase tracking-[0.06em] text-muted">
          技术详情
        </summary>
        <section class={`${SCENE_CARD} mx-3 mb-3`} aria-label="CompiledSceneContract 哈希">
          <div class="flex items-center justify-between gap-2">
            <h4 class="m-0 text-[0.6875rem] uppercase tracking-[0.06em] text-muted">
              CompiledSceneContract
            </h4>
          </div>
          <dl class="m-0 grid gap-1">
            <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
              <dt class="text-[0.625rem] font-extrabold text-muted">stateBefore</dt>
              <dd
                class="m-0 font-mono text-[0.6875rem] [overflow-wrap:anywhere]"
                title={detail().hashes.stateBeforeHash}
              >
                {shortHash(detail().hashes.stateBeforeHash)}
              </dd>
            </div>
            <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
              <dt class="text-[0.625rem] font-extrabold text-muted">stateAfter</dt>
              <dd
                class="m-0 font-mono text-[0.6875rem] [overflow-wrap:anywhere]"
                title={detail().hashes.stateAfterHash}
              >
                {shortHash(detail().hashes.stateAfterHash)}
              </dd>
            </div>
            <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
              <dt class="text-[0.625rem] font-extrabold text-muted">worldHash</dt>
              <dd
                class="m-0 font-mono text-[0.6875rem] [overflow-wrap:anywhere]"
                title={detail().hashes.worldStateHash}
              >
                {shortHash(detail().hashes.worldStateHash)}
              </dd>
            </div>
            <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
              <dt class="text-[0.625rem] font-extrabold text-muted">knowledgeHash</dt>
              <dd
                class="m-0 font-mono text-[0.6875rem] [overflow-wrap:anywhere]"
                title={detail().hashes.knowledgeStateHash}
              >
                {shortHash(detail().hashes.knowledgeStateHash)}
              </dd>
            </div>
            <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
              <dt class="text-[0.625rem] font-extrabold text-muted">narratorProfile</dt>
              <dd
                class="m-0 font-mono text-[0.6875rem] [overflow-wrap:anywhere]"
                title={detail().hashes.narratorProfileHash}
              >
                {shortHash(detail().hashes.narratorProfileHash)}
              </dd>
            </div>
            <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
              <dt class="text-[0.625rem] font-extrabold text-muted">discourseHash</dt>
              <dd
                class="m-0 font-mono text-[0.6875rem] [overflow-wrap:anywhere]"
                title={detail().hashes.discourseHash}
              >
                {shortHash(detail().hashes.discourseHash)}
              </dd>
            </div>
            <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
              <dt class="text-[0.625rem] font-extrabold text-muted">source</dt>
              <dd
                class="m-0 font-mono text-[0.6875rem] [overflow-wrap:anywhere]"
                title={detail().hashes.sourceHash}
              >
                {shortHash(detail().hashes.sourceHash)}
              </dd>
            </div>
          </dl>
        </section>
      </details>
    </>
  );
}

/**
 * Inline Scene Inspector (plan 9.2.2): the right-hand detail panel of the
 * Scene Map. Consumes the host `SceneDetailViewV1` projection; mutations
 * (render trigger, adoption) stay wired through the workspace host callbacks.
 */
export function SceneInspector(props: SceneInspectorProps) {
  const detail = props.detail;
  if (detail === null || detail === undefined) {
    return (
      <aside
        class="sticky top-[calc(var(--wb-topbar-height)+0.75rem)] grid min-w-0 gap-4 max-[64rem]:static"
        aria-label="场景详情"
      >
        <EmptyInspector detailError={props.detailError} />
      </aside>
    );
  }
  return (
    <aside
      class="sticky top-[calc(var(--wb-topbar-height)+0.75rem)] grid min-w-0 gap-4 max-[64rem]:static"
      aria-label="场景详情"
    >
      <SceneInspectorBody
        row={props.row}
        detail={detail}
        adoption={props.adoption}
        sessionRole={props.sessionRole}
        renderBusy={props.renderBusy}
        renderNotice={props.renderNotice}
        renderError={props.renderError}
        onRenderScene={props.onRenderScene}
        onRequestAdoption={props.onRequestAdoption}
      />
    </aside>
  );
}
