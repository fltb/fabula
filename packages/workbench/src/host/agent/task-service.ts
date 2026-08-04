/**
 * Host-only Agent task service: a strict, secret-free provider execution
 * boundary for internal Agents (the Agent Composer and future authorized
 * editors).
 *
 * This layer owns ONLY the provider round trip: it validates a strict,
 * declared-field task request, runs it against an injected
 * {@link AgentTaskProvider}, and returns a typed completed/failed result. It
 * knows nothing about documents, vectors, presence, capabilities, or edits —
 * the suggestion service composes those concerns on top. Never imported by
 * the browser client; the provider handle and any request it receives stay
 * Host-side.
 */
import type { CompletionRequest, CompletionResponse } from '@novalistically/core';

/** Maximum characters accepted in one task prompt (system + user); fail closed beyond. */
export const AGENT_TASK_MAX_PROMPT_CHARACTERS = 128_000;
/** Maximum characters retained from a provider completion. */
export const AGENT_TASK_MAX_OUTPUT_CHARACTERS = 64_000;
/** Maximum characters retained from a failed-task message. */
const MAX_FAILED_MESSAGE_LENGTH = 512;

/** Minimum accepted temperature for suggestion tasks (deterministic-ish default). */
export const AGENT_TASK_MIN_TEMPERATURE = 0;
/** Maximum accepted temperature for suggestion tasks. */
export const AGENT_TASK_MAX_TEMPERATURE = 2;

/**
 * Injected provider execution port. The shape mirrors Core's `LLMProvider`
 * contract so Host wiring can adapt an AiSdk provider (or a test double)
 * without a second interface.
 */
export interface AgentTaskProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/**
 * Strict, secret-free task request. Only these declared fields are accepted;
 * anything else (paths, tokens, raw capabilities) is rejected before the
 * provider is touched.
 */
export interface AgentTaskRequest {
  /** System prompt: behavior and response-format instructions. */
  readonly system: string;
  /** User prompt: the document context and the instruction to act on. */
  readonly user: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Optional abort signal; an aborted request fails with a typed `aborted` code. */
  readonly signal?: AbortSignal;
}

/** Typed outcome of one provider task; `completed` content is plain text, never structured here. */
export type AgentTaskResult =
  | {
      readonly status: 'completed';
      readonly content: string;
      readonly model: string;
      readonly finishReason: string;
      readonly usage: {
        readonly promptTokens: number;
        readonly completionTokens: number;
        readonly totalTokens: number;
      };
    }
  | {
      readonly status: 'failed';
      readonly errorCode: string;
      readonly message: string;
    };

export interface AgentTaskServiceOptions {
  readonly provider: AgentTaskProvider;
  readonly maxPromptCharacters?: number;
  readonly maxOutputCharacters?: number;
}

/** Malformed caller input (unknown fields, empty prompts, oversized payloads). */
export class AgentTaskInputError extends Error {
  override readonly name = 'AgentTaskInputError';
}

const REQUEST_FIELDS = ['system', 'user', 'model', 'temperature', 'maxTokens', 'signal'] as const;

/**
 * Stable error-code mapping shared with the suggestion service: prefers a
 * typed `error.code`, falls back to the provider-failure code.
 */
export function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'agent.task.provider-failed';
}

/** Truncated, control-safe error message shared with the suggestion service. */
export function errorMessageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_FAILED_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_FAILED_MESSAGE_LENGTH)}…`
    : message;
}

/**
 * One strict provider execution boundary, constructed once per Host process
 * and shared. Fails closed on a missing provider: a task surface must never
 * exist without a real provider handle.
 */
export class AgentTaskService {
  readonly #provider: AgentTaskProvider;
  readonly #maxPromptCharacters: number;
  readonly #maxOutputCharacters: number;

  constructor(options: AgentTaskServiceOptions) {
    const provider = options.provider;
    if (
      provider === null ||
      typeof provider !== 'object' ||
      typeof provider.name !== 'string' ||
      provider.name.length === 0 ||
      typeof provider.complete !== 'function'
    ) {
      throw new TypeError(
        'AgentTaskService requires an injected AgentTaskProvider (name, complete)',
      );
    }
    const maxPrompt = options.maxPromptCharacters ?? AGENT_TASK_MAX_PROMPT_CHARACTERS;
    if (!Number.isInteger(maxPrompt) || maxPrompt <= 0) {
      throw new TypeError('maxPromptCharacters must be a positive integer');
    }
    const maxOutput = options.maxOutputCharacters ?? AGENT_TASK_MAX_OUTPUT_CHARACTERS;
    if (!Number.isInteger(maxOutput) || maxOutput <= 0) {
      throw new TypeError('maxOutputCharacters must be a positive integer');
    }
    this.#provider = provider;
    this.#maxPromptCharacters = maxPrompt;
    this.#maxOutputCharacters = maxOutput;
  }

  /** The injected provider identity; used for masked, secret-free diagnostics. */
  get providerName(): string {
    return this.#provider.name;
  }

  /**
   * Run one strict task. Input is validated before any provider call; a
   * provider failure maps to a typed `failed` result (truncated message,
   * stable error code), never a thrown error.
   */
  async run(request: AgentTaskRequest): Promise<AgentTaskResult> {
    this.#validateRequest(request);
    try {
      const response = await this.#provider.complete({
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const content =
        response.content.length > this.#maxOutputCharacters
          ? `${response.content.slice(0, this.#maxOutputCharacters)}…`
          : response.content;
      return {
        status: 'completed',
        content,
        model: response.model,
        finishReason: response.finishReason,
        usage: {
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
        },
      };
    } catch (error) {
      const code = errorCodeOf(error);
      return {
        status: 'failed',
        errorCode:
          code === 'agent.task.provider-failed' && request.signal?.aborted
            ? 'agent.task.aborted'
            : code,
        message: errorMessageOf(error),
      };
    }
  }

  #validateRequest(request: AgentTaskRequest): void {
    if (request === null || typeof request !== 'object') {
      throw new AgentTaskInputError('AgentTaskService requires a task request object.');
    }
    for (const key of Object.keys(request)) {
      if (!REQUEST_FIELDS.includes(key as (typeof REQUEST_FIELDS)[number])) {
        throw new AgentTaskInputError(
          `Unknown field "${key}" passed to AgentTaskService.run; task requests are strict.`,
        );
      }
    }
    if (typeof request.system !== 'string' || request.system.length === 0) {
      throw new AgentTaskInputError('AgentTaskService requires a non-empty system prompt.');
    }
    if (typeof request.user !== 'string' || request.user.length === 0) {
      throw new AgentTaskInputError('AgentTaskService requires a non-empty user prompt.');
    }
    if (request.system.length + request.user.length > this.#maxPromptCharacters) {
      throw new AgentTaskInputError(
        `Task prompt exceeds the ${this.#maxPromptCharacters} character limit.`,
      );
    }
    if (
      request.model !== undefined &&
      (typeof request.model !== 'string' || request.model.length === 0)
    ) {
      throw new AgentTaskInputError('model must be a non-empty string when provided.');
    }
    if (
      request.temperature !== undefined &&
      (typeof request.temperature !== 'number' ||
        !Number.isFinite(request.temperature) ||
        request.temperature < AGENT_TASK_MIN_TEMPERATURE ||
        request.temperature > AGENT_TASK_MAX_TEMPERATURE)
    ) {
      throw new AgentTaskInputError(
        `temperature must be a finite number within ` +
          `[${AGENT_TASK_MIN_TEMPERATURE}, ${AGENT_TASK_MAX_TEMPERATURE}].`,
      );
    }
    if (
      request.maxTokens !== undefined &&
      (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0)
    ) {
      throw new AgentTaskInputError('maxTokens must be a positive integer when provided.');
    }
    if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
      throw new AgentTaskInputError('signal must be an AbortSignal when provided.');
    }
  }
}
