import { createSignal, For, Show } from 'solid-js';
import { PROJECT_ACCESS_ROLE_GRANTS } from '../contracts/configuration.js';
import type {
  BrowserGraphRouteSelectorV1,
  BrowserPublicationListV1,
  BrowserPublicationReadQueryV1,
  BrowserPublicationReadResultV1,
  BrowserPublicationRecordV1,
  BrowserPublishRequestV1,
  ProjectAccessRole,
} from '../contracts/index.js';
import { BrowserPublicationApiError } from './browser-publication-api.js';
import {
  BUTTON,
  BUTTON_GHOST,
  BUTTON_PRIMARY,
  Diagnostic,
  KICKER,
  ScreenEmpty,
  ScreenNote,
} from './ui/primitives';

export interface PublicationViewProps {
  /** Project identity for publish requests; null when no project is open. */
  readonly projectId: string | null;
  /** Host publication catalog; null = not loaded yet. */
  readonly publications?: BrowserPublicationListV1 | null;
  /** Catalog load failure surfaced by the Host surface; non-null renders a retry state. */
  readonly publicationsError?: string | null;
  /**
   * Project membership role for the current session. Publishing is a
   * submit-scope operation, so it is offered only when the role's grants
   * allow it AND the matching callback is wired; the Host remains the
   * authoritative scope enforcer.
   */
  readonly sessionRole?: ProjectAccessRole | null;
  /** Wired by the Host surface only when the session may publish. */
  readonly onPublish?: (request: BrowserPublishRequestV1) => void | Promise<void>;
  /** Re-requests the Host publication catalog after a mutation. */
  readonly onRefresh?: () => void | Promise<void>;
  /** Reads one bounded slice of a publication artifact; wired for download. */
  readonly onReadPublication?: (
    projectId: string,
    publicationId: string,
    query?: BrowserPublicationReadQueryV1,
  ) => Promise<BrowserPublicationReadResultV1>;
}

/** Bounded read chunk used by the download flow (matches the host read bound). */
const PUBLICATION_READ_CHUNK = 256 * 1024;

function roleRank(role: ProjectAccessRole | null | undefined): number {
  if (role === null || role === undefined) return 0;
  return PROJECT_ACCESS_ROLE_GRANTS[role].rank;
}

/**
 * Mutation visibility requires BOTH a wired callback (the Host surface's
 * wiring gate, exactly like Review Hub) and, when the session role is known,
 * a sufficient grant rank (maintainer for publish). An unknown role (null)
 * defers entirely to the callback wiring and to the Host's authoritative
 * scope enforcement.
 */
function roleAllows(rank: number, requiredRank: number): boolean {
  return rank === 0 || rank >= requiredRank;
}

function lifecycleErrorMessage(error: unknown): string {
  if (error instanceof BrowserPublicationApiError) return error.message;
  return error instanceof Error ? error.message : '发布请求未被接受。';
}

/** Project-relative artifact file → local download filename (basename only). */
function downloadFilename(record: BrowserPublicationRecordV1): string {
  const parts = record.relativeOutputPath.split('/');
  const leaf = parts[parts.length - 1];
  return leaf.length > 0 ? leaf : `${record.publicationId}.md`;
}

/** Client mirror of the Host's assertSafePublicationRelativePath rules. */
function publicationRelativePathError(relativePath: string): string | null {
  if (relativePath === '') {
    return '发布相对路径不能为空';
  }
  if (relativePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    return `发布相对路径不能是绝对路径：${relativePath}`;
  }
  const parts = relativePath.split(/[\\/]/);
  if (parts.some((part) => part === '..' || part === '.')) {
    return `发布相对路径不能包含上级目录：${relativePath}`;
  }
  if (parts.some((part) => part === '')) {
    return `发布相对路径不能包含空路径段：${relativePath}`;
  }
  if (parts[0] !== 'output' || parts.length !== 2) {
    return `发布相对路径必须是 output/<文件>：${relativePath}`;
  }
  return null;
}

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

/** One publication record: identity, status, stale reasons, download action. */
function PublicationCard(props: {
  readonly projectId: string;
  readonly record: BrowserPublicationRecordV1;
  readonly onRead?: (
    projectId: string,
    publicationId: string,
    query?: BrowserPublicationReadQueryV1,
  ) => Promise<BrowserPublicationReadResultV1>;
  readonly onDownloadError: (message: string) => void;
}) {
  const record = () => props.record;
  const [downloading, setDownloading] = createSignal(false);

  const download = async () => {
    if (downloading() || props.onRead === undefined) return;
    setDownloading(true);
    try {
      const chunks: string[] = [];
      const total = record().byteLength;
      let offset = 0;
      for (;;) {
        const slice = await props.onRead(props.projectId, record().publicationId, {
          offset,
          limit: PUBLICATION_READ_CHUNK,
        });
        chunks.push(slice.content);
        offset = slice.offset + slice.byteLength;
        if (slice.byteLength === 0 || offset >= total) break;
      }
      const blob = new Blob(chunks, { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloadFilename(record());
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      props.onDownloadError(lifecycleErrorMessage(error));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li
      class="grid gap-4 rounded-[0.625rem] border border-line bg-surface p-5 shadow-[var(--wb-shadow-panel)]"
      data-publication-id={record().publicationId}
      data-status={record().status}
      data-kind={record().kind}
    >
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="rounded-full bg-surface-deep px-2 py-1 text-[0.625rem] font-extrabold uppercase leading-[1.2] tracking-[0.06em] text-focus"
          data-kind={record().kind}
        >
          {record().kind}
        </span>
        <span
          class="rounded-full bg-ready-surface px-2 py-1 text-[0.625rem] font-extrabold uppercase leading-[1.2] tracking-[0.06em] text-success"
          classList={{ 'bg-loading-surface text-warning': record().status === 'stale' }}
          data-status={record().status}
        >
          {record().status}
        </span>
        <code class="text-[0.6875rem] text-muted">{record().publicationId}</code>
      </div>
      <dl class="m-0 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
        <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted px-3 py-2">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">文件</dt>
          <dd class="m-0 text-[0.8125rem] [overflow-wrap:anywhere]">
            <code>{record().relativeOutputPath}</code>
          </dd>
        </div>
        <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted px-3 py-2">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
            成书哈希
          </dt>
          <dd class="m-0 text-[0.8125rem] [overflow-wrap:anywhere]">
            <code title={record().novelHash}>{shortHash(record().novelHash)}</code>
          </dd>
        </div>
        <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted px-3 py-2">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
            源哈希
          </dt>
          <dd class="m-0 text-[0.8125rem] [overflow-wrap:anywhere]">
            <code title={record().sourceHash}>{shortHash(record().sourceHash)}</code>
          </dd>
        </div>
        <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted px-3 py-2">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
            范围哈希
          </dt>
          <dd class="m-0 text-[0.8125rem] [overflow-wrap:anywhere]">
            <code title={record().scopeHash}>{shortHash(record().scopeHash)}</code>
          </dd>
        </div>
        <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted px-3 py-2">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
            场景数
          </dt>
          <dd class="m-0 text-[0.8125rem] [overflow-wrap:anywhere]">{record().sceneCount}</dd>
        </div>
        <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted px-3 py-2">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">字数</dt>
          <dd class="m-0 text-[0.8125rem] [overflow-wrap:anywhere]">{record().wordCount}</dd>
        </div>
        <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted px-3 py-2">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">字节</dt>
          <dd class="m-0 text-[0.8125rem] [overflow-wrap:anywhere]">{record().byteLength}</dd>
        </div>
        <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted px-3 py-2">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
            修订数
          </dt>
          <dd class="m-0 text-[0.8125rem] [overflow-wrap:anywhere]">
            {record().revisionIds.length}
          </dd>
        </div>
        <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted px-3 py-2">
          <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
            更新时间
          </dt>
          <dd class="m-0 text-[0.8125rem] [overflow-wrap:anywhere]">{record().updatedAt}</dd>
        </div>
      </dl>
      <Show when={record().staleReasons.length > 0}>
        <section class="grid gap-2" aria-label="过期原因">
          <h4 class="m-0 text-[0.6875rem] font-extrabold uppercase tracking-[0.08em] text-warning">
            过期原因
          </h4>
          <ul class="m-0 grid list-none gap-1 p-0">
            <For each={record().staleReasons}>
              {(reason) => (
                <li class="text-xs text-muted" data-stale-reason={reason}>
                  <code>{reason}</code>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={props.onRead !== undefined}>
        <button
          class={BUTTON}
          type="button"
          disabled={downloading()}
          data-testid={`publication-download-${record().publicationId}`}
          onClick={() => void download()}
        >
          {downloading() ? '下载中…' : '下载'}
        </button>
      </Show>
    </li>
  );
}

/**
 * Publication renders the Host's publication catalog: canonical and custom
 * branch artifacts with their relative file names, hashes, scene/source
 * identity and stale reasons, plus a publish action and a download action
 * that reads the artifact through the bounded read route (never a Host
 * path). The publish form is structured (branch name + validated relative
 * output path, mirroring the Host's path rules) and the wire branchPath is
 * built exactly as before. Empty, loading, load-error and post-publish
 * confirmation states are honest and no mock data is ever rendered.
 */
export function PublicationView(props: PublicationViewProps) {
  const [mutationError, setMutationError] = createSignal<string | null>(null);
  const [publishOpen, setPublishOpen] = createSignal(false);
  const [branchName, setBranchName] = createSignal('');
  const [relativePath, setRelativePath] = createSignal('output/novel.md');
  const [title, setTitle] = createSignal('');
  const [publishSuccess, setPublishSuccess] = createSignal(false);

  const rank = () => roleRank(props.sessionRole);
  const canPublish = () => roleAllows(rank(), 3) && props.onPublish !== undefined;

  const runMutation = async (mutation: () => void | Promise<void>): Promise<void> => {
    setMutationError(null);
    setPublishSuccess(false);
    try {
      await mutation();
      setPublishSuccess(true);
      await props.onRefresh?.();
    } catch (error) {
      setPublishSuccess(false);
      setMutationError(lifecycleErrorMessage(error));
    }
  };

  /**
   * Submit the publish form. A blank branch name publishes the canonical
   * novel (no branchPath on the wire, exactly like the previous blank JSON
   * input); a named branch publishes a custom artifact whose wire branchPath
   * is the strict route selector `{version:1, branchPath:{decisions:[]}}`
   * plus the branch's discourse name — byte-identical to what the old JSON
   * form produced for the same content. The relative output path is
   * validated client-side with the Host's own rules but is not part of the
   * wire: custom artifacts are addressed by their derived publication id.
   */
  const publish = () => {
    const projectId = props.projectId;
    if (projectId === null) return;
    const name = branchName().trim();
    const pathProblem = publicationRelativePathError(relativePath().trim());
    if (pathProblem !== null) {
      setMutationError(pathProblem);
      return;
    }
    const customSelector: BrowserGraphRouteSelectorV1 = {
      version: 1,
      branchPath: { decisions: [] },
    };
    const request: BrowserPublishRequestV1 = {
      version: 1,
      projectId,
      ...(name.length === 0 ? {} : { branchPath: customSelector, discourseBranch: name }),
      ...(title().trim().length === 0 ? {} : { title: title().trim() }),
    };
    void runMutation(() => props.onPublish?.(request));
    setBranchName('');
    setRelativePath('output/novel.md');
    setTitle('');
    setPublishOpen(false);
  };

  return (
    <section class="mx-auto grid max-w-[60rem] gap-6" aria-labelledby="publication-heading">
      <header class="flex items-start justify-between gap-3">
        <div>
          <p class={KICKER}>成书输出</p>
          <h2 id="publication-heading">发布产物</h2>
        </div>
        <Show when={props.onRefresh !== undefined}>
          <button
            class={BUTTON}
            type="button"
            data-testid="publication-refresh"
            onClick={() => void props.onRefresh?.()}
          >
            刷新
          </button>
        </Show>
      </header>

      <Show when={mutationError() !== null}>
        <div role="alert" data-testid="publication-mutation-error">
          <Diagnostic severity="error">{mutationError()}</Diagnostic>
        </div>
      </Show>
      <Show when={publishSuccess()}>
        <div role="status" data-testid="publication-publish-success">
          <Diagnostic severity="success">发布请求已接受 — 正在排队装配成书文件。</Diagnostic>
        </div>
      </Show>

      <Show
        when={props.publications}
        fallback={
          <Show
            when={props.publicationsError !== null && props.publicationsError !== undefined}
            fallback={
              <ScreenEmpty title="暂无发布数据" body="打开已认证的项目以加载其发布记录。" />
            }
          >
            <div data-testid="publication-load-error">
              <ScreenEmpty title="发布目录加载失败" body={props.publicationsError ?? undefined}>
                <Show when={props.onRefresh !== undefined}>
                  <button
                    class={BUTTON}
                    type="button"
                    data-testid="publication-load-retry"
                    onClick={() => void props.onRefresh?.()}
                  >
                    重试
                  </button>
                </Show>
              </ScreenEmpty>
            </div>
          </Show>
        }
      >
        {(catalog) => (
          <section aria-labelledby="publication-list-heading">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h3 id="publication-list-heading">
                发布记录{' '}
                <span
                  class="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-accent-wash px-1 text-[0.6875rem] font-extrabold text-accent-deep"
                  data-testid="publication-count"
                >
                  {catalog().publications.length}
                </span>
              </h3>
              <Show when={canPublish()}>
                <Show
                  when={publishOpen()}
                  fallback={
                    <button
                      class={`${BUTTON} ${BUTTON_PRIMARY}`}
                      type="button"
                      data-testid="publication-publish-open"
                      onClick={() => setPublishOpen(true)}
                    >
                      发布
                    </button>
                  }
                >
                  <form
                    class="grid gap-2 rounded-[0.625rem] border border-line bg-surface-muted p-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      publish();
                    }}
                  >
                    <input
                      class="rounded-[0.375rem] border border-line bg-surface px-3 py-2 text-ink [font:inherit] focus-visible:outline-3 focus-visible:outline-focus focus-visible:outline-offset-2"
                      aria-label="分支名"
                      placeholder="分支名（可选）"
                      value={branchName()}
                      onInput={(event) => setBranchName(event.currentTarget.value)}
                      data-testid="publication-branch-name"
                    />
                    <input
                      class="rounded-[0.375rem] border border-line bg-surface px-3 py-2 text-ink [font:inherit] focus-visible:outline-3 focus-visible:outline-focus focus-visible:outline-offset-2"
                      aria-label="相对输出路径"
                      placeholder="相对输出路径（如 output/novel.md）"
                      value={relativePath()}
                      onInput={(event) => setRelativePath(event.currentTarget.value)}
                      data-testid="publication-relative-path"
                    />
                    <input
                      class="rounded-[0.375rem] border border-line bg-surface px-3 py-2 text-ink [font:inherit] focus-visible:outline-3 focus-visible:outline-focus focus-visible:outline-offset-2"
                      aria-label="标题"
                      placeholder="标题（可选）"
                      value={title()}
                      onInput={(event) => setTitle(event.currentTarget.value)}
                      data-testid="publication-title"
                    />
                    <button
                      class={`${BUTTON} ${BUTTON_PRIMARY}`}
                      type="submit"
                      data-testid="publication-publish-save"
                    >
                      发布
                    </button>
                    <button
                      class={`${BUTTON} ${BUTTON_GHOST}`}
                      type="button"
                      onClick={() => setPublishOpen(false)}
                    >
                      取消
                    </button>
                  </form>
                </Show>
              </Show>
            </div>
            <Show
              when={catalog().publications.length > 0}
              fallback={<ScreenNote>还没有发布产物。发布已接受的章节以生成成书文件。</ScreenNote>}
            >
              <ul class="m-0 grid list-none gap-4 p-0" aria-label="发布记录">
                <For each={catalog().publications}>
                  {(record) => (
                    <PublicationCard
                      projectId={catalog().projectId}
                      record={record}
                      onRead={props.onReadPublication}
                      onDownloadError={(message) => setMutationError(message)}
                    />
                  )}
                </For>
              </ul>
            </Show>
          </section>
        )}
      </Show>
    </section>
  );
}
