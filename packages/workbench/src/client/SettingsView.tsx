import { createSignal, For, onMount, Show } from 'solid-js';
import type { ProjectAccessRole } from '../contracts/index.js';
import { createAdminClient, type AdminClient } from './admin/admin-client.js';
import { providerPresets, type ProviderPreset } from './provider-presets.js';

export interface SettingsViewProps {
  readonly projectId?: string | null;
  /** Session project role (owner normalizes to `maintainer`); kept for copy. */
  readonly sessionRole?: ProjectAccessRole | null;
  /** Browser session id; forwarded so the admin client can authenticate. */
  readonly sessionId?: string | null;
}

const DEFAULT_PROFILE_ID = 'default';

function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return '操作被 Host 拒绝。';
}

interface HeaderRow {
  readonly key: string;
  readonly value: string;
}

/**
 * Author-facing LLM panel (plan Step 4). The provider profile is Host-wide
 * configuration that only the Host owner may mutate, so the edit gate is
 * host-authoritative: only a session that can read the owner-only advanced
 * configuration (admin routes call `requireOwner`) gets the full preset
 * grid + custom form + credential test + advanced pi-ai tuning; everyone
 * else sees a read-only status line. All mutations go through the owner
 * admin client against the `default` provider profile.
 */
export function SettingsView(props: SettingsViewProps) {
  const client: AdminClient | null =
    typeof window !== 'undefined'
      ? createAdminClient({ getSessionId: () => props.sessionId ?? null })
      : null;

  const [authorized, setAuthorized] = createSignal(false);
  const [presets, setPresets] = createSignal<ProviderPreset[] | null>(null);
  const [presetError, setPresetError] = createSignal('');
  const [activePreset, setActivePreset] = createSignal<string | null>(null);
  const [baseUrl, setBaseUrl] = createSignal('');
  const [model, setModel] = createSignal('');
  const [apiKey, setApiKey] = createSignal('');
  const [reasoning, setReasoning] = createSignal(false);
  const [contextWindow, setContextWindow] = createSignal('');
  const [maxTokens, setMaxTokens] = createSignal('');
  const [headerRows, setHeaderRows] = createSignal<HeaderRow[]>([{ key: '', value: '' }]);
  const [configured, setConfigured] = createSignal(false);
  const [configuredEndpoint, setConfiguredEndpoint] = createSignal<string | null>(null);
  const [configuredModel, setConfiguredModel] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');

  const isOwner = () => authorized();

  const refreshStatus = async () => {
    if (!client) return;
    try {
      const advanced = await client.getAdvancedConfig();
      setAuthorized(true);
      const profile = advanced.providers.find((p) => p.profileId === DEFAULT_PROFILE_ID);
      setConfigured(profile?.configured ?? false);
      setConfiguredEndpoint(profile?.endpoint ?? null);
      setConfiguredModel(profile?.model ?? null);
    } catch {
      setAuthorized(false);
      setConfigured(false);
      setConfiguredEndpoint(null);
      setConfiguredModel(null);
    }
  };

  onMount(() => {
    void providerPresets()
      .then(setPresets)
      .catch(() => {
        setPresets([]);
        setPresetError('无法加载供应商预设列表。');
      });
    void refreshStatus();
  });

  const pickPreset = (preset: ProviderPreset) => {
    setActivePreset(preset.id);
    setBaseUrl(preset.baseUrl);
    setModel(preset.modelHint ?? '');
    setError('');
  };

  const collectHeaders = (): Readonly<Record<string, string>> | undefined => {
    const entries = headerRows()
      .map((row) => [row.key.trim(), row.value] as const)
      .filter(([key]) => key.length > 0);
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  };

  const advancedInput = () => ({
    reasoning: reasoning() ? true : undefined,
    contextWindow: contextWindow().trim() === '' ? undefined : Number(contextWindow().trim()),
    maxTokens: maxTokens().trim() === '' ? undefined : Number(maxTokens().trim()),
    headers: collectHeaders(),
  });

  const run = async (operation: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await operation();
      await refreshStatus();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    void run(async () => {
      if (!client) throw new Error('管理客户端不可用。');
      const advanced = advancedInput();
      const response = await client.upsertProviderProfile(DEFAULT_PROFILE_ID, {
        kind: 'pi',
        baseUrl: baseUrl().trim() || null,
        model: model().trim() || null,
        ...(advanced.reasoning === undefined ? {} : { reasoning: advanced.reasoning }),
        ...(advanced.contextWindow === undefined ? {} : { contextWindow: advanced.contextWindow }),
        ...(advanced.maxTokens === undefined ? {} : { maxTokens: advanced.maxTokens }),
        ...(advanced.headers === undefined ? {} : { headers: advanced.headers }),
      });
      setMessage(`设置已保存（${response.receipt.status}）。`);
    });
  };

  const testCredential = () => {
    void run(async () => {
      if (!client) throw new Error('管理客户端不可用。');
      const secret = apiKey().trim();
      if (secret.length === 0) throw new Error('请先填写 API 密钥。');
      await client.setProviderProfileCredential(DEFAULT_PROFILE_ID, secret);
      setApiKey('');
      await client.testProviderProfile(DEFAULT_PROFILE_ID);
      setMessage('凭据验证通过。');
    });
  };

  const updateHeader = (index: number, field: 'key' | 'value', value: string) => {
    setHeaderRows((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  const addHeader = () => setHeaderRows((rows) => [...rows, { key: '', value: '' }]);
  const removeHeader = (index: number) =>
    setHeaderRows((rows) => (rows.length === 1 ? rows : rows.filter((_, i) => i !== index)));

  return (
    <div class="settings-view" data-testid="settings-view">
      <section class="card">
        <h2 class="card-title">AI 写作服务</h2>
        <p class="settings-copy">
          选择一家供应商并填写 API 密钥，AI 写作功能就会使用它生成小说内容。
        </p>
        <div class="settings-status" data-testid="settings-status">
          <span class={configured() ? 'settings-status-dot is-configured' : 'settings-status-dot'} />
          {configured()
            ? `已配置（${configuredEndpoint() ?? '未知端点'} · ${configuredModel() ?? '未知模型'}）`
            : '尚未配置可用的 AI 服务'}
        </div>
      </section>

      <Show
        when={isOwner()}
        fallback={
          <section class="card">
            <h2 class="card-title">LLM 设置</h2>
            <p class="settings-copy">
              AI 服务设置仅所有者可修改。当前项目
              {configured()
                ? `使用 ${configuredEndpoint() ?? '未知端点'} / ${configuredModel() ?? '未知模型'}。`
                : '尚未配置 AI 服务。'}
            </p>
          </section>
        }
      >
        <section class="card">
          <h2 class="card-title">选择供应商</h2>
          <Show when={presets() === null} fallback={null}>
            <p class="settings-copy" data-testid="presets-loading">
              正在加载供应商预设…
            </p>
          </Show>
          <Show when={presetError() !== ''}>
            <p class="settings-error" role="alert">
              {presetError()}
            </p>
          </Show>
          <div class="settings-preset-grid" data-testid="preset-grid">
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
          <Show when={(presets()?.length ?? 0) === 0 && presetError() === '' && presets() !== null}>
            <p class="settings-copy">没有可用的预设供应商，请手动填写下面的自定义连接。</p>
          </Show>
        </section>

        <section class="card">
          <h2 class="card-title">连接设置</h2>
          <label class="settings-field">
            <span>接口地址（baseUrl）</span>
            <input
              data-testid="base-url-input"
              type="text"
              value={baseUrl()}
              placeholder="https://api.example.com/v1"
              onInput={(event) => setBaseUrl(event.currentTarget.value)}
            />
          </label>
          <label class="settings-field">
            <span>模型</span>
            <input
              data-testid="model-input"
              type="text"
              value={model()}
              placeholder="model-name"
              onInput={(event) => setModel(event.currentTarget.value)}
            />
          </label>
          <label class="settings-field">
            <span>API 密钥</span>
            <input
              data-testid="api-key-input"
              type="password"
              value={apiKey()}
              placeholder="sk-…"
              autocomplete="off"
              onInput={(event) => setApiKey(event.currentTarget.value)}
            />
          </label>
          <div class="settings-actions">
            <button type="button" class="btn btn-primary" disabled={busy()} onClick={save}>
              保存
            </button>
            <button
              type="button"
              class="btn"
              disabled={busy() || baseUrl().trim() === '' || model().trim() === ''}
              onClick={testCredential}
              data-testid="test-credential"
            >
              测试凭据
            </button>
          </div>
        </section>

        <section class="card">
          <details class="settings-advanced" data-testid="advanced-section">
            <summary>高级参数（可选）</summary>
            <div class="settings-advanced-body">
              <label class="settings-field settings-field-inline">
                <input
                  data-testid="reasoning-input"
                  type="checkbox"
                  checked={reasoning()}
                  onChange={(event) => setReasoning(event.currentTarget.checked)}
                />
                <span>启用推理（reasoning）</span>
              </label>
              <label class="settings-field">
                <span>上下文窗口（contextWindow）</span>
                <input
                  data-testid="context-window-input"
                  type="number"
                  min="1"
                  value={contextWindow()}
                  placeholder="128000"
                  onInput={(event) => setContextWindow(event.currentTarget.value)}
                />
              </label>
              <label class="settings-field">
                <span>最大输出（maxTokens）</span>
                <input
                  data-testid="max-tokens-input"
                  type="number"
                  min="1"
                  value={maxTokens()}
                  placeholder="32000"
                  onInput={(event) => setMaxTokens(event.currentTarget.value)}
                />
              </label>
              <div class="settings-headers">
                <span class="settings-headers-label">自定义请求头（headers）</span>
                <For each={headerRows()}>
                  {(row, index) => (
                    <div class="settings-header-row">
                      <input
                        type="text"
                        placeholder="Header-Name"
                        value={row.key}
                        onInput={(event) => updateHeader(index(), 'key', event.currentTarget.value)}
                      />
                      <input
                        type="text"
                        placeholder="值"
                        value={row.value}
                        onInput={(event) =>
                          updateHeader(index(), 'value', event.currentTarget.value)
                        }
                      />
                      <button
                        type="button"
                        class="btn"
                        onClick={() => removeHeader(index())}
                        aria-label="删除此行"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </For>
                <button type="button" class="btn" onClick={addHeader}>
                  添加请求头
                </button>
              </div>
            </div>
          </details>
        </section>
      </Show>

      <Show when={message() !== ''}>
        <p class="settings-notice" role="status" data-testid="settings-message">
          {message()}
        </p>
      </Show>
      <Show when={error() !== ''}>
        <p class="settings-error" role="alert" data-testid="settings-error">
          {error()}
        </p>
      </Show>
    </div>
  );
}
