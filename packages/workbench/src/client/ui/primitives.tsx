import type { JSX } from 'solid-js';
import { Show } from 'solid-js';

/**
 * Shared tailwind class strings and stateless primitives for the Workbench
 * browser client. Semantic colors/spacing come from the `@theme` aliases in
 * styles.css; values mirror the pre-refactor `--wb-*` rules they replace.
 */

/** Replaces `.region-kicker`. */
export const KICKER =
  'mb-1 text-[0.625rem] font-extrabold uppercase leading-[1.2] tracking-[0.12em] text-muted';

/** Replaces `.view-button` (+ `.is-active`). */
export const VIEW_BUTTON =
  'flex w-full min-h-[2.625rem] cursor-pointer items-center gap-3 rounded-[0.375rem] border border-transparent px-3 py-2 text-left text-[0.8125rem] font-semibold text-ink-soft transition-[color,background,border-color] duration-[160ms] hover:bg-surface-muted hover:text-ink';
export const VIEW_BUTTON_ACTIVE =
  'border-empty-border! bg-accent-wash! text-accent-deep! hover:bg-accent-wash! hover:text-accent-deep!';
/** Replaces `.btn` (+ `.btn-primary` / `.btn-ghost` variants). */
export const BUTTON =
  'inline-flex min-h-9 cursor-pointer items-center justify-center gap-2 rounded-[0.375rem] border border-line bg-surface px-4 py-2 text-xs font-extrabold tracking-[0.03em] text-accent-deep transition-[color,background,border-color] duration-[160ms] hover:border-empty-border hover:bg-accent-wash hover:text-accent-deep disabled:cursor-not-allowed disabled:border-line disabled:bg-surface-muted disabled:text-muted';
export const BUTTON_PRIMARY =
  'border-accent-deep! bg-accent! text-on-ink! hover:border-accent-deep! hover:bg-accent-deep! hover:text-on-ink! disabled:border-accent-soft! disabled:bg-accent-soft! disabled:text-on-ink-muted!';
export const BUTTON_GHOST =
  'border-transparent! bg-transparent! text-ink-soft! hover:border-line! hover:bg-surface-muted! hover:text-ink!';

/** Replaces `.text-button` / `.icon-button` affordances. */
export const TEXT_BUTTON =
  'cursor-pointer border-0 bg-transparent p-0 text-xs font-extrabold uppercase tracking-[0.06em] text-accent-deep hover:text-accent';

/** Replaces `.view-glyph`. */
export const VIEW_GLYPH =
  'grid size-6 shrink-0 place-items-center font-display text-base font-bold text-muted';

/** Replaces `.view-label`. */
export const VIEW_LABEL = 'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap';

export type StatusDotStatus =
  | 'ready'
  | 'loading'
  | 'error'
  | 'empty'
  | 'disconnected'
  | 'unavailable';

/** Dot colors copied from the deleted `.topbar-status-* .status-dot` rules. */
const STATUS_DOT_COLOR: Readonly<Record<StatusDotStatus, string>> = {
  ready: 'text-ready-dot',
  loading: 'text-warning',
  error: 'text-accent',
  empty: 'text-accent',
  disconnected: 'text-danger',
  unavailable: 'text-muted',
};

/** Replaces `.status-dot` (a `currentcolor` dot tinted by its status). */
export function StatusDot(props: {
  readonly status: StatusDotStatus;
  readonly class?: string;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      class={`${STATUS_DOT_COLOR[props.status]} size-[0.4375rem] shrink-0 rounded-full bg-current ${
        props.class ?? ''
      }`}
    />
  );
}

/** Replaces `.screen-empty`. */
export function ScreenEmpty(props: {
  readonly title: string;
  readonly body?: string;
  readonly children?: JSX.Element;
}): JSX.Element {
  return (
    <section
      class="mx-auto grid max-w-[60rem] gap-2 rounded-[1rem] border border-empty-border bg-surface p-6"
      aria-live="polite"
    >
      <h2>{props.title}</h2>
      <Show when={props.body}>
        <p class="m-0 text-sm leading-[1.6] text-muted">{props.body}</p>
      </Show>
      {props.children}
    </section>
  );
}

/** Replaces `.screen-note`. */
export function ScreenNote(props: { readonly children: JSX.Element }): JSX.Element {
  return <p class="m-0 text-[0.8125rem] leading-[1.55] text-muted">{props.children}</p>;
}

/** Replaces `.empty-state` + `.empty-mark`. */
export function EmptyState(props: {
  readonly mark?: string;
  readonly title?: JSX.Element;
  readonly body?: JSX.Element;
  readonly actions?: JSX.Element;
}): JSX.Element {
  return (
    <div class="grid gap-2 rounded-[1rem] border border-empty-border bg-surface p-6">
      <Show when={props.mark}>
        <span
          class="mb-4 grid size-10 place-items-center rounded-full bg-surface-deep text-xl text-muted"
          aria-hidden="true"
        >
          {props.mark}
        </span>
      </Show>
      <Show when={props.title}>
        <h3 class="m-0">{props.title}</h3>
      </Show>
      <Show when={props.body}>
        <div class="text-sm leading-[1.6] text-muted">{props.body}</div>
      </Show>
      <Show when={props.actions}>
        <div class="flex gap-2">{props.actions}</div>
      </Show>
    </div>
  );
}

export type DiagnosticSeverity = 'error' | 'success' | 'warning';

/** Severity surfaces use the `--wb-*-surface/--wb-*-border` token pairs. */
const DIAGNOSTIC_TONE: Readonly<Record<DiagnosticSeverity, string>> = {
  error: 'border-error-border bg-error-surface text-danger',
  success: 'border-ready-border bg-ready-surface text-success',
  warning: 'border-loading-border bg-loading-surface text-warning',
};

/** Replaces `.diagnostic` + `.diagnostic-{severity}`. */
export function Diagnostic(props: {
  readonly severity: DiagnosticSeverity;
  readonly children: JSX.Element;
  readonly class?: string;
}): JSX.Element {
  return (
    <p
      class={`m-0 rounded-[0.375rem] border px-4 py-3 text-[0.8125rem] ${
        DIAGNOSTIC_TONE[props.severity]
      } ${props.class ?? ''}`}
    >
      {props.children}
    </p>
  );
}

/** Replaces `.hash-chip` (+ `.hash-chip-copy`). */
export function HashChip(props: {
  readonly children: JSX.Element;
  readonly copyLabel?: string;
  readonly onCopy?: () => void;
}): JSX.Element {
  return (
    <span class="inline-flex w-max max-w-full items-center gap-2 rounded-[0.375rem] border border-line bg-surface-muted px-2 py-1 font-mono text-xs leading-[1.4] text-ink-soft">
      {props.children}
      <Show when={props.onCopy}>
        <button
          class="cursor-pointer rounded-[0.375rem] border-0 bg-transparent px-1 py-0 text-[0.625rem] font-extrabold uppercase tracking-[0.05em] text-muted hover:bg-surface-deep hover:text-accent-deep"
          type="button"
          aria-label={props.copyLabel}
          title={props.copyLabel}
          onClick={props.onCopy}
        >
          复制
        </button>
      </Show>
    </span>
  );
}

/**
 * Floating Agent shelf classes shared by the workspace shell (App.tsx) and
 * the project overview (main.tsx). Replaces `.agent-drawer-floating`,
 * `.agent-drawer-guidance`, and `.agent-drawer-fab`.
 */
export const AGENT_SHELF_FLOATING =
  'fixed right-0 top-0 bottom-0 z-40 w-[min(23.75rem,100vw)] shadow-[var(--wb-shadow-drawer)]';
export const AGENT_GUIDANCE = 'grid content-start justify-items-start gap-2 p-5';
export const AGENT_FAB =
  'fixed bottom-5 right-5 z-30 grid size-12 cursor-pointer place-items-center rounded-full bg-ink text-on-ink shadow-lg';

/** Replaces `.agent-drawer-toggle` (+ its `[aria-expanded="true"]` state). */
export const AGENT_TOGGLE =
  'flex size-9 items-center justify-center rounded-md text-on-ink-soft hover:bg-on-ink-border';
export const AGENT_TOGGLE_ACTIVE = 'bg-accent-wash! text-accent-deep! hover:bg-accent-wash!';
