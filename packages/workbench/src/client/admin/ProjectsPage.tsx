import { AlertDialog } from '@kobalte/core/alert-dialog';
import { Combobox } from '@kobalte/core/combobox';
import type { JSX } from 'solid-js';
import { createEffect, createSignal, For, Show } from 'solid-js';
import type {
  WorkbenchAdminOverviewV1,
  WorkbenchProjectSafeViewV1,
  WorkbenchProjectValidationV1,
} from '../../contracts/index.js';
import type { AdminAuthorizationState, AdminClient, AdminProjectInput } from './admin-client';

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

export interface ProjectsPageProps {
  readonly overview: WorkbenchAdminOverviewV1 | null;
  readonly client?: AdminClient;
  readonly authorization?: AdminAuthorizationState;
  readonly onChanged?: () => void | Promise<void>;
}

type ProjectOption = { readonly projectId: string; readonly displayName: string };

function canMutate(props: ProjectsPageProps): boolean {
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
  return 'The Host rejected the project operation.';
}

function _receiptText(
  receipt:
    | { status: string; activeRevision: string | null; candidateRevision: string | null }
    | undefined,
): string {
  if (!receipt) return '';
  return `${receipt.status}; active ${receipt.activeRevision ?? 'none'}; candidate ${receipt.candidateRevision ?? 'none'}`;
}

export function ProjectsPage(props: ProjectsPageProps) {
  const [projects, setProjects] = createSignal<readonly WorkbenchProjectSafeViewV1[]>([]);
  const [projectId, setProjectId] = createSignal('');
  const [displayName, setDisplayName] = createSignal('');
  const [selectedProjectId, setSelectedProjectId] = createSignal('');
  const [validation, setValidation] = createSignal<
    'idle' | 'pending' | WorkbenchProjectValidationV1
  >('idle');
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const [confirmProjectId, setConfirmProjectId] = createSignal<string | null>(null);

  createEffect(() => {
    const next = props.overview?.setup.projects;
    if (next) setProjects(next);
  });

  const authorized = () => canMutate(props);
  const selectedProject = () =>
    projects().find((project) => project.projectId === selectedProjectId()) ?? null;
  const projectOptions = () =>
    projects().map(({ projectId: id, displayName: name }) => ({
      projectId: id,
      displayName: name,
    }));

  const input = (): AdminProjectInput => ({
    projectId: projectId().trim(),
    displayName: displayName().trim(),
  });

  const run = async (operation: () => Promise<void>) => {
    if (!authorized() || busy()) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await operation();
      await props.onChanged?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const validateProject = () => {
    setValidation('pending');
    void run(async () => {
      const value = input();
      if (!value.projectId || !value.displayName) {
        setValidation('invalid');
        throw new Error('Project id and display name are required for validation.');
      }
      const request = props.client?.validateProject(value);
      const result = await request;
      if (!result) throw new Error('The owner client is unavailable.');
      setValidation(result.validation);
      setMessage(
        result.validation === 'valid'
          ? 'The Host validated the project.'
          : `Validation failed: ${result.code ?? 'PROJECT_INVALID_ROOT'}.`,
      );
    });
  };

  const saveProject = () => {
    void run(async () => {
      const value = input();
      if (!value.projectId || !value.displayName) {
        throw new Error('Project id and display name are required.');
      }
      const exists = projects().some((project) => project.projectId === value.projectId);
      const request = exists
        ? props.client?.updateProject(value)
        : props.client?.createProject(value);
      const response = await request;
      if (!response) throw new Error('The owner client is unavailable.');
      if (response.project) {
        setProjects((current) => {
          const without = current.filter(
            (project) => project.projectId !== response.project?.projectId,
          );
          return [...without, response.project as WorkbenchProjectSafeViewV1];
        });
      }
      setValidation('valid');
      setMessage(`Project ${exists ? 'updated' : 'registered'}; the Host returned a safe receipt.`);
    });
  };

  const openSelected = () => {
    const selected = selectedProject();
    if (!selected) return;
    void run(async () => {
      const response = await props.client?.openProject(selected.projectId);
      if (!response) throw new Error('The owner client is unavailable.');
      setProjects((current) =>
        current.map((project) =>
          project.projectId === selected.projectId ? { ...project, open: true } : project,
        ),
      );
      setMessage(`Opened ${selected.displayName}.`);
    });
  };

  const closeSelected = () => {
    const selected = selectedProject();
    if (!selected) return;
    void run(async () => {
      const response = await props.client?.closeProject(selected.projectId);
      if (!response) throw new Error('The owner client is unavailable.');
      setProjects((current) =>
        current.map((project) =>
          project.projectId === selected.projectId ? { ...project, open: false } : project,
        ),
      );
      setMessage(`Closed ${selected.displayName}.`);
    });
  };

  const removeProject = (id: string) => {
    setConfirmProjectId(null);
    void run(async () => {
      const response = await props.client?.deleteProject(id);
      if (!response) throw new Error('The owner client is unavailable.');
      setProjects((current) => current.filter((project) => project.projectId !== id));
      if (selectedProjectId() === id) setSelectedProjectId('');
      setMessage('Project removed from the Host registry. Its project directory was not deleted.');
    });
  };

  let importInput: HTMLInputElement | undefined;

  const importProject = () => {
    void run(async () => {
      const input = importInput;
      const file = input?.files?.[0];
      if (!file) return;
      // `File.path` is a Chromium-only extension exposing the picked folder's
      // absolute path; the standard File API has no such field.
      const fileWithPath = file as { path?: string };
      const sourcePath = fileWithPath.path;
      if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
        throw new Error(
          'This browser cannot expose the folder path; import is available from the desktop Host.',
        );
      }
      const response = await props.client?.importProject(sourcePath);
      if (!response) throw new Error('The owner client is unavailable.');
      setMessage(
        `Imported "${response.displayName}" (${response.projectId}) into the managed root.`,
      );
      input.value = '';
    });
  };

  return (
    <div class="grid gap-[var(--wb-space-6)]" data-testid="admin-projects-page">
      <header class="grid gap-[var(--wb-space-2)]">
        <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
          Projects
        </p>
        <h2 class="font-display text-3xl tracking-[-0.025em] text-[var(--wb-ink)]">
          Project registry
        </h2>
        <p class="max-w-3xl text-sm leading-6 text-[var(--wb-muted)]">
          Project roots are one-way inputs. After validation or save, the dashboard retains only the
          safe display label, validation state, and runtime flags returned by the Host.
        </p>
      </header>

      <Show when={props.authorization === 'user' || props.authorization === 'unauthorized'}>
        <section class={`${PANEL} border-[var(--wb-error-border)]`} role="alert">
          <h3 class="text-base font-semibold text-[var(--wb-danger)]">
            Owner authorization required
          </h3>
          <p class="mt-[var(--wb-space-2)] text-sm leading-6 text-[var(--wb-ink-soft)]">
            This view is read-only for your session. No project mutation was sent.
          </p>
        </section>
      </Show>

      <section class={PANEL} aria-labelledby="project-form-heading">
        <div class="flex flex-wrap items-start justify-between gap-[var(--wb-space-3)]">
          <div>
            <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
              Owner action
            </p>
            <h3
              id="project-form-heading"
              class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]"
            >
              Validate or register a project
            </h3>
          </div>
          <span class="rounded-full border border-[var(--wb-border)] bg-[var(--wb-surface-muted)] px-[var(--wb-space-3)] py-[var(--wb-space-2)] text-xs font-bold text-[var(--wb-muted)]">
            {authorized() ? 'Mutation enabled' : 'Read-only'}
          </span>
        </div>
        <form
          class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-4)]"
          onSubmit={(event) => {
            event.preventDefault();
            saveProject();
          }}
        >
          <div class="grid gap-[var(--wb-space-4)] md:grid-cols-2">
            <Field
              label="Project id"
              id="project-id"
              hint="Stable identifier, not a filesystem path."
            >
              <input
                id="project-id"
                class={INPUT}
                value={projectId()}
                onInput={(event) => setProjectId(event.currentTarget.value)}
                autocomplete="off"
                disabled={!authorized() || busy()}
              />
            </Field>
            <Field label="Display name" id="display-name">
              <input
                id="display-name"
                class={INPUT}
                value={displayName()}
                onInput={(event) => setDisplayName(event.currentTarget.value)}
                autocomplete="off"
                disabled={!authorized() || busy()}
              />
            </Field>
          </div>
          <input
            ref={(el) => {
              importInput = el;
              el.setAttribute('webkitdirectory', '');
            }}
            type="file"
            class="hidden"
            tabIndex={-1}
            aria-hidden="true"
            disabled={!authorized() || busy()}
          />
          <div class="flex flex-wrap items-center gap-[var(--wb-space-3)]">
            <button
              class={SECONDARY_BUTTON}
              type="button"
              onClick={() => importInput?.click()}
              disabled={!authorized() || busy()}
            >
              Import project
            </button>
            <button
              class={SECONDARY_BUTTON}
              type="button"
              onClick={validateProject}
              disabled={!authorized() || busy()}
            >
              {validation() === 'pending' ? 'Validating…' : 'Validate'}
            </button>
            <button class={BUTTON} type="submit" disabled={!authorized() || busy()}>
              {busy() ? 'Working…' : 'Save project'}
            </button>
            <span
              class={`text-sm ${validation() === 'invalid' ? 'text-[var(--wb-danger)]' : 'text-[var(--wb-muted)]'}`}
              aria-live="polite"
            >
              {validation() === 'valid' ? 'Validated' : validation() === 'invalid' ? 'Invalid' : ''}
            </span>
          </div>
        </form>
        <Show when={message()}>
          <p class="mt-[var(--wb-space-3)] text-sm text-[var(--wb-success)]" aria-live="polite">
            {message()}
          </p>
        </Show>
        <Show when={error()}>
          <p class="mt-[var(--wb-space-3)] text-sm text-[var(--wb-danger)]" role="alert">
            {error()}
          </p>
        </Show>
      </section>

      <Show
        when={projects().length > 0}
        fallback={
          <section class={PANEL}>
            <h3 class="text-base font-semibold text-[var(--wb-ink)]">No projects registered</h3>
            <p class="mt-[var(--wb-space-2)] text-sm leading-6 text-[var(--wb-muted)]">
              Validate a project root above to begin the Host setup.
            </p>
          </section>
        }
      >
        <section class="grid gap-[var(--wb-space-4)]" aria-labelledby="project-list-heading">
          <div class="flex flex-wrap items-end justify-between gap-[var(--wb-space-4)]">
            <div>
              <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
                Safe registry
              </p>
              <h3
                id="project-list-heading"
                class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]"
              >
                Registered projects
              </h3>
            </div>
            <div class="min-w-[16rem]">
              <Combobox<ProjectOption>
                multiple={false}
                options={projectOptions()}
                optionValue="projectId"
                optionTextValue="displayName"
                optionLabel="displayName"
                value={
                  projectOptions().find((project) => project.projectId === selectedProjectId()) ??
                  null
                }
                onChange={(next) => setSelectedProjectId(next?.projectId ?? '')}
                placeholder="Choose a project to open or close"
                disabled={!authorized() || busy()}
                itemComponent={(itemProps) => (
                  <Combobox.Item item={itemProps.item}>
                    <Combobox.ItemLabel>{itemProps.item.rawValue.displayName}</Combobox.ItemLabel>
                  </Combobox.Item>
                )}
              >
                <Combobox.Label class="mb-[var(--wb-space-1)] block text-xs font-bold uppercase tracking-[0.06em] text-[var(--wb-muted)]">
                  Runtime selection
                </Combobox.Label>
                <Combobox.Control class={INPUT}>
                  <Combobox.Input />
                  <Combobox.Trigger aria-label="Open project selection">⌄</Combobox.Trigger>
                </Combobox.Control>
                <Combobox.Portal>
                  <Combobox.Content class="z-50 mt-1 rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-[var(--wb-surface)] p-[var(--wb-space-2)] shadow-[var(--wb-shadow-panel)]">
                    <Combobox.Listbox class="grid max-h-60 gap-1 overflow-auto" />
                  </Combobox.Content>
                </Combobox.Portal>
              </Combobox>
            </div>
          </div>
          <Show when={selectedProject()}>
            {(selected) => (
              <div
                class={`${PANEL} flex flex-wrap items-center justify-between gap-[var(--wb-space-3)]`}
              >
                <div>
                  <p class="font-semibold text-[var(--wb-ink)]">{selected().displayName}</p>
                  <p class="mt-1 text-xs text-[var(--wb-muted)]">
                    {selected().open ? 'Runtime open' : 'Runtime closed'}
                  </p>
                </div>
                <div class="flex flex-wrap gap-[var(--wb-space-2)]">
                  <button
                    class={SECONDARY_BUTTON}
                    type="button"
                    onClick={openSelected}
                    disabled={!authorized() || busy() || selected().open}
                  >
                    Open runtime
                  </button>
                  <button
                    class={SECONDARY_BUTTON}
                    type="button"
                    onClick={closeSelected}
                    disabled={!authorized() || busy() || !selected().open}
                  >
                    Close runtime
                  </button>
                </div>
              </div>
            )}
          </Show>
          <div class="grid gap-[var(--wb-space-3)]">
            <For each={projects()}>
              {(project) => (
                <article
                  class={`${PANEL} grid gap-[var(--wb-space-4)] md:grid-cols-[minmax(0,1fr)_auto]`}
                >
                  <div class="grid gap-[var(--wb-space-2)]">
                    <div class="flex flex-wrap items-center gap-[var(--wb-space-3)]">
                      <h4 class="font-semibold text-[var(--wb-ink)]">{project.displayName}</h4>
                      <code class="rounded bg-[var(--wb-surface-muted)] px-2 py-1 text-xs text-[var(--wb-ink-soft)]">
                        {project.projectId}
                      </code>
                    </div>
                    <div class="flex flex-wrap gap-[var(--wb-space-2)] text-xs">
                      <span class="rounded-full bg-[var(--wb-ready-surface)] px-[var(--wb-space-2)] py-1 text-[var(--wb-success)]">
                        validation: {project.validation}
                      </span>
                      <span class="rounded-full bg-[var(--wb-surface-muted)] px-[var(--wb-space-2)] py-1 text-[var(--wb-muted)]">
                        {project.open ? 'open' : 'closed'}
                      </span>
                      <Show when={project.defaultProject}>
                        <span class="rounded-full bg-[var(--wb-accent-wash)] px-[var(--wb-space-2)] py-1 text-[var(--wb-accent-deep)]">
                          default
                        </span>
                      </Show>
                    </div>
                  </div>
                  <div class="flex items-center justify-end">
                    <button
                      class={DANGER_BUTTON}
                      type="button"
                      onClick={() => setConfirmProjectId(project.projectId)}
                      disabled={!authorized() || busy()}
                    >
                      Remove project
                    </button>
                  </div>
                </article>
              )}
            </For>
          </div>
        </section>
      </Show>

      <AlertDialog
        open={confirmProjectId() !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmProjectId(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="fixed inset-0 z-40 bg-[var(--wb-overlay)]" />
          <AlertDialog.Content class="fixed left-1/2 top-1/2 z-50 grid w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-[var(--wb-space-4)] rounded-[var(--wb-radius-lg)] border border-[var(--wb-border-strong)] bg-[var(--wb-surface)] p-[var(--wb-space-6)] shadow-[var(--wb-shadow-drawer)]">
            <AlertDialog.Title class="font-display text-xl text-[var(--wb-ink)]">
              Remove project from the registry?
            </AlertDialog.Title>
            <AlertDialog.Description class="text-sm leading-6 text-[var(--wb-muted)]">
              This closes a runtime if necessary and removes only the Host registry entry. The
              project directory is not deleted and the action may be recovered by registering it
              again.
            </AlertDialog.Description>
            <div class="flex justify-end gap-[var(--wb-space-3)]">
              <AlertDialog.CloseButton class={SECONDARY_BUTTON}>Cancel</AlertDialog.CloseButton>
              <button
                class={DANGER_BUTTON}
                type="button"
                onClick={() => {
                  const id = confirmProjectId();
                  if (id) removeProject(id);
                }}
              >
                Remove project
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
  readonly hint?: string;
  readonly children: JSX.Element;
}) {
  return (
    <label
      for={props.id}
      class="grid gap-[var(--wb-space-2)] text-sm font-semibold text-[var(--wb-ink-soft)]"
    >
      <span>{props.label}</span>
      <Show when={props.hint}>
        <span class="text-xs font-normal leading-5 text-[var(--wb-muted)]">{props.hint}</span>
      </Show>
      {props.children}
    </label>
  );
}
