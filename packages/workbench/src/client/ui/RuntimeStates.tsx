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
    title: '正在检查 Host 状态',
    description: '浏览器正在向 Host 请求安全的就绪状态。',
    marker: '…',
  },
  empty: {
    title: '暂无可用项目',
    description: 'Host 可用，但当前还没有可以打开的项目。',
    marker: '○',
  },
  disconnected: {
    title: 'Host 连接已断开',
    description: '请重新连接本地 Workbench Host 后继续。',
    marker: '—',
  },
  unauthorized: {
    title: '需要登录',
    description: '当前会话缺失、已过期或不再被授权。',
    marker: '⌁',
  },
  fatal: {
    title: 'Host 错误',
    description: 'Host 返回了意外失败，未推断出项目数据。',
    marker: '!',
  },
  ready: {
    title: 'Host 已连接',
    description: '已认证的 Host 已就绪，可以加载项目数据。',
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
    title: '设置 Workbench',
    description: '创建所有者、登记项目、连接模型，然后完成设置。',
    marker: '1',
  },
  'bootstrap-owner': {
    title: '创建所有者账户',
    description: '首个所有者只能通过本机设置界面创建。',
    marker: '1',
  },
  login: {
    title: '登录 Workbench',
    description: '会话仅保存在内存中，绝不会写入浏览器存储。',
    marker: '→',
  },
  'project-picker': {
    title: '选择项目',
    description: '这里只显示 Host 授权的项目名称。',
    marker: '◇',
  },
  workspace: {
    title: '工作区',
    description: '加载该项目的已接受数据。',
    marker: '·',
  },
  'configuration-restart-required': {
    title: '需要重启',
    description: '配置已接受，但监听器需要重启后才会生效。',
    marker: '↻',
  },
  'fatal-host-error': {
    title: 'Workbench Host 错误',
    description: 'Host 无法完成此请求。未显示任何凭据、路径或源内容。',
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
      setLocalError('请输入用户 ID。');
      return;
    }
    if (nextPassword.length === 0) {
      setLocalError('请输入密码。');
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
          登录
        </h1>
        <p class="mt-[var(--wb-space-3)] text-sm leading-relaxed text-[var(--wb-muted)]">
          使用本地 Host 认证。此浏览器仅将会话保存在内存中。
        </p>
        <form class="mt-[var(--wb-space-6)] grid gap-[var(--wb-space-4)]" onSubmit={submit}>
          <label
            class="grid gap-[var(--wb-space-1)] text-sm font-semibold text-[var(--wb-ink-soft)]"
            for="login-user-id"
          >
            用户 ID
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
            密码
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
            {props.pending ? '正在登录…' : '登录'}
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
          Workbench / 项目访问
        </p>
        <h1
          id="project-picker-heading"
          class="font-[var(--font-display)] text-3xl font-bold text-[var(--wb-ink)]"
        >
          选择项目
        </h1>
        <p class="mt-[var(--wb-space-3)] text-sm leading-relaxed text-[var(--wb-muted)]">
          项目路径保留在 Host 上。这里只使用你的会话对应的安全项目名称。
        </p>
        <Show
          when={!props.pending && props.projects.length > 0}
          fallback={
            <div class="mt-[var(--wb-space-6)]" aria-live="polite" aria-busy={props.pending}>
              <RuntimeStatePanel
                state="project-picker"
                health={props.pending ? 'loading' : (props.health ?? 'empty')}
                message={props.error ?? undefined}
                actionLabel={props.onRetry ? '重试' : undefined}
                onAction={props.onRetry}
              />
            </div>
          }
        >
          <ul
            class="mt-[var(--wb-space-6)] grid gap-[var(--wb-space-3)]"
            aria-label="可用项目"
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
                        {project.open ? '已在 Host 打开' : 'Host 可用'}
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
        actionLabel={props.onSignIn ? '登录' : undefined}
        onAction={props.onSignIn}
      />
    </main>
  );
}

export { FIELD, PANEL, PRIMARY_BUTTON, QUIET_BUTTON };
