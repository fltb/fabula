import { Tabs } from '@kobalte/core/tabs';
import { createSignal, For, onMount, Show } from 'solid-js';
import type { WorkbenchAdminOverviewV1 } from '../../contracts/index.js';
import { AccessDevicesPage } from './AccessDevicesPage';
import { AdvancedPage } from './AdvancedPage';
import type {
  AdminAuthorizationState,
  AdminClient,
  AdminOperationsResponseV1,
} from './admin-client';
import { NetworkPage } from './NetworkPage';
import { OperationsPage } from './OperationsPage';
import { ProjectsPage } from './ProjectsPage';
import { ProviderPage } from './ProviderPage';
import { SystemPage } from './SystemPage';

const PANEL =
  'rounded-[var(--wb-radius-md)] border border-[var(--wb-border)] bg-[var(--wb-surface)] p-[var(--wb-space-5)] shadow-[var(--wb-shadow-panel)]';
const ADMIN_SECTIONS = [
  { id: 'system', label: 'System', glyph: '◌' },
  { id: 'projects', label: 'Projects', glyph: '◇' },
  { id: 'provider', label: 'Provider', glyph: '∿' },
  { id: 'advanced', label: 'Advanced', glyph: '⚙' },
  { id: 'access-devices', label: 'Access & Devices', glyph: '⌁' },
  { id: 'network', label: 'Network', glyph: '↗' },
  { id: 'operations', label: 'Operations', glyph: '✓' },
] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number]['id'];

export interface AdminShellProps {
  /** The client is optional so integration can render an honest unloaded state. */
  readonly client?: AdminClient;
  readonly overview?: WorkbenchAdminOverviewV1 | null;
  readonly operations?: AdminOperationsResponseV1 | null;
  /** Role state comes from the authenticated runtime state machine, not local storage. */
  readonly authorization?: AdminAuthorizationState;
  readonly initialSection?: AdminSection;
  readonly onSectionChange?: (section: AdminSection) => void;
}

function authorizationMessage(state: AdminAuthorizationState): {
  readonly title: string;
  readonly body: string;
} {
  if (state === 'user') {
    return {
      title: 'Owner authorization required',
      body: 'Your session can use the author workspace, but only the owner can view or change Host administration.',
    };
  }
  if (state === 'unauthorized') {
    return {
      title: 'Sign in as the owner',
      body: 'The Host did not accept an owner session. No dashboard mutation was sent.',
    };
  }
  return {
    title: 'Owner dashboard is not connected',
    body: 'Connect an authenticated Host client to load safe system status. This shell does not guess readiness or project state.',
  };
}

export function AdminShell(props: AdminShellProps) {
  const initialAuthorization: AdminAuthorizationState =
    props.authorization ?? (props.overview ? 'owner' : 'unknown');
  const [authorization, setAuthorization] =
    createSignal<AdminAuthorizationState>(initialAuthorization);
  const [overview, setOverview] = createSignal<WorkbenchAdminOverviewV1 | null>(
    props.overview ?? null,
  );
  const [operations, setOperations] = createSignal<AdminOperationsResponseV1 | null>(
    props.operations ?? null,
  );
  const [section, setSection] = createSignal<AdminSection>(props.initialSection ?? 'system');
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');

  const refreshOverview = async () => {
    if (!props.client || authorization() !== 'owner') return;
    const next = await props.client.getOverview();
    setOverview(next);
  };

  const load = async () => {
    if (authorization() === 'user' || authorization() === 'unauthorized') return;
    if (!props.client) return;
    setLoading(true);
    setError('');
    try {
      if (!overview()) {
        const next = await props.client.getOverview();
        setOverview(next);
        setAuthorization('owner');
      }
      if (authorization() === 'unknown') setAuthorization('owner');
      try {
        setOperations(await props.client.getOperations());
      } catch {
        // Operations is an optional read for the shell; its page shows an empty
        // state rather than making System look healthier than the Host says.
      }
    } catch (caught) {
      const nextAuthorization = props.client.getAuthorization();
      setAuthorization(nextAuthorization === 'unknown' ? 'unauthorized' : nextAuthorization);
      if (
        caught &&
        typeof caught === 'object' &&
        'message' in caught &&
        typeof caught.message === 'string'
      ) {
        setError(caught.message);
      } else {
        setError('The owner overview could not be loaded.');
      }
    } finally {
      setLoading(false);
    }
  };

  onMount(() => void load());

  const chooseSection = (value: string) => {
    const next = ADMIN_SECTIONS.some((candidate) => candidate.id === value)
      ? (value as AdminSection)
      : 'system';
    setSection(next);
    props.onSectionChange?.(next);
  };

  const authCopy = () => authorizationMessage(authorization());

  return (
    <section
      class="min-h-full bg-[var(--wb-canvas)] p-[var(--wb-space-4)] text-[var(--wb-ink)] sm:p-[var(--wb-space-6)] lg:p-[var(--wb-space-8)]"
      data-testid="admin-shell"
      aria-labelledby="admin-shell-heading"
    >
      <div class="mx-auto grid max-w-[90rem] gap-[var(--wb-space-6)]">
        <header class="flex flex-wrap items-end justify-between gap-[var(--wb-space-5)]">
          <div class="grid gap-[var(--wb-space-2)]">
            <p class="text-xs font-extrabold uppercase tracking-[0.14em] text-[var(--wb-muted)]">
              Owner control plane
            </p>
            <h1
              id="admin-shell-heading"
              class="font-display text-4xl tracking-[-0.03em] text-[var(--wb-ink)]"
            >
              Workbench administration
            </h1>
            <p class="max-w-3xl text-sm leading-6 text-[var(--wb-muted)]">
              Manage validated Host configuration, project runtime, provider readiness, access,
              listener policy, and durable receipts without exposing secrets or filesystem material.
            </p>
          </div>
          <Show when={overview()}>
            {(current) => (
              <span
                class={`rounded-full border px-[var(--wb-space-3)] py-[var(--wb-space-2)] text-xs font-bold uppercase tracking-[0.06em] ${current().hostStatus === 'ready' ? 'border-[var(--wb-ready-border)] bg-[var(--wb-ready-surface)] text-[var(--wb-success)]' : 'border-[var(--wb-loading-border)] bg-[var(--wb-loading-surface)] text-[var(--wb-warning)]'}`}
              >
                {current().hostStatus}
              </span>
            )}
          </Show>
        </header>

        <Show
          when={authorization() === 'owner'}
          fallback={
            <section
              class={`${PANEL} grid gap-[var(--wb-space-3)]`}
              role={authorization() === 'unknown' ? 'status' : 'alert'}
              aria-live="polite"
              aria-busy={loading()}
            >
              <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
                Authorization
              </p>
              <h2 class="text-xl font-semibold text-[var(--wb-ink)]">
                {loading() ? 'Loading owner dashboard…' : authCopy().title}
              </h2>
              <p class="max-w-2xl text-sm leading-6 text-[var(--wb-muted)]">
                {error() || authCopy().body}
              </p>
              <Show when={authorization() === 'unknown' && !loading() && props.client}>
                <button
                  class="mt-2 inline-flex min-h-[2.5rem] w-fit items-center rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-[var(--wb-surface)] px-4 text-sm font-semibold text-[var(--wb-ink-soft)]"
                  type="button"
                  onClick={() => void load()}
                >
                  Retry owner status
                </button>
              </Show>
            </section>
          }
        >
          <Tabs
            value={section()}
            onChange={chooseSection}
            activationMode="manual"
            class="grid gap-[var(--wb-space-6)]"
          >
            <Tabs.List
              class="flex flex-wrap gap-[var(--wb-space-2)] overflow-x-auto rounded-[var(--wb-radius-md)] border border-[var(--wb-border)] bg-[var(--wb-surface)] p-[var(--wb-space-2)] shadow-[var(--wb-shadow-panel)]"
              aria-label="Owner dashboard pages"
            >
              <For each={ADMIN_SECTIONS}>
                {(item) => (
                  <Tabs.Trigger
                    value={item.id}
                    class="inline-flex min-h-[2.75rem] items-center gap-2 rounded-[var(--wb-radius-sm)] border border-transparent px-[var(--wb-space-3)] text-sm font-semibold text-[var(--wb-ink-soft)] transition-colors hover:bg-[var(--wb-surface-muted)] data-[selected]:border-[var(--wb-empty-border)] data-[selected]:bg-[var(--wb-accent-wash)] data-[selected]:text-[var(--wb-accent-deep)]"
                  >
                    <span aria-hidden="true">{item.glyph}</span>
                    {item.label}
                  </Tabs.Trigger>
                )}
              </For>
              <Tabs.Indicator class="hidden" />
            </Tabs.List>

            <Tabs.Content value="system">
              <SystemPage overview={overview()} operations={operations()} />
            </Tabs.Content>
            <Tabs.Content value="projects">
              <ProjectsPage
                overview={overview()}
                client={props.client}
                authorization={authorization()}
                onChanged={refreshOverview}
              />
            </Tabs.Content>
            <Tabs.Content value="provider">
              <ProviderPage
                overview={overview()}
                client={props.client}
                authorization={authorization()}
                onChanged={refreshOverview}
              />
            </Tabs.Content>
            <Tabs.Content value="advanced">
              <AdvancedPage
                client={props.client}
                authorization={authorization()}
                onChanged={refreshOverview}
              />
            </Tabs.Content>
            <Tabs.Content value="access-devices">
              <AccessDevicesPage
                overview={overview()}
                client={props.client}
                authorization={authorization()}
                onChanged={refreshOverview}
              />
            </Tabs.Content>
            <Tabs.Content value="network">
              <NetworkPage
                overview={overview()}
                client={props.client}
                authorization={authorization()}
                onChanged={refreshOverview}
              />
            </Tabs.Content>
            <Tabs.Content value="operations">
              <OperationsPage
                overview={overview()}
                client={props.client}
                authorization={authorization()}
                operations={operations()}
              />
            </Tabs.Content>
          </Tabs>
        </Show>
      </div>
    </section>
  );
}

export { ADMIN_SECTIONS };
