import { For, Show } from 'solid-js';
import type {
  AuthoringOperationReceiptV1,
  AuthoringReconcileChoiceV1,
  AuthoringStateV1,
  BrowserAuthoringReconcileRequestV1,
  BrowserAuthoringRevisionDiffV1,
  BrowserAuthoringRevisionListV1,
  BrowserAuthoringRevisionRestoreRequestV1,
  BrowserAuthoringRevisionV1,
  BrowserAuthoringSubmitRequestV1,
  SourceStudioDocumentDescriptorV1,
  SourceStudioStateV1,
} from '../contracts/index.js';
import {
  YjsEditor,
  type YjsEditorConnectionStatus,
  type YjsEditorSelection,
} from './yjs-editor.js';

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
  readonly selectedDocumentId?: string | null;
  readonly onSelectDocument?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  /** Transient browser session for the authenticated `/yjs` WebSocket. */
  readonly sessionId?: string | null;
  readonly baseUrl?: string;
  readonly onYjsStatusChange?: (
    descriptor: SourceStudioDocumentDescriptorV1,
    status: SourceStudioYjsStatus,
  ) => void;
  readonly onEditorSelection?: (
    descriptor: SourceStudioDocumentDescriptorV1,
    selection: YjsEditorSelection,
  ) => void;
}

function submitBlockLabel(authoring: AuthoringStateV1): string {
  if (authoring.canSubmit) return 'Ready to submit';
  switch (authoring.submitBlockReason) {
    case 'not-dirty':
      return 'No working changes';
    case 'candidate-invalid':
      return 'Blocked by invalid external candidate';
    case 'conflict-requires-resolution':
      return 'Blocked by unresolved conflict';
    case 'external-candidate-pending':
      return 'Blocked by external candidate';
    case 'submission-in-flight':
      return 'Submit in progress';
    case 'recovery-required':
      return 'Recovery required';
    default:
      return 'Submit unavailable';
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

  return (
    <section
      class="source-studio flex min-h-0 flex-col gap-6"
      aria-labelledby="source-studio-heading"
    >
      <header class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="region-kicker">Source Studio</p>
          <h2 id="source-studio-heading">Authoring source</h2>
          <p class="screen-note max-w-2xl">
            Accepted source is the last valid Host projection. Working edits stay local and
            collaborative until an explicit, validated submit.
          </p>
        </div>
        <Show when={props.authoring}>
          {(authoring) => (
            <div class="flex items-center gap-3" aria-live="polite">
              <span
                class="topbar-status"
                data-phase={authoring().phase}
                data-submit-ready={authoring().canSubmit}
              >
                <span class="status-dot" aria-hidden="true">
                  •
                </span>
                {submitBlockLabel(authoring())}
              </span>
              <Show when={submitRequest()}>
                {(request) => (
                  <button
                    type="button"
                    class="view-button is-active"
                    disabled={request() === null}
                    onClick={() => {
                      const next = request();
                      if (next !== null) void props.onSubmitAuthoring?.(next);
                    }}
                  >
                    Submit working layer
                  </button>
                )}
              </Show>
            </div>
          )}
        </Show>
      </header>

      <Show
        when={props.state}
        fallback={
          <div class="screen-empty" aria-live="polite">
            <h3>No source state</h3>
            <p>The Host has not provided Source Studio state for this project.</p>
          </div>
        }
      >
        {(state) => (
          <>
            <section
              class="accepted-source border-b border-[var(--wb-border)] pb-5"
              aria-labelledby="accepted-source-heading"
            >
              <header>
                <h3 id="accepted-source-heading">Accepted source — last valid projection</h3>
                <p class="screen-note">
                  This is the last source the Host validated and accepted. Working-layer edits below
                  never change it.
                </p>
              </header>
              <Show
                when={state().accepted}
                fallback={
                  <p class="screen-note">
                    The Host has no accepted source projection for this project yet.
                  </p>
                }
              >
                {(accepted) => (
                  <>
                    <dl class="projection-metrics">
                      <div>
                        <dt>Projection revision</dt>
                        <dd>{accepted().revision}</dd>
                      </div>
                      <div>
                        <dt>Accepted source hash</dt>
                        <dd>
                          <code>{accepted().sourceHash ?? 'none accepted'}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Documents</dt>
                        <dd>{accepted().documents}</dd>
                      </div>
                      <div>
                        <dt>Scenes</dt>
                        <dd>{accepted().events}</dd>
                      </div>
                      <div>
                        <dt>Rendered</dt>
                        <dd>{accepted().rendered}</dd>
                      </div>
                      <div>
                        <dt>Blocked</dt>
                        <dd>{accepted().blocked}</dd>
                      </div>
                      <div>
                        <dt>Warnings</dt>
                        <dd>{accepted().warningCount}</dd>
                      </div>
                      <div>
                        <dt>Errors</dt>
                        <dd>{accepted().errorCount}</dd>
                      </div>
                    </dl>
                    <Show when={accepted().diagnostics.length > 0}>
                      <ul class="diagnostic-list" aria-label="Accepted source diagnostics">
                        <For each={accepted().diagnostics}>
                          {(diagnostic) => (
                            <li class={`diagnostic diagnostic-${diagnostic.severity}`}>
                              <code>{diagnostic.code}</code> {diagnostic.message}
                              <Show when={diagnostic.logicalPath !== null}>
                                <span class="diagnostic-path"> — {diagnostic.logicalPath}</span>
                              </Show>
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
              {(authoring) => (
                <section
                  class="authoring-identities grid gap-4 sm:grid-cols-2"
                  aria-label="Independent authoring identities"
                >
                  <div class="workspace-state workspace-state-ready">
                    <p class="region-kicker">Accepted identity</p>
                    <h3>{authoring().acceptedSourceHash ?? 'No accepted source yet'}</h3>
                    <p class="screen-note">
                      Last-valid source hash; this does not change while you type.
                    </p>
                  </div>
                  <div
                    class="workspace-state"
                    data-dirty={authoring().workingDirty}
                    data-phase={authoring().phase}
                  >
                    <p class="region-kicker">Working identity</p>
                    <h3>{authoring().workspaceDigest ?? 'No working digest'}</h3>
                    <p class="screen-note">
                      {authoring().workingDirty
                        ? 'Local Yjs changes are pending explicit validation and submit.'
                        : 'Working documents match the accepted identity.'}
                    </p>
                  </div>
                </section>
              )}
            </Show>

            <section
              class="working-layer flex min-h-0 flex-col gap-4"
              aria-labelledby="working-layer-heading"
            >
              <header>
                <h3 id="working-layer-heading">
                  Working layer (Yjs) — online-only, not accepted source
                </h3>
                <p class="screen-note">
                  Working-layer edits are noncanonical and are never adopted as accepted source
                  until the Host validates and submits them.
                </p>
              </header>
              <Show
                when={state().working.documents.length > 0}
                fallback={
                  <p class="screen-note">The Host reports no working documents for this project.</p>
                }
              >
                <div class="grid gap-4 xl:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)]">
                  <ul class="working-document-list" aria-label="Working documents">
                    <For each={state().working.documents}>
                      {(descriptor) => (
                        <li
                          class="working-document"
                          data-available={descriptor.available}
                          data-selected={selectedDescriptor()?.documentId === descriptor.documentId}
                        >
                          <Show
                            when={props.onSelectDocument !== undefined}
                            fallback={
                              <span class="working-document-identity">
                                <code>{descriptor.documentId}</code>
                                <span class="document-kind">{descriptor.kind}</span>
                                <span class="document-status">
                                  {descriptor.available ? 'available' : 'unavailable'}
                                </span>
                                <span class="document-status">
                                  {statusOf(descriptor.documentId)}
                                </span>
                              </span>
                            }
                          >
                            <button
                              type="button"
                              class="w-full text-left"
                              onClick={() => props.onSelectDocument?.(descriptor)}
                            >
                              <span class="working-document-identity">
                                <code>{descriptor.documentId}</code>
                                <span class="document-kind">{descriptor.kind}</span>
                                <span class="document-status">
                                  {descriptor.available ? 'available' : 'unavailable'}
                                </span>
                                <span class="document-status">
                                  {statusOf(descriptor.documentId)}
                                </span>
                              </span>
                            </button>
                          </Show>
                          <Show when={props.onConnectYjs !== undefined}>
                            <button
                              type="button"
                              disabled={!descriptor.available}
                              onClick={() => props.onConnectYjs?.(descriptor)}
                            >
                              Connect working document
                            </button>
                          </Show>
                          <Show when={props.onSubmit !== undefined}>
                            <button
                              type="button"
                              disabled={
                                !descriptor.available ||
                                (props.authoring !== undefined &&
                                  props.authoring !== null &&
                                  !props.authoring.canSubmit)
                              }
                              onClick={() => props.onSubmit?.(descriptor)}
                            >
                              Submit working document to Host
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>

                  <Show when={props.sessionId !== undefined ? selectedDescriptor() : null}>
                    {(descriptor) => (
                      <section
                        class="min-h-64 overflow-hidden border border-[var(--wb-border)] bg-[var(--wb-surface)]"
                        aria-labelledby="working-editor-heading"
                      >
                        <header class="flex items-center justify-between gap-3 border-b border-[var(--wb-border)] px-4 py-3">
                          <div>
                            <p class="region-kicker">Working editor</p>
                            <h4 id="working-editor-heading">
                              <code>{descriptor().documentId}</code>
                            </h4>
                          </div>
                          <span class="screen-note">Yjs local-first</span>
                        </header>
                        <YjsEditor
                          descriptor={descriptor()}
                          sessionId={props.sessionId}
                          baseUrl={props.baseUrl}
                          onStatusChange={(next) => props.onYjsStatusChange?.(descriptor(), next)}
                          onSelectionChange={(selection) =>
                            props.onEditorSelection?.(descriptor(), selection)
                          }
                        />
                      </section>
                    )}
                  </Show>
                </div>
              </Show>
            </section>

            <Show when={props.authoring?.diagnostics.length}>
              <section
                class="border-t border-[var(--wb-border)] pt-5"
                aria-labelledby="working-diagnostics-heading"
              >
                <h3 id="working-diagnostics-heading">
                  Working candidate diagnostics — not accepted
                </h3>
                <p class="screen-note">
                  These diagnostics describe the current candidate or external tree. The accepted
                  projection above remains the last valid source.
                </p>
                <ul class="diagnostic-list" aria-label="Working candidate diagnostics">
                  <For each={props.authoring?.diagnostics ?? []}>
                    {(diagnostic) => (
                      <li class={`diagnostic diagnostic-${diagnostic.severity}`}>
                        <code>{diagnostic.code}</code> {diagnostic.message}
                        <Show when={diagnostic.logicalPath !== null}>
                          <span class="diagnostic-path"> — {diagnostic.logicalPath}</span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>

            <Show when={props.authoring?.externalCandidate}>
              {(candidate) => (
                <section
                  class="border-t border-[var(--wb-border)] pt-5"
                  aria-labelledby="external-candidate-heading"
                >
                  <h3 id="external-candidate-heading">External candidate</h3>
                  <p class="screen-note">
                    {candidate().valid
                      ? 'A hand-written candidate is waiting for an explicit reconciliation choice.'
                      : 'This candidate is invalid and cannot replace the accepted projection.'}
                  </p>
                  <dl class="projection-metrics">
                    <div>
                      <dt>Candidate hash</dt>
                      <dd>
                        <code>{candidate().candidateHash}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Changed documents</dt>
                      <dd>{candidate().changedLogicalPaths.length}</dd>
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
                            disabled={!candidate().valid && choice !== 'keep-working'}
                            onClick={() => {
                              const request = reconcileRequest(choice);
                              if (request !== null) void props.onReconcileAuthoring?.(request);
                            }}
                          >
                            {choice === 'keep-working'
                              ? 'Keep working'
                              : choice === 'accept-external'
                                ? 'Accept external'
                                : 'Apply proposed disjoint merge'}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </section>
              )}
            </Show>

            <Show when={(props.authoring?.conflicts.length ?? 0) > 0}>
              <section
                class="border-t border-[var(--wb-border)] pt-5"
                aria-labelledby="conflicts-heading"
              >
                <h3 id="conflicts-heading">Dual conflict — same-path edits require resolution</h3>
                <ul class="diagnostic-list" aria-label="Authoring conflicts">
                  <For each={props.authoring?.conflicts ?? []}>
                    {(conflict) => (
                      <li class="diagnostic diagnostic-error">
                        <code>{conflict.logicalPath}</code> has independent working and external
                        hashes.
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>

            <section
              class="operation-center border-t border-[var(--wb-border)] pt-5"
              aria-labelledby="operation-center-heading"
            >
              <div class="operation-heading">
                <div>
                  <p class="region-kicker">Operation Center</p>
                  <h3 id="operation-center-heading">Submit and reconciliation activity</h3>
                </div>
              </div>
              <Show
                when={(props.operations?.length ?? 0) > 0}
                fallback={<p class="operation-empty">No authoring operations are pending.</p>}
              >
                <ul class="grid gap-2" aria-label="Authoring operations">
                  <For each={props.operations ?? []}>
                    {(operation) => (
                      <li class="flex flex-wrap items-center justify-between gap-3 border border-[var(--wb-border)] px-3 py-2">
                        <span>
                          <strong>{operation.kind}</strong>
                          <code class="ml-2">{operation.operationId}</code>
                        </span>
                        <span class="screen-note" data-status={operation.status}>
                          {operation.status}
                          <Show when={operation.errorCode !== null}> — {operation.errorCode}</Show>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
            <section
              class="revision-history border-t border-[var(--wb-border)] pt-5"
              aria-labelledby="revision-history-heading"
            >
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p class="region-kicker">Native history</p>
                  <h3 id="revision-history-heading">Accepted revision history</h3>
                  <p class="screen-note">
                    Native revision identities are Host authority. Git mirrors, if configured, are
                    never used for acceptance or restore decisions.
                  </p>
                </div>
                <Show when={props.onListRevisions !== undefined}>
                  <button type="button" onClick={() => void props.onListRevisions?.()}>
                    Refresh revision history
                  </button>
                </Show>
              </div>
              <Show
                when={(props.revisionHistory?.revisions.length ?? 0) > 0}
                fallback={
                  <p class="screen-note">No native revisions are available for this project.</p>
                }
              >
                <ol class="grid gap-2" aria-label="Native revision history">
                  <For each={props.revisionHistory?.revisions ?? []}>
                    {(revision, index) => (
                      <li class="grid gap-2 border border-[var(--wb-border)] px-3 py-2">
                        <div class="flex flex-wrap items-center justify-between gap-3">
                          <span>
                            <strong>Revision {index() + 1}</strong>
                            <code class="ml-2">{revision.revisionId}</code>
                          </span>
                          <time class="screen-note" dateTime={revision.acceptedAt}>
                            {revision.acceptedAt}
                          </time>
                        </div>
                        <span class="screen-note">
                          Native source identity: <code>{revision.sourceHash}</code>
                        </span>
                        <div class="flex flex-wrap gap-2">
                          <Show when={props.onGetRevision !== undefined}>
                            <button
                              type="button"
                              onClick={() => void props.onGetRevision?.(revision.revisionId)}
                            >
                              View revision
                            </button>
                          </Show>
                          <Show when={index() > 0 && props.onDiffRevisions !== undefined}>
                            <button
                              type="button"
                              onClick={() =>
                                void props.onDiffRevisions?.(
                                  props.revisionHistory?.revisions[index() - 1]?.revisionId ?? '',
                                  revision.revisionId,
                                )
                              }
                            >
                              Compare with previous revision
                            </button>
                          </Show>
                          <Show when={props.onRestoreRevision !== undefined}>
                            <button
                              type="button"
                              disabled={props.authoring?.phase === 'submitting'}
                              onClick={() => {
                                const request = restoreRequest(revision.revisionId);
                                if (request !== null) void props.onRestoreRevision?.(request);
                              }}
                            >
                              Restore revision
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
                  <dl class="projection-metrics" aria-label="Selected native revision">
                    <div>
                      <dt>Selected revision</dt>
                      <dd>
                        <code>{revision().revisionId}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Accepted at</dt>
                      <dd>{revision().acceptedAt}</dd>
                    </div>
                  </dl>
                )}
              </Show>
              <Show when={props.revisionDiff}>
                {(diff) => (
                  <section class="grid gap-2" aria-labelledby="native-revision-diff-heading">
                    <h4 id="native-revision-diff-heading" class="screen-note">
                      Native revision diff
                    </h4>
                    <p class="screen-note">
                      Diff {diff().fromRevisionId} → {diff().toRevisionId}
                    </p>
                    <Show
                      when={diff().changes.length > 0}
                      fallback={
                        <p class="screen-note">The selected revisions have no changed paths.</p>
                      }
                    >
                      <ul class="diagnostic-list">
                        <For each={diff().changes}>
                          {(change) => (
                            <li>
                              <code>{change.logicalPath}</code>
                              <span class="screen-note">
                                {' '}
                                {change.beforeHash === null
                                  ? 'added'
                                  : change.afterHash === null
                                    ? 'removed'
                                    : 'changed'}
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
