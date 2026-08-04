import { createEffect, createSignal, For, Show } from 'solid-js';
import type { WorkbenchAdminOverviewV1 } from '../../contracts/index.js';
import type {
  AdminAuthorizationState,
  AdminClient,
  AdminOperationsResponseV1,
} from './admin-client';

const PANEL =
  'rounded-[var(--wb-radius-md)] border border-[var(--wb-border)] bg-[var(--wb-surface)] p-[var(--wb-space-5)] shadow-[var(--wb-shadow-panel)]';
const SECONDARY_BUTTON =
  'inline-flex min-h-[2.5rem] items-center justify-center rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-[var(--wb-surface)] px-[var(--wb-space-3)] text-sm font-semibold text-[var(--wb-ink-soft)] transition-colors hover:border-[var(--wb-accent)] hover:bg-[var(--wb-accent-wash)] disabled:cursor-not-allowed disabled:opacity-50';

export interface OperationsPageProps {
  readonly overview: WorkbenchAdminOverviewV1 | null;
  readonly client?: AdminClient;
  readonly authorization?: AdminAuthorizationState;
  readonly operations?: AdminOperationsResponseV1 | null;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string')
    return error.message;
  return 'The Host operations feed could not be read.';
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function statusClass(status: string): string {
  if (status === 'completed' || status === 'applied')
    return 'bg-[var(--wb-ready-surface)] text-[var(--wb-success)]';
  if (status === 'failed' || status === 'denied' || status === 'invalid' || status === 'conflict')
    return 'bg-[var(--wb-error-surface)] text-[var(--wb-danger)]';
  return 'bg-[var(--wb-loading-surface)] text-[var(--wb-warning)]';
}

export function OperationsPage(props: OperationsPageProps) {
  const [operations, setOperations] = createSignal<AdminOperationsResponseV1 | null>(
    props.operations ?? null,
  );
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');

  createEffect(() => {
    if (props.operations) setOperations(props.operations);
  });

  const refresh = () => {
    if (
      !props.client ||
      props.authorization === 'user' ||
      props.authorization === 'unauthorized' ||
      loading()
    )
      return;
    setLoading(true);
    setError('');
    void props.client
      .getOperations()
      .then((response) => setOperations(response))
      .catch((caught) => setError(errorMessage(caught)))
      .finally(() => setLoading(false));
  };

  return (
    <div class="grid gap-[var(--wb-space-6)]" data-testid="admin-operations-page">
      <header class="flex flex-wrap items-end justify-between gap-[var(--wb-space-4)]">
        <div class="grid gap-[var(--wb-space-2)]">
          <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
            Operations
          </p>
          <h2 class="font-display text-3xl tracking-[-0.025em] text-[var(--wb-ink)]">
            Receipts &amp; recovery
          </h2>
          <p class="max-w-3xl text-sm leading-6 text-[var(--wb-muted)]">
            Read-only, durable metadata for configuration changes and Host effects. Raw source,
            secrets, tokens, and operation output are never shown.
          </p>
        </div>
        <button
          class={SECONDARY_BUTTON}
          type="button"
          onClick={refresh}
          disabled={
            !props.client ||
            props.authorization === 'user' ||
            props.authorization === 'unauthorized' ||
            loading()
          }
        >
          {loading() ? 'Refreshing…' : 'Refresh feed'}
        </button>
      </header>

      <Show when={props.authorization === 'user' || props.authorization === 'unauthorized'}>
        <section class={`${PANEL} border-[var(--wb-error-border)]`} role="alert">
          <h3 class="text-base font-semibold text-[var(--wb-danger)]">
            Owner authorization required
          </h3>
          <p class="mt-[var(--wb-space-2)] text-sm leading-6 text-[var(--wb-ink-soft)]">
            This feed is not available to your session. No management request was sent.
          </p>
        </section>
      </Show>
      <Show when={error()}>
        <p class="text-sm text-[var(--wb-danger)]" role="alert">
          {error()}
        </p>
      </Show>

      <section class={PANEL} aria-labelledby="configuration-operations-heading">
        <div class="flex flex-wrap items-start justify-between gap-[var(--wb-space-3)]">
          <div>
            <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
              Configuration
            </p>
            <h3
              id="configuration-operations-heading"
              class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]"
            >
              Change receipts
            </h3>
          </div>
          <span class="text-xs text-[var(--wb-muted)]">latest first</span>
        </div>
        <Show
          when={(operations()?.configurationOperations.length ?? 0) > 0}
          fallback={
            <p class="mt-[var(--wb-space-4)] text-sm leading-6 text-[var(--wb-muted)]">
              No configuration operations have been recorded.
            </p>
          }
        >
          <ol class="mt-[var(--wb-space-4)] grid gap-[var(--wb-space-3)]">
            <For each={operations()?.configurationOperations ?? []}>
              {(operation) => (
                <li class="grid gap-[var(--wb-space-3)] border-t border-[var(--wb-border)] pt-[var(--wb-space-4)]">
                  <div class="flex flex-wrap items-center justify-between gap-[var(--wb-space-3)]">
                    <div class="flex flex-wrap items-center gap-[var(--wb-space-2)]">
                      <span
                        class={`rounded-full px-[var(--wb-space-2)] py-1 text-xs font-bold ${statusClass(operation.status)}`}
                      >
                        {operation.status}
                      </span>
                      <span class="text-sm font-semibold text-[var(--wb-ink)]">
                        {operation.origin}
                      </span>
                    </div>
                    <time class="text-xs text-[var(--wb-muted)]">{formatDate(operation.at)}</time>
                  </div>
                  <dl class="grid gap-[var(--wb-space-3)] text-xs sm:grid-cols-2 lg:grid-cols-4">
                    <SafeField label="Operation" value={operation.operationId} />
                    <SafeField label="Active revision" value={operation.activeRevision ?? 'none'} />
                    <SafeField
                      label="Candidate revision"
                      value={operation.candidateRevision ?? 'none'}
                    />
                    <SafeField
                      label="Changed fields"
                      value={
                        operation.changedFields.length ? operation.changedFields.join(', ') : 'none'
                      }
                    />
                  </dl>
                  <Show when={operation.diagnostics.length > 0}>
                    <ul class="grid gap-1 rounded-[var(--wb-radius-sm)] bg-[var(--wb-surface-muted)] p-[var(--wb-space-3)] text-xs text-[var(--wb-ink-soft)]">
                      <For each={operation.diagnostics}>
                        {(diagnostic) => (
                          <li>
                            <code>{diagnostic.code}</code> — {diagnostic.message}
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </section>

      <section class={PANEL} aria-labelledby="audit-heading">
        <div class="flex flex-wrap items-start justify-between gap-[var(--wb-space-3)]">
          <div>
            <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
              Provenance
            </p>
            <h3
              id="audit-heading"
              class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]"
            >
              Recent Host audit
            </h3>
          </div>
          <span class="text-xs text-[var(--wb-muted)]">safe metadata only</span>
        </div>
        <Show
          when={(operations()?.audit.length ?? 0) > 0}
          fallback={
            <p class="mt-[var(--wb-space-4)] text-sm leading-6 text-[var(--wb-muted)]">
              No audit entries have been recorded.
            </p>
          }
        >
          <ol class="mt-[var(--wb-space-4)] grid gap-[var(--wb-space-3)]">
            <For each={operations()?.audit ?? []}>
              {(entry) => (
                <li class="grid gap-2 border-t border-[var(--wb-border)] pt-[var(--wb-space-3)] text-sm">
                  <div class="flex flex-wrap items-center justify-between gap-[var(--wb-space-3)]">
                    <span class="font-semibold text-[var(--wb-ink)]">{entry.operationKind}</span>
                    <time class="text-xs text-[var(--wb-muted)]">{formatDate(entry.at)}</time>
                  </div>
                  <div class="flex flex-wrap gap-2 text-xs">
                    <span class={`rounded-full px-2 py-1 font-bold ${statusClass(entry.outcome)}`}>
                      {entry.outcome}
                    </span>
                    <span class="rounded-full bg-[var(--wb-surface-muted)] px-2 py-1 text-[var(--wb-muted)]">
                      surface: {entry.surface}
                    </span>
                    <Show when={entry.projectId}>
                      <span class="rounded-full bg-[var(--wb-surface-muted)] px-2 py-1 text-[var(--wb-muted)]">
                        project: {entry.projectId}
                      </span>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </section>
    </div>
  );
}

function SafeField(props: { readonly label: string; readonly value: string }) {
  return (
    <div class="grid gap-1">
      <dt class="font-bold uppercase tracking-[0.06em] text-[var(--wb-muted)]">{props.label}</dt>
      <dd class="break-words text-[var(--wb-ink-soft)]">{props.value}</dd>
    </div>
  );
}
