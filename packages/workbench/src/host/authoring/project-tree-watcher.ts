import { type FSWatcher, watch } from 'node:fs';
import { isAbsolute } from 'node:path';
import { classifyAuthoringPath, ENTITY_DIRECTORIES } from './manifest.js';

/** Handle for one recursive host-owned authoring-tree watcher. */
export interface ProjectAuthoringTreeWatcher {
  /** Stops delivery and releases the operating-system watch handle. */
  dispose(): void;
}

export interface ProjectAuthoringTreeWatcherOptions {
  /** Absolute root of the configured authoring project. */
  readonly projectRoot: string;
  /** Receives one relevant relative path per filesystem hint. */
  readonly onChange: (input: { readonly hintPaths: readonly string[] }) => Promise<void>;
}

const ENTITY_DIRECTORY_HINT = new RegExp(
  `^definitions/(?:${ENTITY_DIRECTORIES.join('|')})(?:/[^/]+)*$`,
);
const CHAPTER_DIRECTORY_HINT = /^chapters\/chapter_[0-9]{2}$/;

function normalizeHint(filename: string | Buffer | null): string | null {
  if (filename === null) return null;
  const value = filename.toString().replaceAll('\\', '/');
  return value.length === 0 ? null : value;
}

/**
 * Filesystem hints that can change the source-loader/manifest topology. A
 * recursive watcher deliberately ignores Git and `.nova` activity so managed
 * submission and runtime artifacts cannot produce external candidates.
 */
function isAuthoringHint(path: string | null): boolean {
  if (path === null) return true;
  if (path.split('/').some((segment) => segment.startsWith('.'))) return false;
  if (classifyAuthoringPath(path).ok) return true;
  return (
    path === 'definitions' ||
    path === 'chapters' ||
    ENTITY_DIRECTORY_HINT.test(path) ||
    CHAPTER_DIRECTORY_HINT.test(path)
  );
}

/**
 * Watch the project root recursively using the Node 26 Host runtime. Events
 * are hints only: the observer re-reads the complete constrained tree before
 * staging a candidate. The caller owns this handle alongside the runtime.
 */
export function createProjectAuthoringTreeWatcher(
  options: ProjectAuthoringTreeWatcherOptions,
): ProjectAuthoringTreeWatcher {
  if (!isAbsolute(options.projectRoot)) {
    throw new TypeError('Project authoring tree watcher requires an absolute projectRoot');
  }

  let disposed = false;
  let watcher: FSWatcher;
  const notify = (filename: string | Buffer | null): void => {
    if (disposed) return;
    const path = normalizeHint(filename);
    if (!isAuthoringHint(path)) return;
    void options.onChange({ hintPaths: path === null ? [] : [path] }).catch(() => undefined);
  };

  try {
    watcher = watch(options.projectRoot, { recursive: true }, (_event, filename) => {
      notify(filename);
    });
  } catch (error) {
    throw new Error(`Could not watch project authoring tree: ${options.projectRoot}`, {
      cause: error,
    });
  }
  watcher.on('error', () => {
    // The Host cannot safely infer a missed filesystem state from an error.
    // The handle is closed to avoid an unhandled EventEmitter error; a Host
    // restart explicitly re-arms observation from the authoritative tree.
    watcher.close();
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      watcher.close();
    },
  };
}
