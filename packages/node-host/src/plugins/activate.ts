// ============================================================================
// activate.ts — Trusted Node plugin activation for the Workbench Host.
//
// Activation is the only trust mutation: a plugin loads only when its
// manifest name/version and index.js SHA-256 match a V3 trustedPlugins entry
// exactly. Conflicts requiring human arbitration never resolve silently —
// render is unavailable. Required-plugin failures keep the project open but
// surface as blocking diagnostics; optional failures are disabled + recorded.
// ============================================================================

import type { LLMProvider } from '@novalistically/core';
import { detectConflicts, PluginHooksManager, ValidatorRegistry } from '@novalistically/core';
import type {
  PluginContext,
  PluginHooks,
  PluginLogger,
  ProviderRegistry,
  ValidatorRegistrar,
} from '@novalistically/core/extensions';
import type { LoadedNodePlugin, TrustedNodePluginEntry } from './node-plugin-catalog.js';
import {
  describeTrustedMismatch,
  NodePluginCatalog,
  PluginIdentityMismatchError,
  pluginHookNames,
} from './node-plugin-catalog.js';

/** Default cap for a single async plugin hook invocation. */
export const DEFAULT_PLUGIN_HOOK_TIMEOUT_MS = 30_000;

export interface ActivateNodePluginsOptions {
  readonly projectRoot: string;
  /** Project-relative plugin directory; defaults to `plugins`. */
  readonly pluginsDir?: string;
  /** V3 trusted-plugin allowlist entries (name/version/moduleHash/required). */
  readonly trustedPlugins: readonly TrustedNodePluginEntry[];
  /**
   * Injectable clock. Hook deadlines are computed from it so tests can pin
   * timeout behavior deterministically.
   */
  readonly now?: () => Date;
  /** Per-hook async timeout in milliseconds. */
  readonly hookTimeoutMs?: number;
  /** Scoped logging surface handed to plugin hooks. */
  readonly log?: PluginLogger;
}

export interface ActiveNodePluginRecord {
  readonly name: string;
  readonly version: string;
  readonly manifestHash: string;
  readonly moduleHash: string | null;
  readonly hookNames: readonly string[];
  readonly validatorNames: readonly string[];
  readonly required: boolean;
}

export interface BlockedNodePluginRecord {
  readonly name: string;
  readonly reason: string;
}

export interface DisabledNodePluginRecord {
  readonly name: string;
  readonly reason: string;
}

export interface NodePluginActivationResult {
  readonly hooksManager: PluginHooksManager | null;
  readonly active: readonly ActiveNodePluginRecord[];
  /** Plugins that could not activate and block render until resolved. */
  readonly blocked: readonly BlockedNodePluginRecord[];
  /** Plugins deliberately not loaded (no trust match, or init failure); recorded, never silent. */
  readonly disabled: readonly DisabledNodePluginRecord[];
}

const noopLog: PluginLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Raised when an async plugin hook exceeds its deadline. */
class DeadlineExceededError extends Error {
  constructor(
    what: string,
    readonly timeoutMs: number,
  ) {
    super(`Timed out after ${timeoutMs}ms: ${what}`);
    this.name = 'DeadlineExceededError';
  }
}

/** Names the plugin whose hook failed so activation can attribute failures. */
class PluginHookFailure extends Error {
  constructor(
    readonly pluginName: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginHookFailure';
  }
}

function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  now: () => Date,
  what: string,
): Promise<T> {
  const deadline = now().getTime() + timeoutMs;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DeadlineExceededError(what, timeoutMs)),
      Math.max(0, deadline - now().getTime()),
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const failureOf = (pluginName: string, error: unknown): PluginHookFailure =>
  new PluginHookFailure(pluginName, error instanceof Error ? error.message : String(error));

/**
 * Wrap a plugin's hooks so every async entry point runs under the activation
 * deadline and every failure is attributed to its plugin. Transform/observation
 * hook semantics stay with the hooks-manager; this wrapper only adds the
 * timeout policy and attribution.
 */
function wrapHookForActivation(hook: PluginHooks, timeoutMs: number, now: () => Date): PluginHooks {
  const { onLoad, onUnload, registerValidators, registerProvider } = hook;
  return {
    ...hook,
    ...(onLoad
      ? {
          onLoad: async (context: PluginContext) => {
            try {
              await withDeadline(onLoad(context), timeoutMs, now, `plugin "${hook.name}" onLoad`);
            } catch (error) {
              throw failureOf(hook.name, error);
            }
          },
        }
      : {}),
    ...(onUnload
      ? {
          onUnload: async (context: PluginContext) => {
            try {
              await withDeadline(
                onUnload(context),
                timeoutMs,
                now,
                `plugin "${hook.name}" onUnload`,
              );
            } catch (error) {
              throw failureOf(hook.name, error);
            }
          },
        }
      : {}),
    ...(registerValidators
      ? {
          registerValidators: (registrar: ValidatorRegistrar) => {
            try {
              registerValidators(registrar);
            } catch (error) {
              throw failureOf(hook.name, error);
            }
          },
        }
      : {}),
    ...(registerProvider
      ? {
          registerProvider: (registry: ProviderRegistry) => {
            try {
              registerProvider(registry);
            } catch (error) {
              throw failureOf(hook.name, error);
            }
          },
        }
      : {}),
  };
}

class HostProviderRegistry implements ProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>();

  register(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
  }

  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }
}

function activationRecords(
  entries: ReadonlyArray<{ plugin: LoadedNodePlugin; trusted: TrustedNodePluginEntry }>,
  manager: PluginHooksManager,
): ActiveNodePluginRecord[] {
  const validatorsByName = new Map(
    manager.getPluginIdentities().map((identity) => [identity.name, identity.validators]),
  );
  return entries.map(({ plugin, trusted }) => ({
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    manifestHash: plugin.manifestHash,
    moduleHash: plugin.moduleHash,
    hookNames: plugin.hooks === null ? [] : pluginHookNames(plugin.hooks),
    validatorNames: [...(validatorsByName.get(plugin.manifest.name) ?? [])],
    required: trusted.required,
  }));
}

/**
 * Activate the trusted plugin set for one project.
 *
 * - Catalog discovery is filtered by exact name/version/moduleHash matches
 *   against `trustedPlugins`. A required entry without a match fails the whole
 *   activation with {@link PluginIdentityMismatchError}; an optional entry
 *   without a match is disabled and recorded.
 * - Any conflict in the effective set requires human arbitration: render is
 *   unavailable (no hooks manager) and the conflicting plugins are blocked.
 * - Initialization failures are attributed per plugin: required failures
 *   become blocking diagnostics while the project stays open; optional
 *   failures disable the plugin; plugins that never got initialized are
 *   dropped from the manager and recorded as disabled.
 *
 * Never silently loads, never silently picks a conflict winner.
 */
export async function activateNodePlugins(
  options: ActivateNodePluginsOptions,
): Promise<NodePluginActivationResult> {
  const {
    projectRoot,
    pluginsDir = 'plugins',
    trustedPlugins,
    now = () => new Date(),
    hookTimeoutMs = DEFAULT_PLUGIN_HOOK_TIMEOUT_MS,
    log = noopLog,
  } = options;

  const catalog = new NodePluginCatalog(projectRoot);
  const discovered = await catalog.load(pluginsDir);

  const disabled: DisabledNodePluginRecord[] = [];
  const effective: Array<{ plugin: LoadedNodePlugin; trusted: TrustedNodePluginEntry }> = [];

  // 1. Trusted-identity gate.
  for (const plugin of discovered) {
    const trusted = trustedPlugins.find((entry) => entry.name === plugin.manifest.name);
    if (trusted === undefined) {
      disabled.push({
        name: plugin.manifest.name,
        reason: 'not present in the trusted plugin allowlist',
      });
      continue;
    }
    const mismatch = describeTrustedMismatch(plugin, trusted);
    if (mismatch !== null) {
      if (trusted.required) {
        throw new PluginIdentityMismatchError(
          `Required plugin "${plugin.manifest.name}" failed trusted identity verification: ${mismatch}`,
        );
      }
      disabled.push({ name: plugin.manifest.name, reason: mismatch });
      continue;
    }
    effective.push({ plugin, trusted });
  }

  // 2. Required allowlist entries must have produced an exact match.
  for (const trusted of trustedPlugins) {
    if (
      trusted.required &&
      !effective.some((entry) => entry.plugin.manifest.name === trusted.name)
    ) {
      const isInstalled = discovered.some((plugin) => plugin.manifest.name === trusted.name);
      throw new PluginIdentityMismatchError(
        isInstalled
          ? `Required plugin "${trusted.name}" is installed but failed trusted identity verification`
          : `Required plugin "${trusted.name}" is not installed`,
      );
    }
  }

  // Nothing was accepted: there is no plugin runtime to manage.
  if (effective.length === 0) {
    return { hooksManager: null, active: [], blocked: [], disabled };
  }

  // 3. Conflict gate — human arbitration is the only policy: never pick a winner.
  const conflicts = detectConflicts(effective.map((entry) => entry.plugin.manifest));
  if (conflicts.length > 0) {
    const reasonsByName = new Map<string, string[]>();
    for (const conflict of conflicts) {
      const detail = `${conflict.pluginA} ↔ ${conflict.pluginB}: ${conflict.reason}`;
      for (const name of [conflict.pluginA, conflict.pluginB]) {
        reasonsByName.set(name, [...(reasonsByName.get(name) ?? []), detail]);
      }
    }
    const blocked: BlockedNodePluginRecord[] = [...reasonsByName.keys()].sort().map((name) => ({
      name,
      reason: `conflict requires human arbitration: ${(reasonsByName.get(name) ?? []).join('; ')}`,
    }));
    return { hooksManager: null, active: [], blocked, disabled };
  }

  // 4. Register + initialize with per-plugin attribution.
  const manager = new PluginHooksManager(
    { log },
    new ValidatorRegistry(),
    new HostProviderRegistry(),
  );
  for (const { plugin } of effective) {
    if (plugin.hooks !== null) {
      manager.register(wrapHookForActivation(plugin.hooks, hookTimeoutMs, now));
    }
  }

  try {
    await withDeadline(manager.initialize(), hookTimeoutMs, now, 'plugin hooks initialization');
  } catch (error) {
    const failedName = error instanceof PluginHookFailure ? error.pluginName : null;
    if (failedName === null) {
      // The failure cannot be attributed to one plugin (e.g. the whole
      // initialize pass exceeded the deadline): fail closed so render never
      // runs against a partially initialized set.
      const reason = error instanceof Error ? error.message : String(error);
      return {
        hooksManager: null,
        active: [],
        blocked: effective.map(({ plugin }) => ({
          name: plugin.manifest.name,
          reason: `initialization failed: ${reason}`,
        })),
        disabled,
      };
    }
    const failedIndex = effective.findIndex((entry) => entry.plugin.manifest.name === failedName);
    const failedTrusted = failedIndex === -1 ? undefined : effective[failedIndex].trusted;
    const failureReason = error instanceof Error ? error.message : String(error);

    // Everything from the failed plugin onward was registered but never fully
    // initialized: drop it from the manager so only fully initialized hooks
    // remain, and record the rest as disabled (never silently loaded).
    const fromFailure = effective.slice(Math.max(0, failedIndex));
    for (const { plugin } of fromFailure) {
      manager.unregister(plugin.manifest.name);
    }

    const blocked: BlockedNodePluginRecord[] =
      failedTrusted?.required === true ? [{ name: failedName, reason: failureReason }] : [];
    const tailDisabled: DisabledNodePluginRecord[] = effective
      .slice(failedIndex + 1)
      .map(({ plugin }) => ({
        name: plugin.manifest.name,
        reason: `activation aborted after "${failedName}" failed to initialize`,
      }));
    if (failedTrusted?.required !== true) {
      tailDisabled.unshift({ name: failedName, reason: failureReason });
    }

    return {
      hooksManager: manager,
      active: activationRecords(effective.slice(0, failedIndex), manager),
      blocked,
      disabled: [...disabled, ...tailDisabled],
    };
  }

  return {
    hooksManager: manager,
    active: activationRecords(effective, manager),
    blocked: [],
    disabled,
  };
}

/**
 * Shut down the hooks manager, running onUnload in reverse registration order.
 * Delegates to `PluginHooksManager.shutdown()` (which already reverses and
 * collects per-hook errors); per-hook timeouts come from the activation
 * wrappers, so no hook can hang shutdown.
 */
export async function shutdownNodePlugins(
  hooksManager: PluginHooksManager | null,
): Promise<string[]> {
  if (hooksManager === null) return [];
  return hooksManager.shutdown();
}
