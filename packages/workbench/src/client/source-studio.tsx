import { For, Show } from 'solid-js';
import type { SourceStudioDocumentDescriptorV1, SourceStudioStateV1 } from '../contracts/index.js';

/**
 * Browser-local working-layer connection status. It is UI state, never
 * Host-derived: the component reports it but never binds a socket itself.
 */
export type SourceStudioYjsStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'unavailable';

export interface SourceStudioProps {
  /** Host-provided Source Studio state; null = not loaded yet (or load failed). */
  readonly state: SourceStudioStateV1 | null;
  /** Working-layer connection status per document id; absent entries read as `idle`. */
  readonly yjsStatus?: Readonly<Record<string, SourceStudioYjsStatus>>;
  /** Explicit Host connect handler; absent = no connect action is offered. */
  readonly onConnectYjs?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  /**
   * Explicit Host submit handler. Absent = no submit/authoring action is
   * offered at all; the component never writes or adopts source itself.
   */
  readonly onSubmit?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
}

/**
 * Source Studio: renders only Host-provided accepted state, labels the
 * accepted projection as last-valid and the Yjs working layer as an
 * online-only noncanonical surface, and never offers a submit/authoring
 * action without a Host-provided handler. It constructs no project facts and
 * no source bytes — every rendered value comes from the injected DTO.
 */
export function SourceStudio(props: SourceStudioProps) {
  const statusOf = (documentId: string): SourceStudioYjsStatus =>
    props.yjsStatus?.[documentId] ?? 'idle';
  return (
    <section class="source-studio" aria-labelledby="source-studio-heading">
      <header>
        <p class="region-kicker">Source Studio</p>
        <h2 id="source-studio-heading">Authoring source</h2>
      </header>
      <Show
        when={props.state}
        fallback={
          <div class="screen-empty" aria-live="polite">
            <h3>No source state</h3>
            <p>The Host has not provided Source Studio state for this project.</p>
          </div>
        }
      >
        {(state) => (
          <>
            <section class="accepted-source" aria-labelledby="accepted-source-heading">
              <header>
                <h3 id="accepted-source-heading">Accepted source — last valid projection</h3>
                <p class="screen-note">
                  This is the last source the Host validated and accepted. Working-layer edits below
                  never change it.
                </p>
              </header>
              <Show
                when={state().accepted}
                fallback={
                  <p class="screen-note">
                    The Host has no accepted source projection for this project yet.
                  </p>
                }
              >
                {(accepted) => (
                  <>
                    <dl class="projection-metrics">
                      <div>
                        <dt>Projection revision</dt>
                        <dd>{accepted().revision}</dd>
                      </div>
                      <div>
                        <dt>Source hash</dt>
                        <dd>
                          <code>{accepted().sourceHash ?? 'none accepted'}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Documents</dt>
                        <dd>{accepted().documents}</dd>
                      </div>
                      <div>
                        <dt>Scenes</dt>
                        <dd>{accepted().events}</dd>
                      </div>
                      <div>
                        <dt>Rendered</dt>
                        <dd>{accepted().rendered}</dd>
                      </div>
                      <div>
                        <dt>Blocked</dt>
                        <dd>{accepted().blocked}</dd>
                      </div>
                      <div>
                        <dt>Warnings</dt>
                        <dd>{accepted().warningCount}</dd>
                      </div>
                      <div>
                        <dt>Errors</dt>
                        <dd>{accepted().errorCount}</dd>
                      </div>
                    </dl>
                    <Show when={accepted().diagnostics.length > 0}>
                      <ul class="diagnostic-list" aria-label="Accepted source diagnostics">
                        <For each={accepted().diagnostics}>
                          {(diagnostic) => (
                            <li class={`diagnostic diagnostic-${diagnostic.severity}`}>
                              <code>{diagnostic.code}</code> {diagnostic.message}
                              <Show when={diagnostic.logicalPath !== null}>
                                <span class="diagnostic-path"> — {diagnostic.logicalPath}</span>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </>
                )}
              </Show>
            </section>
            <section class="working-layer" aria-labelledby="working-layer-heading">
              <header>
                <h3 id="working-layer-heading">
                  Working layer (Yjs) — online-only, not accepted source
                </h3>
                <p class="screen-note">
                  Working-layer edits are noncanonical and are never adopted as accepted source
                  until the Host validates and submits them.
                </p>
              </header>
              <Show
                when={state().working.documents.length > 0}
                fallback={
                  <p class="screen-note">The Host reports no working documents for this project.</p>
                }
              >
                <ul class="working-document-list">
                  <For each={state().working.documents}>
                    {(descriptor) => (
                      <li class="working-document" data-available={descriptor.available}>
                        <div class="working-document-identity">
                          <code>{descriptor.documentId}</code>
                          <span class="document-kind">{descriptor.kind}</span>
                          <span class="document-status">
                            {descriptor.available ? 'available' : 'unavailable'}
                          </span>
                          <span class="document-status">{statusOf(descriptor.documentId)}</span>
                        </div>
                        <Show when={props.onConnectYjs !== undefined}>
                          <button
                            type="button"
                            disabled={!descriptor.available}
                            onClick={() => props.onConnectYjs?.(descriptor)}
                          >
                            Connect working document
                          </button>
                        </Show>
                        <Show when={props.onSubmit !== undefined}>
                          <button
                            type="button"
                            disabled={!descriptor.available}
                            onClick={() => props.onSubmit?.(descriptor)}
                          >
                            Submit working document to Host
                          </button>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
          </>
        )}
      </Show>
    </section>
  );
}
