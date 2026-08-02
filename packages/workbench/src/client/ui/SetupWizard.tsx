import { Dialog } from '@kobalte/core/dialog';
import type { JSX } from 'solid-js';
import { createSignal, For, onMount, Show, Switch, Match } from 'solid-js';
import type { ConfigOperationReceiptV1, WorkbenchSetupStatusV1 } from '../../contracts/index.js';
import {
  isSetupApiError,
  type SetupClient,
  type SetupFinishResult,
  type SetupNetworkInput,
  type SetupProviderInput,
  type SetupProjectInput,
  type SetupField,
} from '../setup-client.js';
import type { RuntimeState } from '../runtime-client.js';
import { FIELD, PANEL, PRIMARY_BUTTON, QUIET_BUTTON, RuntimeStatePanel } from './RuntimeStates.js';

export type SetupStep = 'owner' | 'project' | 'source-validation' | 'provider' | 'network' | 'review';

export const SETUP_STEPS: readonly { readonly id: SetupStep; readonly label: string }[] = [
  { id: 'owner', label: 'Owner' },
  { id: 'project', label: 'Project' },
  { id: 'source-validation', label: 'Source validation' },
  { id: 'provider', label: 'Provider' },
  { id: 'network', label: 'Network' },
  { id: 'review', label: 'Review & apply' },
];

export interface SetupWizardProps {
  readonly client: SetupClient;
  readonly initialStatus?: WorkbenchSetupStatusV1 | null;
  readonly onOwnerCreated?: (sessionId: string) => void;
  readonly onComplete?: (receipt: ConfigOperationReceiptV1) => void;
  readonly onStateChange?: (state: RuntimeState) => void;
  readonly onAlreadyConfigured?: () => void;
}

export interface SetupFieldErrors {
  displayName?: string;
  ownerPassword?: string;
  projectId?: string;
  projectDisplayName?: string;
  projectRoot?: string;
  providerBaseUrl?: string;
  providerModel?: string;
  providerApiKey?: string;
  networkPort?: string;
  unixSocketName?: string;
  allowedHosts?: string;
  allowedOrigins?: string;
}

function trim(value: string): string {
  return value.trim();
}

export function validateOwnerFields(displayName: string, password: string): SetupFieldErrors {
  const errors: SetupFieldErrors = {};
  if (trim(displayName).length === 0) errors.displayName = 'Enter a display name.';
  else if (trim(displayName).length > 80) errors.displayName = 'Use 80 characters or fewer.';
  if (password.length < 12) errors.ownerPassword = 'Use at least 12 characters.';
  return errors;
}

export function validateProjectFields(
  projectId: string,
  displayName: string,
  root: string,
): SetupFieldErrors {
  const errors: SetupFieldErrors = {};
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(trim(projectId))) {
    errors.projectId = 'Use 1–64 letters, numbers, hyphens, or underscores.';
  }
  if (trim(displayName).length === 0) errors.projectDisplayName = 'Enter a project name.';
  else if (trim(displayName).length > 120) errors.projectDisplayName = 'Use 120 characters or fewer.';
  const candidate = trim(root);
  if (candidate.length === 0) errors.projectRoot = 'Enter the project path on the Host.';
  else if (!(candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate))) {
    errors.projectRoot = 'Use an absolute path on the Host.';
  }
  return errors;
}

export function validateProviderFields(
  baseUrl: string,
  model: string,
  apiKey: string,
): SetupFieldErrors {
  const errors: SetupFieldErrors = {};
  const endpoint = trim(baseUrl);
  if (endpoint.length === 0) errors.providerBaseUrl = 'Enter the provider endpoint.';
  else {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    } catch {
      errors.providerBaseUrl = 'Use an http(s) provider endpoint.';
    }
  }
  if (trim(model).length === 0) errors.providerModel = 'Enter a model name.';
  if (apiKey.length === 0) errors.providerApiKey = 'Enter the provider credential.';
  return errors;
}
export function validateNetworkFields(
  mode: SetupNetworkInput['mode'],
  port: string,
  unixSocketName = '',
): SetupFieldErrors {
  const errors: SetupFieldErrors = {};
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    errors.networkPort = 'Use a port from 0 to 65535.';
  }
  if (mode !== 'loopback' && mode !== 'lan' && mode !== 'unix') {
    errors.networkPort = 'Choose a supported listener mode.';
  }
  if (mode === 'unix' && !/^[A-Za-z0-9._-]{1,128}$/.test(trim(unixSocketName))) {
    errors.unixSocketName = 'Use a simple Unix socket name.';
  }
  return errors;
}

function initialStep(status: WorkbenchSetupStatusV1 | null | undefined): SetupStep {
  if (!status || !status.ownerCreated) return 'owner';
  if (status.projects.length === 0) return 'project';
  if (status.phase === 'provider-pending') return 'provider';
  if (status.phase === 'network-pending') return 'network';
  if (status.phase === 'ready') return 'review';
  return 'source-validation';
}

function safeFailureMessage(error: unknown): string {
  if (isSetupApiError(error)) {
    switch (error.code) {
      case 'PROJECT_INVALID_ROOT':
        return 'The Host could not validate this project.';
      case 'PROJECT_DUPLICATE_ID':
        return 'Choose a different project identifier.';
      case 'PROJECT_NOT_ACCESSIBLE':
        return 'The Host cannot access this project.';
      case 'PROVIDER_VALIDATION_FAILED':
        return 'The provider could not be validated.';
      case 'CREDENTIAL_INVALID':
        return 'The provider credential could not be stored.';
      case 'NETWORK_INVALID':
        return 'Review the listener settings.';
      case 'CONFIG_STALE':
        return 'Setup changed elsewhere. Refresh and review it again.';
      default:
        return 'The Host could not complete this setup step.';
    }
  }
  return 'The Host could not complete this setup step.';
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function stepIndex(step: SetupStep): number {
  return SETUP_STEPS.findIndex((candidate) => candidate.id === step);
}

function fieldError(errors: SetupFieldErrors, key: keyof SetupFieldErrors): string | undefined {
  return errors[key];
}

export function SetupWizard(props: SetupWizardProps): JSX.Element {
  const [status, setStatus] = createSignal<WorkbenchSetupStatusV1 | null>(props.initialStatus ?? null);
  const [statusLoading, setStatusLoading] = createSignal(props.initialStatus === undefined);
  const [step, setStep] = createSignal<SetupStep>(initialStep(props.initialStatus));
  const [pending, setPending] = createSignal(false);
  const [errors, setErrors] = createSignal<SetupFieldErrors>({});
  const [serverError, setServerError] = createSignal<{ readonly field: SetupField; readonly message: string } | null>(null);
  const [receipt, setReceipt] = createSignal<ConfigOperationReceiptV1 | null>(null);

  const [confirmOpen, setConfirmOpen] = createSignal(false);
  // Secrets and the absolute root are local signals only. They are cleared as
  // soon as their one-way Host request completes, including rejected requests.
  const [ownerDisplayName, setOwnerDisplayName] = createSignal('Owner');
  const [ownerPassword, setOwnerPassword] = createSignal('');
  const [projectId, setProjectId] = createSignal('');
  const [projectDisplayName, setProjectDisplayName] = createSignal('');
  const [projectRoot, setProjectRoot] = createSignal('');
  const [providerBaseUrl, setProviderBaseUrl] = createSignal('');
  const [providerModel, setProviderModel] = createSignal('');
  const [providerApiKey, setProviderApiKey] = createSignal('');
  const [networkMode, setNetworkMode] = createSignal<SetupNetworkInput['mode']>('loopback');
  const [networkPort, setNetworkPort] = createSignal('8787');
  const [unixSocketName, setUnixSocketName] = createSignal('');
  const [allowedHosts, setAllowedHosts] = createSignal('');
  const [allowedOrigins, setAllowedOrigins] = createSignal('');
  let validatedProject: SetupProjectInput | null = null;

  onMount(() => {
    if (props.initialStatus !== undefined) return;
    void (async () => {
      setStatusLoading(true);
      try {
        const next = await props.client.getStatus();
        setStatus(next);
        setStep(initialStep(next));
        if (next.configurationPresent && next.phase === 'ready') props.onAlreadyConfigured?.();
      } catch (error) {
        if (isSetupApiError(error) && error.code === 'SETUP_ALREADY_CONFIGURED') {
          props.onAlreadyConfigured?.();
        } else {
          setServerError({ field: 'host', message: safeFailureMessage(error) });
          props.onStateChange?.('fatal-host-error');
        }
      } finally {
        setStatusLoading(false);
      }
    })();
  });

  const clearErrors = () => {
    setErrors({});
    setServerError(null);
  };

  const fail = (field: SetupField, error: unknown) => {
    setServerError({ field, message: safeFailureMessage(error) });
    if (isSetupApiError(error) && error.field === field) return;
    if (field === 'host') props.onStateChange?.('fatal-host-error');
  };

  const projectInput = (): SetupProjectInput => ({
    projectId: trim(projectId()),
    displayName: trim(projectDisplayName()),
    root: projectRoot(),
  });

  const providerInput = (): SetupProviderInput => ({
    kind: 'ai-sdk',
    baseUrl: trim(providerBaseUrl()) || null,
    model: trim(providerModel()) || null,
  });

  const runOwner = async (): Promise<void> => {
    clearErrors();
    const local = validateOwnerFields(ownerDisplayName(), ownerPassword());
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    setPending(true);
    try {
      const result = await props.client.createOwner({
        displayName: trim(ownerDisplayName()),
        password: ownerPassword(),
      });
      props.onOwnerCreated?.(result.sessionId);
      setOwnerPassword('');
      setStep('project');
    } catch (error) {
      setOwnerPassword('');
      fail('owner', error);
    } finally {
      setPending(false);
    }
  };

  const runProjectValidation = async (): Promise<void> => {
    clearErrors();
    const input = projectInput();
    const local = validateProjectFields(input.projectId, input.displayName, input.root);
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    validatedProject = input;
    // Keep the one-way path only in a non-rendered handoff until source save.
    setProjectRoot('');
    setPending(true);
    try {
      await props.client.validateProject(input);
      setStep('source-validation');
    } catch (error) {
      validatedProject = null;
      // The error is rendered below this step only; no Host message/body is
      // interpolated, so an invalid root cannot appear in the browser.
      fail('project', error);
    } finally {
      setPending(false);
    }
  };

  const runSourceValidation = async (): Promise<void> => {
    clearErrors();
    const input = validatedProject ?? projectInput();
    if (input.root.length === 0) {
      setErrors({ projectRoot: 'Enter the project path again to continue.' });
      setStep('project');
      return;
    }
    setPending(true);
    try {
      await props.client.saveProject(input);
      validatedProject = null;
      setProjectRoot('');
      setStep('provider');
    } catch (error) {
      validatedProject = null;
      setProjectRoot('');
      fail('source', error);
    } finally {
      setPending(false);
    }
  };

  const runProvider = async (): Promise<void> => {
    clearErrors();
    const local = validateProviderFields(providerBaseUrl(), providerModel(), providerApiKey());
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    setPending(true);
    try {
      await props.client.validateProvider(providerInput());
      await props.client.saveCredential({ providerId: 'ai-sdk', apiKey: providerApiKey() });
      setProviderApiKey('');
      setStep('network');
    } catch (error) {
      setProviderApiKey('');
      fail('provider', error);
    } finally {
      setPending(false);
    }
  };

  const runNetwork = async (): Promise<void> => {
    clearErrors();
    const local = validateNetworkFields(networkMode(), networkPort(), unixSocketName());
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    setPending(true);
    try {
      await props.client.applyNetwork({
        mode: networkMode(),
        port: Number(networkPort()),
        allowedHosts: parseList(allowedHosts()),
        allowedOrigins: parseList(allowedOrigins()),
        unixSocketName: networkMode() === 'unix' ? trim(unixSocketName()) : null,
      });
      setStep('review');
    } catch (error) {
      fail('network', error);
    } finally {
      setPending(false);
    }
  };

  const runFinish = async (): Promise<void> => {
    clearErrors();
    setPending(true);
    try {
      const result: SetupFinishResult = await props.client.finish(status()?.configurationRevision ?? null);
      setReceipt(result.receipt);
      setConfirmOpen(false);
      props.onComplete?.(result.receipt);
      if (result.receipt.status === 'restart-required') {
        props.onStateChange?.('configuration-restart-required');
      }
    } catch (error) {
      setConfirmOpen(false);
      fail('review', error);
    } finally {
      setPending(false);
    }
  };

  const goBack = () => {
    clearErrors();
    const index = stepIndex(step());
    if (index <= 0) return;
    const previous = SETUP_STEPS[index - 1];
    if (previous) setStep(previous.id);
  };

  const inputError = (key: keyof SetupFieldErrors) => fieldError(errors(), key);
  const describedBy = (key: keyof SetupFieldErrors, id: string) => (inputError(key) ? id : undefined);

  return (
    <main class="min-h-screen bg-[var(--wb-canvas)] px-[var(--wb-space-4)] py-[var(--wb-space-8)] sm:px-[var(--wb-space-6)]">
      <Show
        when={!statusLoading()}
        fallback={
          <RuntimeStatePanel state="setup" health="loading" message="Checking whether this Host needs setup…" />
        }
      >
        <section class="mx-auto grid w-full max-w-5xl gap-[var(--wb-space-6)] lg:grid-cols-[14rem_minmax(0,1fr)]">
          <aside class="rounded-[var(--wb-radius-md)] border border-[var(--wb-border)] bg-[var(--wb-surface-muted)] p-[var(--wb-space-4)]" aria-label="Setup progress">
            <p class="mb-[var(--wb-space-1)] text-[0.625rem] font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
              Fabula / Workbench
            </p>
            <h1 class="font-[var(--font-display)] text-2xl font-bold text-[var(--wb-ink)]">First launch</h1>
            <ol class="mt-[var(--wb-space-6)] grid gap-[var(--wb-space-2)]">
              <For each={SETUP_STEPS}>
                {(candidate, index) => (
                  <li>
                    <div
                      class={`flex items-center gap-[var(--wb-space-2)] rounded-[var(--wb-radius-sm)] px-[var(--wb-space-2)] py-[var(--wb-space-2)] text-sm ${
                        candidate.id === step()
                          ? 'bg-[var(--wb-accent-wash)] font-bold text-[var(--wb-accent-deep)]'
                          : index() < stepIndex(step())
                            ? 'text-[var(--wb-success)]'
                            : 'text-[var(--wb-muted)]'
                      }`}
                      aria-current={candidate.id === step() ? 'step' : undefined}
                    >
                      <span aria-hidden="true" class="grid h-6 w-6 place-items-center rounded-full border border-current text-xs">
                        {index() < stepIndex(step()) ? '✓' : index() + 1}
                      </span>
                      <span>{candidate.label}</span>
                    </div>
                  </li>
                )}
              </For>
            </ol>
          </aside>

          <section class={`${PANEL} min-h-[32rem]`} aria-labelledby="setup-step-heading">
            <Show when={serverError()?.field === step() || serverError()?.field === 'host'}>
              <p class="mb-[var(--wb-space-5)] rounded-[var(--wb-radius-sm)] border border-[var(--wb-error-border)] bg-[var(--wb-error-surface)] px-[var(--wb-space-3)] py-[var(--wb-space-3)] text-sm text-[var(--wb-danger)]" role="alert" data-testid="setup-server-error">
                {serverError()?.message}
              </p>
            </Show>

            <Switch>
              <Match when={step() === 'owner'}>
                <StepHeading eyebrow="Step 1 / Owner" title="Create the owner account" description="This account controls the local Host. The password is sent once over the setup endpoint and is never echoed." />
                <form class="mt-[var(--wb-space-6)] grid gap-[var(--wb-space-4)]" onSubmit={(event) => { event.preventDefault(); void runOwner(); }}>
                  <label class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]" for="setup-display-name">
                    Display name
                    <input class={FIELD} id="setup-display-name" value={ownerDisplayName()} onInput={(event) => setOwnerDisplayName(event.currentTarget.value)} aria-invalid={Boolean(inputError('displayName'))} aria-describedby={describedBy('displayName', 'setup-display-name-error')} />
                    <FieldError id="setup-display-name-error" message={inputError('displayName')} />
                  </label>
                  <label class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]" for="setup-owner-password">
                    Password
                    <input class={FIELD} id="setup-owner-password" type="password" autocomplete="new-password" value={ownerPassword()} onInput={(event) => setOwnerPassword(event.currentTarget.value)} aria-invalid={Boolean(inputError('ownerPassword'))} aria-describedby={describedBy('ownerPassword', 'setup-owner-password-error')} />
                    <FieldError id="setup-owner-password-error" message={inputError('ownerPassword')} />
                  </label>
                  <StepActions pending={pending()} nextLabel="Create owner" onBack={undefined} />
                </form>
              </Match>

              <Match when={step() === 'project'}>
                <StepHeading eyebrow="Step 2 / Project" title="Register a project" description="Enter the project path on the Host. It is validated server-side and cleared from this browser after source validation." />
                <form class="mt-[var(--wb-space-6)] grid gap-[var(--wb-space-4)]" onSubmit={(event) => { event.preventDefault(); void runProjectValidation(); }}>
                  <label class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]" for="setup-project-id">
                    Project identifier
                    <input class={FIELD} id="setup-project-id" value={projectId()} onInput={(event) => setProjectId(event.currentTarget.value)} aria-invalid={Boolean(inputError('projectId'))} aria-describedby={describedBy('projectId', 'setup-project-id-error')} />
                    <FieldError id="setup-project-id-error" message={inputError('projectId')} />
                  </label>
                  <label class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]" for="setup-project-display-name">
                    Display name
                    <input class={FIELD} id="setup-project-display-name" value={projectDisplayName()} onInput={(event) => setProjectDisplayName(event.currentTarget.value)} aria-invalid={Boolean(inputError('projectDisplayName'))} aria-describedby={describedBy('projectDisplayName', 'setup-project-display-name-error')} />
                    <FieldError id="setup-project-display-name-error" message={inputError('projectDisplayName')} />
                  </label>
                  <label class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]" for="setup-project-root">
                    Project path on Host
                    <input class={FIELD} id="setup-project-root" type="text" autocomplete="off" value={projectRoot()} onInput={(event) => setProjectRoot(event.currentTarget.value)} aria-invalid={Boolean(inputError('projectRoot'))} aria-describedby={describedBy('projectRoot', 'setup-project-root-error')} />
                    <FieldError id="setup-project-root-error" message={inputError('projectRoot')} />
                  </label>
                  <StepActions pending={pending()} nextLabel="Validate project" onBack={goBack} />
                </form>
              </Match>

              <Match when={step() === 'source-validation'}>
                <StepHeading eyebrow="Step 3 / Source validation" title="Confirm the authoring source" description="The Host now checks the project authoring topology. Accepted source remains Host-owned; this wizard never reads raw source into the browser." />
                <div class="mt-[var(--wb-space-8)] rounded-[var(--wb-radius-md)] border border-[var(--wb-ready-border)] bg-[var(--wb-ready-surface)] p-[var(--wb-space-5)]">
                  <p class="text-sm font-semibold text-[var(--wb-success)]">Project path validated by Host</p>
                  <p class="mt-[var(--wb-space-2)] text-sm leading-relaxed text-[var(--wb-ink-soft)]">Save the validated project registration to continue. The path itself is intentionally not repeated here.</p>
                </div>
                <StepActions pending={pending()} nextLabel="Save validated source" onBack={goBack} onNext={() => void runSourceValidation()} />
              </Match>

              <Match when={step() === 'provider'}>
                <StepHeading eyebrow="Step 4 / Provider" title="Connect the provider" description="Endpoint and model are validated first. The credential is then handed directly to the Host credential store and cleared from this browser." />
                <form class="mt-[var(--wb-space-6)] grid gap-[var(--wb-space-4)]" onSubmit={(event) => { event.preventDefault(); void runProvider(); }}>
                  <label class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]" for="setup-provider-url">
                    Provider endpoint
                    <input class={FIELD} id="setup-provider-url" type="url" autocomplete="off" value={providerBaseUrl()} onInput={(event) => setProviderBaseUrl(event.currentTarget.value)} aria-invalid={Boolean(inputError('providerBaseUrl'))} aria-describedby={describedBy('providerBaseUrl', 'setup-provider-url-error')} />
                    <FieldError id="setup-provider-url-error" message={inputError('providerBaseUrl')} />
                  </label>
                  <label class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]" for="setup-provider-model">
                    Model
                    <input class={FIELD} id="setup-provider-model" autocomplete="off" value={providerModel()} onInput={(event) => setProviderModel(event.currentTarget.value)} aria-invalid={Boolean(inputError('providerModel'))} aria-describedby={describedBy('providerModel', 'setup-provider-model-error')} />
                    <FieldError id="setup-provider-model-error" message={inputError('providerModel')} />
                  </label>
                  <label class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]" for="setup-provider-key">
                    Provider credential
                    <input class={FIELD} id="setup-provider-key" type="password" autocomplete="new-password" value={providerApiKey()} onInput={(event) => setProviderApiKey(event.currentTarget.value)} aria-invalid={Boolean(inputError('providerApiKey'))} aria-describedby={describedBy('providerApiKey', 'setup-provider-key-error')} />
                    <FieldError id="setup-provider-key-error" message={inputError('providerApiKey')} />
                  </label>
                  <StepActions pending={pending()} nextLabel="Validate and save provider" onBack={goBack} />
                </form>
              </Match>

              <Match when={step() === 'network'}>
                <StepHeading eyebrow="Step 5 / Network" title="Choose the listener policy" description="Loopback is the safe first-launch default. LAN and Unix policies are explicit and may require a controlled restart." />
                <form class="mt-[var(--wb-space-6)] grid gap-[var(--wb-space-4)]" onSubmit={(event) => { event.preventDefault(); void runNetwork(); }}>
                  <label class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]" for="setup-network-mode">
                    Listener mode
                    <select class={FIELD} id="setup-network-mode" value={networkMode()} onChange={(event) => setNetworkMode(event.currentTarget.value as SetupNetworkInput['mode'])}>
                      <option value="loopback">Loopback (this machine)</option>
                      <option value="lan">LAN (trusted network)</option>
                      <option value="unix">Unix socket</option>
                    </select>
                  </label>
                  <label class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]" for="setup-network-port">
                    Port
                    <input class={FIELD} id="setup-network-port" inputmode="numeric" value={networkPort()} onInput={(event) => setNetworkPort(event.currentTarget.value)} aria-invalid={Boolean(inputError('networkPort'))} aria-describedby={describedBy('networkPort', 'setup-network-port-error')} />
                    <FieldError id="setup-network-port-error" message={inputError('networkPort')} />
                  </label>
                  <Show when={networkMode() === 'unix'}>
                    <label class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]" for="setup-unix-socket-name">
                      Unix socket name
                      <input class={FIELD} id="setup-unix-socket-name" autocomplete="off" value={unixSocketName()} onInput={(event) => setUnixSocketName(event.currentTarget.value)} aria-invalid={Boolean(inputError('unixSocketName'))} aria-describedby={describedBy('unixSocketName', 'setup-unix-socket-name-error')} />
                      <FieldError id="setup-unix-socket-name-error" message={inputError('unixSocketName')} />
                    </label>
                  </Show>
                  <label class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]" for="setup-allowed-hosts">
                    Allowed hosts <span class="font-normal text-[var(--wb-muted)]">(comma separated, optional)</span>
                    <input class={FIELD} id="setup-allowed-hosts" value={allowedHosts()} onInput={(event) => setAllowedHosts(event.currentTarget.value)} />
                  </label>
                  <label class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]" for="setup-allowed-origins">
                    Allowed origins <span class="font-normal text-[var(--wb-muted)]">(comma separated, optional)</span>
                    <input class={FIELD} id="setup-allowed-origins" value={allowedOrigins()} onInput={(event) => setAllowedOrigins(event.currentTarget.value)} />
                  </label>
                  <StepActions pending={pending()} nextLabel="Validate listener" onBack={goBack} />
                </form>
              </Match>

              <Match when={step() === 'review'}>
                <StepHeading eyebrow="Step 6 / Review" title="Review and apply setup" description="Only safe labels and validation outcomes are shown. Secrets and Host paths are never repeated in this review." />
                <dl class="mt-[var(--wb-space-6)] grid gap-[var(--wb-space-3)] sm:grid-cols-2">
                  <ReviewItem label="Owner" value={ownerDisplayName() || 'Owner account created'} />
                  <ReviewItem label="Project" value={projectDisplayName() || 'Validated project'} />
                  <ReviewItem label="Source" value="Authoring topology validated" />
                  <ReviewItem label="Provider" value="Endpoint, model, and credential validated" />
                  <ReviewItem label="Listener" value={`${networkMode()} / port ${networkPort()}`} />
                  <ReviewItem label="Credentials" value="Stored by Host; not shown" />
                </dl>
                <div class="mt-[var(--wb-space-8)] flex flex-wrap items-center justify-between gap-[var(--wb-space-3)]">
                  <button class={QUIET_BUTTON} type="button" onClick={goBack} disabled={pending()}>Back</button>
                  <Dialog open={confirmOpen()} onOpenChange={setConfirmOpen}>
                    <Dialog.Trigger class={PRIMARY_BUTTON} disabled={pending()}>
                      {pending() ? 'Applying…' : 'Review and apply'}
                    </Dialog.Trigger>
                    <Dialog.Portal>
                      <Dialog.Overlay class="fixed inset-0 z-40 bg-[var(--wb-overlay)]" />
                      <Dialog.Content class="fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100vw-var(--wb-space-6)))] -translate-x-1/2 -translate-y-1/2 rounded-[var(--wb-radius-lg)] border border-[var(--wb-border-strong)] bg-[var(--wb-surface)] p-[var(--wb-space-6)] shadow-[var(--wb-shadow-drawer)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-[var(--wb-focus)]">
                        <Dialog.Title class="font-[var(--font-display)] text-2xl font-bold text-[var(--wb-ink)]">Apply Workbench setup?</Dialog.Title>
                        <Dialog.Description class="mt-[var(--wb-space-3)] text-sm leading-relaxed text-[var(--wb-muted)]">This commits the validated, secret-free configuration. Provider credentials remain in the Host credential store, and the listener may require a restart.</Dialog.Description>
                        <div class="mt-[var(--wb-space-6)] flex justify-end gap-[var(--wb-space-3)]">
                          <Dialog.CloseButton class={QUIET_BUTTON} type="button">Cancel</Dialog.CloseButton>
                          <button class={PRIMARY_BUTTON} type="button" disabled={pending()} onClick={() => void runFinish()}>Apply setup</button>
                        </div>
                      </Dialog.Content>
                    </Dialog.Portal>
                  </Dialog>
                </div>
                <Show when={receipt()}>
                  {(current) => (
                    <p class="mt-[var(--wb-space-5)] text-sm text-[var(--wb-success)]" role="status" data-testid="setup-receipt">
                      Setup {current().status === 'restart-required' ? 'accepted; restart required.' : 'accepted.'}
                    </p>
                  )}
                </Show>
              </Match>
            </Switch>
          </section>
        </section>
      </Show>
    </main>
  );
}

function StepHeading(props: { readonly eyebrow: string; readonly title: string; readonly description: string }): JSX.Element {
  return (
    <header>
      <p class="mb-[var(--wb-space-1)] text-[0.625rem] font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">{props.eyebrow}</p>
      <h2 id="setup-step-heading" class="font-[var(--font-display)] text-3xl font-bold leading-tight tracking-[-0.025em] text-[var(--wb-ink)]">{props.title}</h2>
      <p class="mt-[var(--wb-space-3)] max-w-2xl text-sm leading-relaxed text-[var(--wb-muted)]">{props.description}</p>
    </header>
  );
}

function FieldError(props: { readonly id: string; readonly message?: string }): JSX.Element {
  return <Show when={props.message}><span id={props.id} class="text-xs font-medium text-[var(--wb-danger)]" role="alert">{props.message}</span></Show>;
}

function StepActions(props: { readonly pending: boolean; readonly nextLabel: string; readonly onBack?: () => void; readonly onNext?: () => void }): JSX.Element {
  return (
    <div class="mt-[var(--wb-space-3)] flex flex-wrap justify-between gap-[var(--wb-space-3)]">
      <Show when={props.onBack}>
        <button class={QUIET_BUTTON} type="button" onClick={props.onBack} disabled={props.pending}>Back</button>
      </Show>
      <button class={`${PRIMARY_BUTTON} ml-auto`} type={props.onNext ? 'button' : 'submit'} onClick={props.onNext} disabled={props.pending}>
        {props.pending ? 'Checking Host…' : props.nextLabel}
      </button>
    </div>
  );
}

function ReviewItem(props: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <div class="rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-[var(--wb-surface-muted)] p-[var(--wb-space-3)]">
      <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-[var(--wb-muted)]">{props.label}</dt>
      <dd class="mt-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink)]">{props.value}</dd>
    </div>
  );
}

