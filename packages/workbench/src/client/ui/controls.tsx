import { Dialog as KobalteDialog } from '@kobalte/core/dialog';
import { Select as KobalteSelect } from '@kobalte/core/select';
import { TextField as KobalteTextField } from '@kobalte/core/text-field';
import { Tooltip as KobalteTooltip } from '@kobalte/core/tooltip';
import type { JSX } from 'solid-js';
import { Show } from 'solid-js';

/**
 * Thin Kobalte wrappers: headless behavior from @kobalte/core, visuals from
 * the tailwind `@theme` aliases. Keeps `data-testid`/role semantics intact by
 * passing through part props.
 */

const SELECT_TRIGGER =
  'flex h-9 items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 text-sm text-ink hover:border-line-strong';
const SELECT_CONTENT =
  'z-50 rounded-md border border-line bg-surface shadow-[var(--wb-shadow-panel)]';
const SELECT_ITEM =
  'grid cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-[0.375rem] px-2 py-1.5 text-sm text-ink-soft hover:bg-surface-muted hover:text-ink data-[highlighted]:bg-surface-muted data-[highlighted]:text-ink';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/** Kobalte `Select` styled for settings/forms; single string value. */
export function Select(props: {
  readonly options: readonly SelectOption[];
  readonly value: string | null;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly label: string;
}): JSX.Element {
  const selected = () => props.options.find((option) => option.value === props.value) ?? null;
  return (
    <KobalteSelect<SelectOption>
      class="grid gap-1"
      value={selected()}
      onChange={(option) => {
        if (option !== null) props.onChange(option.value);
      }}
      options={props.options as unknown as SelectOption[]}
      optionValue="value"
      optionTextValue="label"
      placeholder={props.placeholder}
      itemComponent={(itemProps) => (
        <KobalteSelect.Item item={itemProps.item} class={SELECT_ITEM}>
          <KobalteSelect.ItemIndicator class="text-accent">
            <span aria-hidden="true">✓</span>
          </KobalteSelect.ItemIndicator>
          <KobalteSelect.ItemLabel>{itemProps.item.rawValue.label}</KobalteSelect.ItemLabel>
        </KobalteSelect.Item>
      )}
    >
      <KobalteSelect.Label class="text-sm font-semibold text-ink">
        {props.label}
      </KobalteSelect.Label>
      <KobalteSelect.Trigger class={SELECT_TRIGGER}>
        <span class={selected() === null ? 'truncate text-muted' : 'truncate'}>
          {selected()?.label ?? props.placeholder}
        </span>
        <KobalteSelect.Icon aria-hidden="true">▾</KobalteSelect.Icon>
      </KobalteSelect.Trigger>
      <KobalteSelect.Portal>
        <KobalteSelect.Content class={SELECT_CONTENT}>
          <KobalteSelect.Listbox class="max-h-60 overflow-auto p-1" />
        </KobalteSelect.Content>
      </KobalteSelect.Portal>
    </KobalteSelect>
  );
}

/** Kobalte `Tabs` styled as the `.graph-domain-tabs` chip row. */
export const TABS_ROOT = 'grid gap-4';
export const TABS_LIST = 'flex w-max gap-1 rounded-[0.625rem] bg-surface-deep p-1';
export const TABS_TRIGGER =
  'min-h-9 cursor-pointer rounded-[0.375rem] border-0 bg-transparent px-4 py-2 text-[0.8125rem] font-bold text-ink-soft transition-[color,background,box-shadow] duration-[160ms] hover:text-ink data-[selected]:bg-surface data-[selected]:text-accent-deep data-[selected]:shadow-[0_0.0625rem_0.25rem_var(--wb-shadow-color)]';
export const TABS_CONTENT = 'grid gap-3';

/** Kobalte `Dialog`; used for the responsive navigation drawer. */
export function Dialog(props: {
  readonly open: boolean;
  readonly label: string;
  readonly onClose: () => void;
  readonly position?: 'left' | 'right' | 'center';
  readonly children: JSX.Element;
}): JSX.Element {
  const positionClass = () => {
    switch (props.position ?? 'left') {
      case 'left':
        return 'left-0 top-0 bottom-0 w-[min(23.75rem,100vw)] rounded-r-lg';
      case 'right':
        return 'right-0 top-0 bottom-0 w-[min(23.75rem,100vw)] rounded-l-lg';
      case 'center':
        return 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2';
    }
  };
  return (
    <KobalteDialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay class="fixed inset-0 z-50 bg-overlay" />
        <KobalteDialog.Content
          class={`fixed z-50 border border-line bg-surface p-4 shadow-[var(--wb-shadow-drawer)] ${positionClass()}`}
          role="dialog"
        >
          <div class="mb-3 flex items-center justify-between gap-3">
            <KobalteDialog.Title class="text-sm font-bold">{props.label}</KobalteDialog.Title>
            <button
              class="grid size-8 cursor-pointer place-items-center rounded-md text-ink-soft hover:bg-surface-muted hover:text-ink"
              type="button"
              aria-label={`关闭${props.label}`}
              onClick={props.onClose}
            >
              ×
            </button>
          </div>
          {props.children}
        </KobalteDialog.Content>
      </KobalteDialog.Portal>
    </KobalteDialog>
  );
}

/** Kobalte `Tooltip`; pass `as="span"` when the trigger is itself a button. */
export function Tooltip(props: {
  readonly label: string;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <KobalteTooltip>
      <KobalteTooltip.Trigger as="span" class="inline-flex">
        {props.children}
      </KobalteTooltip.Trigger>
      <KobalteTooltip.Portal>
        <KobalteTooltip.Content class="rounded-sm bg-ink px-2 py-1 text-xs text-on-ink">
          {props.label}
        </KobalteTooltip.Content>
      </KobalteTooltip.Portal>
    </KobalteTooltip>
  );
}

/** Kobalte `TextField` for labeled inputs with error/description semantics. */
export function TextField(props: {
  readonly label: string;
  readonly value: string;
  readonly onInput: (value: string) => void;
  readonly placeholder?: string;
  readonly error?: string;
  readonly description?: string;
  readonly type?: 'text' | 'password' | 'number';
}): JSX.Element {
  return (
    <KobalteTextField
      class="grid gap-1"
      value={props.value}
      onChange={props.onInput}
      validationState={props.error ? 'invalid' : 'valid'}
    >
      <KobalteTextField.Label class="text-sm font-semibold text-ink">
        {props.label}
      </KobalteTextField.Label>
      <Show when={props.description}>
        <KobalteTextField.Description class="text-xs text-muted">
          {props.description}
        </KobalteTextField.Description>
      </Show>
      <KobalteTextField.Input
        class="min-h-10 w-full rounded-[0.375rem] border border-line-strong bg-surface px-3 py-2 text-ink shadow-sm outline-none transition placeholder:text-muted focus:border-focus focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-1 focus-visible:outline-focus"
        type={props.type ?? 'text'}
        placeholder={props.placeholder}
      />
      <Show when={props.error}>
        <KobalteTextField.ErrorMessage class="text-xs text-danger">
          {props.error}
        </KobalteTextField.ErrorMessage>
      </Show>
    </KobalteTextField>
  );
}

/** Replaces `.badge` + `.badge-entity/.badge-event/.badge-thread` etc. */
const BADGE_TONE: Readonly<
  Record<'accent' | 'success' | 'event' | 'warning' | 'danger' | 'muted', string>
> = {
  accent: 'border-empty-border bg-accent-wash text-accent-deep',
  success: 'border-ready-border bg-ready-surface text-success',
  event: 'border-line-strong bg-surface-deep text-focus',
  warning: 'border-loading-border bg-loading-surface text-warning',
  danger: 'border-error-border bg-error-surface text-danger',
  muted: 'border-line bg-surface-muted text-muted',
};

export function Badge(props: {
  readonly tone?: keyof typeof BADGE_TONE;
  readonly children: JSX.Element;
  readonly class?: string;
}): JSX.Element {
  return (
    <span
      class={`inline-flex w-max items-center gap-1 rounded-full border px-2 py-1 text-[0.625rem] font-extrabold uppercase leading-[1.2] tracking-[0.06em] ${
        BADGE_TONE[props.tone ?? 'accent']
      } ${props.class ?? ''}`}
    >
      {props.children}
    </span>
  );
}

/** Replaces the `.workspace-skeleton` shimmer rows. */
export function Skeleton(props: { readonly class?: string }): JSX.Element {
  return (
    <div
      class={`animate-pulse rounded-[0.375rem] bg-surface-muted ${props.class ?? ''}`}
      aria-hidden="true"
    />
  );
}
