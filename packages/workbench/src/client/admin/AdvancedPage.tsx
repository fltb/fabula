import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { ConfigOperationReceiptV1 } from '../../contracts/configuration.js';
import type {
  AdminAdvancedConfigPreviewResponseV1,
  AdminAdvancedConfigResponseV1,
  AdminAuthorizationState,
  AdminClient,
  AdminDiscoveredPluginViewV1,
  AdminTrustedPluginViewV1,
} from './admin-client';

const PANEL =
  'rounded-[var(--wb-radius-md)] border border-[var(--wb-border)] bg-[var(--wb-surface)] p-[var(--wb-space-5)] shadow-[var(--wb-shadow-panel)]';
const INPUT =
  'min-h-[2.75rem] w-full rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-[var(--wb-surface)] px-[var(--wb-space-3)] text-sm text-[var(--wb-ink)] outline-none transition-colors placeholder:text-[var(--wb-muted)] focus:border-[var(--wb-focus)] focus:ring-2 focus:ring-[var(--wb-focus)] disabled:cursor-not-allowed disabled:bg-[var(--wb-surface-muted)]';
const CHECKBOX =
  'h-5 w-5 rounded-[var(--wb-radius-sm)] border border-[var(--wb-border-strong)] accent-[var(--wb-accent-deep)] disabled:cursor-not-allowed disabled:opacity-50';
const BUTTON =
  'inline-flex min-h-[2.5rem] items-center justify-center rounded-[var(--wb-radius-sm)] border border-[var(--wb-border-strong)] bg-[var(--wb-ink)] px-[var(--wb-space-4)] text-sm font-semibold text-[var(--wb-on-ink)] transition-colors hover:bg-[var(--wb-accent-deep)] disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY_BUTTON =
  'inline-flex min-h-[2.5rem] items-center justify-center rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-[var(--wb-surface)] px-[var(--wb-space-3)] text-sm font-semibold text-[var(--wb-ink-soft)] transition-colors hover:border-[var(--wb-accent)] hover:bg-[var(--wb-accent-wash)] disabled:cursor-not-allowed disabled:opacity-50';
const DANGER_BUTTON =
  'inline-flex min-h-[2.5rem] items-center justify-center rounded-[var(--wb-radius-sm)] border border-[var(--wb-error-border)] bg-[var(--wb-error-surface)] px-[var(--wb-space-3)] text-sm font-semibold text-[var(--wb-danger)] transition-colors hover:border-[var(--wb-danger)] disabled:cursor-not-allowed disabled:opacity-50';

export interface AdvancedPageProps {
  readonly client?: AdminClient;
  readonly authorization?: AdminAuthorizationState;
  readonly onChanged?: () => void | Promise<void>;
}

function canMutate(props: AdvancedPageProps): boolean {
  return props.authorization === undefined
    ? props.client !== undefined
    : props.authorization === 'owner';
}

function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return 'The Host rejected the advanced configuration operation.';
}

export function AdvancedPage(props: AdvancedPageProps) {
  const [advanced, setAdvanced] = createSignal<AdminAdvancedConfigResponseV1 | null>(null);
  const [maxQueued, setMaxQueued] = createSignal('');
  const [maxConcurrentHost, setMaxConcurrentHost] = createSignal('');
  const [agentEnabled, setAgentEnabled] = createSignal(false);
  const [maxTurns, setMaxTurns] = createSignal('');
  const [maxToolCalls, setMaxToolCalls] = createSignal('');
  const [pluginProjectId, setPluginProjectId] = createSignal('');
  const [discovered, setDiscovered] = createSignal<readonly AdminDiscoveredPluginViewV1[]>([]);
  const [discoveredError, setDiscoveredError] = createSignal('');
  const [lastReceipt, setLastReceipt] = createSignal<ConfigOperationReceiptV1 | null>(null);
  const [preview, setPreview] = createSignal<AdminAdvancedConfigPreviewResponseV1 | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');

  onMount(() => {
    if (!props.client) return;
    props.client
      .getAdvancedConfig()
      .then((next) => {
        setAdvanced(next);
        setMaxQueued(String(next.operationLimits.maxQueuedPerProject));
        setMaxConcurrentHost(String(next.operationLimits.maxConcurrentRendersPerHost));
        setAgentEnabled(next.agent.enabled);
        setMaxTurns(String(next.agent.maxTurns));
        setMaxToolCalls(String(next.agent.maxToolCalls));
        if (next.projects.length > 0 && pluginProjectId() === '') {
          setPluginProjectId(next.projects[0]?.projectId ?? '');
        }
      })
      .catch((caught) => setError(errorMessage(caught)));
  });

  const authorized = () => canMutate(props);
  const projects = () => advanced()?.projects ?? [];
  const selectedPlugins = (): readonly AdminTrustedPluginViewV1[] => {
    const selected = pluginProjectId();
    if (selected === '') return [];
    return projects().find((project) => project.projectId === selected)?.trustedPlugins ?? [];
  };

  // Fetch the Host-discovered plugin set whenever the selected project changes.
  createEffect(() => {
    const projectId = pluginProjectId();
    const client = props.client;
    if (!client || projectId === '') return;
    let cancelled = false;
    setDiscoveredError('');
    setDiscovered([]);
    client
      .getDiscoveredPlugins(projectId)
      .then((response) => {
        if (!cancelled) setDiscovered(response.plugins);
      })
      .catch((caught) => {
        if (!cancelled) setDiscoveredError(errorMessage(caught));
      });
    onCleanup(() => {
      cancelled = true;
    });
  });

  const run = async (operation: () => Promise<void>) => {
    if (!authorized() || busy()) return;
    setBusy(true);
    setError('');
    setMessage('');
    setPreview(null);
    setLastReceipt(null);
    try {
      await operation();
      await props.onChanged?.();
      if (props.client) {
        await props.client
          .getAdvancedConfig()
          .then(setAdvanced)
          .catch(() => undefined);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const saveLimits = () => {
    void run(async () => {
      const maxQueuedPerProject = Number(maxQueued());
      const maxConcurrentRendersPerHost = Number(maxConcurrentHost());
      if (!Number.isSafeInteger(maxQueuedPerProject) || maxQueuedPerProject < 0) {
        throw new Error('maxQueuedPerProject must be a non-negative integer.');
      }
      if (!Number.isSafeInteger(maxConcurrentRendersPerHost) || maxConcurrentRendersPerHost < 0) {
        throw new Error('maxConcurrentRendersPerHost must be a non-negative integer.');
      }
      const response = await props.client?.applyAdvancedConfig({
        operationLimits: { maxQueuedPerProject, maxConcurrentRendersPerHost },
      });
      if (!response) throw new Error('The owner client is unavailable.');
      setLastReceipt(response.receipt);
      setMessage(`Operation limits saved; ${response.receipt.status}.`);
    });
  };

  const agentPatch = () => ({
    enabled: agentEnabled(),
    maxTurns: Number(maxTurns()),
    maxToolCalls: Number(maxToolCalls()),
  });

  const previewAgentAndLimits = () => {
    void run(async () => {
      const maxQueuedPerProject = Number(maxQueued());
      const maxConcurrentRendersPerHost = Number(maxConcurrentHost());
      const response = await props.client?.previewAdvancedConfig({
        operationLimits: { maxQueuedPerProject, maxConcurrentRendersPerHost },
        agent: agentPatch(),
      });
      if (!response) throw new Error('The owner client is unavailable.');
      setPreview(response);
    });
  };

  const saveAgent = () => {
    void run(async () => {
      const patch = agentPatch();
      if (!Number.isSafeInteger(patch.maxTurns) || patch.maxTurns < 0) {
        throw new Error('maxTurns must be a non-negative integer.');
      }
      if (!Number.isSafeInteger(patch.maxToolCalls) || patch.maxToolCalls < 0) {
        throw new Error('maxToolCalls must be a non-negative integer.');
      }
      const response = await props.client?.applyAdvancedConfig({ agent: patch });
      if (!response) throw new Error('The owner client is unavailable.');
      setLastReceipt(response.receipt);
      setMessage(`Agent settings saved; ${response.receipt.status}.`);
    });
  };

  const addDiscoveredPlugin = (plugin: AdminDiscoveredPluginViewV1) => {
    const projectId = pluginProjectId();
    if (projectId === '') return;
    const moduleHash = plugin.moduleHash;
    if (moduleHash === null) {
      setError(`Plugin "${plugin.name}" has no module on this Host and cannot be trusted.`);
      return;
    }
    void run(async () => {
      const next = [
        ...selectedPlugins(),
        {
          name: plugin.name,
          version: plugin.version,
          moduleHash,
          required: false,
        },
      ];
      const response = await props.client?.applyAdvancedConfig({
        projects: [{ projectId, trustedPlugins: next }],
      });
      if (!response) throw new Error('The owner client is unavailable.');
      setLastReceipt(response.receipt);
      setMessage(
        `Plugin "${plugin.name}@${plugin.version}" added to the allowlist; ${response.receipt.status}.`,
      );
    });
  };

  const removePlugin = (name: string) => {
    const projectId = pluginProjectId();
    if (projectId === '') return;
    void run(async () => {
      const next = selectedPlugins().filter((plugin) => plugin.name !== name);
      const response = await props.client?.applyAdvancedConfig({
        projects: [{ projectId, trustedPlugins: next }],
      });
      if (!response) throw new Error('The owner client is unavailable.');
      setLastReceipt(response.receipt);
      setMessage(`Plugin "${name}" removed from the allowlist; ${response.receipt.status}.`);
    });
  };

  const toggleRequired = (name: string) => {
    const projectId = pluginProjectId();
    if (projectId === '') return;
    void run(async () => {
      const next = selectedPlugins().map((plugin) =>
        plugin.name === name ? { ...plugin, required: !plugin.required } : plugin,
      );
      const response = await props.client?.applyAdvancedConfig({
        projects: [{ projectId, trustedPlugins: next }],
      });
      if (!response) throw new Error('The owner client is unavailable.');
      setLastReceipt(response.receipt);
      setMessage(`Plugin "${name}" required flag updated; ${response.receipt.status}.`);
    });
  };

  return (
    <div class="grid gap-[var(--wb-space-6)]" data-testid="admin-advanced-page">
      <header class="grid gap-[var(--wb-space-2)]">
        <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
          Advanced
        </p>
        <h2 class="font-display text-3xl tracking-[-0.025em] text-[var(--wb-ink)]">
          Operation limits, agent, and trusted plugins
        </h2>
        <p class="max-w-3xl text-sm leading-6 text-[var(--wb-muted)]">
          These V3 configuration domains are captured at Host startup; every change applies through
          the revision-CAS configuration service and reports whether a controlled restart is
          required. Plugin entries are chosen only from plugins the Host discovered on disk (name,
          version, module hash) — no upload, URL, arbitrary path, or module code crosses this
          boundary.
        </p>
      </header>

      <Show when={props.authorization === 'user' || props.authorization === 'unauthorized'}>
        <section class={`${PANEL} border-[var(--wb-error-border)]`} role="alert">
          <h3 class="text-base font-semibold text-[var(--wb-danger)]">
            Owner authorization required
          </h3>
          <p class="mt-[var(--wb-space-2)] text-sm leading-6 text-[var(--wb-ink-soft)]">
            This view is read-only. No advanced configuration mutation was sent.
          </p>
        </section>
      </Show>

      <section class="grid gap-[var(--wb-space-6)] lg:grid-cols-2">
        <section class={PANEL} aria-labelledby="operation-limits-heading">
          <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
            Host-wide
          </p>
          <h3
            id="operation-limits-heading"
            class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]"
          >
            Operation limits
          </h3>
          <p class="mt-[var(--wb-space-2)] text-xs leading-5 text-[var(--wb-muted)]">
            Per-project render concurrency is fixed at 1. The queue cap and Host-wide concurrency
            apply after a controlled restart.
          </p>
          <form
            class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-4)]"
            onSubmit={(event) => {
              event.preventDefault();
              saveLimits();
            }}
          >
            <Field label="Max queued operations per project" id="max-queued-per-project">
              <input
                id="max-queued-per-project"
                class={INPUT}
                type="number"
                min={0}
                step={1}
                value={maxQueued()}
                onInput={(event) => setMaxQueued(event.currentTarget.value)}
                disabled={!authorized() || busy()}
              />
            </Field>
            <Field label="Max concurrent renders per host" id="max-concurrent-renders-per-host">
              <input
                id="max-concurrent-renders-per-host"
                class={INPUT}
                type="number"
                min={0}
                step={1}
                value={maxConcurrentHost()}
                onInput={(event) => setMaxConcurrentHost(event.currentTarget.value)}
                disabled={!authorized() || busy()}
              />
            </Field>
            <button class={BUTTON} type="submit" disabled={!authorized() || busy()}>
              {busy() ? 'Saving…' : 'Save operation limits'}
            </button>
          </form>
        </section>

        <section class={PANEL} aria-labelledby="agent-settings-heading">
          <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
            Workbench agent
          </p>
          <h3
            id="agent-settings-heading"
            class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]"
          >
            Agent enablement and limits
          </h3>
          <p class="mt-[var(--wb-space-2)] text-xs leading-5 text-[var(--wb-muted)]">
            The agent feature is hidden unless enabled, the project provider supports tool calls,
            and the parity gate passes.
          </p>
          <form
            class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-4)]"
            onSubmit={(event) => {
              event.preventDefault();
              saveAgent();
            }}
          >
            <label
              for="agent-enabled"
              class="flex items-center gap-[var(--wb-space-3)] text-sm font-semibold text-[var(--wb-ink-soft)]"
            >
              <input
                id="agent-enabled"
                class={CHECKBOX}
                type="checkbox"
                checked={agentEnabled()}
                onChange={(event) => setAgentEnabled(event.currentTarget.checked)}
                disabled={!authorized() || busy()}
              />
              Enable the workbench agent
            </label>
            <div class="grid gap-[var(--wb-space-4)] sm:grid-cols-2">
              <Field label="Max turns" id="agent-max-turns">
                <input
                  id="agent-max-turns"
                  class={INPUT}
                  type="number"
                  min={0}
                  step={1}
                  value={maxTurns()}
                  onInput={(event) => setMaxTurns(event.currentTarget.value)}
                  disabled={!authorized() || busy()}
                />
              </Field>
              <Field label="Max tool calls" id="agent-max-tool-calls">
                <input
                  id="agent-max-tool-calls"
                  class={INPUT}
                  type="number"
                  min={0}
                  step={1}
                  value={maxToolCalls()}
                  onInput={(event) => setMaxToolCalls(event.currentTarget.value)}
                  disabled={!authorized() || busy()}
                />
              </Field>
            </div>
            <div class="flex flex-wrap gap-[var(--wb-space-3)]">
              <button
                class={SECONDARY_BUTTON}
                type="button"
                onClick={previewAgentAndLimits}
                disabled={!authorized() || busy()}
              >
                Preview
              </button>
              <button class={BUTTON} type="submit" disabled={!authorized() || busy()}>
                {busy() ? 'Saving…' : 'Save agent settings'}
              </button>
            </div>
          </form>
          <Show when={preview()}>
            {(current) => (
              <dl
                class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-3)] border-t border-[var(--wb-border)] pt-[var(--wb-space-4)]"
                data-testid="advanced-config-preview"
              >
                <SafeField
                  label="Preview result"
                  value={
                    current().valid
                      ? 'valid'
                      : `invalid: ${current().diagnostics[0]?.message ?? 'unknown'}`
                  }
                />
                <SafeField
                  label="Changed fields"
                  value={
                    current().changedFields.length ? current().changedFields.join(', ') : 'none'
                  }
                />
                <SafeField
                  label="Restart required"
                  value={current().restartRequired ? 'yes' : 'no'}
                />
              </dl>
            )}
          </Show>
        </section>
      </section>

      <section class={PANEL} aria-labelledby="trusted-plugins-heading">
        <div class="flex flex-wrap items-start justify-between gap-[var(--wb-space-3)]">
          <div>
            <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
              Per project
            </p>
            <h3
              id="trusted-plugins-heading"
              class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]"
            >
              Trusted plugin allowlist
            </h3>
          </div>
          <label
            for="plugin-project"
            class="grid gap-[var(--wb-space-1)] text-xs font-bold uppercase tracking-[0.06em] text-[var(--wb-muted)]"
          >
            Project
            <select
              id="plugin-project"
              class={INPUT}
              value={pluginProjectId()}
              onChange={(event) => setPluginProjectId(event.currentTarget.value)}
              disabled={!authorized() || busy()}
            >
              <For each={projects()}>
                {(project) => (
                  <option
                    value={project.projectId}
                    selected={project.projectId === pluginProjectId()}
                  >
                    {project.displayName}
                  </option>
                )}
              </For>
            </select>
          </label>
        </div>
        <p class="mt-[var(--wb-space-2)] text-xs leading-5 text-[var(--wb-muted)]">
          Entries can only be chosen from the plugins this Host discovered on disk; no upload, URL,
          or arbitrary module path is accepted. A required plugin that fails to load makes rendering
          unavailable; optional plugins are disabled and recorded. Changes apply through the
          revision-CAS configuration service and require a controlled restart.
        </p>

        <Show
          when={pluginProjectId() !== ''}
          fallback={
            <p class="mt-[var(--wb-space-4)] text-sm leading-6 text-[var(--wb-muted)]">
              No projects are registered yet.
            </p>
          }
        >
          <div class="mt-[var(--wb-space-5)] overflow-x-auto">
            <table
              class="w-full border-collapse text-left text-sm"
              data-testid="trusted-plugins-table"
            >
              <thead>
                <tr class="border-b border-[var(--wb-border)] text-xs font-extrabold uppercase tracking-[0.06em] text-[var(--wb-muted)]">
                  <th class="py-[var(--wb-space-2)] pr-[var(--wb-space-3)]">Name</th>
                  <th class="py-[var(--wb-space-2)] pr-[var(--wb-space-3)]">Version</th>
                  <th class="py-[var(--wb-space-2)] pr-[var(--wb-space-3)]">Module hash</th>
                  <th class="py-[var(--wb-space-2)] pr-[var(--wb-space-3)]">Required</th>
                  <th class="py-[var(--wb-space-2)]">Action</th>
                </tr>
              </thead>
              <tbody>
                <For each={selectedPlugins()}>
                  {(plugin) => (
                    <tr class="border-b border-[var(--wb-border)]">
                      <td class="py-[var(--wb-space-2)] pr-[var(--wb-space-3)] font-semibold text-[var(--wb-ink-soft)]">
                        {plugin.name}
                      </td>
                      <td class="py-[var(--wb-space-2)] pr-[var(--wb-space-3)] text-[var(--wb-ink-soft)]">
                        {plugin.version}
                      </td>
                      <td class="max-w-[16rem] truncate py-[var(--wb-space-2)] pr-[var(--wb-space-3)] font-mono text-xs text-[var(--wb-muted)]">
                        {plugin.moduleHash}
                      </td>
                      <td class="py-[var(--wb-space-2)] pr-[var(--wb-space-3)]">
                        <input
                          class={CHECKBOX}
                          type="checkbox"
                          checked={plugin.required}
                          onChange={() => toggleRequired(plugin.name)}
                          aria-label={`Require plugin ${plugin.name}`}
                          disabled={!authorized() || busy()}
                        />
                      </td>
                      <td class="py-[var(--wb-space-2)]">
                        <button
                          class={DANGER_BUTTON}
                          type="button"
                          onClick={() => removePlugin(plugin.name)}
                          disabled={!authorized() || busy()}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>

          <h4 class="mt-[var(--wb-space-6)] text-sm font-extrabold uppercase tracking-[0.08em] text-[var(--wb-muted)]">
            Discovered on this Host
          </h4>
          <p class="mt-[var(--wb-space-2)] text-xs leading-5 text-[var(--wb-muted)]">
            Identity fields only — name, version, module hash, hook names. Add an entry to the
            allowlist from this list; the required flag is toggled in the allowlist table above.
          </p>
          <Show when={discoveredError()}>
            <p class="mt-[var(--wb-space-3)] text-sm text-[var(--wb-danger)]" role="alert">
              {discoveredError()}
            </p>
          </Show>
          <Show when={discovered().length > 0}>
            <div class="mt-[var(--wb-space-4)] overflow-x-auto">
              <table
                class="w-full border-collapse text-left text-sm"
                data-testid="discovered-plugins-table"
              >
                <thead>
                  <tr class="border-b border-[var(--wb-border)] text-xs font-extrabold uppercase tracking-[0.06em] text-[var(--wb-muted)]">
                    <th class="py-[var(--wb-space-2)] pr-[var(--wb-space-3)]">Name</th>
                    <th class="py-[var(--wb-space-2)] pr-[var(--wb-space-3)]">Version</th>
                    <th class="py-[var(--wb-space-2)] pr-[var(--wb-space-3)]">Module hash</th>
                    <th class="py-[var(--wb-space-2)] pr-[var(--wb-space-3)]">Hooks</th>
                    <th class="py-[var(--wb-space-2)]">Action</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={discovered()}>
                    {(plugin) => {
                      const isTrusted = createMemo(() =>
                        selectedPlugins().some(
                          (entry) =>
                            entry.name === plugin.name &&
                            entry.version === plugin.version &&
                            entry.moduleHash === plugin.moduleHash,
                        ),
                      );
                      return (
                        <tr class="border-b border-[var(--wb-border)]">
                          <td class="py-[var(--wb-space-2)] pr-[var(--wb-space-3)] font-semibold text-[var(--wb-ink-soft)]">
                            {plugin.name}
                          </td>
                          <td class="py-[var(--wb-space-2)] pr-[var(--wb-space-3)] text-[var(--wb-ink-soft)]">
                            {plugin.version}
                          </td>
                          <td class="max-w-[16rem] truncate py-[var(--wb-space-2)] pr-[var(--wb-space-3)] font-mono text-xs text-[var(--wb-muted)]">
                            {plugin.moduleHash ?? 'module missing'}
                          </td>
                          <td class="py-[var(--wb-space-2)] pr-[var(--wb-space-3)] text-xs text-[var(--wb-muted)]">
                            {plugin.hookNames.length > 0 ? plugin.hookNames.join(', ') : 'none'}
                          </td>
                          <td class="py-[var(--wb-space-2)]">
                            <button
                              class={SECONDARY_BUTTON}
                              type="button"
                              onClick={() => addDiscoveredPlugin(plugin)}
                              disabled={
                                !authorized() || busy() || isTrusted() || plugin.moduleHash === null
                              }
                              aria-label={`Trust plugin ${plugin.name}`}
                            >
                              {isTrusted() ? 'Trusted' : 'Add to allowlist'}
                            </button>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
          <Show when={discovered().length === 0 && discoveredError() === ''}>
            <p class="mt-[var(--wb-space-4)] text-sm leading-6 text-[var(--wb-muted)]">
              No plugins were discovered on this Host for the selected project.
            </p>
          </Show>
        </Show>
      </section>

      <Show when={message()}>
        <p class="text-sm text-[var(--wb-success)]" aria-live="polite">
          {message()}
        </p>
      </Show>
      <Show when={error()}>
        <p class="text-sm text-[var(--wb-danger)]" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={lastReceipt()}>
        {(current) => (
          <section
            class={`${PANEL} ${
              current().status === 'restart-required'
                ? 'border-[var(--wb-accent)]'
                : 'border-[var(--wb-border)]'
            }`}
            data-testid="advanced-restart-receipt"
            aria-live="polite"
          >
            <h3 class="text-base font-semibold text-[var(--wb-ink)]">
              {current().status === 'restart-required' ? 'Saved — restart required' : 'Saved'}
            </h3>
            <p class="mt-[var(--wb-space-2)] text-sm leading-6 text-[var(--wb-ink-soft)]">
              {current().status === 'restart-required'
                ? 'The change is persisted and will take effect after a controlled restart. The running Host does not hot-load a partial configuration.'
                : 'The change is persisted and already active.'}
            </p>
            <dl class="mt-[var(--wb-space-4)] grid gap-[var(--wb-space-3)]">
              <SafeField label="Status" value={current().status} />
              <SafeField
                label="Changed fields"
                value={current().changedFields.length ? current().changedFields.join(', ') : 'none'}
              />
              <SafeField label="Active revision" value={current().activeRevision ?? '—'} />
              <SafeField label="Candidate revision" value={current().candidateRevision ?? '—'} />
            </dl>
          </section>
        )}
      </Show>
    </div>
  );
}

function Field(props: {
  readonly label: string;
  readonly id: string;
  readonly children: import('solid-js').JSX.Element;
}) {
  return (
    <label
      for={props.id}
      class="grid gap-[var(--wb-space-2)] text-sm font-semibold text-[var(--wb-ink-soft)]"
    >
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function SafeField(props: { readonly label: string; readonly value: string }) {
  return (
    <div class="grid gap-[var(--wb-space-1)]">
      <dt class="text-xs font-bold uppercase tracking-[0.06em] text-[var(--wb-muted)]">
        {props.label}
      </dt>
      <dd class="break-words text-sm font-semibold text-[var(--wb-ink-soft)]">{props.value}</dd>
    </div>
  );
}
