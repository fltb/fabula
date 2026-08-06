/**
 * Agent Chat view (plan 9.5): a conversation + tool-call review surface.
 *
 * Rendered only when the Host-derived features include `agent-chat`. The view
 * owns ONE conversation per mount: a message list fed by the live SSE progress
 * stream, per-run tool-call receipts from the durable history, a cancel button
 * while a run is queued/running, and an explicit retry for interrupted runs.
 * It is deliberately not a single-document span-diff drawer.
 */

import type { JSX } from 'solid-js';
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type {
  AgentChatConversationViewV1,
  AgentChatProgressEventV1,
  AgentChatRunHistoryEntryV1,
  AgentChatRunViewV1,
  AgentChatToolCallReceiptV1,
} from '../contracts/index.js';
import type { AgentChatClient } from './agent-chat-client.js';

interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly at: string;
}

export interface AgentChatProps {
  readonly projectId: string;
  readonly client: AgentChatClient;
}

function runLabel(run: AgentChatRunViewV1): string {
  return `Run ${run.runId.slice(0, 8)} · ${run.status} · ${run.turn}/${run.maxTurns} turns · ${run.toolCalls}/${run.maxToolCalls} tool calls`;
}

function receiptLabel(call: AgentChatToolCallReceiptV1): string {
  const result =
    call.status === 'pending'
      ? 'pending'
      : call.status === 'succeeded'
        ? `succeeded ${call.resultSummary ?? ''}`
        : `failed ${call.resultSummary ?? ''}`;
  return `${call.toolName} #${call.callIndex} — ${result}`;
}

export function AgentChat(props: AgentChatProps): JSX.Element {
  const [conversation, setConversation] = createSignal<AgentChatConversationViewV1 | null>(null);
  const [messages, setMessages] = createSignal<readonly ChatMessage[]>([]);
  const [runs, setRuns] = createSignal<readonly AgentChatRunHistoryEntryV1[]>([]);
  const [draft, setDraft] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [streamingRun, setStreamingRun] = createSignal<string | null>(null);
  let activeRunId: string | null = null;
  let stopProgress: (() => void) | null = null;

  const refreshHistory = async (): Promise<void> => {
    const current = conversation();
    if (current === null) return;
    const history = await props.client.history(props.projectId, current.conversationId);
    setRuns(history.runs);
  };

  const ensureConversation = async (): Promise<void> => {
    if (conversation() !== null) return;
    const created = await props.client.createConversation(props.projectId);
    setConversation(created);
    await refreshHistory();
  };

  onMount(() => {
    void ensureConversation().catch((cause: unknown) => {
      setError(errorMessage(cause));
    });
    onCleanup(() => {
      stopProgress?.();
      stopProgress = null;
    });
  });

  const handleProgressEvent = (event: AgentChatProgressEventV1): void => {
    if (event.type === 'assistant-text') {
      setMessages((current) => [
        ...current,
        {
          id: `${event.runId}-${event.at}-${current.length}`,
          role: 'assistant',
          content: event.text,
          at: event.at,
        },
      ]);
      return;
    }
    if (event.type === 'tool-call') {
      // Live receipt: merge into the run entry (or show as a standalone run
      // fragment while the durable history refreshes).
      const runId = event.runId;
      setRuns((current) => {
        const existing = current.find((entry) => entry.run.runId === runId);
        if (existing === undefined) return current;
        const nextCalls = upsertReceipt(existing.toolCalls, event.call);
        return current.map((entry) =>
          entry.run.runId === runId ? { run: entry.run, toolCalls: nextCalls } : entry,
        );
      });
      return;
    }
    if (event.type === 'tool-result') {
      return; // the tool-call event already carries the completed receipt
    }
    if (event.type === 'run-status') {
      const run = event.run;
      setRuns((current) => {
        const existing = current.find((entry) => entry.run.runId === run.runId);
        if (existing === undefined) {
          return [...current, { run, toolCalls: [] }];
        }
        return current.map((entry) =>
          entry.run.runId === run.runId ? { run, toolCalls: entry.toolCalls } : entry,
        );
      });
      if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
        if (activeRunId === run.runId) {
          stopProgress?.();
          stopProgress = null;
          activeRunId = null;
          setStreamingRun(null);
        }
        void refreshHistory().catch(() => undefined);
      }
    }
  };

  const send = async (): Promise<void> => {
    const message = draft().trim();
    if (message.length === 0 || sending()) return;
    const current = conversation();
    if (current === null) {
      setError('The conversation is not ready yet.');
      return;
    }
    setError(null);
    setSending(true);
    setMessages((all) => [
      ...all,
      { id: `user-${Date.now()}`, role: 'user', content: message, at: new Date().toISOString() },
    ]);
    setDraft('');
    try {
      const run = await props.client.sendMessage(props.projectId, current.conversationId, message);
      setRuns((all) => [...all, { run, toolCalls: [] }]);
      activeRunId = run.runId;
      setStreamingRun(run.runId);
      stopProgress = props.client.openProgress(
        props.projectId,
        current.conversationId,
        run.runId,
        handleProgressEvent,
      );
      void refreshHistory().catch(() => undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
    }
  };

  const cancelRun = async (runId: string): Promise<void> => {
    setError(null);
    try {
      await props.client.cancel(props.projectId, runId);
      await refreshHistory();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const retryRun = async (runId: string): Promise<void> => {
    setError(null);
    try {
      await props.client.retry(props.projectId, runId);
      await refreshHistory();
      activeRunId = runId;
      setStreamingRun(runId);
      const current = conversation();
      if (current !== null) {
        stopProgress = props.client.openProgress(
          props.projectId,
          current.conversationId,
          runId,
          handleProgressEvent,
        );
      }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <section class="agent-chat" data-testid="agent-chat" aria-label="Agent chat">
      <div class="agent-chat-heading">
        <div>
          <p class="region-kicker">Agent / Conversation</p>
          <h2>Agent Chat</h2>
        </div>
        <Show when={conversation() !== null}>
          <span
            class="text-xs text-[var(--wb-text-muted)]"
            data-testid="agent-chat-conversation-id"
          >
            {conversation()?.conversationId}
          </span>
        </Show>
      </div>

      <Show when={error() !== null}>
        <p class="agent-chat-error" role="alert" data-testid="agent-chat-error">
          {error()}
        </p>
      </Show>

      <div class="agent-chat-messages" data-testid="agent-chat-messages">
        <Show
          when={messages().length > 0}
          fallback={
            <p class="agent-chat-empty">
              Send a message to start an Agent run. The Agent can only use the tools your project
              role grants.
            </p>
          }
        >
          <For each={messages()}>
            {(message) => (
              <article class={`agent-message agent-message-${message.role}`}>
                <span class="agent-message-role">{message.role}</span>
                <p>{message.content}</p>
              </article>
            )}
          </For>
        </Show>
      </div>

      <Show when={runs().length > 0}>
        <div class="agent-runs" data-testid="agent-chat-runs">
          <h3>Tool-call receipts</h3>
          <ul class="grid gap-[var(--wb-space-2)]">
            <For each={runs()}>
              {(entry) => (
                <li class="agent-run" data-testid={`agent-run-${entry.run.runId}`}>
                  <div class="flex flex-wrap items-center justify-between gap-[var(--wb-space-2)]">
                    <span class="agent-run-label" data-testid="agent-run-status">
                      {runLabel(entry.run)}
                    </span>
                    <span class="flex gap-[var(--wb-space-2)]">
                      <Show when={entry.run.status === 'queued' || entry.run.status === 'running'}>
                        <button
                          class="text-button"
                          type="button"
                          data-testid={`agent-cancel-${entry.run.runId}`}
                          onClick={() => void cancelRun(entry.run.runId)}
                        >
                          Cancel
                        </button>
                      </Show>
                      <Show when={entry.run.status === 'interrupted'}>
                        <button
                          class="text-button"
                          type="button"
                          data-testid={`agent-retry-${entry.run.runId}`}
                          onClick={() => void retryRun(entry.run.runId)}
                        >
                          Retry
                        </button>
                      </Show>
                      <Show when={streamingRun() === entry.run.runId}>
                        <span class="agent-streaming" data-testid="agent-streaming">
                          streaming…
                        </span>
                      </Show>
                    </span>
                  </div>
                  <Show when={entry.run.errorCode !== null}>
                    <p class="text-xs text-[var(--wb-text-muted)]" data-testid="agent-run-error">
                      {entry.run.errorCode}
                    </p>
                  </Show>
                  <Show when={entry.toolCalls.length > 0}>
                    <ul class="agent-tool-calls">
                      <For each={entry.toolCalls}>
                        {(call) => (
                          <li data-testid={`agent-tool-call-${entry.run.runId}-${call.callIndex}`}>
                            <span class="agent-tool-call-name">{call.toolName}</span>
                            <span class="agent-tool-call-status" data-status={call.status}>
                              {receiptLabel(call)}
                            </span>
                            <code class="agent-tool-call-hash">
                              {call.sanitizedArgsHash.slice(0, 12)}
                            </code>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      <form
        class="agent-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label class="sr-only" for="agent-chat-input">
          Message the Agent
        </label>
        <input
          id="agent-chat-input"
          type="text"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          placeholder="Describe the authoring work to run…"
          disabled={sending() || conversation() === null}
          data-testid="agent-chat-input"
        />
        <button
          class="text-button"
          type="submit"
          disabled={sending() || draft().trim().length === 0 || conversation() === null}
          data-testid="agent-chat-send"
        >
          {sending() ? 'Sending…' : 'Send'}
        </button>
      </form>
    </section>
  );
}

function upsertReceipt(
  calls: readonly AgentChatToolCallReceiptV1[],
  next: AgentChatToolCallReceiptV1,
): readonly AgentChatToolCallReceiptV1[] {
  const existing = calls.findIndex((call) => call.callIndex === next.callIndex);
  if (existing < 0) return [...calls, next];
  return calls.map((call) => (call.callIndex === next.callIndex ? next : call));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The Agent request failed.';
}
