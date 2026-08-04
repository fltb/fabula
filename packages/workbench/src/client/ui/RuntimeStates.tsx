import type { JSX } from 'solid-js';
import { createSignal, For, Show } from 'solid-js';
import type { BrowserProjectSummaryV1 } from '../../contracts/index.js';
import type { RuntimeHealth, RuntimeState } from '../runtime-client.js';

const PANEL =
  'mx-auto w-full max-w-3xl rounded-[var(--wb-radius-lg)] border border-[var(--wb-border)] bg-[var(--wb-surface)] p-[var(--wb-space-6)] shadow-[var(--wb-shadow-panel)]';
const PRIMARY_BUTTON =
  'inline-flex min-h-9 items-center justify-center rounded-[var(--wb-radius-sm)] border border-[var(--wb-accent-deep)] bg-[var(--wb-accent-deep)] px-[var(--wb-space-4)] text-sm font-bold text-[var(--wb-on-ink)] transition hover:bg-[var(--wb-accent)] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-3 focus-visible:outline-[var(--wb-focus)] focus-visible:outline-offset-2';
const QUIET_BUTTON =
  'inline-flex min-h-9 items-center justify-center rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-transparent px-[var(--wb-space-4)] text-sm font-semibold text-[var(--wb-accent-deep)] transition hover:bg-[var(--wb-accent-wash)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-[var(--wb-focus)] focus-visible:outline-offset-2';
const FIELD =
  'mt-[var(--wb-space-2)] block min-h-10 w-full rounded-[var(--wb-radius-sm)] border border-[var(--wb-border-strong)] bg-[var(--wb-surface)] px-[var(--wb-space-3)] py-[var(--wb-space-2)] text-[var(--wb-ink)] shadow-sm outline-none transition placeholder:text-[var(--wb-muted)] focus:border-[var(--wb-focus)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-[var(--wb-focus)] focus-visible:outline-offset-1';

export const RUNTIME_HEALTH_COPY: Readonly<
  Record<
    RuntimeHealth,
    { readonly title: string; readonly description: string; readonly marker: string }
  >
> = {
  loading: {
    title: 'Checking Host status',
    description: 'The browser is asking the Host for a safe readiness status.',
    marker: '…',
  },
  empty: {
    title: 'No project is ready',
    description: 'The Host is available, but no project can be opened yet.',
    marker: '○',
  },
  disconnected: {
    title: 'Host connection lost',
    description: 'Reconnect to the local Workbench Host before continuing.',
    marker: '—',
  },
  unauthorized: {
    title: 'Sign-in required',
    description: 'This session is missing, expired, or no longer authorized.',
    marker: '⌁',
  },
  fatal: {
    title: 'Host error',
    description: 'The Host returned an unexpected failure. No project data was inferred.',
    marker: '!',
  },
  ready: {
    title: 'Host connected',
    description: 'The authenticated Host is ready to supply a project projection.',
    marker: '·',
  },
};

export interface RuntimeStatePanelProps {
  readonly state: RuntimeState;
  readonly health?: RuntimeHealth;
  readonly message?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}

const RUNTIME_STATE_COPY: Readonly<
  Record<
    RuntimeState,
    { readonly title: string; readonly description: string; readonly marker: string }
  >
> = {
  setup: {
    title: 'Set up this Workbench',
    description:
      'Create the owner, validate a project, connect a provider, and review the listener policy.',
    marker: '1',
  },
  'bootstrap-owner': {
    title: 'Create the owner account',
    description: 'The first owner is created only through the loopback setup surface.',
    marker: '1',
  },
  login: {
    title: 'Sign in to the Workbench',
    description: 'Your session lives in memory and is never written to browser storage.',
    marker: '→',
  },
  'project-picker': {
    title: 'Choose a project',
    description: 'Only Host-authorized project labels are shown here.',
    marker: '◇',
  },
  workspace: {
    title: 'Workspace',
    description: 'Load the accepted Host projection for this project.',
    marker: '·',
  },
  'configuration-restart-required': {
    title: 'Restart required',
    description:
      'The configuration was accepted, but the listener must restart before it is active.',
    marker: '↻',
  },
  'fatal-host-error': {
    title: 'Workbench Host error',
    description:
      'The Host could not complete this request. No credentials, paths, or source were displayed.',
    marker: '!',
  },
};

export function RuntimeStatePanel(props: RuntimeStatePanelProps): JSX.Element {
  const copy = () => RUNTIME_STATE_COPY[props.state];
  const healthCopy = () => (props.health ? RUNTIME_HEALTH_COPY[props.health] : null);
  return (
    <section
      class={`${PANEL} grid gap-[var(--wb-space-4)] sm:grid-cols-[auto_minmax(0,1fr)]`}
      aria-live="polite"
      data-runtime-state={props.state}
      data-runtime-health={props.health}
    >
      <div
        class="grid h-11 w-11 place-items-center rounded-full bg-[var(--wb-accent-wash)] font-[var(--font-display)] text-xl font-bold text-[var(--wb-accent-deep)]"
        aria-hidden="true"
      >
        {props.health ? healthCopy()?.marker : copy().marker}
      </div>
      <div>
        <p class="mb-[var(--wb-space-1)] text-[0.625rem] font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
          Runtime state
        </p>
        <h1 class="font-[var(--font-display)] text-3xl font-bold leading-tight tracking-[-0.025em] text-[var(--wb-ink)]">
          {props.health ? healthCopy()?.title : copy().title}
        </h1>
        <p class="mt-[var(--wb-space-3)] max-w-2xl text-sm leading-relaxed text-[var(--wb-muted)]">
          {props.message ?? (props.health ? healthCopy()?.description : copy().description)}
        </p>
        <Show when={props.onAction && props.actionLabel}>
          <button
            class={`${PRIMARY_BUTTON} mt-[var(--wb-space-5)]`}
            type="button"
            onClick={props.onAction}
          >
            {props.actionLabel}
          </button>
        </Show>
      </div>
    </section>
  );
}

export interface LoginFormProps {
  readonly pending?: boolean;
  readonly error?: string | null;
  readonly onSubmit: (input: {
    readonly userId: string;
    readonly password: string;
  }) => Promise<void> | void;
}
export function LoginForm(props: LoginFormProps): JSX.Element {
  const [userId, setUserId] = createSignal('owner');
  const [password, setPassword] = createSignal('');
  const [localError, setLocalError] = createSignal<string | null>(null);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const nextUserId = userId().trim();
    const nextPassword = password();
    setPassword('');
    if (nextUserId.length === 0) {
      setLocalError('Enter your user ID.');
      return;
    }
    if (nextPassword.length === 0) {
      setLocalError('Enter your password.');
      return;
    }
    setLocalError(null);
    await props.onSubmit({ userId: nextUserId, password: nextPassword });
  };

  return (
    <main class="min-h-screen bg-[var(--wb-canvas)] px-[var(--wb-space-4)] py-[var(--wb-space-10)]">
      <section class={PANEL} aria-labelledby="login-heading">
        <p class="mb-[var(--wb-space-1)] text-[0.625rem] font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
          Fabula / Workbench
        </p>
        <h1
          id="login-heading"
          class="font-[var(--font-display)] text-3xl font-bold text-[var(--wb-ink)]"
        >
          Sign in
        </h1>
        <p class="mt-[var(--wb-space-3)] text-sm leading-relaxed text-[var(--wb-muted)]">
          Authenticate with the local Host. This browser keeps the session in memory only.
        </p>
        <form class="mt-[var(--wb-space-6)] grid gap-[var(--wb-space-4)]" onSubmit={submit}>
          <label
            class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]"
            for="login-user-id"
          >
            User ID
            <input
              class={FIELD}
              id="login-user-id"
              name="userId"
              autocomplete="username"
              value={userId()}
              onInput={(event) => setUserId(event.currentTarget.value)}
            />
          </label>
          <label
            class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]"
            for="login-password"
          >
            Password
            <input
              class={FIELD}
              id="login-password"
              name="password"
              type="password"
              autocomplete="current-password"
              value={password()}
              onInput={(event) => setPassword(event.currentTarget.value)}
            />
          </label>
          <Show when={localError() || props.error}>
            <p class="text-sm text-[var(--wb-danger)]" role="alert">
              {localError() ?? props.error}
            </p>
          </Show>
          <button class={PRIMARY_BUTTON} type="submit" disabled={props.pending}>
            {props.pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}

export interface ProjectPickerProps {
  readonly projects: readonly BrowserProjectSummaryV1[];
  readonly pending?: boolean;
  readonly error?: string | null;
  readonly health?: RuntimeHealth;
  readonly onSelect: (projectId: string) => void;
  readonly onRetry?: () => void;
}

export function ProjectPicker(props: ProjectPickerProps): JSX.Element {
  return (
    <main class="min-h-screen bg-[var(--wb-canvas)] px-[var(--wb-space-4)] py-[var(--wb-space-10)]">
      <section class={PANEL} aria-labelledby="project-picker-heading">
        <p class="mb-[var(--wb-space-1)] text-[0.625rem] font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
          Workbench / Project access
        </p>
        <h1
          id="project-picker-heading"
          class="font-[var(--font-display)] text-3xl font-bold text-[var(--wb-ink)]"
        >
          Choose a project
        </h1>
        <p class="mt-[var(--wb-space-3)] text-sm leading-relaxed text-[var(--wb-muted)]">
          Project paths stay on the Host. This picker uses only safe labels returned for your
          session.
        </p>
        <Show
          when={!props.pending && props.projects.length > 0}
          fallback={
            <div class="mt-[var(--wb-space-6)]" aria-live="polite" aria-busy={props.pending}>
              <RuntimeStatePanel
                state="project-picker"
                health={props.pending ? 'loading' : (props.health ?? 'empty')}
                message={props.error ?? undefined}
                actionLabel={props.onRetry ? 'Try again' : undefined}
                onAction={props.onRetry}
              />
            </div>
          }
        >
          <ul
            class="mt-[var(--wb-space-6)] grid gap-[var(--wb-space-3)]"
            aria-label="Available projects"
          >
            <For each={props.projects}>
              {(project) => (
                <li>
                  <button
                    class="flex min-h-16 w-full items-center justify-between rounded-[var(--wb-radius-md)] border border-[var(--wb-border)] bg-[var(--wb-surface-muted)] px-[var(--wb-space-4)] py-[var(--wb-space-3)] text-left transition hover:border-[var(--wb-accent)] hover:bg-[var(--wb-accent-wash)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-[var(--wb-focus)] focus-visible:outline-offset-2"
                    type="button"
                    onClick={() => props.onSelect(project.projectId)}
                  >
                    <span>
                      <strong class="block text-base text-[var(--wb-ink)]">
                        {project.displayName}
                      </strong>
                      <span class="mt-1 block text-xs text-[var(--wb-muted)]">
                        {project.open ? 'Open on Host' : 'Available on Host'}
                      </span>
                    </span>
                    <span aria-hidden="true" class="text-lg text-[var(--wb-accent)]">
                      →
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
          <Show when={props.error}>
            <p class="mt-[var(--wb-space-4)] text-sm text-[var(--wb-danger)]" role="alert">
              {props.error}
            </p>
          </Show>
        </Show>
      </section>
    </main>
  );
}

export function AdminOutlet(props: {
  readonly authorized: boolean;
  readonly onSignIn?: () => void;
}): JSX.Element {
  return props.authorized ? (
    <main class="min-h-screen bg-[var(--wb-canvas)] px-[var(--wb-space-4)] py-[var(--wb-space-10)]">
      <RuntimeStatePanel
        state="workspace"
        message="Owner dashboard routes are ready for the integration shell."
      />
    </main>
  ) : (
    <main class="min-h-screen bg-[var(--wb-canvas)] px-[var(--wb-space-4)] py-[var(--wb-space-10)]">
      <RuntimeStatePanel
        state="login"
        health="unauthorized"
        actionLabel={props.onSignIn ? 'Sign in' : undefined}
        onAction={props.onSignIn}
      />
    </main>
  );
}

export { FIELD, PANEL, PRIMARY_BUTTON, QUIET_BUTTON };
