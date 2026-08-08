// ============================================================================
// Scripted pi-ai stream helper (plan 3.6) — shared by every stub-model test.
// ============================================================================
// The workbench run loop now drives pi-agent-core's Agent over a pi-ai
// `{ model, streamFn }` pair instead of the deleted WorkbenchAgentModelPort.
// These helpers build deterministic AssistantMessageEventStreams: one streamFn
// call per turn, each scripted as `start` → text_delta/toolcall_end → `done`.
// The Agent loop (pi-agent-core 0.84.1) pushes the `start` partial into the
// transcript, replaces it on every subsequent event, and takes the FINAL
// message from `response.result()` after `done` — so the final message's
// `content` must carry every toolCall block the turn intends to execute.
// ============================================================================

import {
  type AssistantMessage,
  type AssistantMessageEvent,
  AssistantMessageEventStream,
  type ToolCall,
} from '@earendil-works/pi-ai';

/** Zeroed usage accepted by the installed pi-ai `Usage` type (cost/totalTokens required). */
const TEST_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Assistant message fragment used as the scripted stream's partial/final payload. */
export function assistantPartial(
  content: Array<{ type: 'text'; text: string } | ToolCall>,
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'pi-provider',
    model: 'test-model',
    usage: TEST_USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

export function textDelta(text: string, partial: AssistantMessage): AssistantMessageEvent {
  return { type: 'text_delta', contentIndex: 0, delta: text, partial };
}

export function toolCallEnd(toolCall: ToolCall, partial: AssistantMessage): AssistantMessageEvent {
  return { type: 'toolcall_end', contentIndex: 0, toolCall, partial };
}

export function doneEvent(
  reason: 'stop' | 'toolUse' | 'length',
  message: AssistantMessage,
): AssistantMessageEvent {
  return { type: 'done', reason, message };
}

/** Scripted stream: yields events in order; `result()` resolves the final message. */
export function scriptedStream(
  events: AssistantMessageEvent[],
  finalMessage: AssistantMessage,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  for (const event of events) stream.push(event);
  stream.end(finalMessage);
  return stream;
}
