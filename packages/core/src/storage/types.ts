// ============================================================================
// Storage Interface — abstraction over filesystem I/O
// ============================================================================

export interface DirEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface Storage {
  /** Returns true if a file or directory exists at the given path */
  exists(path: string): boolean;

  /** Read a file; throws if it does not exist */
  read(path: string): string;

  /** Read a file; returns null if it does not exist */
  readOptional(path: string): string | null;

  /** Write (or overwrite) a file */
  write(path: string, content: string): void;

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
}
