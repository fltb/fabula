import { AlertDialog } from '@kobalte/core/alert-dialog';
import { Show, createEffect, createSignal } from 'solid-js';
import type { WorkbenchAdminOverviewV1, WorkbenchProviderReadViewV1 } from '../../contracts/index.js';
import type { AdminAuthorizationState, AdminClient } from './admin-client';

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
  return props.authorization === undefined ? props.client !== undefined : props.authorization === 'owner';
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return 'The Host rejected the provider operation.';
}

export function ProviderPage(props: ProviderPageProps) {
  const [provider, setProvider] = createSignal<WorkbenchProviderReadViewV1 | null>(null);
  const [baseUrl, setBaseUrl] = createSignal('');
  const [model, setModel] = createSignal('');
  const [apiKey, setApiKey] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const [confirmClear, setConfirmClear] = createSignal(false);

  createEffect(() => {
    const next = props.overview?.setup.provider;
    if (next !== undefined) setProvider(next);
  });

  const authorized = () => canMutate(props);
  const run = async (operation: () => Promise<void>) => {
    if (!authorized() || busy()) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await operation();
      await props.onChanged?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const updateProvider = () => {
    void run(async () => {
      const response = await props.client?.updateProvider({
        kind: 'ai-sdk',
        baseUrl: baseUrl().trim() || null,
        model: model().trim() || null,
      });
      if (!response) throw new Error('The owner client is unavailable.');
      setProvider(response.provider);
      setBaseUrl('');
      setModel('');
      setMessage(`Provider settings updated; ${response.receipt.status}.`);
    });
  };

  const saveCredential = () => {
    void run(async () => {
      const secret = apiKey();
      if (!secret) throw new Error('Enter a provider credential before saving.');
      const request = props.client?.setProviderCredential(secret);
      // Clear the one-way secret before awaiting the Host response; retries
      // require deliberate re-entry and it never remains in UI state.
      setApiKey('');
      const response = await request;
      if (!response) throw new Error('The owner client is unavailable.');
      setProvider((current) => current ? { ...current, configured: response.configured } : current);
      setMessage('Credential stored by the Host. It is not displayed or retained by this browser.');
    });
  };

  const testProvider = () => {
    void run(async () => {
      const response = await props.client?.testProvider();
      if (!response) throw new Error('The owner client is unavailable.');
      setProvider((current) => current ? { ...current, lastValidation: response.validation, lastValidatedAt: response.lastValidatedAt } : current);
      setMessage(response.validation === 'valid' ? 'Provider validation succeeded.' : `Provider validation failed: ${response.code ?? 'PROVIDER_VALIDATION_FAILED'}.`);
    });
  };

  const clearCredential = () => {
    setConfirmClear(false);
    void run(async () => {
      const response = await props.client?.clearProviderCredential();
      if (!response) throw new Error('The owner client is unavailable.');
      setProvider((current) => current ? { ...current, configured: response.configured, lastValidation: 'unvalidated' } : current);
      setMessage('The Host removed the provider credential.');
    });
  };

  return (
    <div class="grid gap-[var(--wb-space-6)]" data-testid="admin-provider-page">
      <header class="grid gap-[var(--wb-space-2)]">
        <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">Provider</p>
        <h2 class="font-display text-3xl tracking-[-0.025em] text-[var(--wb-ink)]">Model readiness</h2>
        <p class="max-w-3xl text-sm leading-6 text-[var(--wb-muted)]">
          Endpoint and model values are returned masked by the Host. API credentials are one-way
          inputs: this browser never displays, persists, or receives them back.
        </p>
      </header>

      <Show when={props.authorization === 'user' || props.authorization === 'unauthorized'}>
        <section class={`${PANEL} border-[var(--wb-error-border)]`} role="alert">
          <h3 class="text-base font-semibold text-[var(--wb-danger)]">Owner authorization required</h3>
          <p class="mt-[var(--wb-space-2)] text-sm leading-6 text-[var(--wb-ink-soft)]">This view is read-only. No provider mutation was sent.</p>
        </section>
      </Show>

      <Show when={provider()} fallback={<section class={PANEL}><h3 class="text-base font-semibold text-[var(--wb-ink)]">Provider is not configured</h3><p class="mt-[var(--wb-space-2)] text-sm leading-6 text-[var(--wb-muted)]">Save endpoint/model settings to begin provider setup.</p></section>}>
        {(current) => (
          <section class={PANEL} aria-labelledby="provider-status-heading">
            <div class="flex flex-wrap items-start justify-between gap-[var(--wb-space-3)]">
              <div>
                <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">Safe read view</p>
                <h3 id="provider-status-heading" class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]">AI SDK provider</h3>
              </div>
              <span class={`rounded-full px-[var(--wb-space-3)] py-[var(--wb-space-2)] text-xs font-bold ${current().configured ? 'bg-[var(--wb-ready-surface)] text-[var(--wb-success)]' : 'bg-[var(--wb-loading-surface)] text-[var(--wb-warning)]'}`}>
                {current().configured ? 'credential configured' : 'credential not configured'}
              </span>
            </div>
            <dl class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-4)] sm:grid-cols-2 lg:grid-cols-4">
              <SafeField label="Endpoint" value={current().endpoint ?? 'Not set'} />
              <SafeField label="Model" value={current().model ?? 'Not set'} />
              <SafeField label="Last validation" value={current().lastValidation} />
              <SafeField label="Validated at" value={current().lastValidatedAt ?? 'Not recorded'} />
            </dl>
          </section>
        )}
      </Show>

      <section class="grid gap-[var(--wb-space-6)] lg:grid-cols-2">
        <section class={PANEL} aria-labelledby="provider-settings-heading">
          <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">Configuration</p>
          <h3 id="provider-settings-heading" class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]">Set endpoint or model</h3>
          <p class="mt-[var(--wb-space-2)] text-xs leading-5 text-[var(--wb-muted)]">Leave a field blank to unset it. The masked read value above is never copied into an editable field.</p>
          <form class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-4)]" onSubmit={(event) => { event.preventDefault(); updateProvider(); }}>
            <Field label="New base URL"><input class={INPUT} value={baseUrl()} onInput={(event) => setBaseUrl(event.currentTarget.value)} autocomplete="off" disabled={!authorized() || busy()} /></Field>
            <Field label="New model"><input class={INPUT} value={model()} onInput={(event) => setModel(event.currentTarget.value)} autocomplete="off" disabled={!authorized() || busy()} /></Field>
            <button class={BUTTON} type="submit" disabled={!authorized() || busy()}>{busy() ? 'Saving…' : 'Save provider settings'}</button>
          </form>
        </section>

        <section class={PANEL} aria-labelledby="provider-credential-heading">
          <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">Credential</p>
          <h3 id="provider-credential-heading" class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]">Store provider credential</h3>
          <p class="mt-[var(--wb-space-2)] text-xs leading-5 text-[var(--wb-muted)]">The input is sent once to the Host credential store, then cleared from this component. It is never included in YAML, operations, or preferences.</p>
          <form class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-4)]" onSubmit={(event) => { event.preventDefault(); saveCredential(); }}>
            <Field label="Provider API key"><input class={INPUT} type="password" value={apiKey()} onInput={(event) => setApiKey(event.currentTarget.value)} autocomplete="new-password" disabled={!authorized() || busy()} /></Field>
            <div class="flex flex-wrap gap-[var(--wb-space-3)]">
              <button class={BUTTON} type="submit" disabled={!authorized() || busy() || !apiKey()}>{busy() ? 'Storing…' : 'Store credential'}</button>
              <button class={SECONDARY_BUTTON} type="button" onClick={testProvider} disabled={!authorized() || busy()}>Test stored credential</button>
              <button class={DANGER_BUTTON} type="button" onClick={() => setConfirmClear(true)} disabled={!authorized() || busy() || !provider()?.configured}>Clear credential</button>
            </div>
          </form>
        </section>
      </section>

      <Show when={message()}><p class="text-sm text-[var(--wb-success)]" aria-live="polite">{message()}</p></Show>
      <Show when={error()}><p class="text-sm text-[var(--wb-danger)]" role="alert">{error()}</p></Show>

      <AlertDialog open={confirmClear()} onOpenChange={setConfirmClear}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="fixed inset-0 z-40 bg-[var(--wb-overlay)]" />
          <AlertDialog.Content class="fixed left-1/2 top-1/2 z-50 grid w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-[var(--wb-space-4)] rounded-[var(--wb-radius-lg)] border border-[var(--wb-border-strong)] bg-[var(--wb-surface)] p-[var(--wb-space-6)] shadow-[var(--wb-shadow-drawer)]">
            <AlertDialog.Title class="font-display text-xl text-[var(--wb-ink)]">Clear stored provider credential?</AlertDialog.Title>
            <AlertDialog.Description class="text-sm leading-6 text-[var(--wb-muted)]">Agent/provider actions will remain unavailable until a new credential is stored. The Host will not delete any project source.</AlertDialog.Description>
            <div class="flex justify-end gap-[var(--wb-space-3)]">
              <AlertDialog.CloseButton class={SECONDARY_BUTTON}>Cancel</AlertDialog.CloseButton>
              <button class={DANGER_BUTTON} type="button" onClick={clearCredential}>Clear credential</button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog>
    </div>
  );
}

function Field(props: { readonly label: string; readonly children: import('solid-js').JSX.Element }) {
  return <label class="grid gap-[var(--wb-space-2)] text-sm font-semibold text-[var(--wb-ink-soft)]"><span>{props.label}</span>{props.children}</label>;
}

function SafeField(props: { readonly label: string; readonly value: string }) {
  return <div class="grid gap-[var(--wb-space-1)]"><dt class="text-xs font-bold uppercase tracking-[0.06em] text-[var(--wb-muted)]">{props.label}</dt><dd class="break-words text-sm font-semibold text-[var(--wb-ink-soft)]">{props.value}</dd></div>;
}
