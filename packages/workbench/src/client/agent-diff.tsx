import { For, Show } from 'solid-js';
import type { AgentProposalChangeV1, AgentProposalV1 } from './agent-client.js';

export interface AgentDiffBlockV1 extends AgentProposalChangeV1 {
  readonly index: number;
  readonly end: number;
}

export interface AgentDiffProps {
  readonly proposal: AgentProposalV1;
  /** Apply is deliberately injected; this component never calls the Host itself. */
  readonly onApply?: () => void;
  readonly applyDisabled?: boolean;
}

/**
 * Turns a revision-bound proposal into deterministic blocks for review. The
 * helper is pure so editor surfaces can render the same diff without adopting
 * a second document model.
 */
export function getAgentDiffBlocks(proposal: AgentProposalV1): readonly AgentDiffBlockV1[] {
  return proposal.changes.map((change, index) => ({
    ...change,
    index,
    end: change.from + change.length,
  }));
}

function safeDiffText(value: string): string {
  // Keep control characters from changing the drawer's structure. The Host
  // bounds proposal text; this is an additional display-only guard.
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�');
}

/** Renders proposal-only block diffs and an explicit human Apply action. */
export function AgentDiff(props: AgentDiffProps) {
  const blocks = () => getAgentDiffBlocks(props.proposal);
  return (
    <section
      class="grid gap-[var(--wb-space-3)]"
      aria-labelledby="agent-diff-heading"
      data-testid="agent-diff"
    >
      <header class="grid gap-[var(--wb-space-1)]">
        <p class="region-kicker">Reviewable proposal</p>
        <h3 id="agent-diff-heading">Changes waiting for your review</h3>
        <p class="screen-note">
          Nothing is written until you choose Apply. Applying updates the working layer, not the
          accepted projection.
        </p>
      </header>

      <Show
        when={blocks().length > 0}
        fallback={
          <p class="screen-note" aria-live="polite">
            The Host proposed no document changes.
          </p>
        }
      >
        <ol
          class="grid list-none gap-[var(--wb-space-3)] p-0"
          aria-label="Assistant proposal changes"
        >
          <For each={blocks()}>
            {(block) => (
              <li
                class="grid gap-[var(--wb-space-2)] rounded-[var(--wb-radius-md)] border border-[var(--wb-border)] bg-[var(--wb-surface-muted)] p-[var(--wb-space-3)]"
                data-testid="agent-diff-block"
              >
                <div class="flex flex-wrap items-baseline justify-between gap-[var(--wb-space-2)]">
                  <strong>Block {block.index + 1}</strong>
                  <code class="text-[0.75rem] text-[var(--wb-muted)]">
                    characters {block.from}–{block.end}
                  </code>
                </div>
                <Show when={block.before !== undefined}>
                  <div class="grid gap-[var(--wb-space-1)]">
                    <span class="text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-[var(--wb-muted)]">
                      Original
                    </span>
                    <pre class="m-0 overflow-x-auto whitespace-pre-wrap rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-[var(--wb-surface)] p-[var(--wb-space-2)] text-[0.8125rem] text-[var(--wb-danger)]">
                      <del>{safeDiffText(block.before ?? '')}</del>
                    </pre>
                  </div>
                </Show>
                <div class="grid gap-[var(--wb-space-1)]">
                  <span class="text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-[var(--wb-success)]">
                    Proposed
                  </span>
                  <pre class="m-0 overflow-x-auto whitespace-pre-wrap rounded-[var(--wb-radius-sm)] border border-[var(--wb-ready-border)] bg-[var(--wb-ready-surface)] p-[var(--wb-space-2)] text-[0.8125rem] text-[var(--wb-ink)]">
                    <ins>{safeDiffText(block.text)}</ins>
                  </pre>
                </div>
              </li>
            )}
          </For>
        </ol>
      </Show>

      <Show when={props.onApply !== undefined}>
        <button
          type="button"
          class="inline-flex min-h-[2.5rem] items-center justify-center rounded-[var(--wb-radius-sm)] bg-[var(--wb-accent)] px-[var(--wb-space-4)] py-[var(--wb-space-2)] font-semibold text-[var(--wb-on-ink)] transition-colors hover:bg-[var(--wb-accent-deep)] focus-visible:outline-[0.1875rem] focus-visible:outline-[var(--wb-focus)] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={props.applyDisabled || blocks().length === 0}
          onClick={() => props.onApply?.()}
        >
          {props.applyDisabled ? 'Applying…' : 'Apply changes'}
        </button>
      </Show>
    </section>
  );
}
