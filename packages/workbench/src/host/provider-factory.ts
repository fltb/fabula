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
import {
  DEFAULT_PROVIDER_PROFILE,
  type ProviderCredentialStore,
  providerCredentialKey,
} from './providers/index.js';

/**
 * Provider id under which legacy (pre-profile) Hosts stored the AI-SDK API
 * key. New Hosts store profile-scoped keys (`ai-sdk:<profileId>`); the
 * credential store falls back to this bare key for the default profile.
 */
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
  /** Validated Phase-0 provider DTO for the default profile; null when none is configured. */
  readonly configuration: WorkbenchProviderConfigurationV1 | null;
  /**
   * Test/dev-only provider override (e.g. `MockProvider`). When present the
   * factory reports configured and every `create*()` returns the override
   * without touching the credential store. Production construction never
   * uses it.
   */
  readonly override?: LLMProvider;
  /**
   * Test/dev-only PER-PROJECT override constructor (e.g. the deterministic
   * mock built for each project session with that project's reference dir).
   * When present (and no shared `override` is set), `createForProfile`
   * builds a FRESH provider per call from the given project root, so no two
   * sessions share a provider instance. Production construction never uses
   * it, and the credential-backed path is untouched when it is absent.
   */
  readonly overrideForProject?: (projectRoot: string) => LLMProvider;
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
 *
 * Construction is per provider profile (V3 `providers` record): each profile
 * reads its own `ai-sdk:<profileId>` credential key and builds its own
 * provider instance, so no two projects ever share a runtime provider
 * instance. `create()` is the default-profile convenience path and delegates
 * to {@link createForProfile}.
 */
export class HostProviderFactory {
  readonly #store: ProviderCredentialStore;
  readonly #configuration: WorkbenchProviderConfigurationV1 | null;
  readonly #override: LLMProvider | undefined;
  readonly #overrideForProject: ((projectRoot: string) => LLMProvider) | undefined;
  #lastValidation: WorkbenchProjectValidationV1 = 'unvalidated';
  #lastValidatedAt: string | null = null;

  constructor(options: HostProviderFactoryOptions) {
    this.#store = options.store;
    this.#configuration = options.configuration;
    this.#override = options.override;
    this.#overrideForProject = options.overrideForProject;
  }

  /**
   * Presence of a configured provider DTO or an injected override. This is a
   * synchronous signal; the store-backed {@link hasCredential} check is the
   * authoritative readiness for the AI-SDK provider.
   */
  get configured(): boolean {
    return (
      this.#override !== undefined ||
      this.#overrideForProject !== undefined ||
      this.#configuration !== null
    );
  }

  /** True when the credential store holds a key for the default profile. */
  async hasCredential(): Promise<boolean> {
    return (await this.#store.get(providerCredentialKey(DEFAULT_PROVIDER_PROFILE))) !== null;
  }

  /** Secret-free readiness view (Phase-0 `WorkbenchProviderReadViewV1` shape). */
  async readiness(): Promise<WorkbenchProviderReadViewV1> {
    const configured =
      this.#override !== undefined ||
      this.#overrideForProject !== undefined ||
      (this.#configuration !== null && (await this.hasCredential()));
    return {
      kind: 'ai-sdk',
      configured,
      endpoint:
        this.#configuration === null ? null : maskProviderEndpoint(this.#configuration.baseUrl),
      // Model ids are non-secret configuration labels, never credentials.
      model: this.#configuration?.model ?? null,
      lastValidation: this.#lastValidation,
      lastValidatedAt: this.#lastValidatedAt,
    };
  }

  /**
   * Construct the runtime provider for the default profile (`default`). The
   * credential is read from the store and passed as `apiKey`; endpoint/model
   * default in-module when the configuration omits them, so `AiSdkProvider`
   * cannot fall back to process environment values.
   */
  async create(): Promise<LLMProvider> {
    return this.createForProfile(DEFAULT_PROVIDER_PROFILE, this.#configuration ?? undefined);
  }

  /**
   * Construct a runtime provider for one named provider profile. Each call
   * builds its own provider instance from that profile's configuration and
   * reads the `ai-sdk:<profileId>` credential key, so profiles never share a
   * runtime provider instance.
   *
   * `projectRoot` is required only for the per-project dev override seam
   * (`overrideForProject`); the credential-backed path never uses it.
   */
  async createForProfile(
    profileId: string,
    configuration: WorkbenchProviderConfigurationV1 | undefined,
    projectRoot?: string,
  ): Promise<LLMProvider> {
    if (this.#override !== undefined) return this.#override;
    if (this.#overrideForProject !== undefined) {
      if (projectRoot === undefined) {
        throw new HostProviderError(
          'PROVIDER_NOT_CONFIGURED',
          `Provider profile "${profileId}" needs a project root for the per-project dev override`,
        );
      }
      return this.#overrideForProject(projectRoot);
    }
    if (configuration === undefined) {
      throw new HostProviderError(
        'PROVIDER_NOT_CONFIGURED',
        `Provider profile "${profileId}" is not configured; complete Workbench setup first`,
      );
    }
    const apiKey = await this.#store.get(providerCredentialKey(profileId));
    if (apiKey === null) {
      throw new HostProviderError(
        'PROVIDER_CREDENTIAL_UNAVAILABLE',
        `No stored AI provider credential for profile "${profileId}"; save one through Workbench setup or the owner dashboard`,
      );
    }
    return new AiSdkProvider({
      baseURL: configuration.baseUrl ?? DEFAULT_AI_SDK_BASE_URL,
      apiKey,
      model: configuration.model ?? DEFAULT_AI_SDK_MODEL,
    });
  }

  /**
   * Run a cancellable provider validation probe. Returns secret-free
   * diagnostics (empty on success) and updates the readiness validation
   * state; an injected override always validates.
   */
  async validate(signal?: AbortSignal): Promise<readonly ConfigOperationDiagnosticV1[]> {
    const stamp = (lastValidation: WorkbenchProjectValidationV1): void => {
      this.#lastValidation = lastValidation;
      this.#lastValidatedAt = new Date().toISOString();
    };
    if (this.#override !== undefined || this.#overrideForProject !== undefined) {
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
      return [{ code: 'PROVIDER_VALIDATION_FAILED', message: 'Provider validation cancelled' }];
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
