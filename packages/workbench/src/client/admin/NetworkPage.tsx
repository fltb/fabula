import { Show, createEffect, createSignal } from 'solid-js';
import type { WorkbenchAdminOverviewV1, WorkbenchNetworkReadViewV1 } from '../../contracts/index.js';
import type { AdminAuthorizationState, AdminClient } from './admin-client';

const PANEL =
  'rounded-[var(--wb-radius-md)] border border-[var(--wb-border)] bg-[var(--wb-surface)] p-[var(--wb-space-5)] shadow-[var(--wb-shadow-panel)]';
const INPUT =
  'min-h-[2.75rem] w-full rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-[var(--wb-surface)] px-[var(--wb-space-3)] text-sm text-[var(--wb-ink)] outline-none transition-colors placeholder:text-[var(--wb-muted)] focus:border-[var(--wb-focus)] focus:ring-2 focus:ring-[var(--wb-focus)] disabled:cursor-not-allowed disabled:bg-[var(--wb-surface-muted)]';
const BUTTON =
  'inline-flex min-h-[2.5rem] items-center justify-center rounded-[var(--wb-radius-sm)] border border-[var(--wb-border-strong)] bg-[var(--wb-ink)] px-[var(--wb-space-4)] text-sm font-semibold text-[var(--wb-on-ink)] transition-colors hover:bg-[var(--wb-accent-deep)] disabled:cursor-not-allowed disabled:opacity-50';

export interface NetworkPageProps {
  readonly overview: WorkbenchAdminOverviewV1 | null;
  readonly client?: AdminClient;
  readonly authorization?: AdminAuthorizationState;
  readonly onChanged?: () => void | Promise<void>;
}

function canMutate(props: NetworkPageProps): boolean {
  return props.authorization === undefined ? props.client !== undefined : props.authorization === 'owner';
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'The Host rejected the network policy.';
}

export function NetworkPage(props: NetworkPageProps) {
  const [network, setNetwork] = createSignal<WorkbenchNetworkReadViewV1 | null>(null);
  const [mode, setMode] = createSignal<WorkbenchNetworkReadViewV1['mode']>('loopback');
  const [port, setPort] = createSignal('8787');
  const [allowedHosts, setAllowedHosts] = createSignal('');
  const [allowedOrigins, setAllowedOrigins] = createSignal('');
  const [unixSocketName, setUnixSocketName] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');

  createEffect(() => {
    const next = props.overview?.setup.network;
    if (next) {
      setNetwork(next);
      setMode(next.mode);
      setPort(String(next.port));
      setAllowedHosts(next.allowedHosts.join('\n'));
      setAllowedOrigins(next.allowedOrigins.join('\n'));
    }
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

  const saveNetwork = () => {
    void run(async () => {
      const numericPort = Number(port());
      if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
        throw new Error('Port must be an integer between 1 and 65535.');
      }
      const response = await props.client?.updateNetwork({
        mode: mode(),
        port: numericPort,
        allowedHosts: splitLines(allowedHosts()),
        allowedOrigins: splitLines(allowedOrigins()),
        unixSocketName: mode() === 'unix' ? unixSocketName().trim() || null : null,
      });
      if (!response) throw new Error('The owner client is unavailable.');
      setNetwork(response.network);
      setMessage(`Network policy staged; ${response.receipt.status}. A controlled restart is required before the listener changes.`);
    });
  };

  const displayedNetwork = () => network() ?? props.overview?.setup.network ?? null;

  return (
    <div class="grid gap-[var(--wb-space-6)]" data-testid="admin-network-page">
      <header class="grid gap-[var(--wb-space-2)]">
        <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">Network</p>
        <h2 class="font-display text-3xl tracking-[-0.025em] text-[var(--wb-ink)]">Listener policy</h2>
        <p class="max-w-3xl text-sm leading-6 text-[var(--wb-muted)]">
          Network changes are configuration candidates, not live listener switches. Every successful
          save reports restart-required; this page never claims a bind policy changed in place.
        </p>
      </header>

      <Show when={props.authorization === 'user' || props.authorization === 'unauthorized'}>
        <section class={`${PANEL} border-[var(--wb-error-border)]`} role="alert"><h3 class="text-base font-semibold text-[var(--wb-danger)]">Owner authorization required</h3><p class="mt-[var(--wb-space-2)] text-sm leading-6 text-[var(--wb-ink-soft)]">This view is read-only. No network mutation was sent.</p></section>
      </Show>

      <Show when={displayedNetwork()} fallback={<section class={PANEL}><h3 class="text-base font-semibold text-[var(--wb-ink)]">Network status is not loaded</h3><p class="mt-[var(--wb-space-2)] text-sm leading-6 text-[var(--wb-muted)]">An authenticated owner overview is required before listener policy can be displayed.</p></section>}>
        {(current) => (
          <section class={`${PANEL} border-[var(--wb-loading-border)]`} aria-labelledby="network-status-heading">
            <div class="flex flex-wrap items-start justify-between gap-[var(--wb-space-3)]"><div><p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">Active listener</p><h3 id="network-status-heading" class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]">Current Host policy</h3></div><span class="rounded-full bg-[var(--wb-loading-surface)] px-[var(--wb-space-3)] py-[var(--wb-space-2)] text-xs font-bold text-[var(--wb-warning)]">{current().restartRequired ? 'restart-required' : current().listenerActive ? 'active' : 'staged'}</span></div>
            <dl class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-4)] sm:grid-cols-2 lg:grid-cols-4"><SafeField label="Mode" value={current().mode} /><SafeField label="Port" value={String(current().port)} /><SafeField label="Unix socket" value={current().unixSocket ? 'configured (path hidden)' : 'not configured'} /><SafeField label="Listener" value={current().listenerActive ? 'active policy' : 'restart required'} /></dl>
            <p class="mt-[var(--wb-space-4)] text-sm font-semibold text-[var(--wb-warning)]">Saving below stages a policy and requires a controlled restart. It does not change the listener now.</p>
          </section>
        )}
      </Show>

      <section class={PANEL} aria-labelledby="network-form-heading">
        <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">Candidate policy</p>
        <h3 id="network-form-heading" class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]">Edit allowed listener settings</h3>
        <form class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-4)]" onSubmit={(event) => { event.preventDefault(); saveNetwork(); }}>
          <div class="grid gap-[var(--wb-space-4)] md:grid-cols-2">
            <Field label="Mode"><select class={INPUT} value={mode()} onChange={(event) => setMode(event.currentTarget.value as WorkbenchNetworkReadViewV1['mode'])} disabled={!authorized() || busy()}><option value="loopback">Loopback (local only)</option><option value="lan">LAN (trusted network)</option><option value="unix">Unix socket</option></select></Field>
            <Field label="Port"><input class={INPUT} inputmode="numeric" value={port()} onInput={(event) => setPort(event.currentTarget.value)} disabled={!authorized() || busy() || mode() === 'unix'} /></Field>
          </div>
          <Show when={mode() === 'unix'}><Field label="Unix socket name" hint="Name only; the Host resolves the private path."><input class={INPUT} value={unixSocketName()} onInput={(event) => setUnixSocketName(event.currentTarget.value)} autocomplete="off" disabled={!authorized() || busy()} /></Field></Show>
          <div class="grid gap-[var(--wb-space-4)] md:grid-cols-2"><Field label="Allowed hosts" hint="One host per line; leave empty for the Host default."><textarea class={`${INPUT} min-h-32 py-[var(--wb-space-3)]`} value={allowedHosts()} onInput={(event) => setAllowedHosts(event.currentTarget.value)} disabled={!authorized() || busy()} /></Field><Field label="Allowed origins" hint="One origin per line; leave empty for the Host default."><textarea class={`${INPUT} min-h-32 py-[var(--wb-space-3)]`} value={allowedOrigins()} onInput={(event) => setAllowedOrigins(event.currentTarget.value)} disabled={!authorized() || busy()} /></Field></div>
          <button class={BUTTON} type="submit" disabled={!authorized() || busy()}>{busy() ? 'Staging…' : 'Save network candidate'}</button>
        </form>
      </section>

      <Show when={message()}><p class="text-sm text-[var(--wb-warning)]" aria-live="polite">{message()}</p></Show>
      <Show when={error()}><p class="text-sm text-[var(--wb-danger)]" role="alert">{error()}</p></Show>
    </div>
  );
}

function splitLines(value: string): string[] {
  return value.split('\n').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function Field(props: { readonly label: string; readonly hint?: string; readonly children: import('solid-js').JSX.Element }) {
  return <label class="grid gap-[var(--wb-space-2)] text-sm font-semibold text-[var(--wb-ink-soft)]"><span>{props.label}</span><Show when={props.hint}><span class="text-xs font-normal leading-5 text-[var(--wb-muted)]">{props.hint}</span></Show>{props.children}</label>;
}

function SafeField(props: { readonly label: string; readonly value: string }) {
  return <div class="grid gap-1"><dt class="text-xs font-bold uppercase tracking-[0.06em] text-[var(--wb-muted)]">{props.label}</dt><dd class="break-words text-sm font-semibold text-[var(--wb-ink-soft)]">{props.value}</dd></div>;
}
