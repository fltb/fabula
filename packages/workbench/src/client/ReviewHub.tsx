import { createSignal, For, Show } from 'solid-js';
import { PROJECT_ACCESS_ROLE_GRANTS } from '../contracts/configuration.js';
import type {
  BrowserReviewAddRequestV1,
  BrowserReviewCategoryV1,
  BrowserReviewCommentV1,
  BrowserReviewGateDecideRequestV1,
  BrowserReviewGateListV1,
  BrowserReviewGateV1,
  BrowserReviewHistoryV1,
  BrowserReviewListV1,
  BrowserReviewSeverityV1,
  BrowserReviewUpdateActionV1,
  BrowserReviewUpdateRequestV1,
  ProjectAccessRole,
} from '../contracts/index.js';
import { BrowserReviewApiError } from './browser-review-api.js';
import { Diagnostic, KICKER, ScreenEmpty, ScreenNote, TEXT_BUTTON } from './ui/primitives';

export interface ReviewHubProps {
  /** Project identity for mutation requests; null when no project is open. */
  readonly projectId: string | null;
  /** Host review projection; null = not loaded yet (or the load failed). */
  readonly review?: BrowserReviewListV1 | null;
  /** Host release-gate projection; null = not loaded yet (or the load failed). */
  readonly gates?: BrowserReviewGateListV1 | null;
  /** Host review event trail; null = not loaded yet (or the load failed). */
  readonly history?: BrowserReviewHistoryV1 | null;
  /** Review Hub load failure from the Host surface; non-null renders a retry state. */
  readonly reviewError?: string | null;
  /**
   * Project membership role for the current session. Mutations are offered
   * only when the role's grants allow them AND the matching callback is
   * wired; the Host remains the authoritative scope enforcer.
   */
  readonly sessionRole?: ProjectAccessRole | null;
  /** Wired by the Host surface only when the session may add comments. */
  readonly onAddComment?: (request: BrowserReviewAddRequestV1) => void | Promise<void>;
  /** Wired by the Host surface only when the session may update comments. */
  readonly onUpdateComment?: (request: BrowserReviewUpdateRequestV1) => void | Promise<void>;
  /** Wired by the Host surface only when the session may decide gates. */
  readonly onDecideGate?: (request: BrowserReviewGateDecideRequestV1) => void | Promise<void>;
  /** Re-requests the Host projections after a mutation. */
  readonly onRefresh?: () => void | Promise<void>;
}

const REVIEW_SEVERITIES: readonly BrowserReviewSeverityV1[] = [
  'nit',
  'suggestion',
  'blocking',
] as const;
const REVIEW_CATEGORIES: readonly BrowserReviewCategoryV1[] = [
  'style',
  'pacing',
  'character_voice',
  'plot_logic',
  'world_consistency',
  'reader_experience',
] as const;

function roleRank(role: ProjectAccessRole | null | undefined): number {
  if (role === null || role === undefined) return 0;
  return PROJECT_ACCESS_ROLE_GRANTS[role].rank;
}

/**
 * Mutation visibility requires BOTH a wired callback (the Host surface's
 * wiring gate, exactly like Source Studio) and, when the session role is
 * known, a sufficient grant rank (author for comments, maintainer for gate
 * decisions). An unknown role (null) defers entirely to the callback wiring
 * and to the Host's authoritative scope enforcement.
 */
function roleAllows(rank: number, requiredRank: number): boolean {
  return rank === 0 || rank >= requiredRank;
}

function lifecycleErrorMessage(error: unknown): string {
  if (error instanceof BrowserReviewApiError) return error.message;
  return error instanceof Error ? error.message : '评审请求未被接受。';
}

function statusLabel(status: BrowserReviewCommentV1['status']): string {
  switch (status) {
    case 'open':
      return '待处理';
    case 'addressed':
      return '已处理';
    case 'resolved':
      return '已解决';
    case 'wontfix':
      return '不修复';
    case 'superseded':
      return '已被替代';
    default:
      return status;
  }
}

function SeverityBadge(props: { readonly severity: BrowserReviewSeverityV1 }) {
  return (
    <span
      class={`px-2 py-1 rounded-full text-[0.625rem] font-extrabold uppercase leading-[1.2] tracking-[0.06em] ${
        props.severity === 'blocking'
          ? 'bg-error-surface text-danger'
          : 'bg-accent-wash text-accent-deep'
      }`}
      data-severity={props.severity}
    >
      {props.severity}
    </span>
  );
}

/** One comment: status, evidence, revision linkage, and permitted actions. */
function ReviewCommentCard(props: {
  readonly projectId: string;
  readonly comment: BrowserReviewCommentV1;
  readonly canUpdate: boolean;
  readonly onUpdate: (request: BrowserReviewUpdateRequestV1) => void;
}) {
  const comment = () => props.comment;
  const [replaceOpen, setReplaceOpen] = createSignal(false);
  const [replacement, setReplacement] = createSignal('');

  const sendStatusAction = (action: Exclude<BrowserReviewUpdateActionV1, 'replace'>) => {
    props.onUpdate({
      version: 1,
      projectId: props.projectId,
      commentId: props.comment.commentId,
      action,
    });
  };
  const sendReplacement = () => {
    const text = replacement().trim();
    if (text.length === 0) return;
    props.onUpdate({
      version: 1,
      projectId: props.projectId,
      commentId: props.comment.commentId,
      action: 'replace',
      content: text,
    });
    setReplacement('');
    setReplaceOpen(false);
  };

  return (
    <li
      class="grid gap-3 rounded-[0.625rem] border border-line bg-surface p-5 shadow-[var(--wb-shadow-panel)]"
      data-comment-id={comment().commentId}
      data-status={comment().status}
    >
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="rounded-full bg-ready-surface px-2 py-1 text-[0.625rem] font-extrabold uppercase leading-[1.2] tracking-[0.06em] text-success"
          data-status={comment().status}
        >
          {statusLabel(comment().status)}
        </span>
        <SeverityBadge severity={comment().severity} />
        <span>{comment().category}</span>
        <code class="text-[0.6875rem] text-muted">{comment().commentId}</code>
      </div>
      <p class="m-0 text-sm leading-[1.6] text-ink-soft">{comment().content}</p>
      <dl class="m-0 grid gap-2">
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 rounded-[0.375rem] bg-surface-muted px-3 py-2 max-[40rem]:grid-cols-1">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
            场景事件
          </dt>
          <dd class="m-0 break-words text-[0.8125rem]">
            <code>{comment().eventId}</code>
          </dd>
        </div>
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 rounded-[0.375rem] bg-surface-muted px-3 py-2 max-[40rem]:grid-cols-1">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
            创建时间
          </dt>
          <dd class="m-0 break-words text-[0.8125rem]">{comment().createdAt}</dd>
        </div>
        <Show when={comment().supersedesId !== null}>
          <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 rounded-[0.375rem] bg-surface-muted px-3 py-2 max-[40rem]:grid-cols-1">
            <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
              替代
            </dt>
            <dd class="m-0 break-words text-[0.8125rem]">
              <code>{comment().supersedesId}</code>
            </dd>
          </div>
        </Show>
      </dl>
      <Show when={comment().applications.length > 0}>
        <section aria-label="修订关联">
          <h4>相关修订</h4>
          <ul>
            <For each={comment().applications}>
              {(application) => (
                <li>
                  <code>{application.revisionId}</code> · {application.eventId} ·{' '}
                  {application.appliedAt}
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={props.canUpdate}>
        <div class="flex flex-wrap gap-2">
          <Show
            when={comment().status === 'open' || comment().status === 'addressed'}
            fallback={
              <button
                class={TEXT_BUTTON}
                type="button"
                data-testid={`reopen-${comment().commentId}`}
                onClick={() => sendStatusAction('reopen')}
              >
                重新打开
              </button>
            }
          >
            <button
              class={TEXT_BUTTON}
              type="button"
              data-testid={`resolve-${comment().commentId}`}
              onClick={() => sendStatusAction('resolve')}
            >
              标记已解决
            </button>
            <button
              class={TEXT_BUTTON}
              type="button"
              data-testid={`wontfix-${comment().commentId}`}
              onClick={() => sendStatusAction('wontfix')}
            >
              不修复
            </button>
            <Show when={comment().severity !== 'blocking'}>
              <button
                class={TEXT_BUTTON}
                type="button"
                data-testid={`escalate-${comment().commentId}`}
                onClick={() => sendStatusAction('escalate')}
              >
                升级
              </button>
            </Show>
          </Show>
          <Show
            when={replaceOpen()}
            fallback={
              <button
                class={TEXT_BUTTON}
                type="button"
                data-testid={`replace-open-${comment().commentId}`}
                onClick={() => setReplaceOpen(true)}
              >
                替换文本
              </button>
            }
          >
            <input
              class="rounded-[0.375rem] border border-line bg-surface px-3 py-2 font-inherit text-ink"
              aria-label="替换意见内容"
              value={replacement()}
              onInput={(event) => setReplacement(event.currentTarget.value)}
              data-testid={`replace-text-${comment().commentId}`}
            />
            <button
              class={TEXT_BUTTON}
              type="button"
              disabled={replacement().trim().length === 0}
              data-testid={`replace-save-${comment().commentId}`}
              onClick={sendReplacement}
            >
              保存
            </button>
            <button
              class={TEXT_BUTTON}
              type="button"
              onClick={() => {
                setReplacement('');
                setReplaceOpen(false);
              }}
            >
              取消
            </button>
          </Show>
        </div>
      </Show>
    </li>
  );
}

/** One gate: identity, status, decision evidence, and the decide form. */
function ReviewGateCard(props: {
  readonly projectId: string;
  readonly gate: BrowserReviewGateV1;
  readonly canDecide: boolean;
  readonly onDecide: (request: BrowserReviewGateDecideRequestV1) => void;
}) {
  const gate = () => props.gate;
  const [decision, setDecision] = createSignal<'accept' | 'reject'>('accept');
  const [reason, setReason] = createSignal('');

  const decide = () => {
    const text = reason().trim();
    if (text.length === 0) return;
    props.onDecide({
      version: 1,
      projectId: props.projectId,
      gateId: props.gate.gateId,
      decision: decision(),
      reason: text,
    });
    setReason('');
  };

  return (
    <li
      class="grid gap-3 rounded-[0.625rem] border border-line bg-surface p-5 shadow-[var(--wb-shadow-panel)]"
      data-gate-id={gate().gateId}
      data-status={gate().status}
    >
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="rounded-full bg-ready-surface px-2 py-1 text-[0.625rem] font-extrabold uppercase leading-[1.2] tracking-[0.06em] text-success"
          data-status={gate().status}
        >
          {gate().status}
        </span>
        <code class="text-[0.6875rem] text-muted">{gate().gateId}</code>
      </div>
      <dl class="m-0 grid gap-2">
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 rounded-[0.375rem] bg-surface-muted px-3 py-2 max-[40rem]:grid-cols-1">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
            场景事件
          </dt>
          <dd class="m-0 break-words text-[0.8125rem]">
            <code>{gate().eventId}</code>
          </dd>
        </div>
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 rounded-[0.375rem] bg-surface-muted px-3 py-2 max-[40rem]:grid-cols-1">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
            候选修订
          </dt>
          <dd class="m-0 break-words text-[0.8125rem]">
            <code>{gate().revisionId}</code>
          </dd>
        </div>
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 rounded-[0.375rem] bg-surface-muted px-3 py-2 max-[40rem]:grid-cols-1">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
            源哈希
          </dt>
          <dd class="m-0 break-words text-[0.8125rem]">
            <code>{gate().sourceHash}</code>
          </dd>
        </div>
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 rounded-[0.375rem] bg-surface-muted px-3 py-2 max-[40rem]:grid-cols-1">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">警告</dt>
          <dd class="m-0 break-words text-[0.8125rem]">{gate().warningFingerprints.length}</dd>
        </div>
      </dl>
      <Show when={gate().decision !== null}>
        <p
          class="m-0 text-[0.8125rem] leading-[1.5] text-ink-soft"
          data-decision={gate().decision?.decision}
        >
          已决定：{gate().decision?.decision} · {gate().decision?.decidedAt}：{' '}
          {gate().decision?.reason}
        </p>
      </Show>
      <Show when={props.canDecide && gate().status === 'open'}>
        <div class="grid gap-2 rounded-[0.375rem] bg-surface-muted p-3">
          <label>
            <input
              type="radio"
              name={`decision-${gate().gateId}`}
              value="accept"
              checked={decision() === 'accept'}
              onChange={() => setDecision('accept')}
            />{' '}
            通过
          </label>
          <label>
            <input
              type="radio"
              name={`decision-${gate().gateId}`}
              value="reject"
              checked={decision() === 'reject'}
              onChange={() => setDecision('reject')}
            />{' '}
            拒绝
          </label>
          <input
            class="rounded-[0.375rem] border border-line bg-surface px-3 py-2 font-inherit text-ink"
            aria-label="决策理由"
            placeholder="理由（必填）"
            value={reason()}
            onInput={(event) => setReason(event.currentTarget.value)}
          />
          <button
            class={TEXT_BUTTON}
            type="button"
            disabled={reason().trim().length === 0}
            data-testid={`gate-decide-${gate().gateId}`}
            onClick={decide}
          >
            决定
          </button>
        </div>
      </Show>
    </li>
  );
}

/**
 * Review Hub renders the Host's review projection: comments with status and
 * revision linkage, the safe event trail, and release gates with decisions.
 * Mutations are offered only when the session role's grants allow them and
 * the matching callback is wired; empty/loading states are honest and no
 * mock data is ever rendered.
 */
export function ReviewHub(props: ReviewHubProps) {
  const [mutationError, setMutationError] = createSignal<string | null>(null);
  const [addOpen, setAddOpen] = createSignal(false);
  const [addEventId, setAddEventId] = createSignal('');
  const [addSeverity, setAddSeverity] = createSignal<BrowserReviewSeverityV1>('suggestion');
  const [addCategory, setAddCategory] = createSignal<BrowserReviewCategoryV1>('reader_experience');
  const [addContent, setAddContent] = createSignal('');

  const rank = () => roleRank(props.sessionRole);
  const canAdd = () => roleAllows(rank(), 2) && props.onAddComment !== undefined;
  const canUpdate = () => roleAllows(rank(), 2) && props.onUpdateComment !== undefined;
  const canDecide = () => roleAllows(rank(), 3) && props.onDecideGate !== undefined;

  const runMutation = async (mutation: () => void | Promise<void>): Promise<void> => {
    setMutationError(null);
    try {
      await mutation();
      await props.onRefresh?.();
    } catch (error) {
      setMutationError(lifecycleErrorMessage(error));
    }
  };

  const addComment = () => {
    const projectId = props.projectId;
    const eventId = addEventId().trim();
    const content = addContent().trim();
    if (projectId === null || eventId.length === 0 || content.length === 0) return;
    void runMutation(() =>
      props.onAddComment?.({
        version: 1,
        projectId,
        eventId,
        severity: addSeverity(),
        category: addCategory(),
        content,
      }),
    );
    setAddContent('');
    setAddEventId('');
    setAddOpen(false);
  };

  return (
    <section class="mx-auto grid max-w-[60rem] gap-6" aria-labelledby="review-hub-heading">
      <header class="flex items-start justify-between gap-3">
        <div>
          <p class={KICKER}>人工评审</p>
          <h2 id="review-hub-heading">评审中心</h2>
        </div>
        <Show when={props.onRefresh !== undefined}>
          <button
            class={TEXT_BUTTON}
            type="button"
            data-testid="review-refresh"
            onClick={() => void props.onRefresh?.()}
          >
            刷新
          </button>
        </Show>
      </header>

      <Show when={mutationError() !== null}>
        <div role="alert" data-review-mutation-error>
          <Diagnostic severity="error">{mutationError()}</Diagnostic>
        </div>
      </Show>

      <Show
        when={
          props.review !== null &&
          props.review !== undefined &&
          props.reviewError !== null &&
          props.reviewError !== undefined
        }
      >
        <div role="alert" data-testid="review-partial-error">
          <Diagnostic severity="error">{props.reviewError}</Diagnostic>
        </div>
      </Show>

      <Show
        when={props.review}
        fallback={
          <Show
            when={props.reviewError !== null && props.reviewError !== undefined}
            fallback={
              <ScreenEmpty title="暂无评审数据" body="打开已认证的项目以加载其评审意见。" />
            }
          >
            <div data-testid="review-load-error">
              <ScreenEmpty title="评审中心加载失败" body={props.reviewError ?? undefined}>
                <Show when={props.onRefresh !== undefined}>
                  <button
                    class={TEXT_BUTTON}
                    type="button"
                    data-testid="review-load-retry"
                    onClick={() => void props.onRefresh?.()}
                  >
                    重试
                  </button>
                </Show>
              </ScreenEmpty>
            </div>
          </Show>
        }
      >
        {(review) => (
          <section aria-labelledby="review-comments-heading">
            <div>
              <h3 id="review-comments-heading">
                评审意见{' '}
                <span
                  class="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-accent-wash px-1 text-[0.6875rem] font-extrabold text-accent-deep"
                  data-testid="review-count"
                >
                  {review().comments.length}
                </span>
              </h3>
              <Show when={canAdd()}>
                <Show
                  when={addOpen()}
                  fallback={
                    <button
                      class={TEXT_BUTTON}
                      type="button"
                      data-testid="review-add-open"
                      onClick={() => setAddOpen(true)}
                    >
                      添加评审意见
                    </button>
                  }
                >
                  <form
                    class="grid gap-2 rounded-[0.625rem] border border-line bg-surface-muted p-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      addComment();
                    }}
                  >
                    <input
                      class="rounded-[0.375rem] border border-line bg-surface px-3 py-2 font-inherit text-ink"
                      aria-label="场景事件编号"
                      placeholder="场景事件编号（如 E1）"
                      value={addEventId()}
                      onInput={(event) => setAddEventId(event.currentTarget.value)}
                      data-testid="review-add-event"
                    />
                    <select
                      aria-label="严重程度"
                      value={addSeverity()}
                      onChange={(event) =>
                        setAddSeverity(event.currentTarget.value as BrowserReviewSeverityV1)
                      }
                    >
                      <For each={REVIEW_SEVERITIES}>
                        {(severity) => <option value={severity}>{severity}</option>}
                      </For>
                    </select>
                    <select
                      aria-label="类别"
                      value={addCategory()}
                      onChange={(event) =>
                        setAddCategory(event.currentTarget.value as BrowserReviewCategoryV1)
                      }
                    >
                      <For each={REVIEW_CATEGORIES}>
                        {(category) => <option value={category}>{category}</option>}
                      </For>
                    </select>
                    <textarea
                      aria-label="评审意见内容"
                      placeholder="评审意见内容"
                      value={addContent()}
                      onInput={(event) => setAddContent(event.currentTarget.value)}
                      data-testid="review-add-text"
                    />
                    <button
                      class={TEXT_BUTTON}
                      type="submit"
                      disabled={
                        addEventId().trim().length === 0 || addContent().trim().length === 0
                      }
                      data-testid="review-add-save"
                    >
                      添加
                    </button>
                    <button class={TEXT_BUTTON} type="button" onClick={() => setAddOpen(false)}>
                      取消
                    </button>
                  </form>
                </Show>
              </Show>
            </div>
            <Show
              when={review().comments.length > 0}
              fallback={<ScreenNote>还没有评审意见。</ScreenNote>}
            >
              <ul class="m-0 mt-4 grid list-none gap-4 p-0" aria-label="评审意见">
                <For each={review().comments}>
                  {(comment) => (
                    <ReviewCommentCard
                      projectId={review().projectId}
                      comment={comment}
                      canUpdate={canUpdate()}
                      onUpdate={(request) =>
                        void runMutation(() => props.onUpdateComment?.(request))
                      }
                    />
                  )}
                </For>
              </ul>
            </Show>
          </section>
        )}
      </Show>

      <Show when={props.gates} fallback={<ScreenNote>暂无检查项数据。</ScreenNote>}>
        {(gates) => (
          <section aria-labelledby="review-gates-heading">
            <h3 id="review-gates-heading">
              发布检查项{' '}
              <span
                class="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-accent-wash px-1 text-[0.6875rem] font-extrabold text-accent-deep"
                data-testid="gate-count"
              >
                {gates().gates.length}
              </span>
            </h3>
            <Show
              when={gates().gates.length > 0}
              fallback={<ScreenNote>没有待处理的检查项。</ScreenNote>}
            >
              <ul class="m-0 mt-4 grid list-none gap-4 p-0" aria-label="发布检查项">
                <For each={gates().gates}>
                  {(gate) => (
                    <ReviewGateCard
                      projectId={gates().projectId}
                      gate={gate}
                      canDecide={canDecide()}
                      onDecide={(request) => void runMutation(() => props.onDecideGate?.(request))}
                    />
                  )}
                </For>
              </ul>
            </Show>
          </section>
        )}
      </Show>

      <Show when={props.history} fallback={<ScreenNote>暂无评审历史记录。</ScreenNote>}>
        {(history) => (
          <Show when={history().entries.length > 0}>
            <section aria-labelledby="review-history-heading">
              <h3 id="review-history-heading">历史</h3>
              <ol class="m-0 mt-3 grid list-none gap-1 p-0" aria-label="评审事件流">
                <For each={history().entries}>
                  {(entry) => (
                    <li
                      class="flex flex-wrap items-center gap-2 rounded-[0.375rem] bg-surface-muted px-3 py-2 text-[0.8125rem]"
                      data-history-kind={entry.kind}
                    >
                      <span class="text-[0.625rem] font-extrabold uppercase tracking-[0.08em] text-muted">
                        {entry.kind}
                      </span>
                      <span>{entry.summary}</span>
                      <Show when={entry.revisionId !== null}>
                        <code class="text-[0.6875rem] text-muted">{entry.revisionId}</code>
                      </Show>
                      <time>{entry.at}</time>
                    </li>
                  )}
                </For>
              </ol>
            </section>
          </Show>
        )}
      </Show>
    </section>
  );
}
