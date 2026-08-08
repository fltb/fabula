import { AlertDialog } from '@kobalte/core/alert-dialog';
import { createSignal, For, onMount, Show } from 'solid-js';
import type { WorkbenchAdminOverviewV1 } from '../../contracts/index.js';
import type {
  AdminAdvancedConfigResponseV1,
  AdminAuthorizationState,
  AdminClient,
  AdminProviderProfileViewV1,
} from './admin-client';

const PANEL =
  'rounded-[var(--wb-radius-md)] border border-[var(--wb-border)] bg-[var(--wb-surface)] p-[var(--wb-space-5)] shadow-[var(--wb-shadow-panel)]';
const INPUT =
  'min-h-[2.75rem] w-full rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-[var(--wb-surface)] px-[var(--wb-space-3)] text-sm text-[var(--wb-ink)] outline-none transition-colors placeholder:text-[var(--wb-muted)] focus:border-[var(--wb-focus)] focus:ring-2 focus:ring-[var(--wb-focus)] disabled:cursor-not-allowed disabled:bg-[var(--wb-surface-muted)]';
const BUTTON =
  'inline-flex min-h-[2.5rem] items-center justify-center rounded-[var(--wb-radius-sm)] border border-[var(--wb-border-strong)] bg-[var(--wb-ink)] px-[var(--wb-space-4)] text-sm font-semibold text-[var(--wb-on-ink)] transition-colors hover:bg-[var(--wb-accent-deep)] disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY_BUTTON =
  'inline-flex min-h-[2.5rem] items-center justify-center rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-[var(--wb-surface)] px-[var(--wb-space-3)] text-sm font-semibold text-[var(--wb-ink-soft)] transition-colors hover:border-[var(--wb-accent)] hover:bg-[var(--wb-accent-wash)] disabled:cursor-not-allowed disabled:opacity-50';
const DANGER_BUTTON =
  'inline-flex min-h-[2.5rem] items-center justify-center rounded-[var(--wb-radius-sm)] border border-[var(--wb-error-border)] bg-[var(--wb-error-surface)] px-[var(--wb-space-3)] text-sm font-semibold text-[var(--wb-danger)] transition-colors hover:border-[var(--wb-danger)] disabled:cursor-not-allowed disabled:opacity-50';

export interface ProviderPageProps {
  readonly overview: WorkbenchAdminOverviewV1 | null;
  readonly client?: AdminClient;
  readonly authorization?: AdminAuthorizationState;
  readonly onChanged?: () => void | Promise<void>;
}

function canMutate(props: ProviderPageProps): boolean {
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
  return 'The Host rejected the provider operation.';
}

export function ProviderPage(props: ProviderPageProps) {
  const [advanced, setAdvanced] = createSignal<AdminAdvancedConfigResponseV1 | null>(null);
  const [profileId, setProfileId] = createSignal('');
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [baseUrl, setBaseUrl] = createSignal('');
  const [model, setModel] = createSignal('');
  const [credentials, setCredentials] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);

  onMount(() => {
    if (!props.client) return;
    props.client
      .getAdvancedConfig()
      .then(setAdvanced)
      .catch((caught) => setError(errorMessage(caught)));
  });

  const authorized = () => canMutate(props);
  const profiles = () => advanced()?.providers ?? [];
  const projects = () => advanced()?.projects ?? [];
  const profileOptions = () => {
    const ids = profiles().map((profile) => profile.profileId);
    for (const project of projects()) {
      if (!ids.includes(project.providerProfile)) ids.push(project.providerProfile);
    }
    return ids;
  };

  const run = async (operation: () => Promise<void>) => {
    if (!authorized() || busy()) return;
    setBusy(true);
    setError('');
    setMessage('');
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

  const startCreate = () => {
    setEditingId(null);
    setProfileId('');
    setBaseUrl('');
    setModel('');
  };

  const startEdit = (profile: AdminProviderProfileViewV1) => {
    setEditingId(profile.profileId);
    setProfileId(profile.profileId);
    setBaseUrl('');
    setModel('');
  };

  const saveProfile = () => {
    void run(async () => {
      const id = profileId().trim();
      if (!id) throw new Error('A provider profile id is required.');
      const response = await props.client?.upsertProviderProfile(id, {
        kind: 'pi',
        baseUrl: baseUrl().trim() || null,
        model: model().trim() || null,
      });
      if (!response) throw new Error('The owner client is unavailable.');
      setMessage(`Provider profile "${id}" saved; ${response.receipt.status}.`);
      setEditingId(null);
      setProfileId('');
      setBaseUrl('');
      setModel('');
    });
  };

  const removeProfile = (id: string) => {
    setConfirmDelete(null);
    void run(async () => {
      const response = await props.client?.deleteProviderProfile(id);
      if (!response) throw new Error('The owner client is unavailable.');
      setMessage(`Provider profile "${id}" removed.`);
    });
  };

  const storeCredential = (id: string, secret: string) => {
    // Clear the one-way secret before awaiting the Host response; retries
    // require deliberate re-entry and it never remains in UI state.
    setCredentials((current) => ({ ...current, [id]: '' }));
    void run(async () => {
      const response = await props.client?.setProviderProfileCredential(id, secret);
      if (!response) throw new Error('The owner client is unavailable.');
      setMessage(
        `Credential stored by the Host for "${id}". It is not displayed or retained by this browser.`,
      );
    });
  };

  const clearCredential = (id: string) => {
    void run(async () => {
      const response = await props.client?.clearProviderProfileCredential(id);
      if (!response) throw new Error('The owner client is unavailable.');
      setMessage(`The Host removed the credential for "${id}".`);
    });
  };

  const testProfile = (id: string) => {
    void run(async () => {
      const response = await props.client?.testProviderProfile(id);
      if (!response) throw new Error('The owner client is unavailable.');
      setMessage(
        response.validation === 'valid'
          ? `Provider profile "${id}" validation succeeded.`
          : `Provider profile "${id}" validation failed: ${response.code ?? 'PROVIDER_VALIDATION_FAILED'}.`,
      );
    });
  };

  const changeBinding = (projectId: string, providerProfile: string) => {
    void run(async () => {
      const response = await props.client?.applyAdvancedConfig({
        projects: [{ projectId, providerProfile }],
      });
      if (!response) throw new Error('The owner client is unavailable.');
      setMessage(
        `Project "${projectId}" now uses provider profile "${providerProfile}"; ${response.receipt.status}.`,
      );
    });
  };

  return (
    <div class="grid gap-[var(--wb-space-6)]" data-testid="admin-provider-page">
      <header class="grid gap-[var(--wb-space-2)]">
        <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
          Provider
        </p>
        <h2 class="font-display text-3xl tracking-[-0.025em] text-[var(--wb-ink)]">
          Provider profiles
        </h2>
        <p class="max-w-3xl text-sm leading-6 text-[var(--wb-muted)]">
          Each project binds to one provider profile. Endpoint and model values are returned masked
          by the Host; API credentials are one-way inputs that this browser never displays,
          persists, or receives back.
        </p>
      </header>

      <Show when={props.authorization === 'user' || props.authorization === 'unauthorized'}>
        <section class={`${PANEL} border-[var(--wb-error-border)]`} role="alert">
          <h3 class="text-base font-semibold text-[var(--wb-danger)]">
            Owner authorization required
          </h3>
          <p class="mt-[var(--wb-space-2)] text-sm leading-6 text-[var(--wb-ink-soft)]">
            This view is read-only. No provider mutation was sent.
          </p>
        </section>
      </Show>

      <section class={PANEL} aria-labelledby="provider-profiles-heading">
        <div class="flex flex-wrap items-start justify-between gap-[var(--wb-space-3)]">
          <div>
            <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
              Safe read view
            </p>
            <h3
              id="provider-profiles-heading"
              class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]"
            >
              Configured profiles
            </h3>
          </div>
          <button
            class={SECONDARY_BUTTON}
            type="button"
            onClick={startCreate}
            disabled={!authorized() || busy()}
          >
            New profile
          </button>
        </div>
        <Show
          when={profiles().length > 0}
          fallback={
            <p class="mt-[var(--wb-space-4)] text-sm leading-6 text-[var(--wb-muted)]">
              No provider profiles are configured yet. Save one below; the first profile is often
              named `default` and is the binding applied to legacy projects.
            </p>
          }
        >
          <ul class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-4)]">
            <For each={profiles()}>
              {(profile) => (
                <li
                  class="grid gap-[var(--wb-space-4)] rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-[var(--wb-surface-muted)] p-[var(--wb-space-4)]"
                  data-testid={`provider-profile-${profile.profileId}`}
                >
                  <div class="flex flex-wrap items-center justify-between gap-[var(--wb-space-3)]">
                    <h4 class="text-base font-semibold text-[var(--wb-ink)]">
                      {profile.profileId}
                    </h4>
                    <span
                      class={`rounded-full px-[var(--wb-space-3)] py-[var(--wb-space-2)] text-xs font-bold ${profile.configured ? 'bg-[var(--wb-ready-surface)] text-[var(--wb-success)]' : 'bg-[var(--wb-loading-surface)] text-[var(--wb-warning)]'}`}
                    >
                      {profile.configured ? 'credential configured' : 'credential not configured'}
                    </span>
                  </div>
                  <dl class="grid gap-[var(--wb-space-3)] sm:grid-cols-3">
                    <SafeField label="Endpoint" value={profile.endpoint ?? 'Not set'} />
                    <SafeField label="Model" value={profile.model ?? 'Not set'} />
                    <SafeField label="Last validation" value={profile.lastValidation} />
                  </dl>
                  <div class="grid gap-[var(--wb-space-3)] lg:grid-cols-2">
                    <div class="grid gap-[var(--wb-space-2)] text-sm font-semibold text-[var(--wb-ink-soft)]">
                      <label
                        for={`provider-api-key-${profile.profileId}`}
                        class="grid gap-[var(--wb-space-2)] text-sm font-semibold text-[var(--wb-ink-soft)]"
                      >
                        {`Provider API key for ${profile.profileId}`}
                      </label>
                      <div class="flex flex-wrap gap-[var(--wb-space-3)]">
                        <input
                          id={`provider-api-key-${profile.profileId}`}
                          class={INPUT}
                          type="password"
                          value={credentials()[profile.profileId] ?? ''}
                          onInput={(event) =>
                            setCredentials((current) => ({
                              ...current,
                              [profile.profileId]: event.currentTarget.value,
                            }))
                          }
                          autocomplete="new-password"
                          disabled={!authorized() || busy()}
                        />
                        <button
                          class={BUTTON}
                          type="button"
                          onClick={() =>
                            storeCredential(
                              profile.profileId,
                              credentials()[profile.profileId] ?? '',
                            )
                          }
                          disabled={
                            !authorized() ||
                            busy() ||
                            (credentials()[profile.profileId] ?? '') === ''
                          }
                        >
                          Store credential
                        </button>
                      </div>
                    </div>
                    <div class="flex flex-wrap items-end gap-[var(--wb-space-3)]">
                      <button
                        class={SECONDARY_BUTTON}
                        type="button"
                        onClick={() => testProfile(profile.profileId)}
                        disabled={!authorized() || busy()}
                      >
                        Test credential
                      </button>
                      <button
                        class={SECONDARY_BUTTON}
                        type="button"
                        onClick={() => clearCredential(profile.profileId)}
                        disabled={!authorized() || busy() || !profile.configured}
                      >
                        Clear credential
                      </button>
                      <button
                        class={SECONDARY_BUTTON}
                        type="button"
                        onClick={() => startEdit(profile)}
                        disabled={!authorized() || busy()}
                      >
                        Edit
                      </button>
                      <button
                        class={DANGER_BUTTON}
                        type="button"
                        onClick={() => setConfirmDelete(profile.profileId)}
                        disabled={!authorized() || busy()}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section class="grid gap-[var(--wb-space-6)] lg:grid-cols-2">
        <section class={PANEL} aria-labelledby="provider-profile-form-heading">
          <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
            Configuration
          </p>
          <h3
            id="provider-profile-form-heading"
            class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]"
          >
            {editingId() === null
              ? 'Add a provider profile'
              : `Edit provider profile ${editingId()}`}
          </h3>
          <p class="mt-[var(--wb-space-2)] text-xs leading-5 text-[var(--wb-muted)]">
            Leave a field blank to unset it. The masked read value above is never copied into an
            editable field.
          </p>
          <form
            class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-4)]"
            onSubmit={(event) => {
              event.preventDefault();
              saveProfile();
            }}
          >
            <Field label="Profile id" id="provider-profile-id">
              <input
                id="provider-profile-id"
                class={INPUT}
                value={profileId()}
                onInput={(event) => setProfileId(event.currentTarget.value)}
                autocomplete="off"
                disabled={editingId() !== null || !authorized() || busy()}
              />
            </Field>
            <Field label="Base URL" id="provider-profile-base-url">
              <input
                id="provider-profile-base-url"
                class={INPUT}
                value={baseUrl()}
                onInput={(event) => setBaseUrl(event.currentTarget.value)}
                autocomplete="off"
                disabled={!authorized() || busy()}
              />
            </Field>
            <Field label="Model" id="provider-profile-model">
              <input
                id="provider-profile-model"
                class={INPUT}
                value={model()}
                onInput={(event) => setModel(event.currentTarget.value)}
                autocomplete="off"
                disabled={!authorized() || busy()}
              />
            </Field>
            <div class="flex flex-wrap gap-[var(--wb-space-3)]">
              <button class={BUTTON} type="submit" disabled={!authorized() || busy()}>
                {busy() ? 'Saving…' : 'Save profile'}
              </button>
              {editingId() !== null ? (
                <button class={SECONDARY_BUTTON} type="button" onClick={startCreate}>
                  Cancel
                </button>
              ) : null}
            </div>
          </form>
        </section>

        <section class={PANEL} aria-labelledby="provider-binding-heading">
          <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
            Binding
          </p>
          <h3
            id="provider-binding-heading"
            class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]"
          >
            Project to provider profile
          </h3>
          <p class="mt-[var(--wb-space-2)] text-xs leading-5 text-[var(--wb-muted)]">
            Choose the provider profile each project renders with. The change applies through the
            same revision-CAS configuration service as every other admin mutation.
          </p>
          <Show
            when={projects().length > 0}
            fallback={
              <p class="mt-[var(--wb-space-4)] text-sm leading-6 text-[var(--wb-muted)]">
                No projects are registered yet.
              </p>
            }
          >
            <ul class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-3)]">
              <For each={projects()}>
                {(project) => (
                  <li class="flex flex-wrap items-center justify-between gap-[var(--wb-space-3)]">
                    <span class="text-sm font-semibold text-[var(--wb-ink-soft)]">
                      {project.displayName}
                      <span class="ml-[var(--wb-space-2)] text-xs text-[var(--wb-muted)]">
                        {project.projectId}
                      </span>
                    </span>
                    <label
                      for={`provider-binding-${project.projectId}`}
                      class="grid gap-[var(--wb-space-1)] text-xs font-bold uppercase tracking-[0.06em] text-[var(--wb-muted)]"
                    >
                      Provider profile
                      <select
                        id={`provider-binding-${project.projectId}`}
                        class={INPUT}
                        value={project.providerProfile}
                        onChange={(event) =>
                          changeBinding(project.projectId, event.currentTarget.value)
                        }
                        disabled={!authorized() || busy()}
                      >
                        <For each={profileOptions()}>
                          {(option) => (
                            <option value={option} selected={option === project.providerProfile}>
                              {option}
                            </option>
                          )}
                        </For>
                      </select>
                    </label>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
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

      <AlertDialog
        open={confirmDelete() !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="fixed inset-0 z-40 bg-[var(--wb-overlay)]" />
          <AlertDialog.Content class="fixed left-1/2 top-1/2 z-50 grid w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-[var(--wb-space-4)] rounded-[var(--wb-radius-lg)] border border-[var(--wb-border-strong)] bg-[var(--wb-surface)] p-[var(--wb-space-6)] shadow-[var(--wb-shadow-drawer)]">
            <AlertDialog.Title class="font-display text-xl text-[var(--wb-ink)]">
              Delete provider profile?
            </AlertDialog.Title>
            <AlertDialog.Description class="text-sm leading-6 text-[var(--wb-muted)]">
              Projects bound to this profile must be re-bound first; the Host refuses to remove a
              profile that a project still uses.
            </AlertDialog.Description>
            <div class="flex justify-end gap-[var(--wb-space-3)]">
              <AlertDialog.CloseButton class={SECONDARY_BUTTON}>Cancel</AlertDialog.CloseButton>
              <button
                class={DANGER_BUTTON}
                type="button"
                onClick={() => {
                  const id = confirmDelete();
                  if (id !== null) removeProfile(id);
                }}
              >
                Delete profile
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog>
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
