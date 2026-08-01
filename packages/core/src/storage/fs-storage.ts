// ============================================================================
// FsStorage — Node.js filesystem-backed Storage implementation
// ============================================================================

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StorageConflictError } from '../errors.ts';
import { computeContentHash, computeDirectoryManifestHash } from './hash.ts';
import type {
  DirEntry,
  LockV1,
  Storage,
  StorageJournalEntry,
  StorageJournalV1,
  StorageTransaction,
  StorageWrite,
} from './types.ts';

const LOCK_VERSION = 1 as const;
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class FsStorage implements Storage {
  exists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  read(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
  }

  readOptional(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  write(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  commitBatch(transaction: StorageTransaction): void {
    // ── 0. Journal recovery (if a journal already exists) ──────────────
    if (fs.existsSync(transaction.journalPath)) {
      this._recoverJournal(transaction);
    }

    // ── 1. Acquire lock (reclaim if expired / dead PID) ───────────────
    this._acquireLock(transaction);

    try {
      // ── 2. Validate read expectations ───────────────────────────────
      for (const expectation of transaction.readSet) {
        if (expectation.kind === 'file') {
          this._checkFileExpectation(expectation);
        } else {
          this._checkDirectoryExpectation(expectation);
        }
      }

      // ── 3. Validate write preimages (expectedHash) ──────────────────
      const seenPaths = new Set<string>();
      for (const write of transaction.writes) {
        if (seenPaths.has(write.path)) {
          throw new Error(
            `Duplicate write path in transaction ${transaction.transactionId}: ${write.path}`,
          );
        }
        seenPaths.add(write.path);
        this._checkWritePreimage(write, transaction);
      }

      // ── 4. Prepare: write temp files ────────────────────────────────
      const ownerToken = crypto.randomUUID();
      const entries: StorageJournalEntry[] = [];
      for (let i = 0; i < transaction.writes.length; i++) {
        const write = transaction.writes[i];
        const tempPath =
          write.type === 'put'
            ? `${write.path}.tmp-${process.pid}-${transaction.transactionId}-${i}`
            : null;
        const backupPath = `${write.path}.bak-${process.pid}-${transaction.transactionId}-${i}`;
        const existed = fs.existsSync(write.path);

        if (write.type === 'put') {
          if (tempPath === null) throw new Error(`Missing temp path for put ${write.path}`);
          fs.mkdirSync(path.dirname(write.path), { recursive: true });
          fs.writeFileSync(tempPath, write.content!, 'utf-8');
        }
        // deletes have no temp file

        entries.push({ type: write.type, path: write.path, tempPath, backupPath, existed });
      }

      // ── 5. Write journal (prepared) ─────────────────────────────────
      const journal: StorageJournalV1 = {
        version: 1,
        transactionId: transaction.transactionId,
        ownerToken,
        phase: 'prepared',
        entries,
      };
      fs.mkdirSync(path.dirname(transaction.journalPath), { recursive: true });
      this._writeJournal(transaction.journalPath, journal);

      // ── 6. Publish: move files into place ───────────────────────────
      journal.phase = 'publishing';
      this._writeJournal(transaction.journalPath, journal);

      for (const entry of entries) {
        if (entry.existed) {
          fs.renameSync(entry.path, entry.backupPath);
        }
        if (entry.tempPath !== null) {
          fs.renameSync(entry.tempPath, entry.path);
        } else {
          // delete: remove the file
          if (fs.existsSync(entry.path)) {
            fs.unlinkSync(entry.path);
          }
        }
      }

      // ── 7. Commit: mark journal committed ───────────────────────────
      journal.phase = 'committed';
      this._writeJournal(transaction.journalPath, journal);

      // ── 8. Cleanup: remove backups and journal ──────────────────────
      for (const entry of entries) {
        if (fs.existsSync(entry.backupPath)) fs.unlinkSync(entry.backupPath);
      }
      fs.unlinkSync(transaction.journalPath);

      // ── 9. Release lock ─────────────────────────────────────────────
      this._releaseLock(transaction);
    } catch (error) {
      // On any failure, attempt rollback via journal then release lock
      try {
        this._rollback(transaction);
      } catch {
        // rollback itself must not throw — best effort
      }
      this._releaseLock(transaction);
      throw error;
    }
  }

  // ── Lock management ─────────────────────────────────────────────────────────

  /** Acquire the transaction lock, reclaiming if stale. */
  private _acquireLock(transaction: StorageTransaction): void {
    fs.mkdirSync(path.dirname(transaction.lockPath), { recursive: true });

    // If lock exists, check if we can reclaim it
    if (fs.existsSync(transaction.lockPath)) {
      this._reclaimLock(transaction);
    }

    // Write our own lock
    const lock: LockV1 = {
      version: LOCK_VERSION,
      ownerToken: crypto.randomUUID(),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
    };
    fs.writeFileSync(transaction.lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf-8');
  }

  /** Try to reclaim a stale lock. Throws StorageConflictError if lock is live. */
  private _reclaimLock(transaction: StorageTransaction): void {
    let existing: LockV1;
    try {
      existing = JSON.parse(fs.readFileSync(transaction.lockPath, 'utf-8')) as LockV1;
    } catch {
      // Unparseable lock file — treat as stale and overwrite
      this._writeConflictEvidence(transaction, 'unparseable_lock', '');
      return;
    }

    if (existing.version !== LOCK_VERSION) {
      this._writeConflictEvidence(transaction, 'lock_version_mismatch', JSON.stringify(existing));
      return; // Treat as reclaimable
    }

    // Check expiry
    const expiresAt = new Date(existing.expiresAt).getTime();
    const now = Date.now();
    if (expiresAt > now) {
      // Lock not yet expired — check PID liveliness
      if (existing.pid > 0) {
        try {
          // Sending signal 0 tests whether the process exists
          process.kill(existing.pid, 0);
          // Process is alive and lock is not expired — real conflict
          this._writeConflictEvidence(transaction, 'live_lock', JSON.stringify(existing));
          throw new StorageConflictError(
            `Transaction lock is held by live PID ${existing.pid} (expires ${existing.expiresAt})`,
            { path: transaction.lockPath, transactionId: transaction.transactionId },
          );
        } catch (err: unknown) {
          if (err instanceof StorageConflictError) throw err;
          // kill(pid, 0) threw — process doesn't exist, reclaim
        }
      }
      // PID === 0 is always dead (never valid on any real OS)
    }

    // Lock is stale — preserve evidence
    this._writeConflictEvidence(transaction, 'stale-lock', JSON.stringify(existing));
  }

  private _releaseLock(transaction: StorageTransaction): void {
    try {
      if (fs.existsSync(transaction.lockPath)) {
        fs.unlinkSync(transaction.lockPath);
      }
    } catch {
      // Best-effort
    }
  }

  // ── Journal recovery ───────────────────────────────────────────────────────

  /**
   * Recover from a previously interrupted transaction.
   * Reads the existing journal and acts based on its `phase`.
   */
  private _recoverJournal(transaction: StorageTransaction): void {
    let journal: StorageJournalV1;
    try {
      journal = JSON.parse(fs.readFileSync(transaction.journalPath, 'utf-8')) as StorageJournalV1;
    } catch {
      // Corrupt journal — delete and let the new transaction proceed
      try {
        fs.unlinkSync(transaction.journalPath);
      } catch {
        /* ignore */
      }
      return;
    }

    if (journal.phase === 'prepared') {
      // Only temp files exist, no changes applied — clean temps
      for (const entry of journal.entries) {
        if (entry.tempPath && fs.existsSync(entry.tempPath)) {
          fs.unlinkSync(entry.tempPath);
        }
      }
    } else if (journal.phase === 'publishing') {
      // Some or all files may have been moved — roll back
      for (const entry of journal.entries) {
        // If a backup exists, restore the original
        if (fs.existsSync(entry.backupPath)) {
          if (fs.existsSync(entry.path)) {
            fs.unlinkSync(entry.path);
          }
          fs.renameSync(entry.backupPath, entry.path);
        } else if (!entry.existed) {
          // New file that was created and has no backup — delete it
          if (fs.existsSync(entry.path)) {
            fs.unlinkSync(entry.path);
          }
        }
        // Clean any straggler temp file
        if (entry.tempPath && fs.existsSync(entry.tempPath)) {
          fs.unlinkSync(entry.tempPath);
        }
      }
    } else if (journal.phase === 'committed') {
      // Writes are already applied — just clean straggler artifacts
      for (const entry of journal.entries) {
        if (entry.tempPath && fs.existsSync(entry.tempPath)) {
          fs.unlinkSync(entry.tempPath);
        }
        if (fs.existsSync(entry.backupPath)) {
          fs.unlinkSync(entry.backupPath);
        }
      }
    }

    // Remove the journal so the new transaction can start fresh
    try {
      fs.unlinkSync(transaction.journalPath);
    } catch {
      /* ignore */
    }
  }

  // ── Rollback ───────────────────────────────────────────────────────────────

  /**
   * Roll back a failed transaction using the journal.
   * Best-effort — never throws.
   */
  private _rollback(transaction: StorageTransaction): void {
    if (!fs.existsSync(transaction.journalPath)) return;

    let journal: StorageJournalV1;
    try {
      journal = JSON.parse(fs.readFileSync(transaction.journalPath, 'utf-8')) as StorageJournalV1;
    } catch {
      return;
    }

    for (const entry of journal.entries) {
      // Restore backup if it exists
      if (fs.existsSync(entry.backupPath)) {
        if (fs.existsSync(entry.path)) {
          fs.unlinkSync(entry.path);
        }
        fs.renameSync(entry.backupPath, entry.path);
      } else if (!entry.existed) {
        // New file that has no backup was created — delete it
        if (fs.existsSync(entry.path)) {
          fs.unlinkSync(entry.path);
        }
      }

      // Clean temp file
      if (entry.tempPath && fs.existsSync(entry.tempPath)) {
        fs.unlinkSync(entry.tempPath);
      }
    }

    // Remove journal
    try {
      fs.unlinkSync(transaction.journalPath);
    } catch {
      /* ignore */
    }
  }

  // ── Preimage and read-set checks ──────────────────────────────────────────

  private _checkFileExpectation(expectation: {
    kind: 'file';
    path: string;
    expectedHash: string | null;
  }): void {
    const current = this.readOptional(expectation.path);
    const currentHash = current !== null ? computeContentHash(current) : null;

    if (currentHash !== expectation.expectedHash) {
      throw new StorageConflictError(`Read expectation mismatch: ${expectation.path}`, {
        path: expectation.path,
      });
    }
  }

  private _checkDirectoryExpectation(expectation: {
    kind: 'directory';
    path: string;
    expectedManifestHash: string;
  }): void {
    const currentHash = computeDirectoryManifestHash(this, expectation.path);
    if (currentHash !== expectation.expectedManifestHash) {
      throw new StorageConflictError(`Directory read expectation mismatch: ${expectation.path}`, {
        path: expectation.path,
      });
    }
  }

  private _checkWritePreimage(write: StorageWrite, transaction: StorageTransaction): void {
    const current = this.readOptional(write.path);
    const currentHash = current !== null ? computeContentHash(current) : null;

    if (write.expectedHash === null) {
      // null expectedHash = create-only for put: file must not exist
      if (write.type === 'put' && currentHash !== null) {
        this._writeConflictEvidence(
          transaction,
          'write_preimage_mismatch',
          JSON.stringify({
            path: write.path,
            expected: null,
            actual: currentHash,
            reason: 'file exists but expectedHash is null',
          }),
        );
        throw new StorageConflictError(
          `Write preimage mismatch for ${write.path}: expected file absent but it exists`,
          { path: write.path, transactionId: transaction.transactionId },
        );
      }
      // delete with null expectedHash: no guard (delete-if-exists)
      return;
    }

    // String hash: exact match required
    if (currentHash !== write.expectedHash) {
      this._writeConflictEvidence(
        transaction,
        'write_preimage_mismatch',
        JSON.stringify({ path: write.path, expected: write.expectedHash, actual: currentHash }),
      );
      throw new StorageConflictError(`Write preimage mismatch for ${write.path}`, {
        path: write.path,
        transactionId: transaction.transactionId,
      });
    }
  }

  // ── Conflict evidence ─────────────────────────────────────────────────────

  private _writeConflictEvidence(
    transaction: StorageTransaction,
    kind: string,
    detail: string,
  ): void {
    try {
      fs.mkdirSync(transaction.conflictDir, { recursive: true });
      const filePath = path.join(
        transaction.conflictDir,
        `${kind}-${transaction.transactionId}-${Date.now()}.json`,
      );
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            kind,
            transactionId: transaction.transactionId,
            detail,
            timestamp: new Date().toISOString(),
          },
          null,
          2,
        ) + '\n',
        'utf-8',
      );
    } catch {
      // Best-effort
    }
  }

  // ── Journal I/O ────────────────────────────────────────────────────────────

  private _writeJournal(journalPath: string, journal: StorageJournalV1): void {
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n', 'utf-8');
  }

  // ── Remaining Storage methods ─────────────────────────────────────────────

  mkdirp(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  list(dirPath: string): DirEntry[] {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isFile: () => e.isFile(),
      isDirectory: () => e.isDirectory(),
    }));
  }

  listFiles(dirPath: string): string[] {
    return fs.readdirSync(dirPath).filter((name) => {
      const fullPath = path.join(dirPath, name);
      return fs.statSync(fullPath).isFile();
    });
  }

  remove(filePath: string): void {
    fs.unlinkSync(filePath);
  }

  removeAll(dirPath: string): void {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }

  resolvePath(filePath: string): string {
    const normalized = path.resolve(filePath);

    // Walk ancestors from the full path toward root until we find one that exists
    const parts = normalized.split(path.sep).filter(Boolean);
    let resolved = '';
    const tail: string[] = [];

    for (const part of parts) {
      const candidate = resolved ? `${resolved}${path.sep}${part}` : `${path.sep}${part}`;
      if (fs.existsSync(candidate)) {
        resolved = fs.realpathSync.native(candidate);
        tail.length = 0; // reset tail — we synced past it
      } else {
        tail.push(part);
      }
    }

    // If nothing existed, resolved will be empty — fall back to root-relative
    if (!resolved) {
      resolved = path.sep;
    }

    return tail.length > 0 ? path.join(resolved, ...tail) : resolved;
  }
}
