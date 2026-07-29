// ============================================================================
// StorageTransaction — editorial cutover tests
// Covers MemoryStorage and FsStorage with deterministic, no-network tests.
// ============================================================================

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StorageConflictError } from '../../src/errors.ts';
import {
  computeContentHash,
  computeDirectoryManifestHash,
  FsStorage,
  MemoryStorage,
  type StorageTransaction,
} from '../../src/storage/index.ts';
// Helpers
// ============================================================================

/** Build a minimal StorageTransaction with ephemeral paths. */
function memoryTx(
  overrides: Partial<StorageTransaction> & { transactionId: string },
): StorageTransaction {
  return {
    lockPath: '.nova/transactions/workspace.lock',
    journalPath: `.nova/transactions/${overrides.transactionId}.json`,
    conflictDir: '.nova/conflicts',
    readSet: [],
    writes: [],
    ...overrides,
  };
}

/** Build a StorageTransaction rooted in a temp directory for FsStorage tests. */
function fsTx(
  tmpDir: string,
  overrides: Partial<StorageTransaction> & { transactionId: string },
): StorageTransaction {
  return {
    lockPath: path.join(tmpDir, 'transactions', 'workspace.lock'),
    journalPath: path.join(tmpDir, 'transactions', `${overrides.transactionId}.json`),
    conflictDir: path.join(tmpDir, 'conflicts'),
    readSet: [],
    writes: [],
    ...overrides,
  };
}

// ============================================================================
// MemoryStorage cases
// ============================================================================

describe('StorageTransaction — editorial cutover', () => {
  describe('MemoryStorage', () => {
    let storage: MemoryStorage;

    beforeEach(() => {
      storage = new MemoryStorage();
    });

    // ── expectedHash semantics ─────────────────────────────────────────────

    describe('expectedHash semantics', () => {
      it('writes a new file with null expectedHash', () => {
        storage.commitBatch(
          memoryTx({
            transactionId: 'tx-null-hash',
            writes: [
              { type: 'put', path: 'novel.md', content: '# Hello', expectedHash: null },
            ],
          }),
        );
        expect(storage.read('novel.md')).toBe('# Hello');
      });

      it('writes a file with a matching expectedHash (checked replacement)', () => {
        storage.write('novel.md', 'old content');
        storage.commitBatch(
          memoryTx({
            transactionId: 'tx-replace',
            writes: [
              {
                type: 'put',
                path: 'novel.md',
                content: 'new content',
                expectedHash: computeContentHash('old content'),
              },
            ],
          }),
        );
        expect(storage.read('novel.md')).toBe('new content');
      });

      it('deletes a file with a matching expectedHash', () => {
        storage.write('torm.md', 'remove me');
        storage.commitBatch(
          memoryTx({
            transactionId: 'tx-delete',
            writes: [
              { type: 'delete', path: 'torm.md', expectedHash: computeContentHash('remove me') },
            ],
          }),
        );
        expect(storage.readOptional('torm.md')).toBeNull();
      });

      it('rejects a put with null expectedHash when file exists (create-only)', () => {
        storage.write('novel.md', 'existing');
        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-null-overwrite',
              writes: [
                {
                  type: 'put',
                  path: 'novel.md',
                  content: 'new',
                  expectedHash: null,
                },
              ],
            }),
          ),
        ).toThrow(StorageConflictError);
        expect(storage.read('novel.md')).toBe('existing');
      });

      it('rejects a put with a stale expectedHash', () => {
        storage.write('novel.md', 'original');
        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-stale-put',
              writes: [
                {
                  type: 'put',
                  path: 'novel.md',
                  content: 'new',
                  expectedHash: computeContentHash('different'),
                },
              ],
            }),
          ),
        ).toThrow(StorageConflictError);
        expect(storage.read('novel.md')).toBe('original');
      });

      it('rejects a delete with a stale expectedHash', () => {
        storage.write('novel.md', 'original');
        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-stale-del',
              writes: [
                { type: 'delete', path: 'novel.md', expectedHash: computeContentHash('different') },
              ],
            }),
          ),
        ).toThrow(StorageConflictError);
        expect(storage.read('novel.md')).toBe('original');
      });

      it('rejects a delete on a non-existent file with non-null expectedHash', () => {
        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-stale-del-missing',
              writes: [
                { type: 'delete', path: 'nope.md', expectedHash: computeContentHash('anything') },
              ],
            }),
          ),
        ).toThrow(StorageConflictError);
      });
    });

    // ── recursive directory detection ─────────────────────────────────────

    describe('recursive directory detection', () => {
      it('detects additions within a directory', () => {
        storage.write('defs/a.yaml', 'a: 1\n');
        const hash = computeDirectoryManifestHash(storage, 'defs');
        storage.write('defs/nested/b.yaml', 'b: 2\n');

        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-dir-add',
              readSet: [{ kind: 'directory', path: 'defs', expectedManifestHash: hash }],
              writes: [
                { type: 'put', path: 'run/out.txt', content: 'new', expectedHash: null },
              ],
            }),
          ),
        ).toThrow(StorageConflictError);
        expect(storage.readOptional('run/out.txt')).toBeNull();
      });

      it('detects deletions within a directory', () => {
        storage.write('defs/a.yaml', 'a: 1\n');
        const hash = computeDirectoryManifestHash(storage, 'defs');
        storage.removeAll('defs');

        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-dir-del',
              readSet: [{ kind: 'directory', path: 'defs', expectedManifestHash: hash }],
              writes: [
                { type: 'put', path: 'run/out.txt', content: 'new', expectedHash: null },
              ],
            }),
          ),
        ).toThrow(StorageConflictError);
      });

      it('detects content changes within a directory', () => {
        storage.write('defs/a.yaml', 'original\n');
        const hash = computeDirectoryManifestHash(storage, 'defs');
        storage.write('defs/a.yaml', 'modified\n');

        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-dir-change',
              readSet: [{ kind: 'directory', path: 'defs', expectedManifestHash: hash }],
              writes: [],
            }),
          ),
        ).toThrow(StorageConflictError);
      });

      it('detects recursive nested additions two levels deep', () => {
        storage.write('defs/a.yaml', 'a: 1\n');
        storage.write('defs/sub/b.yaml', 'b: 2\n');
        const hash = computeDirectoryManifestHash(storage, 'defs');
        storage.write('defs/sub/deep/c.yaml', 'c: 3\n');

        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-dir-deep',
              readSet: [{ kind: 'directory', path: 'defs', expectedManifestHash: hash }],
              writes: [],
            }),
          ),
        ).toThrow(StorageConflictError);
      });
    });

    // ── readSet file expectations ─────────────────────────────────────────

    describe('readSet file expectations', () => {
      it('passes when readSet file hash matches', () => {
        storage.write('source.yaml', 'data');
        storage.commitBatch(
          memoryTx({
            transactionId: 'tx-read-ok',
            readSet: [
              {
                kind: 'file',
                path: 'source.yaml',
                expectedHash: computeContentHash('data'),
              },
            ],
            writes: [
              { type: 'put', path: 'out.txt', content: 'done', expectedHash: null },
            ],
          }),
        );
        expect(storage.read('out.txt')).toBe('done');
      });

      it('rejects a stale readSet file expectation', () => {
        storage.write('source.yaml', 'original');
        const hash = computeContentHash('original');
        storage.write('source.yaml', 'changed');

        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-read-stale',
              readSet: [{ kind: 'file', path: 'source.yaml', expectedHash: hash }],
              writes: [
                { type: 'put', path: 'out.txt', content: 'done', expectedHash: null },
              ],
            }),
          ),
        ).toThrow(StorageConflictError);
        expect(storage.readOptional('out.txt')).toBeNull();
      });

      it('rejects a readSet file that went from existing to missing', () => {
        storage.write('gone.yaml', 'bye');
        const hash = computeContentHash('bye');
        storage.remove('gone.yaml');

        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-read-gone',
              readSet: [{ kind: 'file', path: 'gone.yaml', expectedHash: hash }],
              writes: [],
            }),
          ),
        ).toThrow(StorageConflictError);
      });

      it('rejects a readSet file that appeared (was null, now exists)', () => {
        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-read-appeared',
              readSet: [{ kind: 'file', path: 'magic.yaml', expectedHash: null }],
              writes: [],
            }),
          ),
        ).not.toThrow();
        storage.write('magic.yaml', 'poof');
        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-read-appeared-2',
              readSet: [{ kind: 'file', path: 'magic.yaml', expectedHash: null }],
              writes: [],
            }),
          ),
        ).toThrow(StorageConflictError);
      });

      it('rejects a readSet file with null expectedHash when file exists', () => {
        storage.write('exists.yaml', 'data');
        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-read-null-vs-exists',
              readSet: [{ kind: 'file', path: 'exists.yaml', expectedHash: null }],
              writes: [],
            }),
          ),
        ).toThrow(StorageConflictError);
      });
    });

    // ── atomic batch semantics ────────────────────────────────────────────

    describe('atomic batch semantics', () => {
      it('publishes all writes or none for preimage failure', () => {
        storage.write('first.yaml', 'original');
        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-atomic-fail',
              writes: [
                { type: 'put', path: 'first.yaml', content: 'changed', expectedHash: computeContentHash('original') },
                { type: 'put', path: 'second.yaml', content: 'also', expectedHash: computeContentHash('WRONG') },
              ],
            }),
          ),
        ).toThrow(StorageConflictError);
        // Neither write should land
        expect(storage.read('first.yaml')).toBe('original');
        expect(storage.readOptional('second.yaml')).toBeNull();
      });

      it('rejects duplicate write paths', () => {
        expect(() =>
          storage.commitBatch(
            memoryTx({
              transactionId: 'tx-dup',
              writes: [
                { type: 'put', path: 'dup.txt', content: 'first', expectedHash: null },
                { type: 'put', path: 'dup.txt', content: 'second', expectedHash: null },
              ],
            }),
          ),
        ).toThrow();
      });
    });

    // ── resolvePath ───────────────────────────────────────────────────────

    describe('resolvePath', () => {
      it('resolves POSIX-absolute virtual paths', () => {
        storage.write('project/nova.yaml', 'x');
        expect(storage.resolvePath('project/../project/nova.yaml')).toBe('/project/nova.yaml');
      });

      it('resolves to root for top-level files', () => {
        expect(storage.resolvePath('nova.yaml')).toBe('/nova.yaml');
      });
    });
  });

  // ========================================================================
  // FsStorage cases
  // ========================================================================

  describe('FsStorage', () => {
    let tmpDir: string;
    let storage: FsStorage;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-storage-'));
      storage = new FsStorage();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── expectedHash semantics ─────────────────────────────────────────────

    describe('expectedHash semantics', () => {
      it('writes a new file with null expectedHash', () => {
        const target = path.join(tmpDir, 'novel.md');
        storage.commitBatch(
          fsTx(tmpDir, {
            transactionId: 'fs-null-hash',
            writes: [{ type: 'put', path: target, content: '# Hello', expectedHash: null }],
          }),
        );
        expect(storage.read(target)).toBe('# Hello');
      });

      it('replaces a file with matching expectedHash', () => {
        const target = path.join(tmpDir, 'novel.md');
        storage.write(target, 'old content');
        storage.commitBatch(
          fsTx(tmpDir, {
            transactionId: 'fs-replace',
            writes: [
              {
                type: 'put',
                path: target,
                content: 'new content',
                expectedHash: computeContentHash('old content'),
              },
            ],
          }),
        );
        expect(storage.read(target)).toBe('new content');
      });

      it('rejects a put with null expectedHash when file exists (create-only)', () => {
        const target = path.join(tmpDir, 'novel.md');
        storage.write(target, 'existing');
        expect(() =>
          storage.commitBatch(
            fsTx(tmpDir, {
              transactionId: 'fs-null-conflict',
              writes: [
                {
                  type: 'put',
                  path: target,
                  content: 'new',
                  expectedHash: null,
                },
              ],
            }),
          ),
        ).toThrow(StorageConflictError);
        expect(storage.read(target)).toBe('existing');
      });

      it('deletes a file with matching expectedHash', () => {
        const target = path.join(tmpDir, 'torm.md');
        storage.write(target, 'remove me');
        storage.commitBatch(
          fsTx(tmpDir, {
            transactionId: 'fs-delete',
            writes: [
              { type: 'delete', path: target, expectedHash: computeContentHash('remove me') },
            ],
          }),
        );
        expect(storage.readOptional(target)).toBeNull();
      });
    });

    // ── lock handling ─────────────────────────────────────────────────────

    describe('lock handling', () => {
      function writeLock(ownerToken: string, pid: number, expiresAt: string): void {
        const lockPath = path.join(tmpDir, 'transactions', 'workspace.lock');
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(
          lockPath,
          `${JSON.stringify(
            { version: 1, ownerToken, pid, acquiredAt: new Date().toISOString(), expiresAt },
            null,
            2,
          )}\n`,
          'utf8',
        );
      }

      it('rejects a live unexpired lock', () => {
        writeLock('other-owner', process.pid, new Date(Date.now() + 300_000).toISOString());

        const target = path.join(tmpDir, 'out.txt');
        expect(() =>
          storage.commitBatch(
            fsTx(tmpDir, {
              transactionId: 'fs-reject-live',
              writes: [{ type: 'put', path: target, content: 'nope', expectedHash: null }],
            }),
          ),
        ).toThrow(StorageConflictError);
        expect(storage.readOptional(target)).toBeNull();
      });

      it('reclaims an expired lock', () => {
        writeLock('stale-owner', process.pid, new Date(Date.now() - 60_000).toISOString());

        const target = path.join(tmpDir, 'reclaimed.txt');
        storage.commitBatch(
          fsTx(tmpDir, {
            transactionId: 'fs-reclaim-expired',
            writes: [{ type: 'put', path: target, content: 'success', expectedHash: null }],
          }),
        );
        expect(storage.read(target)).toBe('success');

        // Stale lock was moved to conflict dir as evidence
        const conflictsDir = path.join(tmpDir, 'conflicts');
        const entries = fs.readdirSync(conflictsDir);
        expect(entries.some((e) => e.startsWith('stale-lock-'))).toBe(true);
      });

      it('reclaims a dead lock (non-existent PID)', () => {
        writeLock('dead-owner', 999_999_999, new Date(Date.now() + 300_000).toISOString());

        const target = path.join(tmpDir, 'reclaimed.txt');
        storage.commitBatch(
          fsTx(tmpDir, {
            transactionId: 'fs-reclaim-dead',
            writes: [{ type: 'put', path: target, content: 'success', expectedHash: null }],
          }),
        );
        expect(storage.read(target)).toBe('success');

        const conflictsDir = path.join(tmpDir, 'conflicts');
        const entries = fs.readdirSync(conflictsDir);
        expect(entries.some((e) => e.startsWith('stale-lock-'))).toBe(true);
      });

      it('reclaims a lock with PID 0 (always dead)', () => {
        writeLock('zero-pid-owner', 0, new Date(Date.now() + 300_000).toISOString());

        const target = path.join(tmpDir, 'reclaimed-zero.txt');
        storage.commitBatch(
          fsTx(tmpDir, {
            transactionId: 'fs-reclaim-zero',
            writes: [{ type: 'put', path: target, content: 'success', expectedHash: null }],
          }),
        );
        expect(storage.read(target)).toBe('success');
      });
    });

    // ── journal recovery ──────────────────────────────────────────────────

    describe('journal recovery', () => {
      /**
       * Write a journal file that looks like FsStorage's own StorageJournalV1.
       * The file paths are rooted in tmpDir so recovery can find temp/backup files.
       */
      function writeJournal(
        transactionId: string,
        phase: 'prepared' | 'publishing' | 'committed',
        entries: Array<{
          type: 'put' | 'delete';
          path: string;
          tempPath: string | null;
          backupPath: string;
          existed: boolean;
        }>,
      ): void {
        const journalPath = path.join(tmpDir, 'transactions', `${transactionId}.json`);
        fs.mkdirSync(path.dirname(journalPath), { recursive: true });
        fs.writeFileSync(
          journalPath,
          `${JSON.stringify(
            { version: 1, transactionId, ownerToken: 'recovery-test', phase, entries },
            null,
            2,
          )}\n`,
          'utf8',
        );
      }

      it('recovers from prepared phase (cleans temp files and journal)', () => {
        const txId = 'tx-rec-prep';
        const target = path.join(tmpDir, 'target.txt');
        const tempPath = path.join(tmpDir, 'transactions', `${txId}.${txId}.0.tmp`);
        const backupPath = path.join(tmpDir, 'transactions', `${txId}.${txId}.0.bak`);

        // Simulate a prepared journal with a temp file
        fs.mkdirSync(path.dirname(tempPath), { recursive: true });
        fs.writeFileSync(tempPath, 'orphaned temp', 'utf8');

        writeJournal(txId, 'prepared', [
          {
            type: 'put',
            path: target,
            tempPath,
            backupPath,
            existed: false,
          },
        ]);

        // Journal exists before recovery
        const jPath = path.join(tmpDir, 'transactions', `${txId}.json`);
        expect(fs.existsSync(jPath)).toBe(true);

        // Commit a transaction with the SAME journal path — recovery runs first
        const newTarget = path.join(tmpDir, 'after-recovery.txt');
        storage.commitBatch(
          fsTx(tmpDir, {
            transactionId: txId,
            writes: [{ type: 'put', path: newTarget, content: 'recovered', expectedHash: null }],
          }),
        );

        // Temp file should be cleaned up
        expect(fs.existsSync(tempPath)).toBe(false);
        // Old journal should be gone (replaced by fresh one, then cleaned by new tx)
        expect(fs.existsSync(jPath)).toBe(false);
        // New transaction landed
        expect(storage.read(newTarget)).toBe('recovered');
      });

      it('recovers from publishing phase (rolls back partial writes)', () => {
        const txId = 'tx-rec-pub';
        const target1 = path.join(tmpDir, 'file1.txt');
        const target2 = path.join(tmpDir, 'file2.txt');

        // Simulate state during publishing: file1 was overwritten, file2 was deleted
        fs.writeFileSync(target1, 'published content', 'utf8');
        fs.writeFileSync(target2, 'original content', 'utf8');

        const backupPath1 = path.join(tmpDir, 'transactions', `${txId}.${txId}.0.bak`);
        const backupPath2 = path.join(tmpDir, 'transactions', `${txId}.${txId}.1.bak`);

        writeJournal(txId, 'publishing', [
          {
            type: 'put',
            path: target1,
            tempPath: null, // already renamed to target1
            backupPath: backupPath1,
            existed: true,
          },
          {
            type: 'delete',
            path: target2,
            tempPath: null,
            backupPath: backupPath2,
            existed: true,
          },
        ]);

        // Create backups as they would be mid-publish
        fs.mkdirSync(path.dirname(backupPath1), { recursive: true });
        fs.writeFileSync(backupPath1, 'backup of file1', 'utf8');
        fs.writeFileSync(backupPath2, 'backup of file2', 'utf8');

        // Commit a transaction with the SAME journal path — recovery triggers rollback
        const newTarget = path.join(tmpDir, 'after-rollback.txt');
        storage.commitBatch(
          fsTx(tmpDir, {
            transactionId: txId,
            writes: [{ type: 'put', path: newTarget, content: 'recovered', expectedHash: null }],
          }),
        );

        // File1 should be restored from backup (it was overwritten during publishing)
        expect(storage.read(target1)).toBe('backup of file1');
        // File2 should be restored from backup (it was deleted during publishing)
        expect(storage.read(target2)).toBe('backup of file2');
        // Backups cleaned up
        expect(fs.existsSync(backupPath1)).toBe(false);
        expect(fs.existsSync(backupPath2)).toBe(false);
        // New transaction landed
        expect(storage.read(newTarget)).toBe('recovered');
      });

      it('recovers from committed phase (cleans straggler artifacts)', () => {
        const txId = 'tx-rec-com';
        const target = path.join(tmpDir, 'clean.txt');
        const tempPath = path.join(tmpDir, 'transactions', `${txId}.${txId}.0.tmp`);
        const backupPath = path.join(tmpDir, 'transactions', `${txId}.${txId}.0.bak`);

        // Simulate artifacts left after a committed transaction that crashed before cleanup
        fs.writeFileSync(target, 'committed content', 'utf8');
        fs.mkdirSync(path.dirname(tempPath), { recursive: true });
        fs.writeFileSync(tempPath, 'stale temp', 'utf8');
        fs.writeFileSync(backupPath, 'stale backup', 'utf8');

        writeJournal(txId, 'committed', [
          {
            type: 'put',
            path: target,
            tempPath,
            backupPath,
            existed: true,
          },
        ]);

        const jPath = path.join(tmpDir, 'transactions', `${txId}.json`);
        expect(fs.existsSync(jPath)).toBe(true);

        const newTarget = path.join(tmpDir, 'after-commit-recovery.txt');
        storage.commitBatch(
          fsTx(tmpDir, {
            transactionId: txId,
            writes: [{ type: 'put', path: newTarget, content: 'ok', expectedHash: null }],
          }),
        );

        // Temp and backup cleaned up, journal deleted
        expect(fs.existsSync(tempPath)).toBe(false);
        expect(fs.existsSync(backupPath)).toBe(false);
        expect(fs.existsSync(jPath)).toBe(false);
        // Target file remains (committed)
        expect(storage.read(target)).toBe('committed content');
        expect(storage.read(newTarget)).toBe('ok');
      });

      it('recovers a publishing journal where a create-only put has no backup', () => {
        const txId = 'tx-rec-pub-create';
        const newFile = path.join(tmpDir, 'new-file.txt');
        const backupPath = path.join(tmpDir, 'transactions', `${txId}.${txId}.0.bak`);

        // Simulate: publishing phase, a new file was created (no backup since it didn't exist)
        fs.writeFileSync(newFile, 'created mid-publish', 'utf8');

        writeJournal(txId, 'publishing', [
          {
            type: 'put',
            path: newFile,
            tempPath: null, // already renamed
            backupPath,
            existed: false,
          },
        ]);

        // Recovery should delete the new file since it has no backup to restore
        const after = path.join(tmpDir, 'after-create-rollback.txt');
        storage.commitBatch(
          fsTx(tmpDir, {
            transactionId: txId,
            writes: [{ type: 'put', path: after, content: 'ok', expectedHash: null }],
          }),
        );

        // The new file should have been rolled back (deleted)
        expect(fs.existsSync(newFile)).toBe(false);
        expect(storage.read(after)).toBe('ok');
      });
    });

    // ── preimage mismatch ─────────────────────────────────────────────────

    describe('preimage mismatch', () => {
      it('rejects a put preimage mismatch without partial publish', () => {
        const target1 = path.join(tmpDir, 'file1.txt');
        const target2 = path.join(tmpDir, 'file2.txt');

        fs.writeFileSync(target1, 'before1', 'utf8');
        fs.writeFileSync(target2, 'before2', 'utf8');

        expect(() =>
          storage.commitBatch(
            fsTx(tmpDir, {
              transactionId: 'fs-preimage',
              writes: [
                {
                  type: 'put',
                  path: target1,
                  content: 'after1',
                  expectedHash: computeContentHash('before1'),
                },
                {
                  type: 'put',
                  path: target2,
                  content: 'after2',
                  expectedHash: computeContentHash('WRONG'), // will fail
                },
              ],
            }),
          ),
        ).toThrow(StorageConflictError);

        // file1 must NOT have been modified (rolled back)
        expect(storage.read(target1)).toBe('before1');
        // file2 unchanged
        expect(storage.read(target2)).toBe('before2');
      });

      it('writes conflict evidence on preimage mismatch', () => {
        const target = path.join(tmpDir, 'source.md');
        fs.writeFileSync(target, 'original', 'utf8');

        expect(() =>
          storage.commitBatch(
            fsTx(tmpDir, {
              transactionId: 'fs-preimage-evidence',
              writes: [
                {
                  type: 'put',
                  path: target,
                  content: 'new',
                  expectedHash: computeContentHash('different'),
                },
              ],
            }),
          ),
        ).toThrow(StorageConflictError);

        const conflictsDir = path.join(tmpDir, 'conflicts');
        const entries = fs.readdirSync(conflictsDir);
        expect(entries.length).toBeGreaterThan(0);
        const content = fs.readFileSync(path.join(conflictsDir, entries[0]), 'utf8');
        expect(content).toContain('write_preimage_mismatch');
      });

      it('rejects a delete preimage mismatch', () => {
        const target = path.join(tmpDir, 'torm.md');
        fs.writeFileSync(target, 'current content', 'utf8');

        expect(() =>
          storage.commitBatch(
            fsTx(tmpDir, {
              transactionId: 'fs-preimage-del',
              writes: [
                { type: 'delete', path: target, expectedHash: computeContentHash('different') },
              ],
            }),
          ),
        ).toThrow(StorageConflictError);

        expect(storage.read(target)).toBe('current content');
      });

      it('rejects a readSet mismatch on FsStorage', () => {
        const source = path.join(tmpDir, 'source.yaml');
        fs.writeFileSync(source, 'original', 'utf8');
        // Change after capturing hash
        const hash = computeContentHash('original');
        fs.writeFileSync(source, 'changed', 'utf8');

        expect(() =>
          storage.commitBatch(
            fsTx(tmpDir, {
              transactionId: 'fs-readset',
              readSet: [{ kind: 'file', path: source, expectedHash: hash }],
              writes: [
                { type: 'put', path: path.join(tmpDir, 'out.txt'), content: 'x', expectedHash: null },
              ],
            }),
          ),
        ).toThrow(StorageConflictError);
        expect(storage.readOptional(path.join(tmpDir, 'out.txt'))).toBeNull();
      });

      it('rejects a directory readSet mismatch on FsStorage', () => {
        const dir = path.join(tmpDir, 'defs');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'a.yaml'), 'a: 1\n', 'utf8');

        const hash = computeDirectoryManifestHash(storage, dir);
        fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'nested', 'b.yaml'), 'b: 2\n', 'utf8');

        expect(() =>
          storage.commitBatch(
            fsTx(tmpDir, {
              transactionId: 'fs-dir-readset',
              readSet: [{ kind: 'directory', path: dir, expectedManifestHash: hash }],
              writes: [],
            }),
          ),
        ).toThrow(StorageConflictError);
      });
    });

    // ── resolvePath ───────────────────────────────────────────────────────

    describe('resolvePath', () => {
      it('follows symlinks to the real target', () => {
        const realDir = path.join(tmpDir, 'real', 'subdir');
        fs.mkdirSync(realDir, { recursive: true });
        // file inside real dir so resolvePath has something to walk through
        fs.writeFileSync(path.join(realDir, 'data.txt'), 'data', 'utf8');

        const linkDir = path.join(tmpDir, 'link');
        fs.symlinkSync(path.join(tmpDir, 'real'), linkDir);

        const resolved = storage.resolvePath(path.join(tmpDir, 'link', 'subdir', 'data.txt'));
        expect(resolved).toBe(
          fs.realpathSync.native(path.join(tmpDir, 'real', 'subdir', 'data.txt')),
        );
      });

      it('resolves through non-existing path segments to the nearest ancestor', () => {
        const existingDir = path.join(tmpDir, 'existing');
        fs.mkdirSync(existingDir, { recursive: true });

        const resolved = storage.resolvePath(
          path.join(tmpDir, 'existing', 'new-dir', 'new-file.txt'),
        );
        const expected = path.join(
          fs.realpathSync.native(path.join(tmpDir, 'existing')),
          'new-dir',
          'new-file.txt',
        );
        expect(resolved).toBe(expected);
      });

      it('resolves through parent references (..) to nearest ancestor', () => {
        const base = path.join(tmpDir, 'a', 'b');
        fs.mkdirSync(base, { recursive: true });

        // existing/a exists, go up via b/../c/new.txt
        const resolved = storage.resolvePath(path.join(tmpDir, 'a', 'b', '..', 'c', 'new.txt'));
        const expected = path.join(
          fs.realpathSync.native(path.join(tmpDir, 'a')),
          'c',
          'new.txt',
        );
        expect(resolved).toBe(expected);
      });

      it('resolves a chain of symlinks in ancestor path', () => {
        const realTarget = path.join(tmpDir, 'target');
        fs.mkdirSync(realTarget, { recursive: true });
        fs.writeFileSync(path.join(realTarget, 'config.yaml'), 'cfg', 'utf8');

        const linkA = path.join(tmpDir, 'link-a');
        const linkB = path.join(tmpDir, 'link-b');
        fs.symlinkSync(realTarget, linkA);
        fs.symlinkSync(linkA, linkB);

        const resolved = storage.resolvePath(path.join(tmpDir, 'link-b', 'config.yaml'));
        expect(resolved).toBe(
          fs.realpathSync.native(path.join(tmpDir, 'target', 'config.yaml')),
        );
      });

      it('resolves an absolute path directly', () => {
        const filePath = path.join(tmpDir, 'afile.txt');
        fs.writeFileSync(filePath, 'data', 'utf8');

        const resolved = storage.resolvePath(filePath);
        expect(resolved).toBe(fs.realpathSync.native(filePath));
      });
    });

    // ── atomic batch semantics ────────────────────────────────────────────

    describe('atomic batch semantics', () => {
      it('publishes all writes atomically on success', () => {
        const target1 = path.join(tmpDir, 'a.txt');
        const target2 = path.join(tmpDir, 'b.txt');
        const target3 = path.join(tmpDir, 'sub', 'c.txt');

        storage.commitBatch(
          fsTx(tmpDir, {
            transactionId: 'fs-atomic-ok',
            writes: [
              { type: 'put', path: target1, content: 'a', expectedHash: null },
              { type: 'put', path: target2, content: 'b', expectedHash: null },
              { type: 'put', path: target3, content: 'sub c', expectedHash: null },
            ],
          }),
        );
        expect(storage.read(target1)).toBe('a');
        expect(storage.read(target2)).toBe('b');
        expect(storage.read(target3)).toBe('sub c');
      });

      it('rejects duplicate write paths', () => {
        const target = path.join(tmpDir, 'dup.txt');
        expect(() =>
          storage.commitBatch(
            fsTx(tmpDir, {
              transactionId: 'fs-dup',
              writes: [
                { type: 'put', path: target, content: 'first', expectedHash: null },
                { type: 'put', path: target, content: 'second', expectedHash: null },
              ],
            }),
          ),
        ).toThrow();
      });
    });
  });
});
