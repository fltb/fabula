import { createSignal, For, Show } from 'solid-js';
import type {
  AuthoringOperationReceiptV1,
  AuthoringPhaseV1,
  AuthoringReconcileChoiceV1,
  AuthoringStateV1,
  BrowserAuthoringDocumentCreateRequestV1,
  BrowserAuthoringDocumentDeleteRequestV1,
  BrowserAuthoringDocumentMoveRequestV1,
  BrowserAuthoringReconcileRequestV1,
  BrowserAuthoringRevisionDiffV1,
  BrowserAuthoringRevisionListV1,
  BrowserAuthoringRevisionRestoreRequestV1,
  BrowserAuthoringRevisionV1,
  BrowserAuthoringSubmitRequestV1,
  SourceStudioDocumentDescriptorV1,
  SourceStudioStateV1,
} from '../contracts/index.js';
import { BrowserAuthoringApiError } from './authoring-client.js';
import {
  BUTTON,
  BUTTON_GHOST,
  BUTTON_PRIMARY,
  Diagnostic,
  type DiagnosticSeverity,
  HashChip,
  KICKER,
  ScreenEmpty,
  ScreenNote,
  StatusDot,
  type StatusDotStatus,
  VIEW_BUTTON,
  VIEW_BUTTON_ACTIVE,
} from './ui/primitives.js';
import { YjsEditor, type YjsEditorConnectionStatus } from './yjs-editor.js';

/**
 * Browser-local working-layer connection status. It is UI state, never
 * Host-derived: the component reports it but never binds a socket itself.
 */
export type SourceStudioYjsStatus = YjsEditorConnectionStatus;

export interface SourceStudioProps {
  /** Host-provided Source Studio state; null = not loaded yet (or load failed). */
  readonly state: SourceStudioStateV1 | null;
  /** Coordinator state; accepted identity and working identity stay separate. */
  readonly authoring?: AuthoringStateV1 | null;
  /** Recent safe coordinator receipts for the Operation Center. */
  readonly operations?: readonly AuthoringOperationReceiptV1[];
  /** Host-derived native revision history; no source bytes or Git metadata. */
  readonly revisionHistory?: BrowserAuthoringRevisionListV1 | null;
  /** Selected revision metadata returned by an explicit history read. */
  readonly selectedRevision?: BrowserAuthoringRevisionV1 | null;
  /** Hash-only diff returned by an explicit history read. */
  readonly revisionDiff?: BrowserAuthoringRevisionDiffV1 | null;
  readonly onListRevisions?: () => void | Promise<void>;
  readonly onGetRevision?: (revisionId: string) => void | Promise<void>;
  readonly onDiffRevisions?: (fromRevisionId: string, toRevisionId: string) => void | Promise<void>;
  readonly onRestoreRevision?: (
    request: BrowserAuthoringRevisionRestoreRequestV1,
  ) => void | Promise<void>;
  /** Working-layer connection status per document id; absent entries read as `idle`. */
  readonly yjsStatus?: Readonly<Record<string, SourceStudioYjsStatus>>;
  /** Explicit Host connect handler; absent = no connect action is offered. */
  readonly onConnectYjs?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  /**
   * Legacy descriptor submit handler. It remains a Host-provided callback and
   * never causes this component to write or adopt source itself.
   */
  readonly onSubmit?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  /** Explicit versioned submit command; no actor/capability/root/head fields. */
  readonly onSubmitAuthoring?: (request: BrowserAuthoringSubmitRequestV1) => void | Promise<void>;
  /** Explicit external-candidate/conflict choice routed to the coordinator. */
  readonly onReconcileAuthoring?: (
    request: BrowserAuthoringReconcileRequestV1,
  ) => void | Promise<void>;
  /** Explicit versioned working-document create command; working layer only. */
  readonly onCreateDocument?: (
    request: BrowserAuthoringDocumentCreateRequestV1,
  ) => void | Promise<void>;
  /** Explicit versioned working-document move command; working layer only. */
  readonly onMoveDocument?: (
    request: BrowserAuthoringDocumentMoveRequestV1,
  ) => void | Promise<void>;
  /** Explicit versioned working-document delete command; working layer only. */
  readonly onDeleteDocument?: (
    request: BrowserAuthoringDocumentDeleteRequestV1,
  ) => void | Promise<void>;
  readonly selectedDocumentId?: string | null;
  readonly onSelectDocument?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  /** Transient browser session for the authenticated `/yjs` WebSocket. */
  readonly sessionId?: string | null;
  readonly baseUrl?: string;
  readonly onYjsStatusChange?: (
    descriptor: SourceStudioDocumentDescriptorV1,
    status: SourceStudioYjsStatus,
  ) => void;
}

/**
 * Surface a lifecycle mutation failure with the same typed client error the
 * submit/reconcile paths throw; unknown failures get a generic message.
 */
function lifecycleErrorMessage(error: unknown): string {
  if (error instanceof BrowserAuthoringApiError) return error.message;
  return error instanceof Error ? error.message : '文稿变更未被接受。';
}

/** Copy a full hash to the clipboard; failures are silent (chip stays readable). */
async function copyHash(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard access can be denied; the visible chip stays readable either way.
  }
}

/** Truncated chip label (first 8 chars) or the fallback when no value exists. */
function hashDisplay(value: string | null, fallback: string): string {
  if (value === null) return fallback;
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

/** Contract severities (`error | warning | info`) → primitive tones. */
const DIAGNOSTIC_SEVERITY: Readonly<Record<'error' | 'warning' | 'info', DiagnosticSeverity>> = {
  error: 'error',
  warning: 'warning',
  info: 'warning',
};

/** Authoring phase → status pill tone (replaces the deleted `.topbar-status`). */
const PHASE_PILL: Readonly<Record<AuthoringPhaseV1, string>> = {
  clean: 'border-ready-border bg-ready-surface text-success',
  'working-dirty': 'border-loading-border bg-loading-surface text-warning',
  'external-pending': 'border-empty-border bg-accent-wash text-accent-deep',
  'dual-conflict': 'border-error-border bg-error-surface text-danger',
  'candidate-invalid': 'border-error-border bg-error-surface text-danger',
  submitting: 'border-loading-border bg-loading-surface text-warning',
  accepted: 'border-ready-border bg-ready-surface text-success',
  stale: 'border-loading-border bg-loading-surface text-warning',
  conflict: 'border-error-border bg-error-surface text-danger',
  'recovery-required': 'border-error-border bg-error-surface text-danger',
};

/** Authoring phase → status-dot color. */
const PHASE_DOT: Readonly<Record<AuthoringPhaseV1, StatusDotStatus>> = {
  clean: 'ready',
  'working-dirty': 'loading',
  'external-pending': 'empty',
  'dual-conflict': 'error',
  'candidate-invalid': 'error',
  submitting: 'loading',
  accepted: 'ready',
  stale: 'loading',
  conflict: 'error',
  'recovery-required': 'error',
};

function submitBlockLabel(authoring: AuthoringStateV1): string {
  if (authoring.canSubmit) return '可以提交';
  switch (authoring.submitBlockReason) {
    case 'not-dirty':
      return '没有待提交的改动';
    case 'candidate-invalid':
      return '被无效的外部候选文稿阻止';
    case 'conflict-requires-resolution':
      return '存在未解决的冲突';
    case 'external-candidate-pending':
      return '存在外部候选文稿待处理';
    case 'submission-in-flight':
      return '提交中';
    case 'recovery-required':
      return '需要恢复';
    default:
      return '暂不能提交';
  }
}

/**
 * Source Studio renders the Host's last-valid projection beside the
 * noncanonical Yjs working layer. It never constructs source bytes or accepts
 * a mutation payload other than the versioned CAS requests provided by the
 * caller. Invalid working/external YAML is always labelled as a candidate,
 * never as accepted source.
 */
export function SourceStudio(props: SourceStudioProps) {
  const statusOf = (documentId: string): SourceStudioYjsStatus =>
    props.yjsStatus?.[documentId] ?? 'idle';

  const selectedDescriptor = (): SourceStudioDocumentDescriptorV1 | null => {
    const state = props.state;
    if (state === null) return null;
    const selected = props.selectedDocumentId;
    return (
      state.working.documents.find((descriptor) => descriptor.documentId === selected) ??
      state.working.documents.find((descriptor) => descriptor.available) ??
      null
    );
  };

  const submitRequest = (): BrowserAuthoringSubmitRequestV1 | null => {
    const state = props.state;
    const authoring = props.authoring;
    if (state === null || authoring === null || authoring === undefined) return null;
    if (
      !authoring.canSubmit ||
      authoring.workspaceDigest === null ||
      props.onSubmitAuthoring === undefined
    ) {
      return null;
    }
    return {
      version: 2,
      projectId: state.projectId,
      expectedAcceptedRevisionId: authoring.acceptedRevisionId,
      expectedAcceptedSourceHash: authoring.acceptedSourceHash,
      expectedWorkspaceDigest: authoring.workspaceDigest,
    };
  };

  const reconcileRequest = (
    choice: AuthoringReconcileChoiceV1,
  ): BrowserAuthoringReconcileRequestV1 | null => {
    const state = props.state;
    const authoring = props.authoring;
    if (state === null || authoring === null || authoring === undefined) return null;
    const candidateHash = authoring.externalCandidate?.candidateHash ?? null;
    if (choice !== 'keep-working' && candidateHash === null) return null;
    return {
      version: 2,
      projectId: state.projectId,
      choice,
      candidateHash,
      expectedAcceptedRevisionId: authoring.acceptedRevisionId,
      expectedAcceptedSourceHash: authoring.acceptedSourceHash,
    };
  };

  const restoreRequest = (revisionId: string): BrowserAuthoringRevisionRestoreRequestV1 | null => {
    const state = props.state;
    if (state === null || props.onRestoreRevision === undefined) return null;
    return {
      version: 2,
      projectId: state.projectId,
      revisionId,
      expectedAcceptedRevisionId: props.authoring?.acceptedRevisionId ?? null,
      expectedSourceHash: props.authoring?.acceptedSourceHash ?? null,
    };
  };

  // ─── Working-document lifecycle (create/move/delete) ───────────────────────
  const [creating, setCreating] = createSignal(false);
  const [newPath, setNewPath] = createSignal('');
  const [newKind, setNewKind] = createSignal<'prose' | 'raw-yaml'>('raw-yaml');
  const [movingId, setMovingId] = createSignal<string | null>(null);
  const [movePath, setMovePath] = createSignal('');
  const [confirmingDeleteId, setConfirmingDeleteId] = createSignal<string | null>(null);
  const [mutationBusy, setMutationBusy] = createSignal(false);
  const [mutationError, setMutationError] = createSignal<string | null>(null);

  /** Shared working-layer CAS base; null when the Host identity is unknown. */
  const lifecycleBase = (): {
    readonly projectId: string;
    readonly expectedAcceptedSourceHash: string | null;
    readonly expectedWorkspaceDigest: string;
  } | null => {
    const state = props.state;
    const authoring = props.authoring;
    if (state === null || authoring === null || authoring === undefined) return null;
    if (authoring.workspaceDigest === null) return null;
    return {
      projectId: state.projectId,
      expectedAcceptedSourceHash: authoring.acceptedSourceHash,
      expectedWorkspaceDigest: authoring.workspaceDigest,
    };
  };

  const canMutate = (): boolean => lifecycleBase() !== null;

  const runCreate = async (): Promise<void> => {
    const base = lifecycleBase();
    if (base === null || props.onCreateDocument === undefined) return;
    const logicalPath = newPath().trim();
    if (logicalPath.length === 0) return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      await props.onCreateDocument({
        version: 2,
        projectId: base.projectId,
        logicalPath,
        kind: newKind(),
        expectedAcceptedSourceHash: base.expectedAcceptedSourceHash,
        expectedWorkspaceDigest: base.expectedWorkspaceDigest,
      });
      setCreating(false);
      setNewPath('');
    } catch (error) {
      setMutationError(lifecycleErrorMessage(error));
    } finally {
      setMutationBusy(false);
    }
  };

  const runMove = async (documentId: string): Promise<void> => {
    const base = lifecycleBase();
    if (base === null || props.onMoveDocument === undefined) return;
    const logicalPath = movePath().trim();
    if (logicalPath.length === 0) return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      await props.onMoveDocument({
        version: 2,
        projectId: base.projectId,
        documentId,
        logicalPath,
        expectedAcceptedSourceHash: base.expectedAcceptedSourceHash,
        expectedWorkspaceDigest: base.expectedWorkspaceDigest,
      });
      setMovingId(null);
      setMovePath('');
    } catch (error) {
      setMutationError(lifecycleErrorMessage(error));
    } finally {
      setMutationBusy(false);
    }
  };

  const runDelete = async (documentId: string): Promise<void> => {
    const base = lifecycleBase();
    if (base === null || props.onDeleteDocument === undefined) return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      await props.onDeleteDocument({
        version: 2,
        projectId: base.projectId,
        documentId,
        expectedAcceptedSourceHash: base.expectedAcceptedSourceHash,
        expectedWorkspaceDigest: base.expectedWorkspaceDigest,
      });
      setConfirmingDeleteId(null);
    } catch (error) {
      setMutationError(lifecycleErrorMessage(error));
    } finally {
      setMutationBusy(false);
    }
  };

  return (
    <section
      class="mx-auto flex min-h-0 max-w-[68rem] flex-col gap-6"
      aria-labelledby="source-studio-heading"
    >
      <header class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class={KICKER}>文稿</p>
          <h2 id="source-studio-heading">写作源文稿</h2>
          <p class="m-0 max-w-2xl text-[0.8125rem] leading-[1.55] text-muted">
            已接受的源是 Host 最后校验通过的投影。工作层编辑保持本地协同，直到显式校验并提交。
          </p>
        </div>
        <Show when={props.authoring}>
          {(authoring) => (
            <div class="flex items-center gap-3" aria-live="polite">
              <span
                class={`inline-flex w-max items-center gap-2 rounded-full border px-3 py-2 text-[0.6875rem] font-bold leading-none tracking-[0.04em] whitespace-nowrap ${PHASE_PILL[authoring().phase]}`}
                data-phase={authoring().phase}
                data-submit-ready={authoring().canSubmit}
              >
                <StatusDot status={PHASE_DOT[authoring().phase]} />
                {submitBlockLabel(authoring())}
              </span>
              <Show when={submitRequest()}>
                {(request) => (
                  <button
                    type="button"
                    class={`${VIEW_BUTTON} ${VIEW_BUTTON_ACTIVE}`}
                    disabled={request() === null}
                    onClick={() => {
                      const next = request();
                      if (next !== null) void props.onSubmitAuthoring?.(next);
                    }}
                  >
                    提交工作层
                  </button>
                )}
              </Show>
            </div>
          )}
        </Show>
      </header>

      <Show
        when={props.state}
        fallback={<ScreenEmpty title="暂无源状态" body="Host 尚未提供该项目的文稿状态。" />}
      >
        {(state) => (
          <>
            <section class="border-b border-line pb-5" aria-labelledby="accepted-source-heading">
              <header>
                <h3 id="accepted-source-heading">已接受的源 — 最后校验通过的投影</h3>
                <ScreenNote>这是 Host 校验并接受的最新源。下方工作层编辑不会改动它。</ScreenNote>
              </header>
              <Show
                when={state().accepted}
                fallback={<ScreenNote>Host 还没有该项目已接受的源投影。</ScreenNote>}
              >
                {(accepted) => (
                  <>
                    <dl class="my-4 grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-3">
                      <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                        <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                          投影修订
                        </dt>
                        <dd class="m-0 text-lg font-[750]">{accepted().revision}</dd>
                      </div>
                      <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                        <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                          已接受源哈希
                        </dt>
                        <dd class="m-0 text-lg font-[750]">
                          <code>{accepted().sourceHash ?? '尚未接受'}</code>
                        </dd>
                      </div>
                      <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                        <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                          文稿数
                        </dt>
                        <dd class="m-0 text-lg font-[750]">{accepted().documents}</dd>
                      </div>
                      <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                        <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                          场景数
                        </dt>
                        <dd class="m-0 text-lg font-[750]">{accepted().events}</dd>
                      </div>
                      <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                        <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                          已渲染
                        </dt>
                        <dd class="m-0 text-lg font-[750]">{accepted().rendered}</dd>
                      </div>
                      <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                        <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                          受阻
                        </dt>
                        <dd class="m-0 text-lg font-[750]">{accepted().blocked}</dd>
                      </div>
                      <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                        <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                          警告
                        </dt>
                        <dd class="m-0 text-lg font-[750]">{accepted().warningCount}</dd>
                      </div>
                      <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                        <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                          错误
                        </dt>
                        <dd class="m-0 text-lg font-[750]">{accepted().errorCount}</dd>
                      </div>
                    </dl>
                    <Show when={accepted().diagnostics.length > 0}>
                      <ul class="grid gap-2 p-0 m-0 list-none" aria-label="已接受源诊断">
                        <For each={accepted().diagnostics}>
                          {(diagnostic) => (
                            <li>
                              <Diagnostic severity={DIAGNOSTIC_SEVERITY[diagnostic.severity]}>
                                <code>{diagnostic.code}</code> {diagnostic.message}
                                <Show when={diagnostic.logicalPath !== null}>
                                  <span class="text-xs text-muted">
                                    {' '}
                                    — {diagnostic.logicalPath}
                                  </span>
                                </Show>
                              </Diagnostic>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </>
                )}
              </Show>
            </section>

            <Show when={props.authoring}>
              {(authoring) => {
                const acceptedHash = authoring().acceptedSourceHash;
                const workspaceDigest = authoring().workspaceDigest;
                return (
                  <section class="grid gap-4 sm:grid-cols-2" aria-label="写作身份标识">
                    <div class="mx-auto mb-6 grid max-w-[60rem] grid-cols-[auto_minmax(0,1fr)] items-start gap-5 rounded-[1rem] border border-line bg-surface p-6 shadow-[var(--wb-shadow-panel)]">
                      <p class={KICKER}>已接受身份</p>
                      <HashChip
                        copyLabel="复制完整哈希"
                        onCopy={
                          acceptedHash === null ? undefined : () => void copyHash(acceptedHash)
                        }
                      >
                        <code>{hashDisplay(acceptedHash, '尚无已接受的源')}</code>
                      </HashChip>
                      <ScreenNote>最近一次校验通过的源哈希；输入时不会改变。</ScreenNote>
                    </div>
                    <div
                      class="mx-auto mb-6 grid max-w-[60rem] grid-cols-[auto_minmax(0,1fr)] items-start gap-5 rounded-[1rem] border border-line bg-surface p-6 shadow-[var(--wb-shadow-panel)]"
                      data-dirty={authoring().workingDirty}
                      data-phase={authoring().phase}
                    >
                      <p class={KICKER}>工作层身份</p>
                      <HashChip
                        copyLabel="复制完整哈希"
                        onCopy={
                          workspaceDigest === null
                            ? undefined
                            : () => void copyHash(workspaceDigest)
                        }
                      >
                        <code>{hashDisplay(workspaceDigest, '无工作摘要')}</code>
                      </HashChip>
                      <ScreenNote>
                        {authoring().workingDirty
                          ? '本地 Yjs 改动等待显式校验与提交。'
                          : '工作文稿与已接受身份一致。'}
                      </ScreenNote>
                    </div>
                  </section>
                );
              }}
            </Show>

            <section class="flex min-h-0 flex-col gap-4" aria-labelledby="working-layer-heading">
              <header class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 id="working-layer-heading">工作层（Yjs）— 仅在线，非已接受源</h3>
                  <ScreenNote>
                    工作层编辑是非权威的，在 Host
                    校验并提交之前不会被采纳为已接受源。新建、移动和删除只作用于该层；已接受层仅通过提交变更。
                  </ScreenNote>
                </div>
                <Show when={props.onCreateDocument !== undefined && canMutate()}>
                  <button
                    type="button"
                    class={VIEW_BUTTON}
                    disabled={mutationBusy()}
                    onClick={() => {
                      setCreating(true);
                      setNewPath('');
                      setNewKind('raw-yaml');
                      setMutationError(null);
                    }}
                  >
                    新建工作文稿
                  </button>
                </Show>
              </header>
              <Show when={creating()}>
                <section class="grid gap-2 border border-line p-3" aria-label="新建工作文稿">
                  <label
                    class="m-0 text-[0.8125rem] leading-[1.55] text-muted"
                    for="new-document-path"
                  >
                    清单相对逻辑路径
                  </label>
                  <input
                    id="new-document-path"
                    value={newPath()}
                    onInput={(event) => setNewPath(event.currentTarget.value)}
                    placeholder="scenes/my_new_scene.md"
                  />
                  <label
                    class="m-0 text-[0.8125rem] leading-[1.55] text-muted"
                    for="new-document-kind"
                  >
                    文稿类型
                  </label>
                  <select
                    id="new-document-kind"
                    value={newKind()}
                    onChange={(event) =>
                      setNewKind(event.currentTarget.value === 'prose' ? 'prose' : 'raw-yaml')
                    }
                  >
                    <option value="raw-yaml">raw-yaml</option>
                    <option value="prose">prose</option>
                  </select>
                  <div class="flex flex-wrap gap-2">
                    <button
                      type="button"
                      class={`${BUTTON} ${BUTTON_PRIMARY}`}
                      disabled={mutationBusy() || newPath().trim().length === 0}
                      onClick={() => void runCreate()}
                    >
                      创建工作文稿
                    </button>
                    <button
                      type="button"
                      class={`${BUTTON} ${BUTTON_GHOST}`}
                      disabled={mutationBusy()}
                      onClick={() => {
                        setCreating(false);
                        setNewPath('');
                        setMutationError(null);
                      }}
                    >
                      取消
                    </button>
                  </div>
                </section>
              </Show>
              <Show when={mutationError() !== null}>
                <p
                  class="m-0 rounded-[0.375rem] border border-error-border bg-error-surface px-4 py-3 text-[0.8125rem] text-danger"
                  role="alert"
                  data-mutation-error
                >
                  {mutationError()}
                </p>
              </Show>
              <Show
                when={state().working.documents.length > 0}
                fallback={<ScreenNote>Host 报告该项目没有工作文稿。</ScreenNote>}
              >
                <div class="grid gap-4 xl:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)]">
                  <ul aria-label="工作文稿">
                    <For each={state().working.documents}>
                      {(descriptor) => (
                        <li
                          data-available={descriptor.available}
                          data-selected={selectedDescriptor()?.documentId === descriptor.documentId}
                        >
                          <Show
                            when={props.onSelectDocument !== undefined}
                            fallback={
                              <span>
                                <code>{descriptor.documentId}</code>
                                <span>{descriptor.kind}</span>
                                <span>{descriptor.available ? '可用' : '不可用'}</span>
                                <span>{statusOf(descriptor.documentId)}</span>
                              </span>
                            }
                          >
                            <button
                              type="button"
                              class="w-full text-left"
                              onClick={() => props.onSelectDocument?.(descriptor)}
                            >
                              <span>
                                <code>{descriptor.documentId}</code>
                                <span>{descriptor.kind}</span>
                                <span>{descriptor.available ? '可用' : '不可用'}</span>
                                <span>{statusOf(descriptor.documentId)}</span>
                              </span>
                            </button>
                          </Show>
                          <Show when={props.onConnectYjs !== undefined}>
                            <button
                              type="button"
                              class={BUTTON}
                              disabled={!descriptor.available}
                              onClick={() => props.onConnectYjs?.(descriptor)}
                            >
                              连接工作文稿
                            </button>
                          </Show>
                          <Show when={props.onSubmit !== undefined}>
                            <button
                              type="button"
                              class={`${BUTTON} ${BUTTON_PRIMARY}`}
                              disabled={
                                !descriptor.available ||
                                (props.authoring !== undefined &&
                                  props.authoring !== null &&
                                  !props.authoring.canSubmit)
                              }
                              onClick={() => props.onSubmit?.(descriptor)}
                            >
                              提交工作文稿到 Host
                            </button>
                          </Show>
                          <Show when={props.onMoveDocument !== undefined}>
                            <button
                              type="button"
                              class={BUTTON}
                              disabled={!descriptor.available || !canMutate()}
                              onClick={() => {
                                setMovingId(descriptor.documentId);
                                setMovePath(descriptor.documentId);
                                setMutationError(null);
                              }}
                            >
                              重命名/移动
                            </button>
                          </Show>
                          <Show when={movingId() === descriptor.documentId}>
                            <section
                              class="grid gap-2 border border-line p-3"
                              aria-label={`移动 ${descriptor.documentId}`}
                            >
                              <label
                                class="m-0 text-[0.8125rem] leading-[1.55] text-muted"
                                for={`move-path-${descriptor.documentId}`}
                              >
                                新的清单相对逻辑路径
                              </label>
                              <input
                                id={`move-path-${descriptor.documentId}`}
                                value={movePath()}
                                onInput={(event) => setMovePath(event.currentTarget.value)}
                              />
                              <div class="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  class={`${BUTTON} ${BUTTON_PRIMARY}`}
                                  disabled={mutationBusy() || movePath().trim().length === 0}
                                  onClick={() => void runMove(descriptor.documentId)}
                                >
                                  移动文稿
                                </button>
                                <button
                                  type="button"
                                  class={`${BUTTON} ${BUTTON_GHOST}`}
                                  disabled={mutationBusy()}
                                  onClick={() => {
                                    setMovingId(null);
                                    setMutationError(null);
                                  }}
                                >
                                  取消
                                </button>
                              </div>
                            </section>
                          </Show>
                          <Show when={props.onDeleteDocument !== undefined}>
                            <button
                              type="button"
                              class={BUTTON}
                              disabled={!descriptor.available || !canMutate()}
                              onClick={() => {
                                setConfirmingDeleteId(descriptor.documentId);
                                setMutationError(null);
                              }}
                            >
                              删除
                            </button>
                          </Show>
                          <Show when={confirmingDeleteId() === descriptor.documentId}>
                            <section
                              class="flex flex-wrap items-center gap-2 border border-line p-3"
                              aria-label={`删除 ${descriptor.documentId}`}
                            >
                              <span class="m-0 text-[0.8125rem] leading-[1.55] text-muted">
                                删除此工作文稿？已接受层不受影响。
                              </span>
                              <button
                                type="button"
                                class={`${BUTTON} ${BUTTON_PRIMARY}`}
                                disabled={mutationBusy()}
                                onClick={() => void runDelete(descriptor.documentId)}
                              >
                                确认删除
                              </button>
                              <button
                                type="button"
                                class={`${BUTTON} ${BUTTON_GHOST}`}
                                disabled={mutationBusy()}
                                onClick={() => setConfirmingDeleteId(null)}
                              >
                                取消
                              </button>
                            </section>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>

                  <Show when={props.sessionId !== undefined ? selectedDescriptor() : null}>
                    {(descriptor) => (
                      <section
                        class="min-h-64 overflow-hidden border border-line bg-surface"
                        aria-labelledby="working-editor-heading"
                      >
                        <header class="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                          <div>
                            <p class={KICKER}>工作文稿编辑器</p>
                            <h4 id="working-editor-heading">
                              <code>{descriptor().documentId}</code>
                            </h4>
                          </div>
                          <span class="m-0 text-[0.8125rem] leading-[1.55] text-muted">
                            Yjs 本地优先
                          </span>
                        </header>
                        <YjsEditor
                          descriptor={descriptor()}
                          sessionId={props.sessionId}
                          baseUrl={props.baseUrl}
                          onStatusChange={(next) => props.onYjsStatusChange?.(descriptor(), next)}
                        />
                      </section>
                    )}
                  </Show>
                </div>
              </Show>
            </section>

            <Show when={props.authoring?.diagnostics.length}>
              <section
                class="border-t border-line pt-5"
                aria-labelledby="working-diagnostics-heading"
              >
                <h3 id="working-diagnostics-heading">工作候选诊断 — 未被接受</h3>
                <ScreenNote>
                  这些诊断描述当前候选或外部树。上方已接受的投影仍是最近一次的有效源。
                </ScreenNote>
                <ul class="grid gap-2 p-0 m-0 list-none" aria-label="工作候选诊断">
                  <For each={props.authoring?.diagnostics ?? []}>
                    {(diagnostic) => (
                      <li>
                        <Diagnostic severity={DIAGNOSTIC_SEVERITY[diagnostic.severity]}>
                          <code>{diagnostic.code}</code> {diagnostic.message}
                          <Show when={diagnostic.logicalPath !== null}>
                            <span class="text-xs text-muted"> — {diagnostic.logicalPath}</span>
                          </Show>
                        </Diagnostic>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>

            <Show when={props.authoring?.externalCandidate}>
              {(candidate) => (
                <section
                  class="border-t border-line pt-5"
                  aria-labelledby="external-candidate-heading"
                >
                  <h3 id="external-candidate-heading">外部候选</h3>
                  <ScreenNote>
                    {candidate().valid
                      ? '存在手写候选，等待显式的合并选择。'
                      : '该候选无效，不能替换已接受的投影。'}
                  </ScreenNote>
                  <dl class="my-4 grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-3">
                    <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                      <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                        候选哈希
                      </dt>
                      <dd class="m-0 text-lg font-[750]">
                        <code>{candidate().candidateHash}</code>
                      </dd>
                    </div>
                    <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                      <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                        变更文稿数
                      </dt>
                      <dd class="m-0 text-lg font-[750]">
                        {candidate().changedLogicalPaths.length}
                      </dd>
                    </div>
                  </dl>
                  <Show when={props.onReconcileAuthoring !== undefined}>
                    <div class="flex flex-wrap gap-2">
                      <For
                        each={
                          [
                            'keep-working',
                            'accept-external',
                            'apply-proposed-disjoint-merge',
                          ] as const
                        }
                      >
                        {(choice) => (
                          <button
                            type="button"
                            class={BUTTON}
                            disabled={!candidate().valid && choice !== 'keep-working'}
                            onClick={() => {
                              const request = reconcileRequest(choice);
                              if (request !== null) void props.onReconcileAuthoring?.(request);
                            }}
                          >
                            {choice === 'keep-working'
                              ? '保留工作层'
                              : choice === 'accept-external'
                                ? '接受外部'
                                : '应用建议的不相交合并'}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </section>
              )}
            </Show>

            <Show when={(props.authoring?.conflicts.length ?? 0) > 0}>
              <section class="border-t border-line pt-5" aria-labelledby="conflicts-heading">
                <h3 id="conflicts-heading">双重冲突 — 同一路径的编辑需要解决</h3>
                <ul class="grid gap-2 p-0 m-0 list-none" aria-label="写作冲突">
                  <For each={props.authoring?.conflicts ?? []}>
                    {(conflict) => (
                      <li>
                        <Diagnostic severity="error">
                          <code>{conflict.logicalPath}</code> 的工作层与外部哈希相互独立。
                        </Diagnostic>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>

            <section
              class="border-t border-line bg-surface px-6 py-4"
              aria-labelledby="operation-center-heading"
            >
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class={KICKER}>操作中心</p>
                  <h3 id="operation-center-heading">提交与合并活动</h3>
                </div>
              </div>
              <Show
                when={(props.operations?.length ?? 0) > 0}
                fallback={<p class="flex items-center gap-3 pt-4 pb-2">没有待处理的写作操作。</p>}
              >
                <ul class="grid gap-2" aria-label="写作操作">
                  <For each={props.operations ?? []}>
                    {(operation) => (
                      <li class="flex flex-wrap items-center justify-between gap-3 border border-line px-3 py-2">
                        <span>
                          <strong>{operation.kind}</strong>
                          <code class="ml-2">{operation.operationId}</code>
                        </span>
                        <span
                          class="m-0 text-[0.8125rem] leading-[1.55] text-muted"
                          data-status={operation.status}
                        >
                          {operation.status}
                          <Show when={operation.errorCode !== null}> — {operation.errorCode}</Show>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
            <section class="border-t border-line pt-5" aria-labelledby="revision-history-heading">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p class={KICKER}>原生历史</p>
                  <h3 id="revision-history-heading">已接受修订历史</h3>
                  <ScreenNote>
                    原生修订身份以 Host 为准。即使配置了 Git 镜像，也不会用于接受或恢复决策。
                  </ScreenNote>
                </div>
                <Show when={props.onListRevisions !== undefined}>
                  <button
                    type="button"
                    class={BUTTON}
                    onClick={() => void props.onListRevisions?.()}
                  >
                    刷新修订历史
                  </button>
                </Show>
              </div>
              <Show
                when={(props.revisionHistory?.revisions.length ?? 0) > 0}
                fallback={<ScreenNote>该项目没有可用的原生修订。</ScreenNote>}
              >
                <ol class="grid gap-2" aria-label="原生修订历史">
                  <For each={props.revisionHistory?.revisions ?? []}>
                    {(revision, index) => (
                      <li class="grid gap-2 border border-line px-3 py-2">
                        <div class="flex flex-wrap items-center justify-between gap-3">
                          <span>
                            <strong>修订 {index() + 1}</strong>
                            <code class="ml-2">{revision.revisionId}</code>
                          </span>
                          <time
                            class="m-0 text-[0.8125rem] leading-[1.55] text-muted"
                            dateTime={revision.acceptedAt}
                          >
                            {revision.acceptedAt}
                          </time>
                        </div>
                        <span class="m-0 text-[0.8125rem] leading-[1.55] text-muted">
                          原生源身份： <code>{revision.sourceHash}</code>
                        </span>
                        <div class="flex flex-wrap gap-2">
                          <Show when={props.onGetRevision !== undefined}>
                            <button
                              type="button"
                              class={BUTTON}
                              onClick={() => void props.onGetRevision?.(revision.revisionId)}
                            >
                              查看修订
                            </button>
                          </Show>
                          <Show when={index() > 0 && props.onDiffRevisions !== undefined}>
                            <button
                              type="button"
                              class={BUTTON}
                              onClick={() =>
                                void props.onDiffRevisions?.(
                                  props.revisionHistory?.revisions[index() - 1]?.revisionId ?? '',
                                  revision.revisionId,
                                )
                              }
                            >
                              与上一修订对比
                            </button>
                          </Show>
                          <Show when={props.onRestoreRevision !== undefined}>
                            <button
                              type="button"
                              class={`${BUTTON} ${BUTTON_PRIMARY}`}
                              disabled={props.authoring?.phase === 'submitting'}
                              onClick={() => {
                                const request = restoreRequest(revision.revisionId);
                                if (request !== null) void props.onRestoreRevision?.(request);
                              }}
                            >
                              恢复修订
                            </button>
                          </Show>
                        </div>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
              <Show when={props.selectedRevision}>
                {(revision) => (
                  <dl
                    class="my-4 grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-3"
                    aria-label="选中的原生修订"
                  >
                    <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                      <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                        选中的修订
                      </dt>
                      <dd class="m-0 text-lg font-[750]">
                        <code>{revision().revisionId}</code>
                      </dd>
                    </div>
                    <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                      <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                        接受时间
                      </dt>
                      <dd class="m-0 text-lg font-[750]">{revision().acceptedAt}</dd>
                    </div>
                  </dl>
                )}
              </Show>
              <Show when={props.revisionDiff}>
                {(diff) => (
                  <section class="grid gap-2" aria-labelledby="native-revision-diff-heading">
                    <h4
                      id="native-revision-diff-heading"
                      class="m-0 text-[0.8125rem] leading-[1.55] text-muted"
                    >
                      原生修订差异
                    </h4>
                    <ScreenNote>
                      差异 {diff().fromRevisionId} → {diff().toRevisionId}
                    </ScreenNote>
                    <Show
                      when={diff().changes.length > 0}
                      fallback={<ScreenNote>选中的修订之间没有变更路径。</ScreenNote>}
                    >
                      <ul class="grid gap-2 p-0 m-0 list-none">
                        <For each={diff().changes}>
                          {(change) => (
                            <li>
                              <code>{change.logicalPath}</code>
                              <span class="m-0 text-[0.8125rem] leading-[1.55] text-muted">
                                {' '}
                                {change.beforeHash === null
                                  ? '新增'
                                  : change.afterHash === null
                                    ? '移除'
                                    : '修改'}
                              </span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </section>
                )}
              </Show>
            </section>
          </>
        )}
      </Show>
    </section>
  );
}
