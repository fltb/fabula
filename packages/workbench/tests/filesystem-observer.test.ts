import { describe, expect, it, vi } from 'vitest';
import {
  type AuthoringCandidateStore,
  createAuthoringFilesystemObserver,
} from '../src/host/authoring/filesystem-observer.js';
import type { AuthoringTreeSnapshot } from '../src/host/authoring/types.js';

function snapshot(treeHash: string): AuthoringTreeSnapshot {
  return {
    projectId: 'project-a',
    treeHash,
    entries: [{ logicalPath: 'nova.yaml', content: `title: ${treeHash}` }],
    diagnostics: [],
    observedAt: '2026-08-02T00:00:00.000Z',
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('authoring filesystem observer', () => {
  it('drains a hint queued while the previous re-read is in flight', async () => {
    const firstLoad = deferred<AuthoringTreeSnapshot>();
    const loader = vi
      .fn<() => Promise<AuthoringTreeSnapshot>>()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockResolvedValueOnce(snapshot('hash-b'));
    const staging: AuthoringCandidateStore = {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => undefined),
    };
    const observer = createAuthoringFilesystemObserver({
      projectId: 'project-a',
      loader: { loadTree: loader },
      staging,
      debounceMs: 0,
    });
    const emitted: string[] = [];
    observer.onCandidate((candidate) => emitted.push(candidate.treeHash));

    const first = observer.notify();
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    const second = observer.notify();
    // Let the second debounce fire while the first tree load is still pending.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    firstLoad.resolve(snapshot('hash-a'));

    await expect(first).resolves.toMatchObject({ treeHash: 'hash-a' });
    await expect(second).resolves.toMatchObject({ treeHash: 'hash-b' });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(emitted).toEqual(['hash-a', 'hash-b']);
  });

  it('does not stage or emit after disposal during an in-flight re-read', async () => {
    const pendingLoad = deferred<AuthoringTreeSnapshot>();
    const load = vi.fn<() => Promise<AuthoringTreeSnapshot>>(() => pendingLoad.promise);
    const staging: AuthoringCandidateStore = {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => undefined),
    };
    const observer = createAuthoringFilesystemObserver({
      projectId: 'project-a',
      loader: { loadTree: load },
      staging,
      debounceMs: 0,
    });
    const emitted = vi.fn();
    observer.onCandidate(emitted);

    const notification = observer.notify();
    const rejected = expect(notification).rejects.toThrow(
      'AuthoringFilesystemObserver is disposed',
    );
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    observer.dispose();
    pendingLoad.resolve(snapshot('hash-a'));

    await rejected;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(staging.put).not.toHaveBeenCalled();
    expect(emitted).not.toHaveBeenCalled();
  });
});
