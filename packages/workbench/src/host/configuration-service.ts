/**
 * Host-only configuration change service: the single validated writer and
 * applicator of the versioned `workbench.yaml` source of truth.
 *
 * Every adapter — setup wizard, owner dashboard, owner MCP, filesystem
 * watcher and dotenv import — funnels through this service. It enforces the
 * revision CAS (`expectedRevision: null` is permitted only while the file
 * does not exist), validates every candidate against the strict version-1
 * shape plus Host-side root accessibility, computes typed changed-field
 * paths, and decides whether a change requires a controlled restart. Listener
 * policy, provider construction, project roots and MCP default routing are
 * captured at Host startup, so changes to any of them are `restart-required`.
 * An invalid or stale candidate never touches the file; a busy project removal is refused; the watcher path never rewrites a
 * hand-edited file, it only validates and reports.
 *
 * YAML content is never stored in SQLite and this module never reads `.env`:
 * configuration operations record only revision metadata through the
 * injected optional operation sink.
 */

import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import type {
  ConfigChangeOriginV1,
  ConfigOperationDiagnosticV1,
  ConfigOperationReceiptV1,
  WorkbenchConfigurationV1,
} from '../contracts/configuration.js';
import {
  type ConfigurationFileStore,
  configurationRevision,
  parseConfigurationYaml,
  validateConfigurationShape,
} from './configuration-file-store.js';

/** Optional durable record of one configuration operation (metadata only). */
export interface ConfigurationOperationSink {
  record(operation: ConfigurationOperationRecordInput): void | Promise<void>;
}

/** Secret-free durable operation metadata; never YAML content, never secrets. */
export interface ConfigurationOperationRecordInput {
  readonly operationId: string;
  readonly origin: ConfigChangeOriginV1;
  readonly status: string;
  readonly activeRevision?: string;
  readonly candidateRevision?: string;
  readonly changedFields: readonly string[];
  readonly diagnostics: readonly ConfigOperationDiagnosticV1[];
  readonly actorId?: string;
  readonly at: string;
}

export interface ConfigurationServiceOptions {
  /** The versioned file store; owns all file I/O and the external watcher. */
  readonly store: ConfigurationFileStore;
  /** Host-side busy check for project removal; defaults to never-busy. */
  readonly isProjectBusy?: (projectId: string) => boolean | Promise<boolean>;
  /** Durable operation metadata sink; default discards (wired by the Host). */
  readonly operations?: ConfigurationOperationSink | null;
  /** Identifier source for operation records; defaults to a random uuid. */
  readonly newId?: () => string;
  /** Timestamp source; defaults to the host clock. */
  readonly now?: () => string;
}

export interface ActiveConfiguration {
  readonly configuration: WorkbenchConfigurationV1;
  readonly revision: string;
}

export type ConfigurationCandidateResult =
  | { readonly ok: true; readonly revision: string }
  | {
      readonly ok: false;
      readonly diagnostics: readonly ConfigOperationDiagnosticV1[];
    };

export interface ConfigurationApplyInput {
  readonly candidate: WorkbenchConfigurationV1;
  readonly expectedRevision: string | null;
  readonly origin: ConfigChangeOriginV1;
  /** Authenticated actor id when the change has one (dashboard/MCP/setup owner). */
  readonly actorId?: string;
}

const NETWORK_PREFIX = 'network';

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => b[index] === entry);
}

/** Stable ordered changed-field paths between two configurations. */
export function computeChangedFields(
  previous: WorkbenchConfigurationV1 | null,
  next: WorkbenchConfigurationV1,
): readonly string[] {
  if (previous === null) {
    return ['projects', 'defaultProjectId', 'provider', 'network'];
  }
  const changed: string[] = [];
  const previousIds = new Set(previous.projects.map((project) => project.projectId));
  const nextIds = new Set(next.projects.map((project) => project.projectId));
  for (const id of nextIds) {
    if (!previousIds.has(id)) changed.push(`projects.${id}`);
  }
  for (const id of previousIds) {
    if (!nextIds.has(id)) changed.push(`projects.${id}`);
  }
  for (const project of next.projects) {
    const other = previous.projects.find((entry) => entry.projectId === project.projectId);
    if (
      other !== undefined &&
      (other.displayName !== project.displayName || other.root !== project.root)
    ) {
      changed.push(`projects.${project.projectId}`);
    }
  }
  if (previous.defaultProjectId !== next.defaultProjectId) changed.push('defaultProjectId');
  if ((previous.provider === null) !== (next.provider === null)) {
    changed.push('provider');
  } else if (previous.provider !== null && next.provider !== null) {
    if (previous.provider.baseUrl !== next.provider.baseUrl) changed.push('provider.baseUrl');
    if (previous.provider.model !== next.provider.model) changed.push('provider.model');
  }
  if (previous.network.mode !== next.network.mode) changed.push('network.mode');
  if (previous.network.port !== next.network.port) changed.push('network.port');
  if (!arraysEqual(previous.network.allowedHosts, next.network.allowedHosts)) {
    changed.push('network.allowedHosts');
  }
  if (!arraysEqual(previous.network.allowedOrigins, next.network.allowedOrigins)) {
    changed.push('network.allowedOrigins');
  }
  if (previous.network.unixSocket !== next.network.unixSocket) {
    changed.push('network.unixSocket');
  }
  return changed;
}

/**
 * The running Host captures listener policy, providers, project roots and MCP
 * default routing at startup. Any change to those fields is persisted but
 * requires a controlled restart; continuing with a partial live rebuild would
 * split Browser, Yjs, MCP, Agent and controlled-Git state across generations.
 */
export function requiresRestart(changedFields: readonly string[]): boolean {
  return changedFields.some(
    (field) =>
      field === NETWORK_PREFIX ||
      field.startsWith(`${NETWORK_PREFIX}.`) ||
      field === 'provider' ||
      field.startsWith('provider.') ||
      field === 'projects' ||
      field.startsWith('projects.') ||
      field === 'defaultProjectId',
  );
}

export class ConfigurationChangeService {
  readonly #store: ConfigurationFileStore;
  readonly #isProjectBusy: (projectId: string) => boolean | Promise<boolean>;
  readonly #operations: ConfigurationOperationSink | null;
  readonly #newId: () => string;
  readonly #now: () => string;
  /** Last valid configuration observed by this process; truthful active-revision reporting. */
  #lastActive: ActiveConfiguration | null = null;
  #watcher: { dispose(): void } | null = null;
  /** Exclusive operation chain: apply/observe never interleave their read-CAS-write windows. */
  #tail: Promise<void> = Promise.resolve();

  /** Run `fn` exclusively: no other apply/observeExternalChange runs until it settles. */
  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const slot = this.#tail.then(fn);
    this.#tail = slot.then(
      () => undefined,
      () => undefined,
    );
    return slot;
  }

  constructor(options: ConfigurationServiceOptions) {
    if (options.store === null || typeof options.store !== 'object') {
      throw new TypeError('ConfigurationChangeService requires an injected ConfigurationFileStore');
    }
    this.#store = options.store;
    this.#isProjectBusy = options.isProjectBusy ?? (() => false);
    this.#operations = options.operations ?? null;
    this.#newId = options.newId ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** The last valid configuration this process observed, or null. */
  lastActive(): ActiveConfiguration | null {
    return this.#lastActive;
  }

  /** Read the current file; null when it does not exist yet (first setup). */
  async readActive(): Promise<ActiveConfiguration | null> {
    const file = await this.#store.read();
    if (file === null) return null;
    this.#lastActive = file;
    return file;
  }

  /**
   * Validate a candidate without applying it: strict shape plus Host-side
   * root accessibility for every registered project. Used by the setup
   * wizard's per-step validation and by admin project validation.
   */
  async validateCandidate(
    candidate: WorkbenchConfigurationV1,
  ): Promise<ConfigurationCandidateResult> {
    const shaped = validateConfigurationShape(candidate);
    if (!shaped.ok) return { ok: false, diagnostics: shaped.diagnostics };
    const diagnostics: ConfigOperationDiagnosticV1[] = [];
    for (const project of candidate.projects) {
      let info: Stats | null;
      try {
        info = await stat(project.root);
      } catch {
        info = null;
      }
      if (info === null || !info.isDirectory()) {
        diagnostics.push({
          code: 'PROJECT_NOT_ACCESSIBLE',
          message: `Project "${project.projectId}" root is not an accessible directory.`,
        });
      }
    }
    if (diagnostics.length > 0) return { ok: false, diagnostics };
    return { ok: true, revision: configurationRevision(candidate) };
  }

  /**
   * Apply a candidate under the revision CAS. Applies run exclusively (see
   * {@link #enqueue}); the CAS is rechecked against a fresh file read
   * immediately before the atomic write, so two callers carrying the same
   * expectedRevision can never both overwrite the file. Returns a typed
   * receipt; an invalid or stale candidate never modifies the file. A
   * candidate whose only changes are listener-policy fields is persisted but
   * reported as `restart-required` (the running listener does not change).
   */
  apply(input: ConfigurationApplyInput): Promise<ConfigOperationReceiptV1> {
    return this.#enqueue(() => this.#applyLocked(input));
  }

  async #applyLocked(input: ConfigurationApplyInput): Promise<ConfigOperationReceiptV1> {
    const candidateRevision = configurationRevision(input.candidate);
    const current = await this.#store.read();
    const activeRevision = current?.revision ?? this.#lastActive?.revision ?? null;

    // Revision CAS: `expectedRevision: null` is allowed only while no file exists.
    if (input.expectedRevision === null && current !== null) {
      return this.#receipt(
        'stale',
        activeRevision,
        candidateRevision,
        ['configuration'],
        [
          {
            code: 'CONFIG_STALE',
            message:
              'Configuration already exists; expectedRevision null is only valid for first setup.',
          },
        ],
        input.origin,
        input.actorId,
      );
    }
    if (
      input.expectedRevision !== null &&
      (current === null || current.revision !== input.expectedRevision)
    ) {
      return this.#receipt(
        'stale',
        activeRevision,
        candidateRevision,
        ['configuration'],
        [
          {
            code: 'CONFIG_STALE',
            message: 'The configuration changed since it was read; re-read and retry.',
          },
        ],
        input.origin,
        input.actorId,
      );
    }

    const validated = await this.validateCandidate(input.candidate);
    if (!validated.ok) {
      return this.#receipt(
        'invalid',
        activeRevision,
        candidateRevision,
        [],
        validated.diagnostics,
        input.origin,
        input.actorId,
      );
    }

    // Refuse removing a project whose session is busy (in-flight work must
    // never be orphaned by a config change).
    if (current !== null) {
      const removed = current.configuration.projects.filter(
        (project) =>
          !input.candidate.projects.some((entry) => entry.projectId === project.projectId),
      );
      for (const project of removed) {
        if (await this.#isProjectBusy(project.projectId)) {
          return this.#receipt(
            'invalid',
            activeRevision,
            candidateRevision,
            [],
            [
              {
                code: 'PROJECT_BUSY',
                message: `Project "${project.projectId}" is busy and cannot be removed.`,
              },
            ],
            input.origin,
            input.actorId,
          );
        }
      }
    }

    // Final CAS recheck immediately before the atomic write: a non-locked
    // external writer that changed the file mid-apply turns this into a stale
    // receipt instead of silently clobbering the external edit.
    const recheck = await this.#store.read();
    if (recheck?.revision !== current?.revision) {
      return this.#receipt(
        'stale',
        activeRevision,
        candidateRevision,
        ['configuration'],
        [
          {
            code: 'CONFIG_STALE',
            message: 'The configuration changed during apply; re-read and retry.',
          },
        ],
        input.origin,
        input.actorId,
      );
    }

    const changedFields = computeChangedFields(current?.configuration ?? null, input.candidate);
    const status = requiresRestart(changedFields) ? 'restart-required' : 'applied';
    const writtenRevision = await this.#store.write(input.candidate);
    this.#lastActive = { configuration: input.candidate, revision: writtenRevision };
    return this.#receipt(
      status,
      writtenRevision,
      candidateRevision,
      changedFields,
      [],
      input.origin,
      input.actorId,
    );
  }

  /**
   * Watcher path: fully re-read, parse and validate the file that a human or
   * tool edited externally. Runs exclusively with `apply` so a watcher
   * observation never interleaves with an in-flight apply. Hot-safe changes
   * are reported `applied`; listener policy changes `restart-required`; a
   * parse/shape/accessibility failure or a busy-project removal keeps the
   * last valid active configuration and is reported `invalid` — the
   * hand-edited file is NEVER rewritten or deleted. Returns null when the
   * change is this service's own write (self-write suppression) or a content
   * no-op.
   */
  observeExternalChange(): Promise<ConfigOperationReceiptV1 | null> {
    return this.#enqueue(() => this.#observeLocked());
  }

  async #observeLocked(): Promise<ConfigOperationReceiptV1 | null> {
    const raw = await this.#store.readRaw();
    const activeRevision = this.#lastActive?.revision ?? null;
    if (raw === null) {
      return this.#receipt(
        'invalid',
        activeRevision,
        null,
        [],
        [{ code: 'CONFIG_INVALID', message: 'workbench.yaml is missing.' }],
        'filesystem',
        undefined,
      );
    }
    if (raw.revision === this.#store.lastWrittenRevision()) {
      return null; // Our own atomic write; suppress the echo.
    }
    const parsed = parseConfigurationYaml(raw.content);
    if (!parsed.ok) {
      return this.#receipt(
        'invalid',
        activeRevision,
        raw.revision,
        [],
        parsed.diagnostics,
        'filesystem',
        undefined,
      );
    }
    const candidate = parsed.configuration;
    const candidateRevision = configurationRevision(candidate);
    const validated = await this.validateCandidate(candidate);
    if (!validated.ok) {
      return this.#receipt(
        'invalid',
        activeRevision,
        candidateRevision,
        [],
        validated.diagnostics,
        'filesystem',
        undefined,
      );
    }
    if (this.#lastActive !== null) {
      const removed = this.#lastActive.configuration.projects.filter(
        (project) => !candidate.projects.some((entry) => entry.projectId === project.projectId),
      );
      for (const project of removed) {
        if (await this.#isProjectBusy(project.projectId)) {
          return this.#receipt(
            'invalid',
            activeRevision,
            candidateRevision,
            [],
            [
              {
                code: 'PROJECT_BUSY',
                message: `Project "${project.projectId}" is busy and cannot be removed.`,
              },
            ],
            'filesystem',
            undefined,
          );
        }
      }
    }
    const changedFields = computeChangedFields(this.#lastActive?.configuration ?? null, candidate);
    if (changedFields.length === 0) return null; // Content no-op (e.g. formatting).
    const status = requiresRestart(changedFields) ? 'restart-required' : 'applied';
    this.#lastActive = { configuration: candidate, revision: candidateRevision };
    return this.#receipt(
      status,
      candidateRevision,
      candidateRevision,
      changedFields,
      [],
      'filesystem',
      undefined,
    );
  }

  /** Arm the external-change watcher; `onChange` receives the receipt or null (no-op). */
  watch(onChange: (receipt: ConfigOperationReceiptV1 | null) => void | Promise<void>): {
    dispose(): void;
  } {
    this.#watcher?.dispose();
    const watcher = this.#store.watch(() => {
      void this.observeExternalChange().then(onChange);
    });
    this.#watcher = watcher;
    return { dispose: () => watcher.dispose() };
  }

  /** Dispose the store's watcher (idempotent). */
  dispose(): void {
    this.#watcher?.dispose();
    this.#watcher = null;
  }

  #receipt(
    status: ConfigOperationReceiptV1['status'],
    activeRevision: string | null,
    candidateRevision: string | null,
    changedFields: readonly string[],
    diagnostics: readonly ConfigOperationDiagnosticV1[],
    origin: ConfigChangeOriginV1,
    actorId: string | undefined,
  ): ConfigOperationReceiptV1 {
    const receipt: ConfigOperationReceiptV1 = {
      status,
      activeRevision,
      candidateRevision,
      changedFields: [...changedFields],
      diagnostics: [...diagnostics],
    };
    if (this.#operations !== null) {
      void Promise.resolve(
        this.#operations.record({
          operationId: this.#newId(),
          origin,
          status,
          activeRevision: activeRevision ?? undefined,
          candidateRevision: candidateRevision ?? undefined,
          changedFields: [...changedFields],
          diagnostics: [...diagnostics],
          ...(actorId !== undefined ? { actorId } : {}),
          at: this.#now(),
        }),
      ).catch(() => undefined);
    }
    return receipt;
  }
}
