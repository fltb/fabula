// ============================================================================
// Storage Interface — abstraction over filesystem I/O
// ============================================================================

export interface DirEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

// ── Transaction kernel ──────────────────────────────────────────────────────

/** A read‑side expectation checked before writes are applied. */
export type TransactionReadExpectation =
  | { kind: 'file'; path: string; expectedHash: string | null }
  | { kind: 'directory'; path: string; expectedManifestHash: string };

/** On‑disk lock‑file format (V1). */
export interface LockV1 {
  version: 1;
  ownerToken: string;
  pid: number;
  acquiredAt: string;
  expiresAt: string;
}

/** A single write operation inside a transaction. */
export interface StorageWrite {
  type: 'put' | 'delete';
  path: string;
  content?: string;
  expectedHash: string | null;
}

/** A journal entry written during the publishing phase. */
export interface StorageJournalEntry {
  type: 'put' | 'delete';
  path: string;
  tempPath: string | null;
  backupPath: string;
  existed: boolean;
}

/** On‑disk journal file format (V1). */
export interface StorageJournalV1 {
  version: 1;
  transactionId: string;
  ownerToken: string;
  phase: 'prepared' | 'publishing' | 'committed';
  entries: StorageJournalEntry[];
}

/** Full transaction descriptor passed to Storage.commitBatch. */
export interface StorageTransaction {
  transactionId: string;
  lockPath: string;
  journalPath: string;
  conflictDir: string;
  readSet: readonly TransactionReadExpectation[];
  writes: readonly StorageWrite[];
}

// ── Core storage contract ───────────────────────────────────────────────────

export interface Storage {
  /** Returns true if a file or directory exists at the given path */
  exists(path: string): boolean;

  /** Read a file; throws if it does not exist */
  read(path: string): string;

  /** Read a file; returns null if it does not exist */
  readOptional(path: string): string | null;

  /** Write (or overwrite) a file */
  write(path: string, content: string): void;

  /**
   * Atomically validate read expectations and apply writes under a
   * transaction lock & journal so that a crash at any point can be
   * recovered on the next call.
   */
  commitBatch(transaction: StorageTransaction): void;

  /** Create a directory and all intermediate parents */
  mkdirp(path: string): void;

  /** List directory entries (files + subdirectories) */
  list(path: string): DirEntry[];

  /** List file names (only files, no directories) in a directory */
  listFiles(path: string): string[];

  /** Remove a single file */
  remove(path: string): void;

  /** Recursively remove a file or directory (rm -rf) */
  removeAll(path: string): void;

  /**
   * Resolve a path to its canonical absolute form, following symlinks
   * through existing ancestor directories.  Non‑existing tail segments
   * are left unresolved — the method returns the nearest existing
   * ancestor's realpath joined with the remaining segments.
   */
  resolvePath(filePath: string): string;
}
