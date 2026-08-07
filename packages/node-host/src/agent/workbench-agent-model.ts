/**
 * WorkbenchAgentModel port (plan 9.2): the Node Host adapter that lets the
 * built-in Agent call the same MCP tool surface as an external device.
 *
 * The adapter is deliberately a thin AI SDK tool-calling seam: it converts
 * `AgentToolSpec` JSON Schemas into AI SDK `tool()` definitions via
 * `jsonSchema()`, runs `generateText` (bounded by `maxSteps`), and re-emits
 * text / tool-call / finish events for the WorkbenchAgentRunService to act
 * on. It never executes tools itself and never touches the project session.
 */
import {
  generateText,
  isStepCount,
  type JSONSchema7,
  type JSONValue,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  type ReasoningUIPart,
  type TextPart,
  type Tool,
  type ToolCallPart,
  tool,
} from 'ai';
import { type AiSdkClientOptions, createAiSdkModelClient } from '../providers/ai-sdk.js';

/** One tool the model may call; `inputSchema` is a plain JSON Schema object. */
export interface AgentToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** Turn-level message history fed back between model calls by the run service. */
export type AgentModelMessage =
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string;
      /** Reasoning text from the model step; deepseek/xai thinking mode
       * requires it to be passed back on subsequent turns. */
      readonly reasoning?: string;
      /** Tool calls the assistant made in the same step; required so the
       * next round's `tool` messages have a preceding `tool_calls` payload. */
      readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly input: unknown }[];
    }
  | {
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: unknown;
      readonly isError?: boolean;
    };

/** Streaming model output events; the run service executes tool calls itself. */
export type AgentModelEvent =
  | { readonly type: 'assistant-text'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly id: string;
      readonly name: string;
      readonly args: unknown;
      /** Thinking-mode reasoning from the model step; must be passed back
       * on subsequent turns for deepseek/xai reasoning providers. */
      readonly reasoning?: string;
    }
  | { readonly type: 'finish'; readonly finishReason: string };

export interface WorkbenchAgentModelRunRequest {
  readonly system: string;
  readonly messages: readonly AgentModelMessage[];
  readonly tools: readonly AgentToolSpec[];
  readonly maxTurns: number;
  readonly signal?: AbortSignal;
}

/** Host-facing model seam; the Host uses `supportsToolCalls` for the feature gate. */
export interface WorkbenchAgentModelPort {
  readonly supportsToolCalls: boolean;
  run(request: WorkbenchAgentModelRunRequest): AsyncIterable<AgentModelEvent>;
}

export interface WorkbenchAgentModelOptions extends AiSdkClientOptions {
  /**
   * Whether the configured provider/profile supports structured tool calls.
   * The Host reads this to omit the `agent-chat` capability for providers
   * that cannot emit tool calls. Defaults to true.
   */
  readonly supportsToolCalls?: boolean;
}

/** AI SDK tool-calling adapter over the shared OpenAI-compatible client. */
export function createWorkbenchAgentModelAdapter(
  options: WorkbenchAgentModelOptions = {},
): WorkbenchAgentModelPort {
  const client = createAiSdkModelClient(options);
  const model: LanguageModel = client.modelFor(client.modelId);
  const supportsToolCalls = options.supportsToolCalls ?? true;

  return {
    supportsToolCalls,
    async *run(request) {
      const toolSet: Record<string, Tool> = {};
      for (const spec of request.tools) {
        toolSet[spec.name] = tool({
          description: spec.description,
          inputSchema: jsonSchema(spec.inputSchema as JSONSchema7),
        });
      }
      const result = await generateText({
        model,
        system: request.system,
        messages: request.messages.map(toAiSdkMessage),
        tools: toolSet,
        // AI SDK v7 bounds the tool-calling loop with a stop condition; the
        // default is a single step. `maxTurns` caps the loop the same way
        // `maxSteps` did in earlier versions.
        stopWhen: isStepCount(Math.max(1, Math.floor(request.maxTurns))),
        abortSignal: request.signal,
      });
      for (const step of result.steps) {
        if (step.text.length > 0) {
          yield { type: 'assistant-text', text: step.text };
        }
        for (const call of step.toolCalls) {
          yield {
            type: 'tool-call',
            id: call.toolCallId,
            name: call.toolName,
            args: call.input,
            reasoning: step.reasoningText,
          };
        }
      }
      yield { type: 'finish', finishReason: result.finishReason ?? 'stop' };
    },
  };
}

function toAiSdkMessage(message: AgentModelMessage): ModelMessage {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant': {
      // AI SDK v7 drops top-level `toolCalls` when the assistant content is a
      // plain string (vercel/ai openai-compatible conversion only reads
      // `tool-call` content PARTS; a tool message without a preceding
      // `tool_calls` payload is rejected by deepseek/xai-compatible
      // providers with HTTP 400). Emit the tool calls as content parts so
      // the wire carries `tool_calls`.
      const parts: (TextPart | ToolCallPart | ReasoningUIPart)[] = [
        ...(message.reasoning !== undefined && message.reasoning.length > 0
          ? [{ type: 'reasoning' as const, text: message.reasoning }]
          : []),
        ...(message.content.length > 0 ? [{ type: 'text' as const, text: message.content }] : []),
        ...(message.toolCalls ?? []).map((call) => ({
          type: 'tool-call' as const,
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
        })),
      ];
      return { role: 'assistant', content: parts };
    }
    case 'tool':
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: message.isError
              ? { type: 'error-text', value: String(message.result) }
              : { type: 'json', value: message.result as JSONValue },
          },
        ],
      };
  }
}
