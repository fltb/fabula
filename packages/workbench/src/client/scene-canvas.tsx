import { Show } from 'solid-js';
import type { SceneAdoptionViewV1 } from '../contracts/index.js';

export interface SceneCanvasProps {
  readonly adoption: SceneAdoptionViewV1 | null;
  /** Opens the Host-backed explicit adoption flow; it never writes source itself. */
  readonly onRequestAdoption?: (candidate: SceneAdoptionViewV1) => void;
}

/**
 * Scene Canvas adoption panel. Generated prose remains non-authoring until a
 * human explicitly requests adoption and the Host derives a manifest claim.
 */
export function SceneCanvas(props: SceneCanvasProps) {
  return (
    <section class="scene-canvas" aria-labelledby="scene-canvas-heading">
      <header>
        <p class="region-kicker">Scene Canvas</p>
        <h2 id="scene-canvas-heading">Accepted scene revision</h2>
      </header>
      <Show
        when={props.adoption}
        fallback={
          <div class="screen-empty" aria-live="polite">
            <h3>No released scene revision</h3>
            <p>Render or revise a scene in the Host before adoption can be considered.</p>
          </div>
        }
      >
        {(candidate) => (
          <div class="adoption-notice" aria-live="polite">
            <h3>Generated prose is not authoring source yet</h3>
            <p>{candidate().disclosure}.</p>
            <dl>
              <div>
                <dt>Scene</dt>
                <dd>{candidate().eventId}</dd>
              </div>
              <div>
                <dt>Revision</dt>
                <dd>
                  <code>{candidate().revisionId}</code>
                </dd>
              </div>
              <div>
                <dt>Prose hash</dt>
                <dd>
                  <code>{candidate().proseHash}</code>
                </dd>
              </div>
            </dl>
            <button
              type="button"
              disabled={!candidate().released || props.onRequestAdoption === undefined}
              onClick={() => props.onRequestAdoption?.(candidate())}
            >
              Adopt into authoring manifest
            </button>
          </div>
        )}
      </Show>
    </section>
  );
}
