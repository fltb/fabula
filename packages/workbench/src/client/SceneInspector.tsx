import { For, Show } from 'solid-js';
import type { DiffResult } from '@novalistically/core/tooling';
import { PROJECT_ACCESS_ROLE_GRANTS } from '../contracts/configuration.js';
import type {
  ProjectAccessRole,
  SceneAdoptionViewV1,
  SceneDetailViewV1,
  SceneSummaryRowV1,
} from '../contracts/index.js';

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
    <div class="scene-inspector-empty" aria-live="polite">
      <Show
        when={props.detailError}
        fallback={
          <>
            <h3>No scene selected</h3>
            <p>Select a scene row on the Scene Map to inspect its compiled contract.</p>
          </>
        }
      >
        <h3>Scene detail could not be loaded</h3>
        <p>{props.detailError}</p>
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
    props.adoption !== null && props.adoption !== undefined &&
    props.adoption.eventId === detail().eventId
      ? props.adoption
      : null;
  const canAdopt = () =>
    detail().renderStatus === 'unadopted' &&
    adoptionCandidate() !== null &&
    adoptionCandidate()!.released &&
    props.onRequestAdoption !== undefined;

  return (
    <>
      <div class="scene-inspector-head">
        <p class="region-kicker">Scene Inspector</p>
        <div class="scene-inspector-title">
          <span class="scene-inspector-id">{detail().eventId}</span>
          <h3>{row()?.title ?? detail().eventId}</h3>
        </div>
        <div class="scene-inspector-chips">
          <Show when={row() !== null && row()!.sceneType.length > 0}>
            <span class="scene-chip">{row()!.sceneType}</span>
          </Show>
          <Show when={detail().discourse.discourseMode !== null}>
            <span class="scene-chip scene-chip-discourse">{detail().discourse.discourseMode}</span>
          </Show>
          <Show when={row() !== null && row()!.storyTime.length > 0}>
            <span class="scene-chip">{row()!.storyTime}</span>
          </Show>
          <Show when={row() !== null}>
            <span class="scene-chip">
              CH.{row()!.coordinate.chapter} · #{row()!.coordinate.narrativeOrder}
            </span>
          </Show>
        </div>
      </div>

      <section class="scene-inspector-card" aria-label="Render status">
        <div class="scene-inspector-card-head">
          <h4>渲染状态</h4>
          <span
            class={`scene-adopt-badge scene-adopt-badge-${detail().renderStatus}`}
            data-status={detail().renderStatus}
          >
            {renderStatusLabel()}
          </span>
        </div>
        <Show when={detail().stale}>
          <p class="scene-inspector-warning">
            该场景的上下文指纹已变化（frontmatter sceneHash ≠ 当前编译 sceneHash）。重新渲染不会静默覆盖手改散文。
          </p>
        </Show>
        <dl class="scene-inspector-meta">
          <div>
            <dt>sceneHash</dt>
            <dd title={detail().hashes.sceneHash ?? undefined}>
              {shortHash(detail().hashes.sceneHash)}
            </dd>
          </div>
          <div>
            <dt>proseHash</dt>
            <dd title={detail().hashes.proseHash ?? undefined}>
              {shortHash(detail().hashes.proseHash)}
            </dd>
          </div>
        </dl>
        <div class="scene-inspector-actions">
          <button
            class="btn btn-primary"
            type="button"
            disabled={!canRender() || props.renderBusy === true}
            onClick={() => props.onRenderScene?.(detail().eventId)}
          >
            {props.renderBusy === true ? 'Queuing…' : 'Render scene'}
          </button>
          <Show when={detail().renderStatus === 'unadopted'}>
            <button
              class="btn"
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
          <p class="scene-inspector-note">
            渲染该场景以产生 released revision 后再采纳；若已存在 released revision，选中行后会显示采纳预览。
          </p>
        </Show>
        <Show when={props.renderError !== null && props.renderError !== undefined}>
          <p class="scene-inspector-error" aria-live="polite">
            {props.renderError}
          </p>
        </Show>
        <Show when={props.renderNotice !== null && props.renderNotice !== undefined}>
          <p class="scene-inspector-note" aria-live="polite">
            {props.renderNotice}
          </p>
        </Show>
      </section>

      <section class="scene-inspector-card" aria-label="WorldState diff">
        <div class="scene-inspector-card-head">
          <h4>WorldState diff</h4>
          <span class="scene-inspector-count">{detail().diff.changed.length} changed</span>
        </div>
        <Show
          when={detail().diff.changed.length > 0}
          fallback={<p class="scene-inspector-note">该场景没有 world-state 变化。</p>}
        >
          <table class="scene-diff">
            <thead>
              <tr>
                <th>实体</th>
                <th>属性</th>
                <th>变化</th>
              </tr>
            </thead>
            <tbody>
              <For each={detail().diff.changed}>
                {(key) => (
                  <For each={diffRows(key, detail().diff)}>
                    {(attributeRow) => (
                      <tr class="scene-diff-row">
                        <td class="scene-diff-ent">{attributeRow.entityId}</td>
                        <td class="scene-diff-attr">{attributeRow.attribute}</td>
                        <td class="scene-diff-change">
                          <Show
                            when={attributeRow.before !== null}
                            fallback={
                              <span class="scene-diff-after">+ {formatValue(attributeRow.after)}</span>
                            }
                          >
                            <span class="scene-diff-before">
                              {formatValue(attributeRow.before)}
                            </span>
                            <Show when={attributeRow.after !== null}>
                              <span class="scene-diff-arrow">→</span>
                              <span class="scene-diff-after">
                                {formatValue(attributeRow.after)}
                              </span>
                            </Show>
                            <Show when={attributeRow.after === null}>
                              <span class="scene-diff-removed"> (移除)</span>
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
          <div class="scene-narrative-hint" aria-label="Narrative hints">
            <span class="scene-narrative-tag">narrativeHint</span>
            <ul>
              <For each={hints()}>{(hint) => <li>{hint}</li>}</For>
            </ul>
          </div>
        </Show>
      </section>

      <section class="scene-inspector-card" aria-label="Entity states">
        <div class="scene-inspector-card-head">
          <h4>实体状态</h4>
          <span class="scene-inspector-count">{detail().entities.length}</span>
        </div>
        <Show
          when={detail().entities.length > 0}
          fallback={<p class="scene-inspector-note">该场景没有受影响的实体。</p>}
        >
          <ul class="scene-entity-list">
            <For each={detail().entities}>
              {(entity) => (
                <li class="scene-entity">
                  <details>
                    <summary>
                      <span class="scene-entity-kind">{entity.kind}</span>
                      <span class="scene-entity-id">{entity.id}</span>
                      <span class="scene-entity-name">{entity.name}</span>
                    </summary>
                    <dl class="scene-entity-state">
                      <For each={Object.entries(entity.state)}>
                        {([attribute, value]) => (
                          <>
                            <dt>{attribute}</dt>
                            <dd>{formatValue(value)}</dd>
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

      <section class="scene-inspector-card" aria-label="Discourse projection">
        <div class="scene-inspector-card-head">
          <h4>Discourse 投影</h4>
          <span class="scene-inspector-count">planned</span>
        </div>
        <dl class="scene-inspector-meta">
          <div>
            <dt>ledger</dt>
            <dd>{detail().discourse.ledgerId ?? '—'}</dd>
          </div>
          <div>
            <dt>discourseMode</dt>
            <dd>{detail().discourse.discourseMode ?? '—'}</dd>
          </div>
          <div>
            <dt>discoursePosition</dt>
            <dd>{detail().discourse.discoursePosition ?? '—'}</dd>
          </div>
        </dl>
        <Show when={detail().discourse.assertions.length > 0}>
          <ul class="scene-assertion-list">
            <For each={detail().discourse.assertions}>
              {(assertion) => (
                <li>
                  <span class="scene-assertion-id">{assertion.assertionId}</span>
                  <span class="scene-assertion-action">{assertion.action}</span>
                  <span class="scene-assertion-pos">pos {assertion.discoursePosition}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section class="scene-inspector-card" aria-label="Graph edges">
        <div class="scene-inspector-card-head">
          <h4>因果图位置</h4>
          <span class="scene-inspector-count">{detail().graphEdges.length}</span>
        </div>
        <Show
          when={detail().graphEdges.length > 0}
          fallback={<p class="scene-inspector-note">该场景没有已投影的图边。</p>}
        >
          <ul class="scene-edge-list">
            <For each={detail().graphEdges}>
              {(edge) => (
                <li class="scene-edge">
                  <span class="scene-edge-class">{edge.edgeClass}</span>
                  <span class="scene-edge-from">{edge.predecessor}</span>
                  <span class="scene-edge-arrow">→</span>
                  <span class="scene-edge-to">{edge.dependent}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <details class="scene-technical-details" open={false}>
        <summary>技术详情</summary>
        <section class="scene-inspector-card" aria-label="CompiledSceneContract hashes">
          <div class="scene-inspector-card-head">
            <h4>CompiledSceneContract</h4>
          </div>
          <dl class="scene-hash-list">
            <div>
              <dt>stateBefore</dt>
              <dd title={detail().hashes.stateBeforeHash}>{shortHash(detail().hashes.stateBeforeHash)}</dd>
            </div>
            <div>
              <dt>stateAfter</dt>
              <dd title={detail().hashes.stateAfterHash}>{shortHash(detail().hashes.stateAfterHash)}</dd>
            </div>
            <div>
              <dt>worldHash</dt>
              <dd title={detail().hashes.worldStateHash}>{shortHash(detail().hashes.worldStateHash)}</dd>
            </div>
            <div>
              <dt>knowledgeHash</dt>
              <dd title={detail().hashes.knowledgeStateHash}>
                {shortHash(detail().hashes.knowledgeStateHash)}
              </dd>
            </div>
            <div>
              <dt>narratorProfile</dt>
              <dd title={detail().hashes.narratorProfileHash}>
                {shortHash(detail().hashes.narratorProfileHash)}
              </dd>
            </div>
            <div>
              <dt>discourseHash</dt>
              <dd title={detail().hashes.discourseHash}>{shortHash(detail().hashes.discourseHash)}</dd>
            </div>
            <div>
              <dt>source</dt>
              <dd title={detail().hashes.sourceHash}>{shortHash(detail().hashes.sourceHash)}</dd>
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
  return (
    <aside class="scene-inspector" aria-label="Scene inspector">
      <Show
        when={props.detail !== null && props.detail !== undefined}
        fallback={<EmptyInspector detailError={props.detailError} />}
      >
        <SceneInspectorBody
          row={props.row}
          detail={props.detail!}
          adoption={props.adoption}
          sessionRole={props.sessionRole}
          renderBusy={props.renderBusy}
          renderNotice={props.renderNotice}
          renderError={props.renderError}
          onRenderScene={props.onRenderScene}
          onRequestAdoption={props.onRequestAdoption}
        />
      </Show>
    </aside>
  );
}
