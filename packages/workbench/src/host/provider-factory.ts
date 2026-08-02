/**
 * Host-only provider construction boundary (Phase 1A).
 *
 * Workbench constructs LLM providers exclusively through this factory:
 *
 * - The API key is read only from {@link ProviderCredentialStore} and passed
 *   to the AI SDK as an explicit `apiKey` option, so provider construction
 *   can never fall back to `NOVALISTICALLY_AI_API_KEY` or any other
 *   process-environment key.
 * - Endpoint and model come from the validated Phase-0 provider configuration
 *   DTO (`WorkbenchProviderConfigurationV1`) when present, with explicit
 *   in-module defaults when unset. The process environment is never
 *   consulted, so a running Host's provider behavior cannot drift with the
 *   shell.
 * - Readiness and validation outputs are secret-free by construction: they
 *   carry only a `configured` boolean, a masked endpoint, a non-secret model
 *   id and validation status — never the key.
 *
 * This module is Host-only: it imports the credential store and the node-host
 * provider adapter and is never re-exported through the browser contract
 * barrel. A test/dev provider (e.g. `MockProvider`) is injected by the caller
 * as an explicit `override`, bypassing the store entirely.
 */

import type { LLMProvider } from '@novalistically/core';
import { AiSdkProvider } from '@novalistically/node-host';
import type {
  ConfigOperationDiagnosticV1,
  WorkbenchProjectValidationV1,
  WorkbenchProviderConfigurationV1,
  WorkbenchProviderReadViewV1,
} from '../contracts/configuration.js';
import type { ProviderCredentialStore } from './providers/index.js';

/** Provider id under which the Host stores the AI-SDK API key. */
export const HOST_AI_SDK_PROVIDER_ID = 'ai-sdk';

/**
 * Explicit defaults mirroring `AiSdkProvider`'s own fallbacks. The factory
 * passes them explicitly whenever the configuration omits a value so that
 * construction never performs a process-environment read.
 */
export const DEFAULT_AI_SDK_BASE_URL = 'https://opencode.ai/zen/v1';
export const DEFAULT_AI_SDK_MODEL = 'deepseek-v4-flash-free';

export type HostProviderErrorCode =
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_CREDENTIAL_UNAVAILABLE'
  | 'PROVIDER_VALIDATION_FAILED';

/** Typed provider-boundary failure. Messages never contain a credential. */
export class HostProviderError extends Error {
  override readonly name = 'HostProviderError';

  constructor(
    readonly code: HostProviderErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface HostProviderFactoryOptions {
  /** Credential boundary; the only source of the API key. */
  readonly store: ProviderCredentialStore;
  /** Validated Phase-0 provider DTO; null when no provider is configured. */
  readonly configuration: WorkbenchProviderConfigurationV1 | null;
  /**
   * Test/dev-only provider override (e.g. `MockProvider`). When present the
   * factory reports configured and `create()` returns the override without
   * touching the credential store. Production construction never uses it.
   */
  readonly override?: LLMProvider;
}

/** Minimal completion used as the default validation probe. */
const VALIDATION_PROBE = {
  taskType: 'summary' as const,
  messages: [{ role: 'user' as const, content: 'ping' }],
  maxTokens: 4,
  temperature: 0,
  seed: 1,
};

/**
 * Mask a provider endpoint to its origin (scheme + host). Non-URL endpoints
 * are reduced to their first path segment. Never returns credentials or
 * query material.
 */
export function maskProviderEndpoint(endpoint: string | null): string | null {
  if (endpoint === null) return null;
  const trimmed = endpoint.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`;
  } catch {
    const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const firstSegment = withoutScheme.split(/[/?#]/)[0] ?? '';
    return firstSegment === '' ? null : firstSegment;
  }
}

/**
 * Settle `task` while honouring `signal`: an abort unblocks the caller with a
 * typed error even when the underlying provider does not honour the signal
 * itself (the in-flight request then settles harmlessly on its own).
 */
async function abortable<T>(task: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return task;
  if (signal.aborted) {
    throw new HostProviderError('PROVIDER_VALIDATION_FAILED', 'Provider validation cancelled');
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void =>
      reject(new HostProviderError('PROVIDER_VALIDATION_FAILED', 'Provider validation cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Credential-backed provider factory. One instance per Host: it owns the
 * secret-free readiness state and constructs runtime providers with fully
 * explicit AI SDK options.
 */
export class HostProviderFactory {
  readonly #store: ProviderCredentialStore;
  readonly #configuration: WorkbenchProviderConfigurationV1 | null;
  readonly #override: LLMProvider | undefined;
  #lastValidation: WorkbenchProjectValidationV1 = 'unvalidated';
  #lastValidatedAt: string | null = null;

  constructor(options: HostProviderFactoryOptions) {
    this.#store = options.store;
    this.#configuration = options.configuration;
    this.#override = options.override;
  }

  /**
   * Presence of a configured provider DTO or an injected override. This is a
   * synchronous signal; the store-backed {@link hasCredential} check is the
   * authoritative readiness for the AI-SDK provider.
   */
  get configured(): boolean {
    return this.#override !== undefined || this.#configuration !== null;
  }

  /** True when the credential store holds a key for the AI-SDK provider. */
  async hasCredential(): Promise<boolean> {
    return (await this.#store.get(HOST_AI_SDK_PROVIDER_ID)) !== null;
  }

  /** Secret-free readiness view (Phase-0 `WorkbenchProviderReadViewV1` shape). */
  async readiness(): Promise<WorkbenchProviderReadViewV1> {
    const configured =
      this.#override !== undefined ||
      (this.#configuration !== null && (await this.hasCredential()));
    return {
      kind: 'ai-sdk',
      configured,
      endpoint:
        this.#configuration === null
          ? null
          : maskProviderEndpoint(this.#configuration.baseUrl),
      // Model ids are non-secret configuration labels, never credentials.
      model: this.#configuration?.model ?? null,
      lastValidation: this.#lastValidation,
      lastValidatedAt: this.#lastValidatedAt,
    };
  }

  /**
   * Construct the runtime provider with explicit AI SDK options. The
   * credential is read from the store and passed as `apiKey`; endpoint/model
   * default in-module when the configuration omits them, so `AiSdkProvider`
   * cannot fall back to process environment values.
   */
  async create(): Promise<LLMProvider> {
    if (this.#override !== undefined) return this.#override;
    if (this.#configuration === null) {
      throw new HostProviderError(
        'PROVIDER_NOT_CONFIGURED',
        'The AI provider is not configured; complete Workbench setup first',
      );
    }
    const apiKey = await this.#store.get(HOST_AI_SDK_PROVIDER_ID);
    if (apiKey === null) {
      throw new HostProviderError(
        'PROVIDER_CREDENTIAL_UNAVAILABLE',
        'No stored AI provider credential; save one through Workbench setup or the owner dashboard',
      );
    }
    return new AiSdkProvider({
      baseURL: this.#configuration.baseUrl ?? DEFAULT_AI_SDK_BASE_URL,
      apiKey,
      model: this.#configuration.model ?? DEFAULT_AI_SDK_MODEL,
    });
  }

  /**
   * Run a cancellable provider validation probe. Returns secret-free
   * diagnostics (empty on success) and updates the readiness validation
   * state; an injected override always validates.
   */
  async validate(
    signal?: AbortSignal,
  ): Promise<readonly ConfigOperationDiagnosticV1[]> {
    const stamp = (lastValidation: WorkbenchProjectValidationV1): void => {
      this.#lastValidation = lastValidation;
      this.#lastValidatedAt = new Date().toISOString();
    };
    if (this.#override !== undefined) {
      stamp('valid');
      return [];
    }
    let provider: LLMProvider;
    try {
      provider = await this.create();
    } catch (error) {
      stamp('invalid');
      return [
        {
          code: error instanceof HostProviderError ? error.code : 'PROVIDER_VALIDATION_FAILED',
          message: 'Provider is not ready; complete provider configuration first',
        },
      ];
    }
    if (signal?.aborted) {
      stamp('unvalidated');
      return [
        { code: 'PROVIDER_VALIDATION_FAILED', message: 'Provider validation cancelled' },
      ];
    }
    try {
      await abortable(provider.complete({ ...VALIDATION_PROBE, signal }), signal);
      stamp('valid');
      return [];
    } catch {
      stamp('invalid');
      return [
        {
          code: 'PROVIDER_VALIDATION_FAILED',
          message: 'Provider validation failed; see Host logs for details',
        },
      ];
    }
  }
}
