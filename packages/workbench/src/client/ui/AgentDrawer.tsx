import { Dialog } from '@kobalte/core/dialog';
import { Show, createEffect, createSignal, on, onCleanup } from 'solid-js';
import type {
  AgentApplyResponseV1,
  AgentClient,
  AgentClientError,
  AgentPauseReason,
  AgentProposalResponseV1,
  AgentProposalV1,
  AgentRequestOptions,
  AgentStaleReason,
} from '../agent-client.js';
import {
  AGENT_CLIENT_CONTRACT_VERSION,
  displayAgentFailure,
  displayAgentPause,
  displayAgentStale,
} from '../agent-client.js';
import type { EditorAssistantContextV1 } from '../editor-assistant-contract.js';
import { AgentDiff } from '../agent-diff.js';

export interface AgentDrawerProps {
  readonly open: boolean;
  /** Safe editor identity/selection; null means the editor has no active scope. */
  readonly context: EditorAssistantContextV1 | null;
  /** Browser transport to guarded Host endpoints; no provider is accepted here. */
  readonly client?: AgentClient;
  readonly onClose?: () => void;
  /** Called after the Host returns an explicit apply result. */
  readonly onApplied?: (result: AgentApplyResponseV1) => void;
  /** Requests a fresh editor context after a pause or stale-vector result. */
  readonly onRefreshContext?: () => void;
  readonly title?: string;
}

type AgentDrawerState =
  | { readonly status: 'idle' }
  | { readonly status: 'queued'; readonly requestId: string | null }
  | { readonly status: 'streaming'; readonly requestId: string | null }
  | { readonly status: 'proposed'; readonly proposal: AgentProposalV1 }
  | { readonly status: 'applying'; readonly proposal: AgentProposalV1 }
  | { readonly status: 'applied'; readonly suggestionId: string }
  | { readonly status: 'paused'; readonly reason: AgentPauseReason }
  | { readonly status: 'stale'; readonly reason: AgentStaleReason }
  | { readonly status: 'failed'; readonly errorCode: string };

export type AgentDrawerStatus = AgentDrawerState['status'];

function contextIdentity(context: EditorAssistantContextV1): string {
  return [
    context.projectId,
    context.documentId,
    context.sceneId ?? '',
    context.baseVector,
    context.selection.from,
    context.selection.to,
  ].join('\u0000');
}

function statusLabel(state: AgentDrawerState): string {
  switch (state.status) {
    case 'idle':
      return 'Ready for a contextual proposal';
    case 'queued':
      return 'Queued with the Host';
    case 'streaming':
      return 'Preparing a proposal';
    case 'proposed':
      return 'Proposal ready for review';
    case 'applying':
      return 'Applying to the working layer';
    case 'applied':
      return 'Applied to the working layer';
    case 'paused':
      return 'Paused — action required';
    case 'stale':
      return 'Stale — refresh required';
    case 'failed':
      return 'Request failed';
  }
}

function statusTone(state: AgentDrawerState): string {
  switch (state.status) {
    case 'queued':
    case 'streaming':
    case 'applying':
      return 'border-[var(--wb-loading-border)] bg-[var(--wb-loading-surface)] text-[var(--wb-warning)]';
    case 'proposed':
      return 'border-[var(--wb-empty-border)] bg-[var(--wb-accent-wash)] text-[var(--wb-accent-deep)]';
    case 'applied':
      return 'border-[var(--wb-ready-border)] bg-[var(--wb-ready-surface)] text-[var(--wb-success)]';
    case 'paused':
    case 'stale':
    case 'failed':
      return 'border-[var(--wb-error-border)] bg-[var(--wb-error-surface)] text-[var(--wb-danger)]';
    case 'idle':
      return 'border-[var(--wb-border)] bg-[var(--wb-surface-muted)] text-[var(--wb-muted)]';
  }
}

function responseToState(response: AgentProposalResponseV1): AgentDrawerState {
  switch (response.status) {
    case 'queued':
      return { status: 'queued', requestId: response.requestId };
    case 'streaming':
      return { status: 'streaming', requestId: response.requestId };
    case 'proposed':
      return { status: 'proposed', proposal: response.proposal };
    case 'paused':
      return { status: 'paused', reason: response.reason };
    case 'stale':
      return { status: 'stale', reason: response.reason };
    case 'failed':
      return { status: 'failed', errorCode: response.errorCode };
  }
}

function errorState(error: unknown): AgentDrawerState {
  if (error instanceof Error && error.name === 'AgentClientError') {
    const clientError = error as AgentClientError;
    return { status: 'failed', errorCode: clientError.code };
  }
  return { status: 'failed', errorCode: 'agent.host-failed' };
}

/**
 * Editor-neutral contextual assistant drawer. It intentionally does not
 * autofocus its controls or use a modal focus trap: opening it leaves the
 * CodeMirror/scene/form editor focused so ordinary typing remains local.
 */
export function AgentDrawer(props: AgentDrawerProps) {
  const [instruction, setInstruction] = createSignal('');
  const [state, setState] = createSignal<AgentDrawerState>({ status: 'idle' });
  const [notice, setNotice] = createSignal<string | null>(null);
  let requestController: AbortController | null = null;
  let requestSerial = 0;
  let requestedContext: EditorAssistantContextV1 | null = null;
  let previousFocus: HTMLElement | null = null;

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open && previousFocus === null && typeof document !== 'undefined') {
          const active = document.activeElement;
          previousFocus = active instanceof HTMLElement ? active : null;
        }
        if (!open && previousFocus !== null) {
          const target = previousFocus;
          previousFocus = null;
          if (target.isConnected) {
            queueMicrotask(() => target.focus({ preventScroll: true }));
          }
        }
      },
    ),
  );

  // A proposal is revision-bound. If the editor changes selection/vector while
  // it is waiting for review, mark it stale instead of offering Apply.
  createEffect(() => {
    const context = props.context;
    const current = state();
    const contextChanged =
      requestedContext !== null &&
      (context === null || contextIdentity(context) !== contextIdentity(requestedContext));
    if (
      contextChanged &&
      (current.status === 'proposed' || current.status === 'applying')
    ) {
      requestSerial += 1;
      requestController?.abort();
      setState({ status: 'stale', reason: 'context-changed' });
      setNotice(null);
    }
  });

  onCleanup(() => {
    requestController?.abort();
    requestSerial += 1;
  });

  const isBusy = () => {
    const current = state().status;
    return current === 'queued' || current === 'streaming' || current === 'applying';
  };

  const setProgress = (serial: number, event: { status: 'queued' | 'streaming'; requestId?: string | null }) => {
    if (serial !== requestSerial) return;
    setState(
      event.status === 'queued'
        ? { status: 'queued', requestId: event.requestId ?? null }
        : { status: 'streaming', requestId: event.requestId ?? null },
    );
  };

  const ask = async (event?: SubmitEvent): Promise<void> => {
    event?.preventDefault();
    const context = props.context;
    const client = props.client;
    const value = instruction().trim();
    setNotice(null);
    if (context === null) {
      setNotice('Select a document range in an editor before asking the assistant.');
      return;
    }
    if (client === undefined) {
      setState({ status: 'failed', errorCode: 'agent.host-failed' });
      return;
    }
    if (value.length === 0) {
      setNotice('Describe the change you want the assistant to propose.');
      return;
    }
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    const serial = ++requestSerial;
    requestedContext = context;
    setState({ status: 'queued', requestId: null });
    try {
      const options: AgentRequestOptions = {
        signal: controller.signal,
        onStatus: (progress) => setProgress(serial, progress),
      };
      const response = await client.propose(
        {
          version: AGENT_CLIENT_CONTRACT_VERSION,
          context,
          instruction: value,
        },
        options,
      );
      if (serial !== requestSerial) return;
      setState(responseToState(response));
    } catch (error) {
      if (serial !== requestSerial) return;
      if (controller.signal.aborted) {
        setState({ status: 'idle' });
        setNotice('The request was stopped before a proposal returned.');
      } else {
        setState(errorState(error));
      }
    } finally {
      if (requestController === controller) requestController = null;
    }
  };

  const stopRequest = (): void => {
    if (!isBusy()) return;
    requestSerial += 1;
    requestController?.abort();
    requestController = null;
    setState({ status: 'idle' });
    setNotice('The request was stopped before a proposal returned.');
  };

  const apply = async (): Promise<void> => {
    const current = state();
    const context = props.context;
    const client = props.client;
    if (
      current.status !== 'proposed' ||
      context === null ||
      client === undefined ||
      requestedContext === null ||
      contextIdentity(context) !== contextIdentity(requestedContext)
    ) {
      if (current.status === 'proposed' && context !== null) {
        setState({ status: 'stale', reason: 'context-changed' });
      }
      return;
    }
    const serial = ++requestSerial;
    setNotice(null);
    setState({ status: 'applying', proposal: current.proposal });
    try {
      const result = await client.applyProposal(
        {
          version: AGENT_CLIENT_CONTRACT_VERSION,
          context,
          proposal: current.proposal,
        },
        {},
      );
      if (serial !== requestSerial) return;
      if (result.status === 'applied') {
        setState({ status: 'applied', suggestionId: result.suggestionId });
      } else if (result.status === 'paused') {
        setState({ status: 'paused', reason: result.reason });
      } else if (result.status === 'stale') {
        setState({ status: 'stale', reason: result.reason });
      } else if (result.status === 'queued') {
        setState({ status: 'queued', requestId: result.requestId });
        setNotice('The Host queued the apply effect. Wait for its operation receipt.');
      } else {
        setState({ status: 'failed', errorCode: result.errorCode });
      }
      props.onApplied?.(result);
    } catch (error) {
      if (serial !== requestSerial) return;
      setState(errorState(error));
    }
  };

  const refresh = (): void => {
    props.onRefreshContext?.();
    setNotice(
      props.onRefreshContext === undefined
        ? 'Select the changed range again to refresh this assistant context.'
        : 'Context refresh requested. Review the new selection before asking again.',
    );
  };

  const proposal = () => {
    const current = state();
    return current.status === 'proposed' || current.status === 'applying' ? current.proposal : null;
  };
  const pausedState = () => {
    const current = state();
    return current.status === 'paused' ? current : null;
  };

  const staleState = () => {
    const current = state();
    return current.status === 'stale' ? current : null;
  };

  const failedState = () => {
    const current = state();
    return current.status === 'failed' ? current : null;
  };


  const currentState = () => state();

  return (
    <Dialog
      open={props.open}
      modal={false}
      preventScroll={false}
      onOpenChange={(open: boolean) => {
        if (!open) props.onClose?.();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          class="agent-shelf-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) props.onClose?.();
          }}
        />
        <Dialog.Content
          class="agent-shelf grid gap-[var(--wb-space-5)]"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div class="region-heading">
            <div>
              <p class="region-kicker">Editor assistant</p>
              <Dialog.Title>{props.title ?? 'Ask the Host assistant'}</Dialog.Title>
              <Dialog.Description>
                The assistant proposes a bounded diff. You decide whether anything enters the
                working layer.
              </Dialog.Description>
            </div>
            <button
              class="icon-button"
              type="button"
              aria-label="Close Agent Drawer"
              onClick={() => props.onClose?.()}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>

          <Show
            when={props.context}
            fallback={
              <div class="grid gap-[var(--wb-space-2)] rounded-[var(--wb-radius-md)] border border-[var(--wb-border)] bg-[var(--wb-surface-muted)] p-[var(--wb-space-4)]">
                <strong>Select an editor range</strong>
                <p class="screen-note">Place the caret or select text in a source, scene, or form before asking.</p>
              </div>
            }
          >
            {(context) => (
              <div
                class="grid gap-[var(--wb-space-1)] rounded-[var(--wb-radius-md)] border border-[var(--wb-border)] bg-[var(--wb-surface-muted)] p-[var(--wb-space-3)]"
                data-testid="agent-context"
              >
                <span class="text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-[var(--wb-muted)]">
                  Version-bound context
                </span>
                <span>
                  <code>{context().documentId}</code> · characters {context().selection.from}–
                  {context().selection.to}
                </span>
                <span class="text-[0.75rem] text-[var(--wb-muted)]">
                  The Host will re-read this working document; source bytes stay outside this drawer.
                </span>
              </div>
            )}
          </Show>

          <form class="grid gap-[var(--wb-space-3)]" onSubmit={(event) => void ask(event)}>
            <label class="grid gap-[var(--wb-space-2)]" for="agent-instruction">
              <span class="font-semibold text-[var(--wb-ink)]">What should change?</span>
              <textarea
                id="agent-instruction"
                name="instruction"
                rows="4"
                value={instruction()}
                placeholder="Describe a focused edit for the selected range…"
                disabled={isBusy()}
                onInput={(event) => setInstruction(event.currentTarget.value)}
                class="w-full resize-y rounded-[var(--wb-radius-sm)] border border-[var(--wb-border-strong)] bg-[var(--wb-surface)] p-[var(--wb-space-3)] text-[var(--wb-ink)] placeholder:text-[var(--wb-muted)] focus:border-[var(--wb-focus)] focus-visible:outline-[0.1875rem] focus-visible:outline-[var(--wb-focus)] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            <div class="flex flex-wrap items-center gap-[var(--wb-space-2)]">
              <button
                type="submit"
                disabled={
                  props.client === undefined ||
                  props.context === null ||
                  instruction().trim().length === 0 ||
                  isBusy()
                }
                class="inline-flex min-h-[2.5rem] items-center justify-center rounded-[var(--wb-radius-sm)] bg-[var(--wb-accent)] px-[var(--wb-space-4)] py-[var(--wb-space-2)] font-semibold text-[var(--wb-on-ink)] transition-colors hover:bg-[var(--wb-accent-deep)] focus-visible:outline-[0.1875rem] focus-visible:outline-[var(--wb-focus)] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Ask for a proposal
              </button>
              <Show when={isBusy()}>
                <button
                  type="button"
                  class="text-button"
                  onClick={stopRequest}
                >
                  Stop waiting
                </button>
              </Show>
            </div>
          </form>

          <div
            class={`grid gap-[var(--wb-space-2)] rounded-[var(--wb-radius-md)] border p-[var(--wb-space-3)] ${statusTone(currentState())}`}
            role="status"
            aria-live="polite"
            aria-busy={isBusy()}
            data-testid="agent-status"
          >
            <strong>{statusLabel(currentState())}</strong>
            <Show when={currentState().status === 'queued'}>
              <p class="m-0">The Host has accepted the request; no document change has happened.</p>
            </Show>
            <Show when={currentState().status === 'streaming'}>
              <p class="m-0">The Host is preparing a reviewable diff. Nothing is applied yet.</p>
            </Show>
            <Show when={currentState().status === 'applying'}>
              <p class="m-0">The explicit Apply action is being checked against the latest working vector.</p>
            </Show>
            <Show when={currentState().status === 'applied'}>
              <p class="m-0">The proposal entered the working layer. Accepted source is unchanged until submit.</p>
            </Show>
            <Show when={pausedState()}>
              {(paused) => (
                <>
                  <p class="m-0">{displayAgentPause(paused().reason)}</p>
                  <button type="button" class="text-button justify-self-start" onClick={refresh}>
                    Refresh context and replan
                  </button>
                </>
              )}
            </Show>
            <Show when={staleState()}>
              {(stale) => (
                <>
                  <p class="m-0">{displayAgentStale(stale().reason)}</p>
                  <button type="button" class="text-button justify-self-start" onClick={refresh}>
                    Refresh context
                  </button>
                </>
              )}
            </Show>
            <Show when={failedState()}>
              {(failed) => <p class="m-0">{displayAgentFailure(failed().errorCode)}</p>}
            </Show>
            <Show when={notice()}>
              {(message) => <p class="m-0 text-[var(--wb-muted)]">{message()}</p>}
            </Show>
          </div>

          <Show when={proposal()}>
            {(currentProposal) => (
              <AgentDiff
                proposal={currentProposal()}
                applyDisabled={currentState().status === 'applying'}
                onApply={() => void apply()}
              />
            )}
          </Show>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
