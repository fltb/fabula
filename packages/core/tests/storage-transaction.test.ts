import { describe, expect, it } from 'vitest';
import { StorageConflictError } from '../src/errors.ts';
import {
  computeContentHash,
  computeDirectoryManifestHash,
  MemoryStorage,
  type StorageTransaction,
} from '../src/storage/index.ts';

describe('Storage.commitBatch', () => {
  it('publishes every memory write together', () => {
    const storage = new MemoryStorage();
    storage.write('run/old.txt', 'old');
    storage.commitBatch({
      transactionId: 'tx-publish',
      lockPath: '.nova/transactions/workspace.lock',
      journalPath: '.nova/transactions/tx-publish.json',
      conflictDir: '.nova/conflicts',
      readSet: [{ kind: 'file', path: 'run/old.txt', expectedHash: computeContentHash('old') }],
      writes: [
        { type: 'put', path: 'run/a.txt', content: 'a', expectedHash: null },
        { type: 'put', path: 'run/b.txt', content: 'b', expectedHash: null },
      ],
    });

    expect(storage.read('run/a.txt')).toBe('a');
    expect(storage.read('run/b.txt')).toBe('b');
    expect(storage.read('run/old.txt')).toBe('old');
  });

  it('supports checked replacement and deletion', () => {
    const storage = new MemoryStorage();
    storage.write('run/replace.txt', 'before');
    storage.write('run/delete.txt', 'remove');
    storage.commitBatch({
      transactionId: 'tx-replace-delete',
      lockPath: '.nova/transactions/workspace.lock',
      journalPath: '.nova/transactions/tx-replace-delete.json',
      conflictDir: '.nova/conflicts',
      readSet: [],
      writes: [
        {
          type: 'put',
          path: 'run/replace.txt',
          content: 'after',
          expectedHash: computeContentHash('before'),
        },
        {
          type: 'delete',
          path: 'run/delete.txt',
          expectedHash: computeContentHash('remove'),
        },
      ],
    });

    expect(storage.read('run/replace.txt')).toBe('after');
    expect(storage.readOptional('run/delete.txt')).toBeNull();
  });

  it('rejects a stale file expectation without partial publication', () => {
    const storage = new MemoryStorage();
    storage.write('run/source.txt', 'changed');
    const transaction: StorageTransaction = {
      transactionId: 'tx-stale-file',
      lockPath: '.nova/transactions/workspace.lock',
      journalPath: '.nova/transactions/tx-stale-file.json',
      conflictDir: '.nova/conflicts',
      readSet: [
        { kind: 'file', path: 'run/source.txt', expectedHash: computeContentHash('original') },
      ],
      writes: [{ type: 'put', path: 'run/output.txt', content: 'new', expectedHash: null }],
    };

    expect(() => storage.commitBatch(transaction)).toThrow(StorageConflictError);
    expect(storage.readOptional('run/output.txt')).toBeNull();
  });

  it('detects recursive directory additions', () => {
    const storage = new MemoryStorage();
    storage.write('definitions/a.yaml', 'a: 1\n');
    const expectedManifestHash = computeDirectoryManifestHash(storage, 'definitions');
    storage.write('definitions/nested/b.yaml', 'b: 2\n');

    expect(() =>
      storage.commitBatch({
        transactionId: 'tx-stale-directory',
        lockPath: '.nova/transactions/workspace.lock',
        journalPath: '.nova/transactions/tx-stale-directory.json',
        conflictDir: '.nova/conflicts',
        readSet: [{ kind: 'directory', path: 'definitions', expectedManifestHash }],
        writes: [{ type: 'put', path: 'run/output.txt', content: 'new', expectedHash: null }],
      }),
    ).toThrow(StorageConflictError);
    expect(storage.readOptional('run/output.txt')).toBeNull();
  });

  it('resolves virtual paths with POSIX absolute semantics', () => {
    const storage = new MemoryStorage();
    expect(storage.resolvePath('project/../project/nova.yaml')).toBe('/project/nova.yaml');
  });
});
