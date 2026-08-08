import { Show } from 'solid-js';
import type { SceneAdoptionViewV1 } from '../contracts/index.js';
import { Badge } from './ui/controls';
import { BUTTON, BUTTON_PRIMARY, EmptyState, KICKER } from './ui/primitives';

export interface SceneCanvasProps {
  readonly adoption: SceneAdoptionViewV1 | null;
  /** Adoption preview load failure; non-null renders a distinct retry state. */
  readonly adoptionError?: string | null;
  /** Opens the Host-backed explicit adoption flow; it never writes source itself. */
  readonly onRequestAdoption?: (candidate: SceneAdoptionViewV1) => void;
  /** Re-requests the last adoption preview after a load failure. */
  readonly onRetryAdoption?: () => void | Promise<void>;
}

/**
 * Scene Canvas adoption panel. Generated prose remains non-authoring until a
 * human explicitly requests adoption and the Host derives a manifest claim.
 */
export function SceneCanvas(props: SceneCanvasProps) {
  return (
    <section class="mx-auto grid max-w-[60rem] gap-6" aria-labelledby="scene-canvas-heading">
      <header class="grid gap-1">
        <p class={KICKER}>Scene Canvas</p>
        <h2 id="scene-canvas-heading">Accepted scene revision</h2>
      </header>
      <Show
        when={props.adoption}
        fallback={
          <Show
            when={props.adoptionError !== null && props.adoptionError !== undefined}
            fallback={
              <EmptyState
                title="No released scene revision"
                body="Render or revise a scene in the Host before adoption can be considered."
              />
            }
          >
            <div role="alert" data-testid="scene-adoption-error">
              <EmptyState
                title="Adoption preview could not be loaded"
                body={props.adoptionError}
                actions={
                  <Show when={props.onRetryAdoption !== undefined}>
                    <button
                      class={BUTTON}
                      type="button"
                      data-testid="scene-adoption-retry"
                      onClick={() => void props.onRetryAdoption?.()}
                    >
                      Retry
                    </button>
                  </Show>
                }
              />
            </div>
          </Show>
        }
      >
        {(candidate) => (
          <div
            class="grid gap-4 rounded-[0.625rem] border border-line bg-surface p-5 shadow-[var(--wb-shadow-panel)]"
            aria-live="polite"
          >
            <div class="flex flex-wrap items-center gap-2">
              <Badge tone={candidate().released ? 'success' : 'accent'}>
                {candidate().released ? 'Released' : 'Not released'}
              </Badge>
            </div>
            <h3>Generated prose is not authoring source yet</h3>
            <p class="m-0 text-sm leading-[1.6] text-ink-soft">{candidate().disclosure}.</p>
            <dl class="m-0 grid gap-2">
              <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted px-3 py-2">
                <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                  Scene
                </dt>
                <dd class="m-0 text-[0.8125rem] break-words">{candidate().eventId}</dd>
              </div>
              <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted px-3 py-2">
                <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                  Revision
                </dt>
                <dd class="m-0 text-[0.8125rem] break-words">
                  <code class="text-xs">{candidate().revisionId}</code>
                </dd>
              </div>
              <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted px-3 py-2">
                <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                  Prose hash
                </dt>
                <dd class="m-0 text-[0.8125rem] break-words">
                  <code class="text-xs">{candidate().proseHash}</code>
                </dd>
              </div>
            </dl>
            <button
              class={`${BUTTON} ${BUTTON_PRIMARY}`}
              type="button"
              disabled={!candidate().released || props.onRequestAdoption === undefined}
              onClick={() => props.onRequestAdoption?.(candidate())}
            >
              收下这版
            </button>
          </div>
        )}
      </Show>
    </section>
  );
}
