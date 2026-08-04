import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  loadWorkbenchPreferences,
  parseWorkbenchPreferences,
  saveWorkbenchPreferences,
  WORKBENCH_PREFERENCES_STORAGE_KEY,
  WORKBENCH_PREFERENCES_VERSION,
  type WorkbenchPreferencesStorage,
  type WorkbenchPreferencesV1,
} from '../../src/client/preferences.js';

const VALID_PAYLOAD = {
  version: 1,
  navigatorCollapsed: false,
  inspectorPinned: true,
  operationCenterExpanded: false,
  agentShelfOpen: false,
  selectedNavigationView: 'project-home',
} as const;

function memoryStorage(seed?: Record<string, string>) {
  const entries = new Map<string, string>(Object.entries(seed ?? {}));
  const writes: Array<{ key: string; value: string }> = [];
  const storage: WorkbenchPreferencesStorage = {
    getItem(key: string) {
      const value = entries.get(key);
      if (value === undefined) return null;
      return value;
    },
    setItem(key: string, value: string) {
      writes.push({ key, value });
      entries.set(key, value);
    },
  };
  return { storage, writes, entries };
}

function snapshot(overrides: Partial<WorkbenchPreferencesV1> = {}): WorkbenchPreferencesV1 {
  return { ...DEFAULT_WORKBENCH_PREFERENCES, ...overrides };
}

describe('workbench client preferences', () => {
  it('exposes immutable defaults with the fixed known shape', () => {
    expect(WORKBENCH_PREFERENCES_VERSION).toBe(1);
    expect(WORKBENCH_PREFERENCES_STORAGE_KEY).toMatch(/^novalistically\.workbench\./);
    expect(DEFAULT_WORKBENCH_PREFERENCES).toEqual(VALID_PAYLOAD);
    expect(Object.isFrozen(DEFAULT_WORKBENCH_PREFERENCES)).toBe(true);
    expect(() => {
      (DEFAULT_WORKBENCH_PREFERENCES as { navigatorCollapsed: boolean }).navigatorCollapsed = true;
    }).toThrow(TypeError);
  });

  it('falls back to immutable defaults when ambient storage is unavailable', () => {
    // Node has no globalThis.localStorage; jsdom has an empty one. Either way
    // the result is the shared default snapshot, deterministically.
    expect(loadWorkbenchPreferences()).toBe(DEFAULT_WORKBENCH_PREFERENCES);
    expect(loadWorkbenchPreferences(undefined)).toBe(DEFAULT_WORKBENCH_PREFERENCES);
    expect(loadWorkbenchPreferences(null)).toBe(DEFAULT_WORKBENCH_PREFERENCES);
    expect(Object.isFrozen(loadWorkbenchPreferences())).toBe(true);
  });

  it('falls back to defaults when storage access throws', () => {
    const throwing: WorkbenchPreferencesStorage = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('quota');
      },
    };
    expect(loadWorkbenchPreferences(throwing)).toBe(DEFAULT_WORKBENCH_PREFERENCES);
    expect(saveWorkbenchPreferences(DEFAULT_WORKBENCH_PREFERENCES, throwing)).toBe(false);
  });

  it('round-trips a non-default snapshot through save and load', () => {
    const { storage, writes } = memoryStorage();
    const custom = snapshot({
      navigatorCollapsed: true,
      inspectorPinned: false,
      operationCenterExpanded: true,
      agentShelfOpen: true,
      selectedNavigationView: 'source-studio',
    });
    expect(saveWorkbenchPreferences(custom, storage)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toBe(WORKBENCH_PREFERENCES_STORAGE_KEY);
    const loaded = loadWorkbenchPreferences(storage);
    expect(loaded).toEqual(custom);
    expect(loaded).not.toBe(custom);
    expect(Object.isFrozen(loaded)).toBe(true);
    const stored = JSON.parse(writes[0]?.value) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      'agentShelfOpen',
      'inspectorPinned',
      'navigatorCollapsed',
      'operationCenterExpanded',
      'selectedNavigationView',
      'version',
    ]);
  });

  it('writes byte-identically for equal snapshots', () => {
    const a = memoryStorage();
    const b = memoryStorage();
    const custom = snapshot({ selectedNavigationView: 'review-hub' });
    expect(saveWorkbenchPreferences(custom, a.storage)).toBe(true);
    expect(saveWorkbenchPreferences(custom, b.storage)).toBe(true);
    expect(a.writes[0]?.value).toBe(b.writes[0]?.value);
  });

  it('overwrites a prior blob on save and keeps the same storage key', () => {
    const { storage, writes } = memoryStorage({
      [WORKBENCH_PREFERENCES_STORAGE_KEY]: JSON.stringify({
        ...VALID_PAYLOAD,
        navigatorCollapsed: true,
      }),
    });
    const loaded = loadWorkbenchPreferences(storage);
    expect(loaded.navigatorCollapsed).toBe(true);
    expect(loaded).not.toBe(DEFAULT_WORKBENCH_PREFERENCES);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(saveWorkbenchPreferences(DEFAULT_WORKBENCH_PREFERENCES, storage)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(loadWorkbenchPreferences(storage)).toStrictEqual(DEFAULT_WORKBENCH_PREFERENCES);
  });

  it('rejects malformed JSON and non-object payloads', () => {
    for (const raw of ['', 'not-json{', 'null', '42', '"graph"', 'true', '[]']) {
      expect(parseWorkbenchPreferences(raw)).toBeNull();
    }
  });

  it('rejects wrong or missing versions', () => {
    for (const version of [0, 2, -1, '1', null, true]) {
      expect(parseWorkbenchPreferences(JSON.stringify({ ...VALID_PAYLOAD, version }))).toBeNull();
    }
    expect(
      parseWorkbenchPreferences(JSON.stringify({ ...VALID_PAYLOAD, version: undefined })),
    ).toBeNull();
    expect(parseWorkbenchPreferences('{}')).toBeNull();
  });

  it('rejects wrong types for every boolean flag and the navigation view', () => {
    for (const bad of ['true', 1, 0, null, {}, []]) {
      for (const key of [
        'navigatorCollapsed',
        'inspectorPinned',
        'operationCenterExpanded',
        'agentShelfOpen',
      ]) {
        expect(
          parseWorkbenchPreferences(JSON.stringify({ ...VALID_PAYLOAD, [key]: bad })),
        ).toBeNull();
      }
    }
    for (const bad of ['', 'Graph', 'story', 'graph', 'overview', 42, null, true, {}]) {
      expect(
        parseWorkbenchPreferences(
          JSON.stringify({ ...VALID_PAYLOAD, selectedNavigationView: bad }),
        ),
      ).toBeNull();
    }
  });

  it('rejects missing fields', () => {
    for (const key of Object.keys(VALID_PAYLOAD) as Array<keyof typeof VALID_PAYLOAD>) {
      const rest: Partial<typeof VALID_PAYLOAD> = { ...VALID_PAYLOAD };
      delete rest[key];
      expect(parseWorkbenchPreferences(JSON.stringify(rest))).toBeNull();
    }
  });

  it('accepts exactly the canonical navigation views', () => {
    for (const view of [
      'project-home',
      'scene-canvas',
      'source-studio',
      'graph-route',
      'review-hub',
      'publication',
    ]) {
      const parsed = parseWorkbenchPreferences(
        JSON.stringify({ ...VALID_PAYLOAD, selectedNavigationView: view }),
      );
      expect(parsed?.selectedNavigationView).toBe(view);
    }
  });

  it('rejects unknown keys, including user/project/secret/yjs state', () => {
    for (const extra of [
      'userId',
      'projectId',
      'gitHead',
      'operationState',
      'capabilityToken',
      'yjsUpdate',
      'secret',
      '__proto__',
    ]) {
      expect(
        parseWorkbenchPreferences(JSON.stringify({ ...VALID_PAYLOAD, [extra]: 'x' })),
      ).toBeNull();
    }
  });

  it('does not partially apply a corrupt blob and never rewrites it on load', () => {
    const corrupt = JSON.stringify({ ...VALID_PAYLOAD, userId: 'u', navigatorCollapsed: true });
    const { storage, writes } = memoryStorage({ [WORKBENCH_PREFERENCES_STORAGE_KEY]: corrupt });
    expect(loadWorkbenchPreferences(storage)).toBe(DEFAULT_WORKBENCH_PREFERENCES);
    expect(writes).toHaveLength(0);
    expect(storage.getItem(WORKBENCH_PREFERENCES_STORAGE_KEY)).toBe(corrupt);
  });

  it('saves only known state and refuses invalid input without writing', () => {
    const { storage, writes } = memoryStorage();
    const withJunk = {
      ...DEFAULT_WORKBENCH_PREFERENCES,
      userId: 'u',
      yjsUpdate: 'x',
    } as unknown as WorkbenchPreferencesV1;
    expect(saveWorkbenchPreferences(withJunk, storage)).toBe(false);
    const wrongVersion = {
      ...DEFAULT_WORKBENCH_PREFERENCES,
      version: 2,
    } as unknown as WorkbenchPreferencesV1;
    expect(saveWorkbenchPreferences(wrongVersion, storage)).toBe(false);
    const badView = {
      ...DEFAULT_WORKBENCH_PREFERENCES,
      selectedNavigationView: 'graph',
    } as unknown as WorkbenchPreferencesV1;
    expect(saveWorkbenchPreferences(badView, storage)).toBe(false);
    expect(writes).toHaveLength(0);
    expect(loadWorkbenchPreferences(storage)).toBe(DEFAULT_WORKBENCH_PREFERENCES);
  });
});
