import type { JSX } from 'solid-js';
import { createSignal, For, Match, onMount, Show, Switch } from 'solid-js';
import type { ConfigOperationReceiptV1, WorkbenchSetupStatusV1 } from '../../contracts/index.js';
import { type ProviderPreset, providerPresets } from '../provider-presets.js';
import type { RuntimeState } from '../runtime-client.js';
import {
  isSetupApiError,
  type SetupClient,
  type SetupField,
  type SetupFinishResult,
  type SetupNetworkInput,
  type SetupProviderInput,
} from '../setup-client.js';
import { FIELD, PANEL, PRIMARY_BUTTON, QUIET_BUTTON, RuntimeStatePanel } from './RuntimeStates.js';

export type SetupStep = 'owner' | 'provider';

export const SETUP_STEPS: readonly { readonly id: SetupStep; readonly label: string }[] = [
  { id: 'owner', label: '账号' },
  { id: 'provider', label: '模型服务' },
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
  if (trim(displayName).length === 0) errors.displayName = '请输入显示名称。';
  else if (trim(displayName).length > 80) errors.displayName = '请控制在 80 个字符以内。';
  if (password.length > 0 && password.length < 12) {
    errors.ownerPassword = '密码至少 12 个字符；留空则无需密码。';
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
  if (endpoint.length === 0) errors.providerBaseUrl = '请输入服务地址。';
  else {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    } catch {
      errors.providerBaseUrl = '请输入 http(s) 开头的服务地址。';
    }
  }
  if (trim(model).length === 0) errors.providerModel = '请输入模型名称。';
  if (apiKey.length === 0) errors.providerApiKey = '请输入服务密钥。';
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
    errors.networkPort = '端口需在 0 到 65535 之间。';
  }
  if (mode !== 'loopback' && mode !== 'lan' && mode !== 'unix') {
    errors.networkPort = '请选择受支持的监听模式。';
  }
  if (mode === 'unix' && !/^[A-Za-z0-9._-]{1,128}$/.test(trim(unixSocketName))) {
    errors.unixSocketName = '请输入简单的 Unix socket 名称。';
  }
  return errors;
}

function initialStep(status: WorkbenchSetupStatusV1 | null | undefined): SetupStep {
  if (!status?.ownerCreated) return 'owner';
  return 'provider';
}

function safeFailureMessage(error: unknown): string {
  if (isSetupApiError(error)) {
    switch (error.code) {
      case 'PROJECT_INVALID_ROOT':
        return 'Host 无法校验该项目。';
      case 'PROJECT_DUPLICATE_ID':
        return '请换一个项目标识。';
      case 'PROJECT_NOT_ACCESSIBLE':
        return 'Host 无法访问该项目。';
      case 'PROVIDER_VALIDATION_FAILED':
        return '无法校验该服务配置。';
      case 'CREDENTIAL_INVALID':
        return '无法保存服务密钥。';
      case 'NETWORK_INVALID':
        return '请检查监听设置。';
      case 'CONFIG_STALE':
        return '设置已在别处变更，请刷新后重新检查。';
      default:
        return 'Host 未能完成该设置步骤。';
    }
  }
  return 'Host 未能完成该设置步骤。';
}

function stepIndex(step: SetupStep): number {
  return SETUP_STEPS.findIndex((candidate) => candidate.id === step);
}

function fieldError(errors: SetupFieldErrors, key: keyof SetupFieldErrors): string | undefined {
  return errors[key];
}

export function SetupWizard(props: SetupWizardProps): JSX.Element {
  const [status, setStatus] = createSignal<WorkbenchSetupStatusV1 | null>(
    props.initialStatus ?? null,
  );
  const [statusLoading, setStatusLoading] = createSignal(props.initialStatus === undefined);
  const [step, setStep] = createSignal<SetupStep>(initialStep(props.initialStatus));
  const [pending, setPending] = createSignal(false);
  const [errors, setErrors] = createSignal<SetupFieldErrors>({});
  const [serverError, setServerError] = createSignal<{
    readonly field: SetupField;
    readonly message: string;
  } | null>(null);

  const [ownerDisplayName, setOwnerDisplayName] = createSignal('Owner');
  const [ownerPassword, setOwnerPassword] = createSignal('');
  const [providerBaseUrl, setProviderBaseUrl] = createSignal('');
  const [providerModel, setProviderModel] = createSignal('');
  const [providerApiKey, setProviderApiKey] = createSignal('');
  const [presets, setPresets] = createSignal<ProviderPreset[] | null>(null);
  const [presetError, setPresetError] = createSignal('');
  const [activePreset, setActivePreset] = createSignal('');

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

  const providerInput = (): SetupProviderInput => ({
    kind: 'pi',
    baseUrl: trim(providerBaseUrl()) || null,
    model: trim(providerModel()) || null,
  });

  onMount(() => {
    void (async () => {
      try {
        setPresets(await providerPresets());
      } catch (error) {
        setPresetError(safeFailureMessage(error));
      }
    })();
  });

  const pickPreset = (preset: ProviderPreset) => {
    setActivePreset(preset.id);
    setProviderBaseUrl(preset.baseUrl);
    setProviderModel(preset.modelHint ?? '');
  };

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
      setStep('provider');
    } catch (error) {
      setOwnerPassword('');
      fail('owner', error);
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
      await runFinish();
    } catch (error) {
      setProviderApiKey('');
      fail('provider', error);
    } finally {
      setPending(false);
    }
  };

  const runFinish = async (): Promise<void> => {
    clearErrors();
    setPending(true);
    try {
      const result: SetupFinishResult = await props.client.finish(
        status()?.configurationRevision ?? null,
      );
      props.onComplete?.(result.receipt);
      if (result.receipt.status === 'restart-required') {
        props.onStateChange?.('configuration-restart-required');
      }
    } catch (error) {
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
  const describedBy = (key: keyof SetupFieldErrors, id: string) =>
    inputError(key) ? id : undefined;

  return (
    <main class="min-h-screen bg-[var(--wb-canvas)] px-[var(--wb-space-4)] py-[var(--wb-space-8)] sm:px-[var(--wb-space-6)]">
      <Show
        when={!statusLoading()}
        fallback={
          <RuntimeStatePanel state="setup" health="loading" message="正在检查 Host 是否需要设置…" />
        }
      >
        <section class="mx-auto grid w-full max-w-5xl gap-[var(--wb-space-6)] lg:grid-cols-[14rem_minmax(0,1fr)]">
          <aside
            class="rounded-[var(--wb-radius-md)] border border-[var(--wb-border)] bg-[var(--wb-surface-muted)] p-[var(--wb-space-4)]"
            aria-label="设置进度"
          >
            <p class="mb-[var(--wb-space-1)] text-[0.625rem] font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
              Fabula / 工作台
            </p>
            <h1 class="font-[var(--font-display)] text-2xl font-bold text-[var(--wb-ink)]">
              首次启动
            </h1>
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
                      <span
                        aria-hidden="true"
                        class="grid h-6 w-6 place-items-center rounded-full border border-current text-xs"
                      >
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
              <p
                class="mb-[var(--wb-space-5)] rounded-[var(--wb-radius-sm)] border border-[var(--wb-error-border)] bg-[var(--wb-error-surface)] px-[var(--wb-space-3)] py-[var(--wb-space-3)] text-sm text-[var(--wb-danger)]"
                role="alert"
                data-testid="setup-server-error"
              >
                {serverError()?.message}
              </p>
            </Show>

            <Switch>
              <Match when={step() === 'owner'}>
                <StepHeading
                  eyebrow="第 1 步 / 账号"
                  title="创建账号"
                  description="该账号用于控制本机 Host。密码为可选项；留空则在本机免密启动。"
                />
                <form
                  class="mt-[var(--wb-space-6)] grid gap-[var(--wb-space-4)]"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runOwner();
                  }}
                >
                  <label
                    class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]"
                    for="setup-display-name"
                  >
                    显示名称
                    <input
                      class={FIELD}
                      id="setup-display-name"
                      value={ownerDisplayName()}
                      onInput={(event) => setOwnerDisplayName(event.currentTarget.value)}
                      aria-invalid={Boolean(inputError('displayName'))}
                      aria-describedby={describedBy('displayName', 'setup-display-name-error')}
                    />
                    <FieldError id="setup-display-name-error" message={inputError('displayName')} />
                  </label>
                  <label
                    class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]"
                    for="setup-owner-password"
                  >
                    密码 <span class="font-normal text-[var(--wb-muted)]">（可选）</span>
                    <input
                      class={FIELD}
                      id="setup-owner-password"
                      type="password"
                      autocomplete="new-password"
                      value={ownerPassword()}
                      onInput={(event) => setOwnerPassword(event.currentTarget.value)}
                      aria-invalid={Boolean(inputError('ownerPassword'))}
                      aria-describedby={describedBy('ownerPassword', 'setup-owner-password-error')}
                    />
                    <FieldError
                      id="setup-owner-password-error"
                      message={inputError('ownerPassword')}
                    />
                  </label>
                  <StepActions pending={pending()} nextLabel="创建账号" onBack={undefined} />
                </form>
              </Match>

              <Match when={step() === 'provider'}>
                <StepHeading
                  eyebrow="第 2 步 / 模型服务"
                  title="连接模型服务"
                  description="选择一个预设服务商，或自行填写服务地址。密钥直接交给 Host 凭据库保存，本浏览器不留存。"
                />
                <div class="mt-[var(--wb-space-6)] grid gap-[var(--wb-space-2)]">
                  <Show when={presets() === null && presetError() === ''}>
                    <p class="text-sm text-[var(--wb-muted)]">正在加载预设服务商…</p>
                  </Show>
                  <Show when={presetError() !== ''}>
                    <p class="text-sm text-[var(--wb-danger)]" role="alert">
                      {presetError()}
                    </p>
                  </Show>
                  <div class="settings-preset-grid" data-testid="setup-preset-grid">
                    <For each={presets() ?? []}>
                      {(preset) => (
                        <button
                          type="button"
                          class="settings-preset"
                          classList={{ 'is-active': activePreset() === preset.id }}
                          onClick={() => pickPreset(preset)}
                          title={preset.baseUrl}
                        >
                          {preset.label}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
                <form
                  class="mt-[var(--wb-space-6)] grid gap-[var(--wb-space-4)]"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runProvider();
                  }}
                >
                  <label
                    class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]"
                    for="setup-provider-url"
                  >
                    服务地址
                    <input
                      class={FIELD}
                      id="setup-provider-url"
                      type="url"
                      autocomplete="off"
                      value={providerBaseUrl()}
                      onInput={(event) => setProviderBaseUrl(event.currentTarget.value)}
                      aria-invalid={Boolean(inputError('providerBaseUrl'))}
                      aria-describedby={describedBy('providerBaseUrl', 'setup-provider-url-error')}
                    />
                    <FieldError
                      id="setup-provider-url-error"
                      message={inputError('providerBaseUrl')}
                    />
                  </label>
                  <label
                    class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]"
                    for="setup-provider-model"
                  >
                    模型
                    <input
                      class={FIELD}
                      id="setup-provider-model"
                      autocomplete="off"
                      value={providerModel()}
                      onInput={(event) => setProviderModel(event.currentTarget.value)}
                      aria-invalid={Boolean(inputError('providerModel'))}
                      aria-describedby={describedBy('providerModel', 'setup-provider-model-error')}
                    />
                    <FieldError
                      id="setup-provider-model-error"
                      message={inputError('providerModel')}
                    />
                  </label>
                  <label
                    class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]"
                    for="setup-provider-key"
                  >
                    服务密钥
                    <input
                      class={FIELD}
                      id="setup-provider-key"
                      type="password"
                      autocomplete="new-password"
                      value={providerApiKey()}
                      onInput={(event) => setProviderApiKey(event.currentTarget.value)}
                      aria-invalid={Boolean(inputError('providerApiKey'))}
                      aria-describedby={describedBy('providerApiKey', 'setup-provider-key-error')}
                    />
                    <FieldError
                      id="setup-provider-key-error"
                      message={inputError('providerApiKey')}
                    />
                  </label>
                  <StepActions pending={pending()} nextLabel="完成设置" onBack={goBack} />
                </form>
              </Match>
            </Switch>
          </section>
        </section>
      </Show>
    </main>
  );
}

function StepHeading(props: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
}): JSX.Element {
  return (
    <header>
      <p class="mb-[var(--wb-space-1)] text-[0.625rem] font-extrabold uppercase tracking-[0.12em] text-[var(--wb-muted)]">
        {props.eyebrow}
      </p>
      <h2
        id="setup-step-heading"
        class="font-[var(--font-display)] text-3xl font-bold leading-tight tracking-[-0.025em] text-[var(--wb-ink)]"
      >
        {props.title}
      </h2>
      <p class="mt-[var(--wb-space-3)] max-w-2xl text-sm leading-relaxed text-[var(--wb-muted)]">
        {props.description}
      </p>
    </header>
  );
}

function FieldError(props: { readonly id: string; readonly message?: string }): JSX.Element {
  return (
    <Show when={props.message}>
      <span id={props.id} class="text-xs font-medium text-[var(--wb-danger)]" role="alert">
        {props.message}
      </span>
    </Show>
  );
}

function StepActions(props: {
  readonly pending: boolean;
  readonly nextLabel: string;
  readonly onBack?: () => void;
  readonly onNext?: () => void;
}): JSX.Element {
  return (
    <div class="mt-[var(--wb-space-3)] flex flex-wrap justify-between gap-[var(--wb-space-3)]">
      <Show when={props.onBack}>
        <button class={QUIET_BUTTON} type="button" onClick={props.onBack} disabled={props.pending}>
          上一步
        </button>
      </Show>
      <button
        class={`${PRIMARY_BUTTON} ml-auto`}
        type={props.onNext ? 'button' : 'submit'}
        onClick={props.onNext}
        disabled={props.pending}
      >
        {props.pending ? '正在检查…' : props.nextLabel}
      </button>
    </div>
  );
}
