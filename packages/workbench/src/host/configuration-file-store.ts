/**
 * Host-only versioned `workbench.yaml` file store.
 *
 * This module is the ONLY reader/writer of the secret-free Host configuration
 * source of truth. It owns the file path resolution under the resolved
 * `WORKBENCH_HOME`, the strict schema validation of the version-1 YAML shape,
 * the content-hash revision identity, the atomic 0600 temp-write + rename, and
 * the debounced external-change watcher. It deliberately holds no SQLite, no
 * `.env` access, and no credential material: configuration content never
 * crosses into persistence, and secrets never enter this file.
 *
 * The pure validation here accepts only the exact `WorkbenchConfigurationV1`
 * wire shape (rejecting unknown fields anywhere), so a hand-edited file that
 * adds a stray key is reported as `UNKNOWN_FIELD` instead of being silently
 * re-serialized into a different document.
 */

import { createHash, randomBytes } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import YAML from 'yaml';
import {
  WORKBENCH_CONFIGURATION_VERSION,
  type ConfigOperationDiagnosticV1,
  type WorkbenchConfigurationV1,
  type WorkbenchNetworkConfigurationV1,
} from '../contracts/configuration.js';

// ─── Host home resolution ────────────────────────────────────────────────────

/** Environment inputs used to resolve the Host home directory. */
export interface WorkbenchHomeEnv {
  readonly WORKBENCH_HOME?: string;
  readonly XDG_STATE_HOME?: string;
  readonly HOME?: string;
}

/**
 * Resolve the Host home directory: `WORKBENCH_HOME` when set, otherwise
 * `$XDG_STATE_HOME/fabula/workbench`, otherwise `$HOME/.local/state/fabula/workbench`.
 * Returns null when no source is available; the caller decides whether an
 * unresolvable home blocks process startup.
 */
export function resolveWorkbenchHome(env: WorkbenchHomeEnv = process.env): string | null {
  const override = env.WORKBENCH_HOME;
  if (override !== undefined && override.trim() !== '') return resolve(override.trim());
  const xdg = env.XDG_STATE_HOME;
  if (xdg !== undefined && xdg.trim() !== '') {
    return resolve(xdg.trim(), 'fabula', 'workbench');
  }
  const home = env.HOME;
  if (home === undefined || home.trim() === '') return null;
  return resolve(home.trim(), '.local', 'state', 'fabula', 'workbench');
}

/** Resolve the versioned configuration file path under a resolved Host home. */
export function resolveConfigurationFilePath(home: string): string {
  return join(home, 'config', 'workbench.yaml');
}

// ─── Canonical serialization and revision ────────────────────────────────────

const NETWORK_KEYS = ['mode', 'port', 'allowedHosts', 'allowedOrigins', 'unixSocket'] as const;
const PROVIDER_KEYS = ['kind', 'baseUrl', 'model'] as const;
const PROJECT_KEYS = ['projectId', 'displayName', 'root'] as const;
const CONFIGURATION_KEYS = [
  'version',
  'projects',
  'defaultProjectId',
  'provider',
  'network',
] as const;

/** Stable plain-object projection; key order is the canonical YAML order. */
function toPlain(configuration: WorkbenchConfigurationV1): Record<string, unknown> {
  return {
    version: configuration.version,
    projects: configuration.projects.map((project) => ({
      projectId: project.projectId,
      displayName: project.displayName,
      root: project.root,
    })),
    defaultProjectId: configuration.defaultProjectId,
    provider:
      configuration.provider === null
        ? null
        : {
            kind: configuration.provider.kind,
            baseUrl: configuration.provider.baseUrl,
            model: configuration.provider.model,
          },
    network: {
      mode: configuration.network.mode,
      port: configuration.network.port,
      allowedHosts: [...configuration.network.allowedHosts],
      allowedOrigins: [...configuration.network.allowedOrigins],
      unixSocket: configuration.network.unixSocket,
    },
  };
}

/** Serialize a configuration to its canonical YAML document (stable key order, no wrapping). */
export function serializeConfigurationYaml(configuration: WorkbenchConfigurationV1): string {
  return YAML.stringify(toPlain(configuration), { lineWidth: 0 });
}

/** Content-hash revision of a configuration: sha256 of the canonical YAML bytes. */
export function configurationRevision(configuration: WorkbenchConfigurationV1): string {
  return createHash('sha256').update(serializeConfigurationYaml(configuration), 'utf8').digest('hex');
}

// ─── Strict shape validation ─────────────────────────────────────────────────

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const LOOPBACK_MODES: readonly string[] = ['loopback', 'lan', 'unix'];

export type ConfigurationShapeResult =
  | { readonly ok: true; readonly configuration: WorkbenchConfigurationV1 }
  | { readonly ok: false; readonly diagnostics: readonly ConfigOperationDiagnosticV1[] };

function diagnostic(code: string, message: string): ConfigOperationDiagnosticV1 {
  return { code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  diagnostics: ConfigOperationDiagnosticV1[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      diagnostics.push(diagnostic('UNKNOWN_FIELD', `Unknown field "${key}" in ${where}.`));
    }
  }
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  where: string,
  diagnostics: ConfigOperationDiagnosticV1[],
): string | null {
  const raw = value[key];
  if (typeof raw !== 'string') {
    diagnostics.push(diagnostic('CONFIG_INVALID', `Field "${where}.${key}" must be a string.`));
    return null;
  }
  return raw;
}

function nullableStringField(
  value: Record<string, unknown>,
  key: string,
  where: string,
  diagnostics: ConfigOperationDiagnosticV1[],
): string | null {
  const raw = value[key];
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    diagnostics.push(diagnostic('CONFIG_INVALID', `Field "${where}.${key}" must be a string or null.`));
    return null;
  }
  return raw;
}

function stringArrayField(
  value: Record<string, unknown>,
  key: string,
  where: string,
  diagnostics: ConfigOperationDiagnosticV1[],
): readonly string[] | null {
  const raw = value[key];
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    diagnostics.push(
      diagnostic('CONFIG_INVALID', `Field "${where}.${key}" must be an array of strings.`),
    );
    return null;
  }
  return raw as string[];
}

/**
 * Parse and strictly validate one YAML document into the version-1
 * configuration shape. Unknown keys anywhere, duplicate project ids, non
 * absolute roots, a default project id that is not registered, malformed
 * provider/listener values and any invalid listener policy are all rejected
 * with typed diagnostics; nothing is silently defaulted.
 */
export function parseConfigurationYaml(content: string): ConfigurationShapeResult {
  let value: unknown;
  try {
    value = YAML.parse(content);
  } catch {
    return {
      ok: false,
      diagnostics: [diagnostic('CONFIG_INVALID', 'workbench.yaml is not valid YAML.')],
    };
  }
  return validateConfigurationShape(value);
}

/**
 * Validate an already-parsed value against the version-1 shape. Exported for
 * the setup draft and admin candidates, which validate in-memory objects
 * before any file write.
 */
export function validateConfigurationShape(value: unknown): ConfigurationShapeResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      diagnostics: [diagnostic('CONFIG_INVALID', 'workbench.yaml must be a mapping at the top level.')],
    };
  }
  const diagnostics: ConfigOperationDiagnosticV1[] = [];
  rejectUnknownKeys(value, CONFIGURATION_KEYS, 'workbench.yaml', diagnostics);

  if (value.version !== WORKBENCH_CONFIGURATION_VERSION) {
    diagnostics.push(
      diagnostic(
        'CONFIG_INVALID',
        `Unsupported configuration version; expected ${WORKBENCH_CONFIGURATION_VERSION}.`,
      ),
    );
  }

  const projects: { projectId: string; displayName: string; root: string }[] = [];
  const seenIds = new Set<string>();
  if (!Array.isArray(value.projects)) {
    diagnostics.push(diagnostic('CONFIG_INVALID', 'Field "projects" must be an array.'));
  } else {
    value.projects.forEach((entry, index) => {
      const where = `projects[${index}]`;
      if (!isRecord(entry)) {
        diagnostics.push(diagnostic('CONFIG_INVALID', `Field "${where}" must be a mapping.`));
        return;
      }
      rejectUnknownKeys(entry, PROJECT_KEYS, where, diagnostics);
      const projectId = stringField(entry, 'projectId', where, diagnostics);
      const displayName = stringField(entry, 'displayName', where, diagnostics);
      const root = stringField(entry, 'root', where, diagnostics);
      if (projectId === null || displayName === null || root === null) return;
      if (!PROJECT_ID_PATTERN.test(projectId)) {
        diagnostics.push(
          diagnostic(
            'CONFIG_INVALID',
            `Field "${where}.projectId" contains characters that are not allowed.`,
          ),
        );
        return;
      }
      if (displayName.trim() === '') {
        diagnostics.push(diagnostic('CONFIG_INVALID', `Field "${where}.displayName" must not be empty.`));
        return;
      }
      if (!isAbsolute(root)) {
        diagnostics.push(
          diagnostic('PROJECT_INVALID_ROOT', `Field "${where}.root" must be an absolute path.`),
        );
        return;
      }
      if (seenIds.has(projectId)) {
        diagnostics.push(
          diagnostic('PROJECT_DUPLICATE_ID', `Project id "${projectId}" is registered twice.`),
        );
        return;
      }
      seenIds.add(projectId);
      projects.push({ projectId, displayName, root });
    });
  }

  let defaultProjectId: string | null = null;
  if (value.defaultProjectId !== undefined) {
    if (value.defaultProjectId === null) {
      defaultProjectId = null;
    } else if (typeof value.defaultProjectId === 'string') {
      if (!seenIds.has(value.defaultProjectId)) {
        diagnostics.push(
          diagnostic(
            'CONFIG_INVALID',
            `defaultProjectId "${value.defaultProjectId}" is not a registered project.`,
          ),
        );
      } else {
        defaultProjectId = value.defaultProjectId;
      }
    } else {
      diagnostics.push(
        diagnostic('CONFIG_INVALID', 'Field "defaultProjectId" must be a string or null.'),
      );
    }
  } else {
    diagnostics.push(
      diagnostic(
        'CONFIG_INVALID',
        'Field "defaultProjectId" is required; write null or a registered project id explicitly.',
      ),
    );
  }

  let provider: WorkbenchConfigurationV1['provider'] = null;
  if (value.provider === undefined) {
    diagnostics.push(
      diagnostic('CONFIG_INVALID', 'Field "provider" is required; write null or a provider mapping explicitly.'),
    );
  } else if (value.provider === null) {
    provider = null;
  } else if (!isRecord(value.provider)) {
    diagnostics.push(diagnostic('CONFIG_INVALID', 'Field "provider" must be a mapping or null.'));
  } else {
    rejectUnknownKeys(value.provider, PROVIDER_KEYS, 'provider', diagnostics);
    const kind = stringField(value.provider, 'kind', 'provider', diagnostics);
    const baseUrl = nullableStringField(value.provider, 'baseUrl', 'provider', diagnostics);
    const model = nullableStringField(value.provider, 'model', 'provider', diagnostics);
    if (kind === 'ai-sdk' && baseUrl !== null && model !== null) {
      if (baseUrl.length > 0 && !/^https?:\/\//.test(baseUrl)) {
        diagnostics.push(
          diagnostic('CONFIG_INVALID', 'provider.baseUrl must be an http(s) URL or null.'),
        );
      }
      provider = { kind: 'ai-sdk', baseUrl: baseUrl.length === 0 ? null : baseUrl, model: model.length === 0 ? null : model };
    } else if (kind !== 'ai-sdk' && kind !== null) {
      diagnostics.push(
        diagnostic('CONFIG_INVALID', `Unsupported provider kind "${kind}"; only "ai-sdk" is valid.`),
      );
    }
  }

  let network: WorkbenchNetworkConfigurationV1 | null = null;
  if (!isRecord(value.network)) {
    diagnostics.push(diagnostic('NETWORK_INVALID', 'Field "network" must be a mapping.'));
  } else {
    rejectUnknownKeys(value.network, NETWORK_KEYS, 'network', diagnostics);
    const mode = stringField(value.network, 'mode', 'network', diagnostics);
    const port = value.network.port;
    const allowedHosts = stringArrayField(value.network, 'allowedHosts', 'network', diagnostics);
    const allowedOrigins = stringArrayField(
      value.network,
      'allowedOrigins',
      'network',
      diagnostics,
    );
    const unixSocket = nullableStringField(value.network, 'unixSocket', 'network', diagnostics);
    if (mode !== null && port !== undefined && allowedHosts !== null && allowedOrigins !== null) {
      if (!LOOPBACK_MODES.includes(mode)) {
        diagnostics.push(
          diagnostic(
            'NETWORK_INVALID',
            `network.mode must be one of ${LOOPBACK_MODES.join(', ')}; got "${mode}".`,
          ),
        );
      } else if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65535) {
        diagnostics.push(
          diagnostic('NETWORK_INVALID', 'network.port must be an integer between 0 and 65535.'),
        );
      } else if (mode === 'unix' && (unixSocket === null || !isAbsolute(unixSocket))) {
        diagnostics.push(
          diagnostic(
            'NETWORK_INVALID',
            'network.unixSocket must be an absolute path when network.mode is "unix".',
          ),
        );
      } else if (mode !== 'unix' && unixSocket !== null) {
        diagnostics.push(
          diagnostic(
            'NETWORK_INVALID',
            'network.unixSocket must be null unless network.mode is "unix".',
          ),
        );
      } else {
        network = {
          mode: mode as WorkbenchNetworkConfigurationV1['mode'],
          port: port as number,
          allowedHosts: [...allowedHosts],
          allowedOrigins: [...allowedOrigins],
          unixSocket,
        };
      }
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  if (network === null) {
    return { ok: false, diagnostics: [diagnostic('NETWORK_INVALID', 'network is required.')] };
  }
  const configuration: WorkbenchConfigurationV1 = {
    version: 1,
    projects,
    defaultProjectId,
    provider,
    network,
  };
  return { ok: true, configuration };
}

// ─── File store ──────────────────────────────────────────────────────────────

export interface ConfigurationFileStoreOptions {
  /** Resolved absolute path of `workbench.yaml` (see {@link resolveConfigurationFilePath}). */
  readonly filePath: string;
  /** Debounce window for external-change events; default 250ms. */
  readonly debounceMs?: number;
}

export interface StoredConfigurationFile {
  readonly configuration: WorkbenchConfigurationV1;
  /** Content-hash revision of the canonical serialization. */
  readonly revision: string;
}

export interface ConfigurationFileWatcher {
  dispose(): void;
}

/**
 * Versioned configuration file store. `read()` returns null when the file
 * does not exist yet (first setup); `write()` performs an atomic 0600
 * temp-write + rename and records the written revision for self-write
 * suppression. `watch()` observes the containing directory (the file is
 * replaced by rename, so a file-scoped watcher would silently detach) and
 * emits a debounced callback for external changes.
 */
export class ConfigurationFileStore {
  readonly #filePath: string;
  readonly #debounceMs: number;
  /** Revision of the most recent successful self-write; watcher callbacks compare against it. */
  #lastWrittenRevision: string | null = null;
  #watcher: FSWatcher | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(options: ConfigurationFileStoreOptions) {
    if (typeof options.filePath !== 'string' || options.filePath.length === 0 || !isAbsolute(options.filePath)) {
      throw new TypeError('ConfigurationFileStore requires an absolute filePath');
    }
    this.#filePath = options.filePath;
    this.#debounceMs = options.debounceMs ?? 250;
  }

  get filePath(): string {
    return this.#filePath;
  }

  /** Revision of the most recent self-write, or null before the first write. */
  lastWrittenRevision(): string | null {
    return this.#lastWrittenRevision;
  }

  /** Read and parse the current file; null when the file does not exist yet. */
  async read(): Promise<StoredConfigurationFile | null> {
    let content: string;
    try {
      content = await readFile(this.#filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const parsed = parseConfigurationYaml(content);
    if (!parsed.ok) {
      throw new ConfigurationFileParseError(parsed.diagnostics);
    }
    return {
      configuration: parsed.configuration,
      revision: configurationRevision(parsed.configuration),
    };
  }

  /**
   * Read the raw file content and its byte revision. Used by the watcher path
   * so an invalid document still yields a candidate revision for the receipt
   * without losing the user's hand-edited bytes.
   */
  async readRaw(): Promise<{ readonly content: string; readonly revision: string } | null> {
    let content: string;
    try {
      content = await readFile(this.#filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return { content, revision: createHash('sha256').update(content, 'utf8').digest('hex') };
  }

  /**
   * Atomically persist a configuration: write the canonical document to a
   * fresh 0600 temporary file in the same directory, fsync-free by design
   * (rename is atomic on POSIX), then rename over the target. A failed write
   * never leaves a partial `workbench.yaml`.
   */
  async write(configuration: WorkbenchConfigurationV1): Promise<string> {
    const revision = configurationRevision(configuration);
    const dir = dirname(this.#filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `.workbench.yaml.tmp-${randomBytes(8).toString('hex')}`);
    try {
      await writeFile(temporary, serializeConfigurationYaml(configuration), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await chmod(temporary, 0o600);
      await rename(temporary, this.#filePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    this.#lastWrittenRevision = revision;
    return revision;
  }

  /** Ensure the config directory exists (e.g. before watching an absent file). */
  async ensureDirectory(): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
  }

  /**
   * Watch for external file changes. The callback fires after a debounce;
   * callers compare the re-read revision against {@link lastWrittenRevision}
   * to suppress their own writes. The watcher is best-effort: a missing or
   * temporarily unavailable directory yields no watcher, and `dispose()` is
   * always safe.
   */
  watch(onExternalChange: () => void | Promise<void>): ConfigurationFileWatcher {
    const dir = dirname(this.#filePath);
    const name = basename(this.#filePath);
    const schedule = (): void => {
      if (this.#disposed) return;
      clearTimeout(this.#timer ?? undefined);
      this.#timer = setTimeout(() => {
        this.#timer = null;
        if (!this.#disposed) void onExternalChange();
      }, this.#debounceMs);
    };
    void mkdir(dir, { recursive: true, mode: 0o700 })
      .then(() => {
        if (this.#disposed) return;
        try {
          this.#watcher = watch(dir, (_event, filename) => {
            if (filename === name) schedule();
          });
        } catch {
          // Best-effort: the next write or an explicit re-watch re-arms.
        }
      })
      .catch(() => undefined);
    return {
      dispose: () => {
        this.#disposed = true;
        clearTimeout(this.#timer ?? undefined);
        this.#timer = null;
        this.#watcher?.close();
        this.#watcher = null;
      },
    };
  }
  async exists(): Promise<boolean> {
    try {
      const info = await stat(this.#filePath);
      return info.isFile();
    } catch {
      return false;
    }
  }
}

/** Typed parse/shape failure of a stored file; diagnostics never carry content. */
export class ConfigurationFileParseError extends Error {
  override readonly name = 'ConfigurationFileParseError';
  readonly diagnostics: readonly ConfigOperationDiagnosticV1[];

  constructor(diagnostics: readonly ConfigOperationDiagnosticV1[]) {
    super('workbench.yaml failed schema validation');
    this.diagnostics = diagnostics;
  }
}
