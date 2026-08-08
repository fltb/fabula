import { createEffect, createSignal, For, Show } from 'solid-js';
import { PROJECT_ACCESS_ROLE_GRANTS } from '../contracts/configuration.js';
import type {
  BrowserProjectReferenceImportResultV1,
  BrowserProjectReferenceListV1,
  BrowserProjectReferenceReadQueryV1,
  BrowserProjectReferenceReadResultV1,
  BrowserProjectReferenceRetryResultV1,
  ProjectAccessRole,
  ReferenceItemV1,
} from '../contracts/index.js';
import { Badge } from './ui/controls';
import {
  BUTTON,
  BUTTON_GHOST,
  BUTTON_PRIMARY,
  Diagnostic,
  KICKER,
  ScreenEmpty,
  ScreenNote,
} from './ui/primitives';

/** Bounded content preview slice; the Host read route caps at 1 MiB per read. */
const REFERENCE_PREVIEW_BYTES = 64 * 1024;

/** Local upload row: optimistic state while the Host drives the durable job. */
interface UploadRow {
  readonly id: string;
  readonly fileName: string;
  readonly status: 'uploading' | 'failed';
  readonly jobId?: string;
  readonly message?: string;
}

export interface ReferencesViewProps {
  readonly projectId: string | null;
  /** First server page; the view accumulates later pages locally. */
  readonly references: BrowserProjectReferenceListV1 | null;
  /** Catalog load failure; non-null renders a distinct retry state. */
  readonly referencesError?: string | null;
  readonly sessionRole?: ProjectAccessRole | null;
  /** Re-requests the first server page (after import/delete). */
  readonly onRefresh?: () => void | Promise<void>;
  /** Fetches one more server page for the accumulated list. */
  readonly onLoadMore?: (cursor: string) => Promise<BrowserProjectReferenceListV1 | null>;
  /** Uploads one file; the returned job is terminal (succeeded or failed). */
  readonly onImport?: (file: File) => Promise<BrowserProjectReferenceImportResultV1>;
  /** Re-runs one failed import job from its persisted chunks. */
  readonly onRetry?: (jobId: string) => Promise<BrowserProjectReferenceRetryResultV1 | null>;
  /** Deletes one reference; the caller refreshes the list. */
  readonly onDelete?: (referenceId: string) => void | Promise<void>;
  /** Reads one bounded content slice for the detail preview. */
  readonly onReadContent?: (
    referenceId: string,
    query?: BrowserProjectReferenceReadQueryV1,
  ) => Promise<BrowserProjectReferenceReadResultV1 | null>;
}

function roleRank(role: ProjectAccessRole | null | undefined): number {
  if (role === null || role === undefined) return 0;
  return PROJECT_ACCESS_ROLE_GRANTS[role].rank;
}

/** Mutation visibility requires BOTH a wired callback and author rank+. */
function canMutate(
  rank: number,
  wired: boolean,
  requiredRank: number = PROJECT_ACCESS_ROLE_GRANTS.author.rank,
): boolean {
  return wired && (rank === 0 || rank >= requiredRank);
}

function lifecycleErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '参考资料操作失败。';
}

/** Human-readable byte size (B/KB/MB/GB). */
function formatBytes(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return '0 B';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let size = value;
  let unit = -1;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === -1 ? Math.round(size) : size.toFixed(1)} ${units[Math.max(0, unit)] ?? 'KB'}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/** Local search mirror of the Host searchable fields (displayName, originalName, …). */
function matchesFilter(item: ReferenceItemV1, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return [
    item.referenceId,
    item.displayName,
    item.originalName,
    item.mediaType,
    item.title ?? '',
    ...item.authors,
    item.sourceUrl ?? '',
    item.license ?? '',
    ...item.tags,
  ]
    .join('\u0000')
    .toLowerCase()
    .includes(needle);
}

/** Decode a bounded base64 slice into display text (binary-safe enough for previews). */
function previewText(content: BrowserProjectReferenceReadResultV1): string {
  try {
    const binary = atob(content.content.dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

function MediaTypeBadge(props: { readonly mediaType: string }) {
  return (
    <span title={props.mediaType}>
      <Badge tone="event">{props.mediaType}</Badge>
    </span>
  );
}

/**
 * References (plan 9.1): full-management view over the Host's reference
 * library. The list is server-cursor paginated («加载更多» reuses nextCursor)
 * with a local search filter; import is optimistic (per-file rows while the
 * Host drives the durable three-phase import — the port processes commits
 * synchronously, so the returned job is terminal and no background polling
 * is needed) with failed rows that persist and retry through the durable
 * job; delete is inline with a confirm; clicking a row opens the detail
 * panel with metadata and a bounded content preview.
 */
export function ReferencesView(props: ReferencesViewProps) {
  const [items, setItems] = createSignal<readonly ReferenceItemV1[]>([]);
  const [nextCursor, setNextCursor] = createSignal<string | null>(null);
  const [filter, setFilter] = createSignal('');
  const [uploads, setUploads] = createSignal<readonly UploadRow[]>([]);
  const [loadMoreError, setLoadMoreError] = createSignal<string | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [detailContent, setDetailContent] = createSignal<string | null>(null);
  const [detailError, setDetailError] = createSignal<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = createSignal<string | null>(null);
  const [mutationError, setMutationError] = createSignal<string | null>(null);
  const [dragging, setDragging] = createSignal(false);

  // A new first page (refresh, project switch) resets the accumulated list.
  createEffect(() => {
    const page = props.references;
    setItems(page?.items ?? []);
    setNextCursor(page?.nextCursor ?? null);
    setLoadMoreError(null);
  });

  const rank = () => roleRank(props.sessionRole);
  const canImport = () => canMutate(rank(), props.onImport !== undefined);
  const canDelete = () => canMutate(rank(), props.onDelete !== undefined);

  const visibleItems = () => {
    const query = filter().trim();
    return query.length === 0 ? items() : items().filter((item) => matchesFilter(item, query));
  };

  const loadMore = async (): Promise<void> => {
    const cursor = nextCursor();
    if (cursor === null || props.onLoadMore === undefined) return;
    setLoadMoreError(null);
    try {
      const page = await props.onLoadMore(cursor);
      if (page === null) return;
      const known = new Set(items().map((item) => item.referenceId));
      setItems([...items(), ...page.items.filter((item) => !known.has(item.referenceId))]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setLoadMoreError(lifecycleErrorMessage(error));
    }
  };
  /** Import a batch of files with optimistic rows; failed rows persist with retry. */
  const importFiles = async (files: readonly File[]): Promise<void> => {
    if (props.onImport === undefined) return;
    setMutationError(null);
    const accepted = files.filter((file) => file.size > 0);
    if (accepted.length === 0) return;
    const rows: UploadRow[] = accepted.map((file) => ({
      id: `${Date.now()}-${file.name}-${Math.random()}`,
      fileName: file.name,
      status: 'uploading',
    }));
    setUploads((current) => [...current, ...rows]);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const file = accepted[index];
      if (row === undefined || file === undefined) continue;
      try {
        const result = await props.onImport(file);
        if (result.job.status === 'succeeded') {
          setUploads((current) => current.filter((entry) => entry.id !== row.id));
        } else {
          setUploads((current) =>
            current.map((entry) =>
              entry.id === row.id
                ? {
                    ...entry,
                    status: 'failed' as const,
                    jobId: result.job.jobId,
                    message: result.job.errorMessage ?? '导入任务在 Host 上失败了。',
                  }
                : entry,
            ),
          );
        }
      } catch (error) {
        setUploads((current) =>
          current.map((entry) =>
            entry.id === row.id
              ? { ...entry, status: 'failed' as const, message: lifecycleErrorMessage(error) }
              : entry,
          ),
        );
      }
    }
    // The list always refreshes so newly succeeded imports appear; failed rows
    // stay visible with their durable jobId for retry.
    await props.onRefresh?.();
  };

  const retry = async (row: UploadRow): Promise<void> => {
    if (row.jobId === undefined || props.onRetry === undefined) return;
    setMutationError(null);
    try {
      const result = await props.onRetry(row.jobId);
      if (result === null) return;
      if (result.job.status === 'succeeded') {
        setUploads((current) => current.filter((entry) => entry.id !== row.id));
      } else {
        setUploads((current) =>
          current.map((entry) =>
            entry.id === row.id
              ? {
                  ...entry,
                  message: result.job.errorMessage ?? '导入任务在 Host 上失败了。',
                }
              : entry,
          ),
        );
      }
      await props.onRefresh?.();
    } catch (error) {
      setMutationError(lifecycleErrorMessage(error));
    }
  };

  const confirmDelete = (referenceId: string): void => {
    if (confirmDeleteId() === referenceId) {
      setConfirmDeleteId(null);
      setMutationError(null);
      void (async () => {
        try {
          await props.onDelete?.(referenceId);
          if (selectedId() === referenceId) {
            setSelectedId(null);
            setDetailContent(null);
          }
          await props.onRefresh?.();
        } catch (error) {
          setMutationError(lifecycleErrorMessage(error));
        }
      })();
    } else {
      setConfirmDeleteId(referenceId);
    }
  };

  const openDetail = async (item: ReferenceItemV1): Promise<void> => {
    setSelectedId(item.referenceId);
    setDetailContent(null);
    setDetailError(null);
    if (props.onReadContent === undefined) return;
    try {
      const result = await props.onReadContent(item.referenceId, {
        offset: 0,
        limit: REFERENCE_PREVIEW_BYTES,
      });
      if (result === null) {
        setDetailError('无法读取参考资料内容。');
        return;
      }
      setDetailContent(previewText(result));
    } catch (error) {
      setDetailError(lifecycleErrorMessage(error));
    }
  };

  const selectedItem = () => items().find((item) => item.referenceId === selectedId()) ?? null;

  return (
    <section class="grid max-w-[60rem] gap-6" aria-labelledby="references-heading">
      <header class="flex items-start justify-between gap-4">
        <div>
          <p class={KICKER}>参考资料库</p>
          <h2 id="references-heading">参考资料</h2>
        </div>
        <Show when={props.onRefresh !== undefined}>
          <button
            class={BUTTON}
            type="button"
            data-testid="references-refresh"
            onClick={() => void props.onRefresh?.()}
          >
            刷新
          </button>
        </Show>
      </header>

      <Show when={mutationError() !== null}>
        <div role="alert" data-testid="references-mutation-error">
          <Diagnostic severity="error">{mutationError()}</Diagnostic>
        </div>
      </Show>

      <Show
        when={props.references}
        fallback={
          <Show
            when={props.referencesError !== null && props.referencesError !== undefined}
            fallback={
              <ScreenEmpty
                title="暂无参考资料投影"
                body="在 Host 中打开已认证的项目以加载其参考资料库。"
              />
            }
          >
            <section data-testid="references-load-error">
              <ScreenEmpty title="参考资料库加载失败" body={props.referencesError ?? undefined}>
                <Show when={props.onRefresh !== undefined}>
                  <button
                    class={BUTTON}
                    type="button"
                    data-testid="references-load-retry"
                    onClick={() => void props.onRefresh?.()}
                  >
                    重试
                  </button>
                </Show>
              </ScreenEmpty>
            </section>
          </Show>
        }
      >
        {(catalog) => (
          <section
            aria-labelledby="references-list-heading"
            class="grid gap-4 rounded-[0.625rem] border-2 border-dashed p-4 transition-[border-color,background] duration-[150ms]"
            classList={{
              'border-line': !dragging(),
              'border-accent': dragging(),
              'bg-accent-wash': dragging(),
            }}
            data-testid="references-list-section"
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const files = [...(event.dataTransfer?.files ?? [])];
              void importFiles(files);
            }}
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h3 id="references-list-heading">
                参考资料{' '}
                <span class="publication-count" data-testid="references-count">
                  {catalog().items.length}
                </span>
              </h3>
              <Show when={canImport()}>
                <label class={`${BUTTON} ${BUTTON_PRIMARY}`} data-testid="references-import-open">
                  导入文件
                  <input
                    type="file"
                    multiple
                    data-testid="references-import-input"
                    style={{ display: 'none' }}
                    onChange={(event) => {
                      const files = [...(event.currentTarget.files ?? [])];
                      event.currentTarget.value = '';
                      void importFiles(files);
                    }}
                  />
                </label>
              </Show>
            </div>

            <Show when={canImport()}>
              <div data-testid="references-import-hint">
                <ScreenNote>或将文件拖拽到列表区域导入。</ScreenNote>
              </div>
            </Show>

            <Show when={uploads().length > 0}>
              <ul class="m-0 grid list-none gap-2 p-0" aria-label="待导入">
                <For each={uploads()}>
                  {(row) => (
                    <li
                      class="flex flex-wrap items-center gap-2 rounded-[0.625rem] border border-line bg-surface-muted px-3 py-2 text-[0.8125rem]"
                      data-testid={`reference-upload-${row.status}`}
                    >
                      <span class="wrap-anywhere font-bold">{row.fileName}</span>
                      <Show
                        when={row.status === 'failed'}
                        fallback={<span class="text-muted">导入中…</span>}
                      >
                        <span class="text-danger">{row.message ?? '导入失败'}</span>
                        <Show when={row.jobId !== undefined && props.onRetry !== undefined}>
                          <button
                            class={`${BUTTON} ${BUTTON_GHOST}`}
                            type="button"
                            data-testid={`reference-retry-${row.id}`}
                            onClick={() => void retry(row)}
                          >
                            重试
                          </button>
                        </Show>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>

            <input
              class="rounded-[0.625rem] border border-line bg-surface px-3 py-2 text-ink focus-visible:outline focus-visible:outline-3 focus-visible:outline-focus focus-visible:outline-offset-2"
              type="search"
              aria-label="搜索参考资料"
              placeholder="搜索参考资料…"
              value={filter()}
              onInput={(event) => setFilter(event.currentTarget.value)}
              data-testid="references-search"
            />

            <Show
              when={catalog().items.length > 0 || items().length > 0}
              fallback={
                <section data-testid="references-empty">
                  <ScreenEmpty title="还没有参考资料">
                    <p class="m-0 text-sm leading-[1.6] text-muted">
                      还没有参考资料。点击「导入文件」添加，或让 Agent 用{' '}
                      <code>nova_reference_import_*</code> 帮你导入。
                    </p>
                  </ScreenEmpty>
                </section>
              }
            >
              <Show
                when={visibleItems().length > 0}
                fallback={
                  <div data-testid="references-filter-empty">
                    <ScreenNote>没有匹配「{filter()}」的参考资料。</ScreenNote>
                  </div>
                }
              >
                <ul class="m-0 grid list-none gap-3 p-0" aria-label="参考资料">
                  <For each={visibleItems()}>
                    {(item) => (
                      <li
                        class="grid grid-cols-[1fr_auto] items-center gap-3 rounded-[0.625rem] border border-line bg-surface p-4"
                        data-testid={`reference-row-${item.referenceId}`}
                      >
                        <button
                          class="group grid cursor-pointer gap-1 border-0 bg-transparent p-0 text-left text-ink"
                          type="button"
                          onClick={() => void openDetail(item)}
                        >
                          <span class="wrap-anywhere font-extrabold group-hover:text-accent-deep">
                            {item.displayName}
                          </span>
                          <span class="text-xs text-muted">
                            {item.originalName} · {formatBytes(item.byteLength)}
                          </span>
                          <span class="flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted">
                            <MediaTypeBadge mediaType={item.mediaType} />
                            <Show when={item.authors.length > 0}>
                              <span class="wrap-anywhere">{item.authors.join(', ')}</span>
                            </Show>
                            <Show when={item.sourceUrl !== null}>
                              <a
                                class="wrap-anywhere text-accent-deep"
                                href={item.sourceUrl ?? undefined}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(event) => event.stopPropagation()}
                              >
                                {item.sourceUrl}
                              </a>
                            </Show>
                            <span class="wrap-anywhere">{formatDate(item.createdAt)}</span>
                          </span>
                        </button>
                        <Show when={canDelete()}>
                          <button
                            class={`${BUTTON} ${BUTTON_GHOST} whitespace-nowrap`}
                            type="button"
                            data-testid={`reference-delete-${item.referenceId}`}
                            onClick={() => confirmDelete(item.referenceId)}
                          >
                            {confirmDeleteId() === item.referenceId ? '确认删除？' : '删除'}
                          </button>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>

              <Show when={nextCursor() !== null && props.onLoadMore !== undefined}>
                <button
                  class={BUTTON}
                  type="button"
                  data-testid="references-load-more"
                  onClick={() => void loadMore()}
                >
                  加载更多
                </button>
              </Show>
              <Show when={loadMoreError() !== null}>
                <div role="alert">
                  <Diagnostic severity="error">{loadMoreError()}</Diagnostic>
                </div>
              </Show>
            </Show>
          </section>
        )}
      </Show>

      <Show when={selectedItem() !== null}>
        <section
          class="grid gap-4 rounded-[0.625rem] border border-line bg-surface p-5"
          aria-labelledby="reference-detail-heading"
        >
          <div class="flex items-center justify-between gap-3">
            <h3 id="reference-detail-heading" class="m-0 wrap-anywhere">
              {selectedItem()?.displayName}
            </h3>
            <button
              class={`${BUTTON} ${BUTTON_GHOST}`}
              type="button"
              onClick={() => setSelectedId(null)}
              data-testid="references-detail-close"
            >
              关闭
            </button>
          </div>
          <dl class="m-0 grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-2">
            <div class="grid gap-1 rounded-[0.625rem] bg-surface-muted px-3 py-2">
              <dt class="text-[0.625rem] font-extrabold text-muted">原文文件名</dt>
              <dd class="m-0 wrap-anywhere text-[0.8125rem]">{selectedItem()?.originalName}</dd>
            </div>
            <div class="grid gap-1 rounded-[0.625rem] bg-surface-muted px-3 py-2">
              <dt class="text-[0.625rem] font-extrabold text-muted">类型</dt>
              <dd class="m-0 wrap-anywhere text-[0.8125rem]">
                <MediaTypeBadge mediaType={selectedItem()?.mediaType ?? ''} />
              </dd>
            </div>
            <div class="grid gap-1 rounded-[0.625rem] bg-surface-muted px-3 py-2">
              <dt class="text-[0.625rem] font-extrabold text-muted">大小</dt>
              <dd class="m-0 wrap-anywhere text-[0.8125rem]">
                {formatBytes(selectedItem()?.byteLength ?? 0)}
              </dd>
            </div>
            <Show when={selectedItem()?.title !== null}>
              <div class="grid gap-1 rounded-[0.625rem] bg-surface-muted px-3 py-2">
                <dt class="text-[0.625rem] font-extrabold text-muted">标题</dt>
                <dd class="m-0 wrap-anywhere text-[0.8125rem]">{selectedItem()?.title}</dd>
              </div>
            </Show>
            <Show when={(selectedItem()?.authors.length ?? 0) > 0}>
              <div class="grid gap-1 rounded-[0.625rem] bg-surface-muted px-3 py-2">
                <dt class="text-[0.625rem] font-extrabold text-muted">作者</dt>
                <dd class="m-0 wrap-anywhere text-[0.8125rem]">
                  {selectedItem()?.authors.join(', ')}
                </dd>
              </div>
            </Show>
            <Show when={selectedItem()?.sourceUrl !== null}>
              <div class="grid gap-1 rounded-[0.625rem] bg-surface-muted px-3 py-2">
                <dt class="text-[0.625rem] font-extrabold text-muted">来源</dt>
                <dd class="m-0 wrap-anywhere text-[0.8125rem]">{selectedItem()?.sourceUrl}</dd>
              </div>
            </Show>
            <Show when={selectedItem()?.license !== null}>
              <div class="grid gap-1 rounded-[0.625rem] bg-surface-muted px-3 py-2">
                <dt class="text-[0.625rem] font-extrabold text-muted">许可</dt>
                <dd class="m-0 wrap-anywhere text-[0.8125rem]">{selectedItem()?.license}</dd>
              </div>
            </Show>
            <Show when={(selectedItem()?.tags.length ?? 0) > 0}>
              <div class="grid gap-1 rounded-[0.625rem] bg-surface-muted px-3 py-2">
                <dt class="text-[0.625rem] font-extrabold text-muted">标签</dt>
                <dd class="m-0 wrap-anywhere text-[0.8125rem]">
                  {selectedItem()?.tags.join(', ')}
                </dd>
              </div>
            </Show>
          </dl>
          <Show when={detailError() !== null}>
            <div role="alert">
              <Diagnostic severity="error">{detailError()}</Diagnostic>
            </div>
          </Show>
          <Show when={detailContent() !== null}>
            <pre
              class="m-0 max-h-96 overflow-auto whitespace-pre-wrap rounded-[0.625rem] bg-surface-deep p-3 font-mono text-xs text-ink-soft wrap-anywhere"
              data-testid="references-detail-content"
            >
              {detailContent()}
            </pre>
          </Show>
        </section>
      </Show>
    </section>
  );
}
