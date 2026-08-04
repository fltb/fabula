import { AlertDialog } from '@kobalte/core/alert-dialog';
import { Checkbox } from '@kobalte/core/checkbox';
import { Combobox } from '@kobalte/core/combobox';
import { For, Show, createEffect, createSignal, onMount } from 'solid-js';
import type { WorkbenchAdminOverviewV1, WorkbenchDeviceSafeViewV1, WorkbenchInviteSafeViewV1 } from '../../contracts/index.js';
import { PROJECT_ACCESS_ROLES, type ProjectAccessRole } from '../../contracts/configuration.js';
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
const SCOPES = ['mcp:read', 'mcp:render', 'mcp:author', 'mcp:submit', 'mcp:admin'] as const;
const INVITE_ROLE_OPTIONS = PROJECT_ACCESS_ROLES.map((role) => [role, role[0].toUpperCase() + role.slice(1)] as const);

type ProjectOption = { readonly projectId: string; readonly displayName: string };

export interface AccessDevicesPageProps {
  readonly overview: WorkbenchAdminOverviewV1 | null;
  readonly client?: AdminClient;
  readonly authorization?: AdminAuthorizationState;
  readonly devices?: readonly WorkbenchDeviceSafeViewV1[];
  readonly onChanged?: () => void | Promise<void>;
}

function canMutate(props: AccessDevicesPageProps): boolean {
  return props.authorization === undefined ? props.client !== undefined : props.authorization === 'owner';
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'The Host rejected the access operation.';
}

export function AccessDevicesPage(props: AccessDevicesPageProps) {
  const [devices, setDevices] = createSignal<readonly WorkbenchDeviceSafeViewV1[]>(props.devices ?? []);
  const [projectId, setProjectId] = createSignal('');
  const [inviteRole, setInviteRole] = createSignal<ProjectAccessRole>('reader');
  const [inviteTtl, setInviteTtl] = createSignal('86400000');
  const [invite, setInvite] = createSignal<WorkbenchInviteSafeViewV1 | null>(null);
  const [pairingCode, setPairingCode] = createSignal('');
  const [pairingExpiresAt, setPairingExpiresAt] = createSignal('');
  const [deviceLabel, setDeviceLabel] = createSignal('');
  const [deviceTtl, setDeviceTtl] = createSignal('2592000000');
  const [scopes, setScopes] = createSignal<readonly string[]>(['mcp:read']);
  const [credential, setCredential] = createSignal('');
  const [credentialCopied, setCredentialCopied] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const [confirmDeviceId, setConfirmDeviceId] = createSignal<string | null>(null);

  createEffect(() => {
    if (props.devices) setDevices(props.devices);
  });

  const authorized = () => canMutate(props);
  const projectOptions = () => props.overview?.setup.projects.map(({ projectId: id, displayName }) => ({ projectId: id, displayName })) ?? [];

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

  const refreshDevices = () => {
    if (!props.client || props.authorization === 'user' || props.authorization === 'unauthorized') return;
    void props.client.listDevices().then((response) => setDevices(response.devices)).catch((caught) => setError(errorMessage(caught)));
  };

  onMount(refreshDevices);

  const createInvite = () => {
    void run(async () => {
      const selectedProjectId = projectId().trim();
      if (!selectedProjectId) throw new Error('A project must be selected before creating an invite.');
      const response = await props.client?.createInvite({
        projectId: selectedProjectId,
        role: inviteRole(),
        ttlMs: Number(inviteTtl()),
      });
      if (!response) throw new Error('The owner client is unavailable.');
      setInvite(response.invite);
      setMessage('Invite created. Only the safe project, role, expiry, and consumption state are shown.');
    });
  };

  const issuePairing = () => {
    void run(async () => {
      const selectedProjectId = projectId().trim();
      if (!selectedProjectId) throw new Error('A project must be selected before issuing a device pairing.');
      const response = await props.client?.issueDevicePairing({
        kind: 'project',
        projectId: selectedProjectId,
        role: inviteRole(),
        ttlMs: Number(deviceTtl()),
      });
      if (!response) throw new Error('The owner client is unavailable.');
      setPairingCode(response.pairingCode);
      setPairingExpiresAt(response.expiresAt);
      setCredential('');
      setCredentialCopied(false);
      setMessage('Pairing code issued. Show it only to the intended device, then claim it once.');
    });
  };

  const claimDevice = () => {
    void run(async () => {
      if (!pairingCode() || !deviceLabel().trim()) throw new Error('Pairing code and device label are required.');
      const response = await props.client?.claimDevice({
        pairingCode: pairingCode(),
        label: deviceLabel().trim(),
        scopes: [...scopes()],
        ttlMs: Number(deviceTtl()),
      });
      if (!response) throw new Error('The owner client is unavailable.');
      // The code and credential are one-time browser memory only. The code is
      // cleared on claim; the credential is cleared after explicit acknowledgement.
      setPairingCode('');
      setPairingExpiresAt('');
      setCredential(response.credential);
      setDevices((current) => [...current.filter((device) => device.deviceId !== response.device.deviceId), response.device]);
      setDeviceLabel('');
      setMessage('Device paired. Save the credential now; it will not be returned again.');
    });
  };

  const copyCredential = async () => {
    if (!credential() || typeof navigator.clipboard?.writeText !== 'function') {
      setCredentialCopied(false);
      setMessage('Clipboard access is unavailable; the credential remains visible only in this page.');
      return;
    }
    try {
      await navigator.clipboard.writeText(credential());
      setCredentialCopied(true);
      setMessage('Credential copied once. Clear it after the device stores it.');
    } catch {
      setCredentialCopied(false);
      setMessage('Clipboard access was denied; nothing was copied.');
    }
  };

  const revokeDevice = (deviceId: string) => {
    setConfirmDeviceId(null);
    void run(async () => {
      const response = await props.client?.revokeDevice(deviceId);
      if (!response) throw new Error('The owner client is unavailable.');
      setDevices((current) => current.map((device) => device.deviceId === deviceId ? { ...device, revokedAt: new Date().toISOString() } : device));
      setMessage('Device revoked. Its opaque credential is no longer accepted by the Host.');
    });
  };

  return (
    <div class="grid gap-[var(--wb-space-6)]" data-testid="admin-access-devices-page">
      <header class="grid gap-[var(--wb-space-2)]">
        <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">Access &amp; Devices</p>
        <h2 class="font-display text-3xl tracking-[-0.025em] text-[var(--wb-ink)]">Invites and MCP devices</h2>
        <p class="max-w-3xl text-sm leading-6 text-[var(--wb-muted)]">
          Owner-only controls issue narrow, expiring access. Device credentials are shown exactly
          once after claim and never appear in lists, local preferences, or later reads.
        </p>
      </header>

      <Show when={props.authorization === 'user' || props.authorization === 'unauthorized'}>
        <section class={`${PANEL} border-[var(--wb-error-border)]`} role="alert">
          <h3 class="text-base font-semibold text-[var(--wb-danger)]">Owner authorization required</h3>
          <p class="mt-[var(--wb-space-2)] text-sm leading-6 text-[var(--wb-ink-soft)]">This view is read-only. No invite, pairing, claim, or revoke mutation was sent.</p>
        </section>
      </Show>

      <section class="grid gap-[var(--wb-space-6)] lg:grid-cols-2">
        <section class={PANEL} aria-labelledby="invite-heading">
          <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">Browser access</p>
          <h3 id="invite-heading" class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]">Create project invite</h3>
          <p class="mt-[var(--wb-space-2)] text-xs leading-5 text-[var(--wb-muted)]">Select a project and canonical access role. No redemption secret is returned to this page.</p>
          <form class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-4)]" onSubmit={(event) => { event.preventDefault(); createInvite(); }}>
            <Combobox<ProjectOption>
              multiple={false}
              options={projectOptions()}
              optionValue="projectId"
              optionTextValue="displayName"
              optionLabel="displayName"
              value={projectOptions().find((project) => project.projectId === projectId()) ?? null}
              onChange={(next) => setProjectId(next?.projectId ?? '')}
              placeholder="Choose a project"
              disabled={!authorized() || busy()}
              itemComponent={(itemProps) => <Combobox.Item item={itemProps.item}><Combobox.ItemLabel>{itemProps.item.rawValue.displayName}</Combobox.ItemLabel></Combobox.Item>}
            >
              <Combobox.Label class="text-xs font-bold uppercase tracking-[0.06em] text-[var(--wb-muted)]">Project scope</Combobox.Label>
              <Combobox.Control class={`${INPUT} mt-2`}><Combobox.Input required /><Combobox.Trigger aria-label="Choose invite project">⌄</Combobox.Trigger></Combobox.Control>
              <Combobox.Portal><Combobox.Content class="z-50 mt-1 rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-[var(--wb-surface)] p-[var(--wb-space-2)] shadow-[var(--wb-shadow-panel)]"><Combobox.Listbox class="grid max-h-60 gap-1 overflow-auto" /></Combobox.Content></Combobox.Portal>
            </Combobox>
            <SelectField label="Access role" value={inviteRole()} onChange={(next) => setInviteRole(next as ProjectAccessRole)} disabled={!authorized() || busy()} options={INVITE_ROLE_OPTIONS} />
            <SelectField label="Invite lifetime" value={inviteTtl()} onChange={setInviteTtl} disabled={!authorized() || busy()} options={[['3600000', '1 hour'], ['86400000', '24 hours'], ['604800000', '7 days']]} />
            <button class={BUTTON} type="submit" disabled={!authorized() || busy() || !projectId()}>{busy() ? 'Creating…' : 'Create invite'}</button>
          </form>
          <Show when={invite()}>
            {(created) => <div class="mt-[var(--wb-space-5)] rounded-[var(--wb-radius-sm)] border border-[var(--wb-ready-border)] bg-[var(--wb-ready-surface)] p-[var(--wb-space-4)]" aria-live="polite"><p class="font-semibold text-[var(--wb-success)]">Invite created</p><dl class="mt-3 grid gap-2 text-xs text-[var(--wb-ink-soft)]"><SafeField label="Invite id" value={created().inviteId} /><SafeField label="Project" value={created().projectId ?? 'unknown'} /><SafeField label="Role" value={created().role} /><SafeField label="Expires" value={created().expiresAt} /></dl></div>}
          </Show>
        </section>

        <section class={PANEL} aria-labelledby="pairing-heading">
          <p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">MCP device access</p>
          <h3 id="pairing-heading" class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]">Pair a device</h3>
          <p class="mt-[var(--wb-space-2)] text-xs leading-5 text-[var(--wb-muted)]">Issue a short-lived code, then claim it with a label and least scopes. The opaque credential is shown once.</p>
          <div class="mt-[var(--wb-space-5)] grid gap-[var(--wb-space-4)]">
            <button class={SECONDARY_BUTTON} type="button" onClick={issuePairing} disabled={!authorized() || busy()}>{busy() ? 'Working…' : 'Issue pairing code'}</button>
            <Show when={pairingCode()}>
              <div class="rounded-[var(--wb-radius-sm)] border border-[var(--wb-loading-border)] bg-[var(--wb-loading-surface)] p-[var(--wb-space-4)]"><p class="text-xs font-bold uppercase tracking-[0.06em] text-[var(--wb-warning)]">One-time pairing code</p><code class="mt-2 block break-all text-lg font-semibold text-[var(--wb-ink)]">{pairingCode()}</code><p class="mt-2 text-xs text-[var(--wb-muted)]">Expires {pairingExpiresAt()}</p></div>
            </Show>
            <Field label="Device label"><input class={INPUT} value={deviceLabel()} onInput={(event) => setDeviceLabel(event.currentTarget.value)} autocomplete="off" disabled={!authorized() || busy() || !pairingCode()} /></Field>
            <SelectField label="Credential lifetime" value={deviceTtl()} onChange={setDeviceTtl} disabled={!authorized() || busy() || !pairingCode()} options={[['86400000', '24 hours'], ['2592000000', '30 days'], ['7776000000', '90 days']]} />
            <fieldset class="grid gap-[var(--wb-space-2)]" disabled={!authorized() || busy() || !pairingCode()}><legend class="text-xs font-bold uppercase tracking-[0.06em] text-[var(--wb-muted)]">Scopes</legend><For each={SCOPES}>{(scope) => <Checkbox checked={scopes().includes(scope)} onChange={(checked) => setScopes((current) => checked ? [...new Set([...current, scope])] : current.filter((value) => value !== scope))} class="flex items-center gap-2"><Checkbox.Input /><Checkbox.Control class="grid h-5 w-5 place-items-center rounded border border-[var(--wb-border-strong)] bg-[var(--wb-surface)] data-[checked]:border-[var(--wb-accent)] data-[checked]:bg-[var(--wb-accent-wash)]"><Checkbox.Indicator class="text-sm text-[var(--wb-accent-deep)]">✓</Checkbox.Indicator></Checkbox.Control><Checkbox.Label class="text-sm text-[var(--wb-ink-soft)]">{scope}</Checkbox.Label></Checkbox>}</For></fieldset>
            <button class={BUTTON} type="button" onClick={claimDevice} disabled={!authorized() || busy() || !pairingCode() || !deviceLabel().trim()}>Claim device</button>
            <Show when={credential()}>
              <div class="rounded-[var(--wb-radius-sm)] border border-[var(--wb-error-border)] bg-[var(--wb-error-surface)] p-[var(--wb-space-4)]" aria-live="assertive"><p class="text-xs font-bold uppercase tracking-[0.06em] text-[var(--wb-danger)]">Save this credential now — shown once</p><code class="mt-2 block max-h-28 overflow-auto break-all text-sm text-[var(--wb-ink)]">{credential()}</code><div class="mt-3 flex flex-wrap gap-2"><button class={SECONDARY_BUTTON} type="button" onClick={() => void copyCredential()}>{credentialCopied() ? 'Copied' : 'Copy once'}</button><button class={DANGER_BUTTON} type="button" onClick={() => setCredential('')}>Clear credential</button></div></div>
            </Show>
          </div>
        </section>
      </section>

      <section class={PANEL} aria-labelledby="device-list-heading">
        <div class="flex flex-wrap items-end justify-between gap-[var(--wb-space-3)]"><div><p class="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">Safe device registry</p><h3 id="device-list-heading" class="mt-[var(--wb-space-1)] text-lg font-semibold text-[var(--wb-ink)]">Paired MCP devices</h3></div><button class={SECONDARY_BUTTON} type="button" onClick={refreshDevices} disabled={!props.client || props.authorization === 'user' || props.authorization === 'unauthorized'}>Refresh list</button></div>
        <Show when={devices().length > 0} fallback={<p class="mt-[var(--wb-space-4)] text-sm leading-6 text-[var(--wb-muted)]">No devices are paired. Device credentials never appear in this list.</p>}>
          <ul class="mt-[var(--wb-space-4)] grid gap-[var(--wb-space-3)]"><For each={devices()}>{(device) => <li class={`${PANEL} flex flex-wrap items-center justify-between gap-[var(--wb-space-4)]`}><div class="grid gap-1"><span class="font-semibold text-[var(--wb-ink)]">MCP device</span><span class="text-xs text-[var(--wb-muted)]">{device.deviceId} · {device.scopes.join(', ')} · expires {device.expiresAt}</span><Show when={device.revokedAt}><span class="text-xs font-semibold text-[var(--wb-danger)]">Revoked {device.revokedAt}</span></Show></div><button class={DANGER_BUTTON} type="button" onClick={() => setConfirmDeviceId(device.deviceId)} disabled={!authorized() || busy() || device.revokedAt !== null}>Revoke device</button></li>}</For></ul>
        </Show>
      </section>

      <Show when={message()}><p class="text-sm text-[var(--wb-success)]" aria-live="polite">{message()}</p></Show>
      <Show when={error()}><p class="text-sm text-[var(--wb-danger)]" role="alert">{error()}</p></Show>

      <AlertDialog open={confirmDeviceId() !== null} onOpenChange={(open) => { if (!open) setConfirmDeviceId(null); }}>
        <AlertDialog.Portal><AlertDialog.Overlay class="fixed inset-0 z-40 bg-[var(--wb-overlay)]" /><AlertDialog.Content class="fixed left-1/2 top-1/2 z-50 grid w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-[var(--wb-space-4)] rounded-[var(--wb-radius-lg)] border border-[var(--wb-border-strong)] bg-[var(--wb-surface)] p-[var(--wb-space-6)] shadow-[var(--wb-shadow-drawer)]"><AlertDialog.Title class="font-display text-xl text-[var(--wb-ink)]">Revoke this MCP device?</AlertDialog.Title><AlertDialog.Description class="text-sm leading-6 text-[var(--wb-muted)]">The Host will reject this device credential immediately. Other devices and project source remain unchanged.</AlertDialog.Description><div class="flex justify-end gap-[var(--wb-space-3)]"><AlertDialog.CloseButton class={SECONDARY_BUTTON}>Cancel</AlertDialog.CloseButton><button class={DANGER_BUTTON} type="button" onClick={() => { const id = confirmDeviceId(); if (id) revokeDevice(id); }}>Revoke device</button></div></AlertDialog.Content></AlertDialog.Portal>
      </AlertDialog>
    </div>
  );
}

function Field(props: { readonly label: string; readonly children: import('solid-js').JSX.Element }) {
  return <label class="grid gap-[var(--wb-space-2)] text-sm font-semibold text-[var(--wb-ink-soft)]"><span>{props.label}</span>{props.children}</label>;
}

function SelectField(props: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly disabled: boolean; readonly options: readonly (readonly [string, string])[] }) {
  return <label class="grid gap-[var(--wb-space-2)] text-sm font-semibold text-[var(--wb-ink-soft)]"><span>{props.label}</span><select class={INPUT} value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)} disabled={props.disabled}>{props.options.map(([value, label]) => <option value={value}>{label}</option>)}</select></label>;
}

function SafeField(props: { readonly label: string; readonly value: string }) {
  return <div class="grid gap-1"><dt class="text-xs font-bold uppercase tracking-[0.06em] text-[var(--wb-muted)]">{props.label}</dt><dd class="break-words text-sm font-semibold text-[var(--wb-ink-soft)]">{props.value}</dd></div>;
}
