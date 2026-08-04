import { createSignal, For, Show } from 'solid-js';
import type { WorkbenchAdminOverviewV1 } from '../../contracts/index.js';
import type { AdminOperationsResponseV1 } from './admin-client';

const PANEL =
  'rounded-[var(--wb-radius-md)] border border-[var(--wb-border)] bg-[var(--wb-surface)] p-[var(--wb-space-5)] shadow-[var(--wb-shadow-panel)]';
const BUTTON =
  'inline-flex min-h-[2.5rem] items-center justify-center rounded-[var(--wb-radius-sm)] border border-[var(--wb-border-strong)] bg-[var(--wb-ink)] px-[var(--wb-space-4)] text-sm font-semibold text-[var(--wb-on-ink)] transition-colors hover:bg-[var(--wb-accent-deep)] disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY_BUTTON =
  'inline-flex min-h-[2.5rem] items-center justify-center rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-[var(--wb-surface)] px-[var(--wb-space-4)] text-sm font-semibold text-[var(--wb-ink-soft)] transition-colors hover:border-[var(--wb-accent)] hover:bg-[var(--wb-accent-wash)] disabled:cursor-not-allowed disabled:opacity-50';
const SAFE_CONFIG_TEMPLATE = `version: 1
projects:
  - projectId: project-id
    displayName: Project name
    root: /absolute/path/on-host
defaultProjectId: project-id
provider:
  kind: ai-sdk
  baseUrl: null
  model: null
network:
  mode: loopback
  port: 8787
  allowedHosts: []
  allowedOrigins: []
  unixSocket: null
`;

/**
 * The Host currently does not return a typed configuration-source view on its
 * overview route. Keep this state explicit instead of inferring it from
 * operation history; Phase 3 can add the exact safe DTO without changing the
 * System page's privacy boundary.
 */
export interface AdminConfigSourceUnavailableV1 {
  readonly version: 1;
  readonly status: 'unavailable';
  readonly code: 'CONFIG_SOURCE_VIEW_UNAVAILABLE';
  readonly message: string;
}

export interface SystemPageProps {
  readonly overview: WorkbenchAdminOverviewV1 | null;
  readonly operations?: AdminOperationsResponseV1 | null;
  readonly configSource?: AdminConfigSourceUnavailableV1;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function statusLabel(value: string): string {
  return value.replaceAll('-', ' ');
}

function capabilityVersionLabel(owner: WorkbenchAdminOverviewV1['owner']): string {
  const capabilityVersion = owner?.capabilityVersion;
  return capabilityVersion === undefined ? 'Unavailable' : String(capabilityVersion);
}

export function SystemPage(props: SystemPageProps) {
  const [templateStatus, setTemplateStatus] = createSignal('');
  const configSource = () =>
    props.configSource ?? {
      version: 1 as const,
      status: 'unavailable' as const,
      code: 'CONFIG_SOURCE_VIEW_UNAVAILABLE' as const,
      message:
        'The Host has not supplied the typed safe configuration-source DTO. No revision, origin, staged state, or diagnostics are inferred here.',
    };

  const downloadTemplate = () => {
    if (typeof URL.createObjectURL !== 'function') {
      setTemplateStatus('Downloads are unavailable in this browser.');
      return;
    }
    const url = URL.createObjectURL(new Blob([SAFE_CONFIG_TEMPLATE], { type: 'text/yaml' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'workbench.safe-template.yaml';
    anchor.click();
    URL.revokeObjectURL(url);
    setTemplateStatus('A secret-free YAML template was downloaded.');
  };

  const copyTemplate = async () => {
    if (typeof navigator.clipboard?.writeText !== 'function') {
      setTemplateStatus('Clipboard access is unavailable in this browser.');
      return;
    }
    try {
      await navigator.clipboard.writeText(SAFE_CONFIG_TEMPLATE);
      setTemplateStatus('The secret-free YAML template was copied.');
    } catch {
      setTemplateStatus('Clipboard access was denied; nothing was copied.');
    }
  };

  return (
    <div class="grid gap-[var(--wb-space-6)]" data-testid="admin-system-page">
      <header class="grid gap-[var(--wb-space-2)]">
        <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
          System
        </p>
        <h2 class="font-display text-3xl tracking-[-0.025em] text-[var(--wb-ink)]">
          Host health &amp; source of truth
        </h2>
        <p class="max-w-3xl text-sm leading-6 text-[var(--wb-muted)]">
          This page reports safe Host readiness only. Filesystem roots, credentials, tokens, Git
          internals, and raw configuration are never rendered in the dashboard.
        </p>
      </header>

      <Show
        when={props.overview}
        fallback={
          <section class={PANEL} aria-live="polite">
            <h3 class="text-base font-semibold text-[var(--wb-ink)]">
              System status is not loaded
            </h3>
            <p class="mt-[var(--wb-space-2)] text-sm leading-6 text-[var(--wb-muted)]">
              An authenticated owner overview is required before management status can be shown.
            </p>
          </section>
        }
      >
        {(overview) => (
          <>
            <section
              class="grid gap-[var(--wb-space-4)] md:grid-cols-2 xl:grid-cols-4"
              aria-label="Host health"
            >
              <StatusCard
                label="Host"
                value={statusLabel(overview().hostStatus)}
                detail={formatDate(overview().generatedAt)}
              />
              <StatusCard
                label="Setup phase"
                value={statusLabel(overview().setup.phase)}
                detail={
                  overview().setup.configurationPresent
                    ? 'Configuration present'
                    : 'Configuration not present'
                }
              />
              <StatusCard
                label="Persistence worker"
                value={overview().workerReady ? 'Ready' : 'Unavailable'}
                detail="SQLite stays outside the browser"
                tone={overview().workerReady ? 'ready' : 'warning'}
              />
              <StatusCard
                label="Open projects"
                value={String(overview().openProjects)}
                detail={
                  overview().restartRequired
                    ? 'Controlled restart required'
                    : 'Listener policy active'
                }
                tone={overview().restartRequired ? 'warning' : 'ready'}
              />
            </section>

            <section
              class={PANEL}
              aria-labelledby="admin-config-source-heading"
              data-testid="config-source-panel"
            >
              <div class="flex flex-wrap items-start justify-between gap-[var(--wb-space-4)]">
                <div>
                  <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
                    Configuration source
                  </p>
                  <h3
                    id="admin-config-source-heading"
                    class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]"
                  >
                    Safe source status
                  </h3>
                </div>
                <span class="rounded-full border border-[var(--wb-border)] bg-[var(--wb-surface-muted)] px-[var(--wb-space-3)] py-[var(--wb-space-2)] text-xs font-bold uppercase tracking-[0.06em] text-[var(--wb-muted)]">
                  {configSource().status}
                </span>
              </div>
              <p class="mt-[var(--wb-space-3)] max-w-3xl text-sm leading-6 text-[var(--wb-muted)]">
                {configSource().message}
              </p>
              <dl class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-3)] sm:grid-cols-2 xl:grid-cols-4">
                <SafeField label="Active revision" value="Unavailable" />
                <SafeField label="Last origin" value="Unavailable" />
                <SafeField label="Active / staged" value="Unavailable" />
                <SafeField label="Diagnostics" value="Unavailable" />
              </dl>
              <p class="mt-[var(--wb-space-4)] text-xs leading-5 text-[var(--wb-muted)]">
                The Host must add a versioned, secret-free source-status DTO before these fields can
                be reported. Operation history is intentionally not treated as a substitute.
              </p>
            </section>

            <section class="grid gap-[var(--wb-space-6)] lg:grid-cols-2">
              <section class={PANEL} aria-labelledby="admin-runtime-heading">
                <div class="flex items-start justify-between gap-[var(--wb-space-3)]">
                  <div>
                    <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
                      Runtime
                    </p>
                    <h3
                      id="admin-runtime-heading"
                      class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]"
                    >
                      Safe readiness details
                    </h3>
                  </div>
                  <span class="rounded-full bg-[var(--wb-ready-surface)] px-[var(--wb-space-3)] py-[var(--wb-space-2)] text-xs font-bold text-[var(--wb-success)]">
                    {overview().owner ? 'Owner session' : 'Owner profile unavailable'}
                  </span>
                </div>
                <dl class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-4)] sm:grid-cols-2">
                  <SafeField label="Owner" value={overview().owner?.displayName ?? 'Unavailable'} />
                  <SafeField
                    label="Capability version"
                    value={capabilityVersionLabel(overview().owner)}
                  />
                  <SafeField
                    label="Default project"
                    value={overview().setup.defaultProjectId ?? 'Not selected'}
                  />
                  <SafeField label="Network mode" value={overview().setup.network.mode} />
                </dl>
              </section>

              <section class={PANEL} aria-labelledby="admin-template-heading">
                <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
                  Transparent configuration
                </p>
                <h3
                  id="admin-template-heading"
                  class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]"
                >
                  Start from a safe YAML template
                </h3>
                <p class="mt-[var(--wb-space-2)] text-sm leading-6 text-[var(--wb-muted)]">
                  The template contains placeholders only. It has no project root, API key, owner
                  password, session, device credential, or token from this Host.
                </p>
                <div class="mt-[var(--wb-space-4)] flex flex-wrap gap-[var(--wb-space-3)]">
                  <button class={BUTTON} type="button" onClick={downloadTemplate}>
                    Download template
                  </button>
                  <button
                    class={SECONDARY_BUTTON}
                    type="button"
                    onClick={() => void copyTemplate()}
                  >
                    Copy template
                  </button>
                </div>
                <p
                  class="mt-[var(--wb-space-3)] min-h-[1.25rem] text-xs text-[var(--wb-success)]"
                  aria-live="polite"
                >
                  {templateStatus()}
                </p>
              </section>
            </section>

            <Show when={props.operations?.configurationOperations.length}>
              <section class={PANEL} aria-labelledby="admin-recent-config-heading">
                <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
                  Recent activity
                </p>
                <h3
                  id="admin-recent-config-heading"
                  class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]"
                >
                  Configuration operations are detailed in Operations
                </h3>
                <ul class="mt-[var(--wb-space-4)] grid gap-[var(--wb-space-3)]">
                  <For each={props.operations?.configurationOperations.slice(0, 3) ?? []}>
                    {(operation) => (
                      <li class="flex flex-wrap items-baseline justify-between gap-[var(--wb-space-3)] border-t border-[var(--wb-border)] pt-[var(--wb-space-3)] text-sm">
                        <span class="font-semibold text-[var(--wb-ink)]">
                          {operation.origin} · {operation.status}
                        </span>
                        <span class="text-xs text-[var(--wb-muted)]">
                          {formatDate(operation.at)}
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function StatusCard(props: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone?: 'ready' | 'warning';
}) {
  return (
    <article class={`${PANEL} grid gap-[var(--wb-space-2)]`}>
      <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
        {props.label}
      </p>
      <p
        class={`text-2xl font-semibold ${props.tone === 'warning' ? 'text-[var(--wb-warning)]' : 'text-[var(--wb-ink)]'}`}
      >
        {props.value}
      </p>
      <p class="text-xs leading-5 text-[var(--wb-muted)]">{props.detail}</p>
    </article>
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
