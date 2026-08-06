import { cleanup, render, screen, waitFor, within } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentChat } from '../../src/client/AgentChat.js';
import type { AgentChatClient } from '../../src/client/agent-chat-client.js';
import type {
  AgentChatConversationViewV1,
  AgentChatProgressEventV1,
  AgentChatRunHistoryEntryV1,
  AgentChatRunViewV1,
  AgentChatToolCallReceiptV1,
} from '../../src/contracts/index.js';

afterEach(() => cleanup());

const conversation: AgentChatConversationViewV1 = {
  version: 1,
  conversationId: 'conv-1',
  projectId: 'proj-a',
  title: null,
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
};

const runningRun: AgentChatRunViewV1 = {
  version: 1,
  runId: 'run-1',
  conversationId: 'conv-1',
  operationId: 'op-1',
  status: 'running',
  turn: 1,
  maxTurns: 16,
  toolCalls: 0,
  maxToolCalls: 64,
  errorCode: null,
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
};

const interruptedRun: AgentChatRunViewV1 = { ...runningRun, runId: 'run-2', status: 'interrupted' };

const receipt: AgentChatToolCallReceiptV1 = {
  version: 1,
  callIndex: 0,
  toolName: 'nova_status',
  status: 'succeeded',
  turn: 1,
  sanitizedArgsHash: 'a'.repeat(64),
  resultRef: 'ok:0123456789abcdef',
  resultSummary: 'ok:0123456789abcdef',
  createdAt: '2026-08-06T00:00:00.000Z',
};

function stubClient(overrides: Partial<AgentChatClient> = {}): AgentChatClient & {
  readonly sent: Array<{ message: string }>;
  readonly cancelled: string[];
  readonly retried: string[];
  readonly progressListeners: Array<{
    runId: string;
    listener: (event: AgentChatProgressEventV1) => void;
  }>;
} {
  const sent: Array<{ message: string }> = [];
  const cancelled: string[] = [];
  const retried: string[] = [];
  const progressListeners: Array<{
    runId: string;
    listener: (event: AgentChatProgressEventV1) => void;
  }> = [];
  return {
    createConversation: async () => conversation,
    sendMessage: async (_projectId, _conversationId, message) => {
      sent.push({ message });
      return runningRun;
    },
    history: async () => ({
      version: 1,
      projectId: 'proj-a',
      conversation,
      runs: [
        { run: interruptedRun, toolCalls: [receipt] },
        { run: runningRun, toolCalls: [] },
      ],
    }),
    cancel: async () => {
      cancelled.push('run-1');
      return { version: 1, runId: 'run-1', status: 'cancelled' };
    },
    retry: async () => {
      retried.push('run-2');
      return { version: 1, runId: 'run-2', status: 'queued' };
    },
    openProgress: (_projectId, _conversationId, runId, listener) => {
      progressListeners.push({ runId, listener });
      return () => {};
    },
    ...overrides,
    sent,
    cancelled,
    retried,
    progressListeners,
  };
}

describe('AgentChat surface', () => {
  it('renders the conversation, history receipts and a composer', async () => {
    const client = stubClient();
    render(() => <AgentChat projectId="proj-a" client={client} />);
    await waitFor(() => {
      expect(screen.getByTestId('agent-chat-conversation-id')).toHaveTextContent('conv-1');
    });
    // Durable history receipts render per run.
    expect(screen.getByTestId('agent-run-run-1')).toBeInTheDocument();
    expect(screen.getByTestId('agent-run-run-2')).toBeInTheDocument();
    expect(screen.getByTestId('agent-tool-call-run-2-0')).toHaveTextContent('nova_status');
    expect(screen.getByTestId('agent-tool-call-run-2-0')).toHaveTextContent('succeeded');
    expect(screen.getByTestId('agent-chat-input')).toBeInTheDocument();
  });

  it('sends a message, shows it in the list and opens the progress stream', async () => {
    const client = stubClient();
    const user = userEvent.setup();
    render(() => <AgentChat projectId="proj-a" client={client} />);
    await waitFor(() => {
      expect(screen.getByTestId('agent-chat-input')).toBeEnabled();
    });
    await user.type(screen.getByTestId('agent-chat-input'), 'check status');
    await user.click(screen.getByTestId('agent-chat-send'));
    await waitFor(() => {
      expect(client.sent).toEqual([{ message: 'check status' }]);
      expect(screen.getByText('check status')).toBeInTheDocument();
    });
    expect(client.progressListeners.map((entry) => entry.runId)).toEqual(['run-1']);
  });

  it('appends assistant text and live tool-call receipts from the stream', async () => {
    const client = stubClient();
    const user = userEvent.setup();
    render(() => <AgentChat projectId="proj-a" client={client} />);
    await waitFor(() => {
      expect(screen.getByTestId('agent-chat-input')).toBeEnabled();
    });
    await user.type(screen.getByTestId('agent-chat-input'), 'status');
    await user.click(screen.getByTestId('agent-chat-send'));
    await waitFor(() => {
      expect(client.progressListeners.length).toBeGreaterThan(0);
    });
    const { listener } = client.progressListeners[0]!;
    listener({ type: 'assistant-text', runId: 'run-1', text: 'inspecting…', at: 'now' });
    expect(screen.getByText('inspecting…')).toBeInTheDocument();
    listener({
      type: 'tool-call',
      runId: 'run-1',
      call: { ...receipt, callIndex: 0, status: 'pending', resultRef: null, resultSummary: null },
    });
    await waitFor(() => {
      expect(screen.getByTestId('agent-tool-call-run-1-0')).toHaveTextContent('pending');
    });
  });

  it('offers Cancel for queued/running runs and Retry for interrupted runs', async () => {
    const client = stubClient();
    const user = userEvent.setup();
    render(() => <AgentChat projectId="proj-a" client={client} />);
    await waitFor(() => {
      expect(screen.getByTestId('agent-cancel-run-1')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('agent-cancel-run-1'));
    await waitFor(() => {
      expect(client.cancelled).toEqual(['run-1']);
    });
    await user.click(screen.getByTestId('agent-retry-run-2'));
    await waitFor(() => {
      expect(client.retried).toEqual(['run-2']);
    });
  });

  it('surfaces send failures without dropping the composer', async () => {
    const client = stubClient({
      sendMessage: async () => {
        throw new Error('AGENT_CHAT_QUEUE_FULL');
      },
    });
    const user = userEvent.setup();
    render(() => <AgentChat projectId="proj-a" client={client} />);
    await waitFor(() => {
      expect(screen.getByTestId('agent-chat-input')).toBeEnabled();
    });
    await user.type(screen.getByTestId('agent-chat-input'), 'boom');
    await user.click(screen.getByTestId('agent-chat-send'));
    await waitFor(() => {
      expect(screen.getByTestId('agent-chat-error')).toHaveTextContent('AGENT_CHAT_QUEUE_FULL');
    });
    expect(screen.getByTestId('agent-chat-input')).toBeEnabled();
  });
});
