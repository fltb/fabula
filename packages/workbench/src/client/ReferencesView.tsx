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
  return error instanceof Error ? error.message : 'The reference operation failed.';
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
    <span class="badge reference-media-badge" title={props.mediaType}>
      {props.mediaType}
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
                    message: result.job.errorMessage ?? 'The import job failed on the host.',
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
                  message: result.job.errorMessage ?? 'The import job failed on the host.',
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
        setDetailError('The reference content could not be read.');
        return;
      }
      setDetailContent(previewText(result));
    } catch (error) {
      setDetailError(lifecycleErrorMessage(error));
    }
  };

  const selectedItem = () => items().find((item) => item.referenceId === selectedId()) ?? null;

  return (
    <section class="reference-view" aria-labelledby="references-heading">
      <header class="reference-header">
        <div>
          <p class="region-kicker">Reference library</p>
          <h2 id="references-heading">References</h2>
        </div>
        <Show when={props.onRefresh !== undefined}>
          <button
            class="btn"
            type="button"
            data-testid="references-refresh"
            onClick={() => void props.onRefresh?.()}
          >
            Refresh
          </button>
        </Show>
      </header>

      <Show when={mutationError() !== null}>
        <p class="diagnostic diagnostic-error" role="alert" data-testid="references-mutation-error">
          {mutationError()}
        </p>
      </Show>

      <Show
        when={props.references}
        fallback={
          <Show
            when={props.referencesError !== null && props.referencesError !== undefined}
            fallback={
              <section class="screen-empty" aria-live="polite">
                <h3>No reference projection</h3>
                <p>Open an authenticated project in the Host to load its reference library.</p>
              </section>
            }
          >
            <section class="screen-empty" aria-live="polite" data-testid="references-load-error">
              <h3>Reference library could not be loaded</h3>
              <p>{props.referencesError}</p>
              <Show when={props.onRefresh !== undefined}>
                <button
                  class="btn"
                  type="button"
                  data-testid="references-load-retry"
                  onClick={() => void props.onRefresh?.()}
                >
                  Retry
                </button>
              </Show>
            </section>
          </Show>
        }
      >
        {(catalog) => (
          <div
            class={`reference-list-section${dragging() ? ' reference-dragging' : ''}`}
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
            <div class="reference-section-heading">
              <h3 id="references-list-heading">
                References{' '}
                <span class="publication-count" data-testid="references-count">
                  {catalog().items.length}
                </span>
              </h3>
              <Show when={canImport()}>
                <label class="btn btn-primary" data-testid="references-import-open">
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
              <p class="screen-note" data-testid="references-import-hint">
                或将文件拖拽到列表区域导入。
              </p>
            </Show>

            <Show when={uploads().length > 0}>
              <ul class="reference-uploads" aria-label="Pending imports">
                <For each={uploads()}>
                  {(row) => (
                    <li
                      class={`reference-upload reference-upload-${row.status}`}
                      data-testid={`reference-upload-${row.status}`}
                    >
                      <span class="reference-upload-name">{row.fileName}</span>
                      <Show
                        when={row.status === 'failed'}
                        fallback={<span class="reference-upload-state">导入中…</span>}
                      >
                        <span class="reference-upload-state">{row.message ?? '导入失败'}</span>
                        <Show when={row.jobId !== undefined && props.onRetry !== undefined}>
                          <button
                            class="btn btn-ghost"
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
              class="reference-filter"
              type="search"
              aria-label="Search references"
              placeholder="搜索参考资料…"
              value={filter()}
              onInput={(event) => setFilter(event.currentTarget.value)}
              data-testid="references-search"
            />

            <Show
              when={catalog().items.length > 0 || items().length > 0}
              fallback={
                <section class="screen-empty" aria-live="polite" data-testid="references-empty">
                  <h3>还没有参考资料</h3>
                  <p>
                    还没有参考资料。点击「导入文件」添加，或让 Agent 用{' '}
                    <code>nova_reference_import_*</code> 帮你导入。
                  </p>
                </section>
              }
            >
              <Show
                when={visibleItems().length > 0}
                fallback={
                  <p class="screen-note" data-testid="references-filter-empty">
                    没有匹配「{filter()}」的参考资料。
                  </p>
                }
              >
                <ul class="reference-list" aria-label="References">
                  <For each={visibleItems()}>
                    {(item) => (
                      <li class="reference-row" data-testid={`reference-row-${item.referenceId}`}>
                        <button
                          class="reference-row-main"
                          type="button"
                          onClick={() => void openDetail(item)}
                        >
                          <span class="reference-row-title">{item.displayName}</span>
                          <span class="reference-row-subline">
                            {item.originalName} · {formatBytes(item.byteLength)}
                          </span>
                          <span class="reference-row-meta">
                            <MediaTypeBadge mediaType={item.mediaType} />
                            <Show when={item.authors.length > 0}>
                              <span class="reference-row-authors">{item.authors.join(', ')}</span>
                            </Show>
                            <Show when={item.sourceUrl !== null}>
                              <a
                                class="reference-row-source"
                                href={item.sourceUrl ?? undefined}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(event) => event.stopPropagation()}
                              >
                                {item.sourceUrl}
                              </a>
                            </Show>
                            <span class="reference-row-date">{formatDate(item.createdAt)}</span>
                          </span>
                        </button>
                        <Show when={canDelete()}>
                          <button
                            class="btn btn-ghost reference-row-delete"
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
                  class="btn"
                  type="button"
                  data-testid="references-load-more"
                  onClick={() => void loadMore()}
                >
                  加载更多
                </button>
              </Show>
              <Show when={loadMoreError() !== null}>
                <p class="diagnostic diagnostic-error" role="alert">
                  {loadMoreError()}
                </p>
              </Show>
            </Show>
          </div>
        )}
      </Show>

      <Show when={selectedItem() !== null}>
        <section class="reference-detail" aria-labelledby="reference-detail-heading">
          <div class="reference-detail-heading">
            <h3 id="reference-detail-heading">{selectedItem()?.displayName}</h3>
            <button
              class="btn btn-ghost"
              type="button"
              onClick={() => setSelectedId(null)}
              data-testid="references-detail-close"
            >
              关闭
            </button>
          </div>
          <dl class="reference-detail-meta">
            <div>
              <dt>原文文件名</dt>
              <dd>{selectedItem()?.originalName}</dd>
            </div>
            <div>
              <dt>类型</dt>
              <dd>
                <MediaTypeBadge mediaType={selectedItem()?.mediaType ?? ''} />
              </dd>
            </div>
            <div>
              <dt>大小</dt>
              <dd>{formatBytes(selectedItem()?.byteLength ?? 0)}</dd>
            </div>
            <Show when={selectedItem()?.title !== null}>
              <div>
                <dt>标题</dt>
                <dd>{selectedItem()?.title}</dd>
              </div>
            </Show>
            <Show when={(selectedItem()?.authors.length ?? 0) > 0}>
              <div>
                <dt>作者</dt>
                <dd>{selectedItem()?.authors.join(', ')}</dd>
              </div>
            </Show>
            <Show when={selectedItem()?.sourceUrl !== null}>
              <div>
                <dt>来源</dt>
                <dd>{selectedItem()?.sourceUrl}</dd>
              </div>
            </Show>
            <Show when={selectedItem()?.license !== null}>
              <div>
                <dt>许可</dt>
                <dd>{selectedItem()?.license}</dd>
              </div>
            </Show>
            <Show when={(selectedItem()?.tags.length ?? 0) > 0}>
              <div>
                <dt>标签</dt>
                <dd>{selectedItem()?.tags.join(', ')}</dd>
              </div>
            </Show>
          </dl>
          <Show when={detailError() !== null}>
            <p class="diagnostic diagnostic-error" role="alert">
              {detailError()}
            </p>
          </Show>
          <Show when={detailContent() !== null}>
            <pre class="reference-detail-content" data-testid="references-detail-content">
              {detailContent()}
            </pre>
          </Show>
        </section>
      </Show>
    </section>
  );
}
