/**
 * Agent Chat surface (plan 5.1): a conversation list + message surface.
 *
 * Rendered as a global right-side drawer on every workspace view (the shell
 * owns the drawer shell; this component owns the chat). The surface owns the
 * conversation list (newest-updated first) and one active conversation whose
 * messages are loaded from the durable history and streamed live over SSE:
 * assistant text accumulates into ONE message per run (not one per delta),
 * tool-call receipts fold into that run's `<details>`, cancel / retry
 * controls cover queued/running/interrupted/failed runs, artifact chips link
 * succeeded nova_publish / nova_render calls to the publication and review
 * surfaces, and an empty-conversation welcome card set fills the composer
 * with agent-first example prompts. An optional view-context strip shows what
 * the agent knows about the caller's current view.
 */

import type { JSX } from 'solid-js';
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { SolidMarkdown } from 'solid-markdown';
import type {
  AgentChatConversationViewV1,
  AgentChatMessageViewV1,
  AgentChatProgressEventV1,
  AgentChatRunHistoryEntryV1,
  AgentChatRunViewV1,
  AgentChatToolCallReceiptV1,
  AgentViewContextV1,
} from '../contracts/index.js';
import type { HostStatus } from './App.js';
import type { AgentChatClient } from './agent-chat-client.js';
import { BrowserAgentChatApiError } from './agent-chat-client.js';

interface ChatMessage {
  readonly id: string;
  readonly runId: string;
  readonly role: 'user' | 'assistant' | 'tool_result';
  readonly content: string;
  readonly toolName: string | null;
  readonly callIndex: number | null;
  readonly at: string;
}

interface ArtifactChip {
  readonly key: string;
  readonly label: string;
  readonly view: string;
  readonly hint: string;
}

/** Agent-first onboarding prompts; clicking one fills the composer. */
const WELCOME_PROMPTS: readonly {
  readonly glyph: string;
  readonly prompt: string;
  readonly hint: string;
}[] = [
  {
    glyph: '✳',
    prompt: '查看项目当前状态并告诉我下一步',
    hint: '了解项目进展，由 Agent 规划下一步动作',
  },
  {
    glyph: '◫',
    prompt: '让 AI 写第 1 章并生成书籍文件',
    hint: '生成第 1 章散文并输出为可下载的书籍文件',
  },
  {
    glyph: '✓',
    prompt: '检查有哪些待处理的评审或门禁',
    hint: '扫描待处理的评审意见与发布门禁',
  },
];

/** localStorage gate for the first-visit mini tour (plan 9.4.1). */
const ONBOARDING_SEEN_KEY = 'workbench.onboardingSeen';

/** Plan 9.4.1: four-step first-visit mini tour shown on the empty Agent Chat. */
const TOUR_STEPS: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'Agent Chat 是入口',
    body: '从这里用自然语言驱动整个写作流程：提问、渲染、发布都由它发起。',
  },
  {
    title: 'Source Studio 编辑源文件',
    body: '切换到 Source Studio 视图直接编辑章节源文件，Agent 的改动也落在这里。',
  },
  {
    title: 'Review Hub 看评审门禁',
    body: 'Review Hub 汇总评审意见与发布门禁，Agent 可以代你扫描待办。',
  },
  {
    title: 'Publication 发布产物',
    body: '发布后的产物在 Publication 视图查看，Agent 的发布调用会生成可查看的产物。',
  },
];

/** Plan 9.4.3: inline copy for the agent-unavailable banner. */
const AGENT_UNAVAILABLE_COPY = 'Agent 未启用（配置：agent.enabled / provider key / parity）';

export interface AgentChatProps {
  readonly projectId: string;
  readonly client: AgentChatClient;
  /** Switch the workspace to another view (artifact chips → publication / review-hub). */
  readonly onViewChange?: (view: string) => void;
  /** Host readiness; 'error' also renders the agent-unavailable banner (plan 9.4.3). */
  readonly hostStatus?: HostStatus;
  /** Open the admin Provider settings; absent → the banner renders text only. */
  readonly onOpenSettings?: () => void;
  /**
   * Secret-free snapshot of what the caller is looking at. Passed through to
   * every `sendMessage` and shown read-only in the context strip.
   */
  readonly context?: AgentViewContextV1;
  /** Whether the panel body starts expanded; the drawer renders open by default. */
  readonly defaultOpen?: boolean;
}

function runLabel(run: AgentChatRunViewV1): string {
  return `Run ${run.runId.slice(0, 8)} · ${run.status} · ${run.turn}/${run.maxTurns} turns · ${run.toolCalls}/${run.maxToolCalls} tool calls`;
}
/** Chinese action label for known Agent tool calls; unknown tools keep their wire name. */
const TOOL_ACTION_NAMES: Readonly<Record<string, string>> = {
  nova_render: '渲染',
  nova_publish: '发布',
  nova_authoring_submit: '提交',
  nova_status: '查看状态',
  nova_authoring_validate: '校验',
};
function toolActionName(toolName: string): string {
  return TOOL_ACTION_NAMES[toolName] ?? toolName;
}

/** Chinese labels for known workspace views, shown in the agent context strip. */
const AGENT_VIEW_LABELS: Readonly<Record<string, string>> = {
  'project-home': '项目首页',
  'source-studio': '文稿',
  'graph-route': '图谱',
  'scene-map': '场景图',
  'review-hub': '审校',
  'scene-canvas': '场景画布',
  publication: '发布',
  references: '参考资料',
  settings: '设置',
};
/** Human-readable view label for a view id; unknown ids keep their wire name. */
export function agentViewLabel(view: string): string {
  return AGENT_VIEW_LABELS[view] ?? view;
}

/**
 * Compact read-only strip of what the agent currently knows about the
 * caller's context. Only non-empty fields are shown.
 */
function AgentContextStrip(props: { readonly context: AgentViewContextV1 }): JSX.Element {
  const items = (): string[] => {
    const out: string[] = [];
    const view = props.context.view;
    if (view.length > 0) out.push(`当前视图: ${agentViewLabel(view)}`);
    const projectName = props.context.projectName;
    if (projectName !== undefined && projectName.length > 0) out.push(`项目: ${projectName}`);
    const actions = props.context.actions;
    if (actions !== undefined && actions.length > 0) out.push(`可执行: ${actions.join('、')}`);
    return out;
  };
  return (
    <p class="agent-context-strip" data-testid="agent-context-strip">
      {items().join(' · ')}
    </p>
  );
}

function receiptLabel(call: AgentChatToolCallReceiptV1): string {
  const result =
    call.status === 'pending'
      ? '等待中'
      : call.status === 'succeeded'
        ? `成功 ${call.resultSummary ?? ''}`
        : `失败 ${call.resultSummary ?? ''}`;
  return `${toolActionName(call.toolName)} #${call.callIndex} — ${result}`;
}
/** The failed run entry for a message's run id, if any (drives the inline retry chip). */
function failedRunOf(
  runs: readonly AgentChatRunHistoryEntryV1[],
  runId: string,
): AgentChatRunHistoryEntryV1 | null {
  return (
    runs.find(
      (entry) =>
        entry.run.runId === runId &&
        (entry.run.status === 'failed' || entry.run.status === 'interrupted'),
    ) ?? null
  );
}

function messageViewOf(message: AgentChatMessageViewV1): ChatMessage {
  return {
    id: message.messageId,
    runId: message.runId,
    role: message.role,
    content: message.content,
    toolName: message.toolName,
    callIndex: message.callIndex,
    at: message.createdAt,
  };
}

function artifactChipsOf(entry: AgentChatRunHistoryEntryV1): readonly ArtifactChip[] {
  const chips: ArtifactChip[] = [];
  for (const call of entry.toolCalls) {
    if (call.status !== 'succeeded') continue;
    if (call.toolName === 'nova_publish') {
      chips.push({
        key: `publish-${call.callIndex}`,
        label: '查看发布产物',
        view: 'publication',
        hint: '在 Publication 视图查看已发布产物',
      });
    } else if (call.toolName === 'nova_render') {
      chips.push({
        key: `render-${call.callIndex}`,
        label: '查看渲染产物',
        view: 'review-hub',
        hint: '渲染产物可在 Publication / Review Hub 查看',
      });
    }
  }
  return chips;
}

export function AgentChat(props: AgentChatProps): JSX.Element {
  const [conversations, setConversations] = createSignal<readonly AgentChatConversationViewV1[]>(
    [],
  );
  const [conversation, setConversation] = createSignal<AgentChatConversationViewV1 | null>(null);
  const [messages, setMessages] = createSignal<readonly ChatMessage[]>([]);
  const [runs, setRuns] = createSignal<readonly AgentChatRunHistoryEntryV1[]>([]);
  const [draft, setDraft] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [streamingRun, setStreamingRun] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal(props.defaultOpen ?? true);
  let activeRunId: string | null = null;
  let agentChatInput: HTMLTextAreaElement | undefined;
  let chipsScroll: HTMLDivElement | undefined;
  let stopProgress: (() => void) | null = null;
  let loadToken = 0;
  const [historyState, setHistoryState] = createSignal<'loading' | 'empty' | 'populated' | 'error'>(
    'loading',
  );
  const [agentUnavailable, setAgentUnavailable] = createSignal(false);
  const [tourStep, setTourStep] = createSignal(0);
  const [tourDismissed, setTourDismissed] = createSignal(
    typeof localStorage !== 'undefined' && localStorage.getItem(ONBOARDING_SEEN_KEY) !== null,
  );
  const showTour = (): boolean => historyState() === 'empty' && !tourDismissed();

  const dismissTour = (): void => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
    setTourDismissed(true);
  };

  const nextTourStep = (): void => {
    if (tourStep() >= TOUR_STEPS.length - 1) {
      dismissTour();
      return;
    }
    setTourStep((step) => step + 1);
  };

  const reportError = (cause: unknown): void => {
    if (cause instanceof BrowserAgentChatApiError && cause.code === 'AGENT_CHAT_UNAVAILABLE') {
      setAgentUnavailable(true);
      setError(null);
      return;
    }
    setError(errorMessage(cause));
  };

  const refreshHistory = async (): Promise<void> => {
    const current = conversation();
    if (current === null) return;
    const history = await props.client.history(props.projectId, current.conversationId);
    setRuns(history.runs);
    setMessages(history.messages.map(messageViewOf));
  };

  const openConversation = async (target: AgentChatConversationViewV1): Promise<void> => {
    stopProgress?.();
    stopProgress = null;
    activeRunId = null;
    setStreamingRun(null);
    setConversation(target);
    const token = ++loadToken;
    const history = await props.client.history(props.projectId, target.conversationId);
    if (token !== loadToken) return; // a newer selection superseded this one
    setRuns(history.runs);
    setMessages(history.messages.map(messageViewOf));
    setError(null);
    setAgentUnavailable(false);
  };

  const createConversation = async (): Promise<void> => {
    try {
      const created = await props.client.createConversation(props.projectId);
      setConversations((all) => [created, ...all]);
      setHistoryState('populated');
      dismissTour();
      await openConversation(created);
      agentChatInput?.focus();
    } catch (cause) {
      reportError(cause);
    }
  };

  createEffect(() => {
    const activeId = conversation()?.conversationId;
    if (activeId === undefined) return;
    const chip = chipsScroll?.querySelector<HTMLElement>(
      `[data-testid="agent-conversation-${activeId}"]`,
    );
    // jsdom has no scrollIntoView; guard for both absence and non-matching chips.
    chip?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });

  onMount(() => {
    void props.client
      .listConversations(props.projectId)
      .then(async (list) => {
        const sorted = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        setConversations(sorted);
        setHistoryState(sorted.length === 0 ? 'empty' : 'populated');
        if (sorted[0] !== undefined) await openConversation(sorted[0]);
      })
      .catch((cause: unknown) => {
        setHistoryState('error');
        reportError(cause);
      });
    onCleanup(() => {
      stopProgress?.();
      stopProgress = null;
    });
  });

  const handleProgressEvent = (event: AgentChatProgressEventV1): void => {
    if (event.type === 'assistant-text') {
      // Accumulate deltas into the CURRENT assistant message of this run:
      // one message per run, not one per delta.
      const runId = event.runId;
      setMessages((current) => {
        let index = -1;
        for (let i = current.length - 1; i >= 0; i -= 1) {
          const message = current[i];
          if (message !== undefined && message.role === 'assistant' && message.runId === runId) {
            index = i;
            break;
          }
        }
        if (index >= 0) {
          const existing = current[index];
          if (existing === undefined) return current;
          const merged = [...current];
          merged[index] = { ...existing, content: existing.content + event.text, at: event.at };
          return merged;
        }
        return [
          ...current,
          {
            id: `run-${runId}`,
            runId,
            role: 'assistant',
            content: event.text,
            toolName: null,
            callIndex: null,
            at: event.at,
          },
        ];
      });
      return;
    }
    if (event.type === 'tool-call') {
      // Live receipt: merge into the run entry (the run-status replay of the
      // progress stream guarantees the entry exists before any tool-call event).
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
    let current = conversation();
    if (current === null) {
      // Welcome-card start: create the conversation on first send.
      try {
        const created = await props.client.createConversation(props.projectId);
        setConversations((all) => [created, ...all]);
        setConversation(created);
        current = created;
        setHistoryState('populated');
        dismissTour();
      } catch (cause) {
        reportError(cause);
        return;
      }
    }
    setError(null);
    setAgentUnavailable(false);
    setSending(true);
    const optimisticId = `user-${Date.now()}`;
    setMessages((all) => [
      ...all,
      {
        id: optimisticId,
        runId: '',
        role: 'user',
        content: message,
        toolName: null,
        callIndex: null,
        at: new Date().toISOString(),
      },
    ]);
    setDraft('');
    try {
      const run = await props.client.sendMessage(
        props.projectId,
        current.conversationId,
        message,
        props.context,
      );
      setMessages((all) =>
        all.map((entry) => (entry.id === optimisticId ? { ...entry, runId: run.runId } : entry)),
      );
      setRuns((all) =>
        all.some((entry) => entry.run.runId === run.runId)
          ? all.map((entry) =>
              entry.run.runId === run.runId ? { run, toolCalls: entry.toolCalls } : entry,
            )
          : [...all, { run, toolCalls: [] }],
      );
      activeRunId = run.runId;
      setStreamingRun(run.runId);
      stopProgress = props.client.openProgress(
        props.projectId,
        current.conversationId,
        run.runId,
        handleProgressEvent,
      );
    } catch (cause) {
      reportError(cause);
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
      reportError(cause);
    }
  };

  const cancelCurrent = async (): Promise<void> => {
    const runId = activeRunId ?? streamingRun();
    if (runId === null) return;
    await cancelRun(runId);
  };

  const retryRun = async (runId: string): Promise<void> => {
    setError(null);
    try {
      await props.client.retry(props.projectId, runId);
      await refreshHistory();
      // The retried attempt re-streams under the same run id: drop the
      // previous attempt's assistant/tool messages but keep its user message
      // so deltas start a fresh assistant message.
      setMessages((all) =>
        all.filter((message) => message.runId !== runId || message.role === 'user'),
      );
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
      reportError(cause);
    }
  };

  return (
    <section class="agent-chat" data-testid="agent-chat" aria-label="Agent chat">
      <div class="agent-chat-heading">
        <div>
          <p class="region-kicker">Agent / Conversation</p>
          <h2>Agent Chat</h2>
        </div>
        <div class="flex items-center gap-[var(--wb-space-3)]">
          <Show when={conversation() !== null}>
            <span
              class="text-xs text-[var(--wb-text-muted)]"
              data-testid="agent-chat-conversation-id"
            >
              {conversation()?.conversationId}
            </span>
          </Show>
          <button
            class="icon-button"
            type="button"
            aria-label={open() ? '收起 Agent 面板' : '展开 Agent 面板'}
            aria-expanded={open()}
            data-testid="agent-panel-toggle"
            onClick={() => setOpen((current) => !current)}
          >
            <span aria-hidden="true">{open() ? '–' : '✳'}</span>
          </button>
        </div>
      </div>
      <Show when={props.context}>{(ctx) => <AgentContextStrip context={ctx()} />}</Show>
      <Show when={open()}>
        <Show when={showTour()}>
          <aside
            class="agent-onboarding-tour"
            data-testid="agent-onboarding-tour"
            aria-label="首次使用引导"
          >
            <div class="agent-onboarding-step">
              <span class="agent-onboarding-index" aria-hidden="true">
                {tourStep() + 1}/{TOUR_STEPS.length}
              </span>
              <div class="agent-onboarding-copy">
                <h3 class="agent-onboarding-title">{TOUR_STEPS[tourStep()]?.title}</h3>
                <p class="agent-onboarding-body">{TOUR_STEPS[tourStep()]?.body}</p>
              </div>
            </div>
            <div class="agent-onboarding-actions">
              <button
                class="text-button"
                type="button"
                data-testid="agent-tour-skip"
                onClick={dismissTour}
              >
                跳过
              </button>
              <button
                class="text-button"
                type="button"
                data-testid="agent-tour-next"
                onClick={nextTourStep}
              >
                下一步
              </button>
            </div>
            <div class="agent-onboarding-dots" aria-hidden="true">
              <For each={TOUR_STEPS}>
                {(_, index) => (
                  <span
                    class="agent-onboarding-dot"
                    classList={{ 'is-active': index() === tourStep() }}
                  />
                )}
              </For>
            </div>
          </aside>
        </Show>

        <Show when={agentUnavailable() || props.hostStatus === 'error'}>
          <div class="agent-unavailable-banner" role="alert" data-testid="agent-unavailable-banner">
            <span>{AGENT_UNAVAILABLE_COPY}</span>
            <Show when={props.onOpenSettings !== undefined}>
              <button
                class="text-button"
                type="button"
                data-testid="agent-open-settings"
                onClick={() => props.onOpenSettings?.()}
              >
                打开设置
              </button>
            </Show>
          </div>
        </Show>

        <Show when={error() !== null}>
          <p class="agent-chat-error" role="alert" data-testid="agent-chat-error">
            {error()}
          </p>
        </Show>

        <fieldset class="agent-conversation-chips" aria-label="Conversations">
          <span class="agent-conversations-label">会话</span>
          <div class="agent-chips-scroll" ref={chipsScroll} data-testid="agent-chips-scroll">
            <Show
              when={conversations().length > 0}
              fallback={<span class="text-xs text-[var(--wb-text-muted)]">暂无会话</span>}
            >
              <For each={conversations()}>
                {(entry) => (
                  <button
                    class="agent-conversation-chip"
                    classList={{
                      'is-active': conversation()?.conversationId === entry.conversationId,
                    }}
                    type="button"
                    data-testid={`agent-conversation-${entry.conversationId}`}
                    onClick={() => void openConversation(entry)}
                  >
                    <span class="agent-conversation-title">{entry.title ?? '新会话'}</span>
                  </button>
                )}
              </For>
            </Show>
          </div>
          <button
            class="text-button agent-chips-new"
            type="button"
            data-testid="agent-chat-new-conversation"
            onClick={() => void createConversation()}
          >
            + 新会话
          </button>
        </fieldset>

        <div class="agent-chat-scroll" data-testid="agent-chat-scroll">
          <div class="agent-chat-messages" data-testid="agent-chat-messages">
            <Show
              when={messages().length > 0}
              fallback={
                <div class="agent-chat-welcome" data-testid="agent-chat-welcome">
                  <p class="agent-chat-welcome-title">不知道从哪开始？试试这些</p>
                  <div class="grid gap-[var(--wb-space-2)]">
                    <For each={WELCOME_PROMPTS}>
                      {(example, index) => (
                        <button
                          class="agent-chat-welcome-card"
                          type="button"
                          data-testid={`agent-chat-welcome-card-${index()}`}
                          onClick={() => setDraft(example.prompt)}
                        >
                          <span class="agent-chat-welcome-glyph" aria-hidden="true">
                            {example.glyph}
                          </span>
                          <span class="agent-chat-welcome-text">
                            <span class="agent-chat-welcome-prompt">{example.prompt}</span>
                            <span class="agent-chat-welcome-hint">{example.hint}</span>
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              }
            >
              <For each={messages()}>
                {(message) => (
                  <Show when={message.role !== 'tool_result'}>
                    <article class={`agent-message agent-message-${message.role}`}>
                      <span class="agent-message-role">{message.role}</span>
                      {message.role === 'assistant' ? (
                        <div class="agent-message-markdown">
                          <SolidMarkdown children={message.content} />
                        </div>
                      ) : (
                        <p>{message.content}</p>
                      )}
                      <Show
                        when={
                          message.role === 'assistant' ? failedRunOf(runs(), message.runId) : null
                        }
                      >
                        {(failed) => (
                          <div
                            class="agent-run-error-chip"
                            role="alert"
                            data-testid={`agent-run-error-chip-${message.runId}`}
                          >
                            <span class="agent-run-error-code" data-testid="agent-run-error-inline">
                              {failed().run.errorCode ?? '运行失败'}
                            </span>
                            <button
                              class="text-button"
                              type="button"
                              data-testid={`agent-retry-inline-${message.runId}`}
                              onClick={() => void retryRun(message.runId)}
                            >
                              重试
                            </button>
                          </div>
                        )}
                      </Show>
                    </article>
                  </Show>
                )}
              </For>
            </Show>
          </div>

          <Show when={runs().length > 0}>
            <div class="agent-runs" data-testid="agent-chat-runs">
              <h3>工具调用记录</h3>
              <ul class="grid gap-[var(--wb-space-2)]">
                <For each={runs()}>
                  {(entry) => {
                    const chips = artifactChipsOf(entry);
                    return (
                      <li>
                        <details
                          class="agent-run"
                          data-testid={`agent-run-${entry.run.runId}`}
                          open={
                            entry.run.status === 'queued' ||
                            entry.run.status === 'running' ||
                            streamingRun() === entry.run.runId
                          }
                        >
                          <summary class="flex flex-wrap items-center justify-between gap-[var(--wb-space-2)]">
                            <span class="agent-run-label" data-testid="agent-run-status">
                              {runLabel(entry.run)}
                            </span>
                            <span class="flex gap-[var(--wb-space-2)]">
                              <Show
                                when={
                                  entry.run.status === 'queued' || entry.run.status === 'running'
                                }
                              >
                                <button
                                  class="text-button"
                                  type="button"
                                  data-testid={`agent-cancel-${entry.run.runId}`}
                                  onClick={() => void cancelRun(entry.run.runId)}
                                >
                                  Cancel
                                </button>
                              </Show>
                              <Show
                                when={
                                  entry.run.status === 'interrupted' ||
                                  entry.run.status === 'failed'
                                }
                              >
                                <button
                                  class="text-button"
                                  type="button"
                                  data-testid={`agent-retry-${entry.run.runId}`}
                                  onClick={() => void retryRun(entry.run.runId)}
                                >
                                  重试
                                </button>
                              </Show>
                              <Show when={streamingRun() === entry.run.runId}>
                                <span class="agent-streaming" data-testid="agent-streaming">
                                  streaming…
                                </span>
                              </Show>
                            </span>
                          </summary>
                          <Show when={entry.run.errorCode !== null}>
                            <p
                              class="text-xs text-[var(--wb-text-muted)]"
                              data-testid="agent-run-error"
                            >
                              {entry.run.errorCode}
                            </p>
                          </Show>
                          <Show when={entry.toolCalls.length > 0}>
                            <ul class="agent-tool-calls">
                              <For each={entry.toolCalls}>
                                {(call) => (
                                  <li
                                    data-testid={`agent-tool-call-${entry.run.runId}-${call.callIndex}`}
                                  >
                                    <span class="agent-tool-call-name">
                                      {toolActionName(call.toolName)}
                                    </span>
                                    <span class="agent-tool-call-status" data-status={call.status}>
                                      {receiptLabel(call)}
                                    </span>
                                    <span class="text-xs text-[var(--wb-text-muted)]">
                                      {new Date(call.createdAt).toLocaleTimeString()}
                                    </span>
                                    <code class="agent-tool-call-hash">
                                      {call.sanitizedArgsHash.slice(0, 12)}
                                    </code>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </Show>
                          <Show when={chips.length > 0}>
                            <div class="agent-artifact-chips">
                              <For each={chips}>
                                {(chip) => (
                                  <button
                                    class="agent-artifact-chip"
                                    type="button"
                                    title={chip.hint}
                                    data-testid={`agent-artifact-${chip.key}-${entry.run.runId}`}
                                    onClick={() => props.onViewChange?.(chip.view)}
                                  >
                                    {chip.label}
                                  </button>
                                )}
                              </For>
                            </div>
                          </Show>
                        </details>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </div>
          </Show>
        </div>
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
          <textarea
            ref={agentChatInput}
            id="agent-chat-input"
            rows={3}
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="描述要运行的写作任务…（Enter 发送，Shift+Enter 换行）"
            disabled={sending()}
            data-testid="agent-chat-input"
          />
          <div class="flex gap-[var(--wb-space-2)]">
            <Show when={streamingRun() !== null}>
              <button
                class="text-button"
                type="button"
                data-testid="agent-chat-cancel"
                onClick={() => void cancelCurrent()}
              >
                Cancel
              </button>
            </Show>
            <button
              class="text-button"
              type="submit"
              disabled={sending() || draft().trim().length === 0}
              data-testid="agent-chat-send"
            >
              {sending() ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </Show>
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
