import { createSignal, For, Show } from 'solid-js';
import { PROJECT_ACCESS_ROLE_GRANTS } from '../contracts/configuration.js';
import type {
  BrowserPublicationListV1,
  BrowserPublicationReadQueryV1,
  BrowserPublicationReadResultV1,
  BrowserPublicationRecordV1,
  BrowserPublishRequestV1,
  ProjectAccessRole,
} from '../contracts/index.js';
import { BrowserPublicationApiError } from './browser-publication-api.js';

export interface PublicationViewProps {
  /** Project identity for publish requests; null when no project is open. */
  readonly projectId: string | null;
  /** Host publication catalog; null = not loaded yet (or the load failed). */
  readonly publications?: BrowserPublicationListV1 | null;
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
  return error instanceof Error ? error.message : 'The publication request was not accepted.';
}

/** Project-relative artifact file → local download filename (basename only). */
function downloadFilename(record: BrowserPublicationRecordV1): string {
  const parts = record.relativeOutputPath.split('/');
  const leaf = parts[parts.length - 1];
  return leaf.length > 0 ? leaf : `${record.publicationId}.md`;
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
      class="publication-card"
      data-publication-id={record().publicationId}
      data-status={record().status}
      data-kind={record().kind}
    >
      <div class="publication-heading">
        <span class="publication-kind" data-kind={record().kind}>
          {record().kind}
        </span>
        <span class="publication-status" data-status={record().status}>
          {record().status}
        </span>
        <code class="publication-id">{record().publicationId}</code>
      </div>
      <dl class="publication-meta">
        <div>
          <dt>File</dt>
          <dd>
            <code>{record().relativeOutputPath}</code>
          </dd>
        </div>
        <div>
          <dt>Novel hash</dt>
          <dd>
            <code title={record().novelHash}>{shortHash(record().novelHash)}</code>
          </dd>
        </div>
        <div>
          <dt>Source hash</dt>
          <dd>
            <code title={record().sourceHash}>{shortHash(record().sourceHash)}</code>
          </dd>
        </div>
        <div>
          <dt>Scope hash</dt>
          <dd>
            <code title={record().scopeHash}>{shortHash(record().scopeHash)}</code>
          </dd>
        </div>
        <div>
          <dt>Scenes</dt>
          <dd>{record().sceneCount}</dd>
        </div>
        <div>
          <dt>Words</dt>
          <dd>{record().wordCount}</dd>
        </div>
        <div>
          <dt>Bytes</dt>
          <dd>{record().byteLength}</dd>
        </div>
        <div>
          <dt>Revisions</dt>
          <dd>{record().revisionIds.length}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{record().updatedAt}</dd>
        </div>
      </dl>
      <Show when={record().staleReasons.length > 0}>
        <section class="publication-stale" aria-label="Stale reasons">
          <h4>Stale reasons</h4>
          <ul>
            <For each={record().staleReasons}>
              {(reason) => (
                <li data-stale-reason={reason}>
                  <code>{reason}</code>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={props.onRead !== undefined}>
        <button
          class="text-button"
          type="button"
          disabled={downloading()}
          data-testid={`publication-download-${record().publicationId}`}
          onClick={() => void download()}
        >
          {downloading() ? 'Downloading…' : 'Download'}
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
 * path). Empty/loading states are honest and no mock data is ever rendered.
 */
export function PublicationView(props: PublicationViewProps) {
  const [mutationError, setMutationError] = createSignal<string | null>(null);
  const [publishOpen, setPublishOpen] = createSignal(false);
  const [branchPath, setBranchPath] = createSignal('');
  const [discourseBranch, setDiscourseBranch] = createSignal('');
  const [title, setTitle] = createSignal('');

  const rank = () => roleRank(props.sessionRole);
  const canPublish = () => roleAllows(rank(), 3) && props.onPublish !== undefined;

  const runMutation = async (mutation: () => void | Promise<void>): Promise<void> => {
    setMutationError(null);
    try {
      await mutation();
      await props.onRefresh?.();
    } catch (error) {
      setMutationError(lifecycleErrorMessage(error));
    }
  };

  const publish = () => {
    const projectId = props.projectId;
    if (projectId === null) return;
    let parsedBranchPath: unknown;
    const raw = branchPath().trim();
    if (raw.length > 0) {
      try {
        const value: unknown = JSON.parse(raw);
        if (
          typeof value !== 'object' ||
          value === null ||
          Array.isArray(value) ||
          !('decisions' in value) ||
          !Array.isArray(value.decisions)
        ) {
          throw new Error('invalid shape');
        }
        parsedBranchPath = { version: 1, branchPath: value };
      } catch {
        setMutationError('--branch path must be JSON like {"decisions": []}.');
        return;
      }
    }
    const request: BrowserPublishRequestV1 = {
      version: 1,
      projectId,
      ...(parsedBranchPath === undefined
        ? {}
        : { branchPath: parsedBranchPath as BrowserPublishRequestV1['branchPath'] }),
      ...(discourseBranch().trim().length === 0
        ? {}
        : { discourseBranch: discourseBranch().trim() }),
      ...(title().trim().length === 0 ? {} : { title: title().trim() }),
    };
    void runMutation(() => props.onPublish?.(request));
    setBranchPath('');
    setDiscourseBranch('');
    setTitle('');
    setPublishOpen(false);
  };

  return (
    <section class="publication-view" aria-labelledby="publication-heading">
      <header class="publication-header">
        <div>
          <p class="region-kicker">Assembled novel</p>
          <h2 id="publication-heading">Publication</h2>
        </div>
        <Show when={props.onRefresh !== undefined}>
          <button
            class="text-button"
            type="button"
            data-testid="publication-refresh"
            onClick={() => void props.onRefresh?.()}
          >
            Refresh
          </button>
        </Show>
      </header>

      <Show when={mutationError() !== null}>
        <p
          class="diagnostic diagnostic-error"
          role="alert"
          data-testid="publication-mutation-error"
        >
          {mutationError()}
        </p>
      </Show>

      <Show
        when={props.publications}
        fallback={
          <section class="screen-empty" aria-live="polite">
            <h3>No publication projection</h3>
            <p>Open an authenticated project in the Host to load its publication records.</p>
          </section>
        }
      >
        {(catalog) => (
          <section class="publication-list-section" aria-labelledby="publication-list-heading">
            <div class="publication-section-heading">
              <h3 id="publication-list-heading">
                Publications{' '}
                <span class="publication-count" data-testid="publication-count">
                  {catalog().publications.length}
                </span>
              </h3>
              <Show when={canPublish()}>
                <Show
                  when={publishOpen()}
                  fallback={
                    <button
                      class="text-button"
                      type="button"
                      data-testid="publication-publish-open"
                      onClick={() => setPublishOpen(true)}
                    >
                      Publish
                    </button>
                  }
                >
                  <form
                    class="publication-publish-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      publish();
                    }}
                  >
                    <input
                      aria-label="Branch path JSON"
                      placeholder='Branch path JSON (e.g. {"decisions": []})'
                      value={branchPath()}
                      onInput={(event) => setBranchPath(event.currentTarget.value)}
                      data-testid="publication-branch-path"
                    />
                    <input
                      aria-label="Discourse branch"
                      placeholder="Discourse branch (optional)"
                      value={discourseBranch()}
                      onInput={(event) => setDiscourseBranch(event.currentTarget.value)}
                      data-testid="publication-discourse-branch"
                    />
                    <input
                      aria-label="Title"
                      placeholder="Title (optional)"
                      value={title()}
                      onInput={(event) => setTitle(event.currentTarget.value)}
                      data-testid="publication-title"
                    />
                    <button
                      class="text-button"
                      type="submit"
                      data-testid="publication-publish-save"
                    >
                      Publish
                    </button>
                    <button class="text-button" type="button" onClick={() => setPublishOpen(false)}>
                      Cancel
                    </button>
                  </form>
                </Show>
              </Show>
            </div>
            <Show
              when={catalog().publications.length > 0}
              fallback={
                <p class="screen-note">
                  No publications yet. Publish the accepted novel to produce an artifact.
                </p>
              }
            >
              <ul class="publication-list" aria-label="Publications">
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
