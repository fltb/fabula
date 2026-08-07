/**
 * Browser-only, versioned localStorage preference store for the fixed
 * Workbench layout.
 *
 * Privacy boundary: this store persists ONLY local UI layout state. It must
 * never carry a user id, project id, source/Git/validation/operation state,
 * provider secret, capability token, or Yjs data. `saveWorkbenchPreferences`
 * serializes exactly the known schema fields and the validator rejects any
 * payload that contains unknown keys, so a foreign or hand-edited blob can
 * never leak into the app as preferences.
 *
 * Storage safety: the module performs no ambient I/O at import time and never
 * touches `window`/`localStorage` at module scope, so importing it under SSR
 * or in an environment without Web Storage is safe. Every storage access is
 * guarded: a missing, throwing, or malformed store degrades deterministically
 * to the immutable defaults instead of crashing or partially applying state.
 *
 * Versioning: the stored blob is an envelope `{ version: 1, ...fields }`.
 * The storage key is intentionally unversioned; any blob whose version is not
 * exactly `WORKBENCH_PREFERENCES_VERSION` is rejected wholesale and the store
 * falls back to defaults.
 */

export const WORKBENCH_PREFERENCES_VERSION = 1 as const;

/** localStorage key under which the single preferences blob is stored. */
export const WORKBENCH_PREFERENCES_STORAGE_KEY = 'novalistically.workbench.preferences';

/** Navigation views selectable from the fixed Workbench layout. */
export type WorkbenchNavigationView =
  | 'project-home'
  | 'scene-canvas'
  | 'source-studio'
  | 'graph-route'
  | 'review-hub'
  | 'publication'
  | 'references'
  | 'agent-chat';

/**
 * Immutable layout preference snapshot. Every field is `readonly`; consumers
 * replace the snapshot (e.g. via a Solid signal) rather than mutate it, and
 * hand the replacement to `saveWorkbenchPreferences`.
 */
export interface WorkbenchPreferencesV1 {
  readonly version: typeof WORKBENCH_PREFERENCES_VERSION;
  /** Navigator panel collapsed state. */
  readonly navigatorCollapsed: boolean;
  /** Inspector panel pinned state. */
  readonly inspectorPinned: boolean;
  /** Operation Center expanded state. */
  readonly operationCenterExpanded: boolean;
  /** Selected navigation view. */
  readonly selectedNavigationView: WorkbenchNavigationView;
}

/** The fixed layout defaults; deeply immutable and shared by reference. */
export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferencesV1 = Object.freeze({
  version: WORKBENCH_PREFERENCES_VERSION,
  navigatorCollapsed: false,
  inspectorPinned: true,
  operationCenterExpanded: false,
  selectedNavigationView: 'project-home',
});

/** Minimal storage surface this store depends on (a subset of `Storage`). */
export interface WorkbenchPreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const NAVIGATION_VIEWS: readonly WorkbenchNavigationView[] = [
  'project-home',
  'scene-canvas',
  'source-studio',
  'graph-route',
  'review-hub',
  'publication',
  'references',
  'agent-chat',
];

/** Static lookup of every key the v1 envelope may contain. */
const KNOWN_PREFERENCE_KEYS: Record<string, true> = {
  version: true,
  navigatorCollapsed: true,
  inspectorPinned: true,
  operationCenterExpanded: true,
  selectedNavigationView: true,
};

/**
 * Resolves the ambient `localStorage` without ever throwing. Returns `null`
 * when the caller supplied none and the environment exposes no usable store
 * (SSR, sandboxed iframes whose `localStorage` getter throws, disabled Web
 * Storage).
 */
function resolveStorage(
  storage: WorkbenchPreferencesStorage | null | undefined,
): WorkbenchPreferencesStorage | null {
  if (storage !== undefined && storage !== null) {
    return storage;
  }
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Strictly validates an unknown value as a `WorkbenchPreferencesV1` snapshot:
 * rejects non-object payloads, wrong or missing versions, non-boolean flags,
 * unknown navigation views, and ANY key outside the known envelope.
 */
function isWorkbenchPreferencesV1(candidate: unknown): candidate is WorkbenchPreferencesV1 {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return false;
  }
  if (!('version' in candidate) || candidate.version !== WORKBENCH_PREFERENCES_VERSION) {
    return false;
  }
  if (!('navigatorCollapsed' in candidate) || typeof candidate.navigatorCollapsed !== 'boolean') {
    return false;
  }
  if (!('inspectorPinned' in candidate) || typeof candidate.inspectorPinned !== 'boolean') {
    return false;
  }
  if (
    !('operationCenterExpanded' in candidate) ||
    typeof candidate.operationCenterExpanded !== 'boolean'
  ) {
    return false;
  }
  if (!('selectedNavigationView' in candidate)) {
    return false;
  }
  const view = candidate.selectedNavigationView;
  if (
    typeof view !== 'string' ||
    !NAVIGATION_VIEWS.some((candidateView) => candidateView === view)
  ) {
    return false;
  }
  for (const key of Object.keys(candidate)) {
    if (!Object.hasOwn(KNOWN_PREFERENCE_KEYS, key)) {
      return false;
    }
  }
  return true;
}

/**
 * Parses and strictly validates a raw stored string into a frozen
 * `WorkbenchPreferencesV1` snapshot. Returns `null` for malformed JSON or any
 * payload that fails validation (unknown keys, wrong types, wrong version).
 */
export function parseWorkbenchPreferences(raw: string): WorkbenchPreferencesV1 | null {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isWorkbenchPreferencesV1(candidate)) {
    return null;
  }
  return Object.freeze({
    version: WORKBENCH_PREFERENCES_VERSION,
    navigatorCollapsed: candidate.navigatorCollapsed,
    inspectorPinned: candidate.inspectorPinned,
    operationCenterExpanded: candidate.operationCenterExpanded,
    selectedNavigationView: candidate.selectedNavigationView,
  });
}

/**
 * Loads the preference snapshot from storage. Falls back to the immutable
 * defaults when storage is unavailable, the key is absent, or the stored
 * blob fails strict validation. Read-only: a corrupt blob is left untouched.
 */
export function loadWorkbenchPreferences(
  storage?: WorkbenchPreferencesStorage | null,
): WorkbenchPreferencesV1 {
  const resolved = resolveStorage(storage);
  if (resolved === null) {
    return DEFAULT_WORKBENCH_PREFERENCES;
  }
  let raw: string | null;
  try {
    raw = resolved.getItem(WORKBENCH_PREFERENCES_STORAGE_KEY);
  } catch {
    return DEFAULT_WORKBENCH_PREFERENCES;
  }
  if (raw === null) {
    return DEFAULT_WORKBENCH_PREFERENCES;
  }
  return parseWorkbenchPreferences(raw) ?? DEFAULT_WORKBENCH_PREFERENCES;
}

/**
 * Persists a snapshot. The snapshot is re-validated strictly and serialized
 * in a fixed field order, so only known state is ever written — extra fields
 * on the input are ignored by construction, and an invalid snapshot writes
 * nothing. Returns `true` when the blob was written, `false` when storage is
 * unavailable or the snapshot is invalid (never throws).
 */
export function saveWorkbenchPreferences(
  preferences: WorkbenchPreferencesV1,
  storage?: WorkbenchPreferencesStorage | null,
): boolean {
  const resolved = resolveStorage(storage);
  if (resolved === null) {
    return false;
  }
  if (!isWorkbenchPreferencesV1(preferences)) {
    return false;
  }
  try {
    resolved.setItem(
      WORKBENCH_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: preferences.version,
        navigatorCollapsed: preferences.navigatorCollapsed,
        inspectorPinned: preferences.inspectorPinned,
        operationCenterExpanded: preferences.operationCenterExpanded,
        selectedNavigationView: preferences.selectedNavigationView,
      }),
    );
    return true;
  } catch {
    return false;
  }
}
