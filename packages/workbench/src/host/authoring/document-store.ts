/**
 * Production Yjs working-document store: the scoped working-document mutation
 * port, the authoring materializer, and the coordinator's window into the
 * working layer — all over ONE shared per-key working-document core.
 *
 * The store NEVER holds a second CRDT or store: it binds the same
 * {@link YjsWorkingDocumentCore} instance the browser Yjs gateway binds, so
 * browser updates, Agent scoped updates, and MCP writes all merge onto the
 * same canonical in-memory document per exact project/document key and the
 * same typed persisted state (`loadWorkingDocument` / `persistYjsUpdate`).
 *
 * Responsibilities:
 *
 *  - Scoped working-document port: `load`, atomic `applyScopedUpdate`
 *    (state-vector CAS + human-presence generation guard + compensating-update
 *    derivation) and conditional `applyCompensatingUpdate`. A moved document
 *    or a human presence transition rejects the mutation and applies nothing;
 *    a revert only ever compensates the exact effect's changes, never a
 *    whole-document rewind.
 *  - Document identity: the per-project catalog maps `documentId` →
 *    manifest-relative `logicalPath` + kind. Catalog documents are seeded
 *    from the accepted source snapshot (`seedFromAccepted`) and never carry
 *    filesystem paths; the materializer resolves working-or-accepted content
 *    for a submit/reconcile candidate.
 *  - Working-layer identity: `workspaceDigest()` is the stable sorted
 *    `logicalPath + state-vector-hash` summary — the submit precondition —
 *    and `isWorkingDirty()` compares materialized working content against
 *    the accepted snapshot. Neither ever leaks document bytes.
 *
 * Working documents are full-text: the working state IS the current document
 * text (prose or raw YAML). Materialization therefore merges working content
 * over the accepted base; a document with no working state falls back to its
 * accepted content. Rebase after an acceptance only re-bases the accepted
 * identity — live working content is never blanked, because it already
 * contains everything the accepted source has.
 */

import { createHash } from 'node:crypto';
import type { ProjectSourceSnapshotV1 } from '@novalistically/core';
import { compareLogicalPaths, computeSourceDocumentHash } from '@novalistically/core/source';
import * as Y from 'yjs';
import {
  AUTHORING_CONTRACT_VERSION,
  type AuthoringDocumentDigestV1,
  type AuthoringWorkspaceDigestV1,
} from '../../contracts/authoring.js';
import type {
  AuthoringWorkingDocumentRecord,
  WorkingDocumentPhase,
  WorkingDocumentState,
  YjsDocumentKey,
} from '../../contracts/persistence.js';
import type { YjsWorkingDocumentCore } from '../yjs/gateway.js';
import { classifyAuthoringPath, ROOT_AUTHORING_FILES } from './manifest.js';
import type { AuthoringDocumentMaterializer } from './types.js';

/** The Yjs text type every working document uses (prose and raw YAML alike). */
export const WORKING_TEXT_TYPE = 'prose';

/** Typed failure thrown by the document store; callers map `code` to a typed outcome. */
export class AuthoringDocumentStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthoringDocumentStoreError';
    this.code = code;
  }
}

/** One catalog entry: exact document identity plus the accepted content base. */
export interface AuthoringDocumentDescriptor {
  readonly projectId: string;
  readonly documentId: string;
  readonly logicalPath: string;
  readonly kind: 'prose' | 'raw-yaml';
  readonly state: WorkingDocumentPhase;
  /** True when the Host currently holds a live working document for this key. */
  readonly available: boolean;
}

/** Optional durable catalog seam. Implementations route to the persistence worker. */
export interface AuthoringDocumentCatalogPort {
  list(projectId: string): Promise<readonly AuthoringWorkingDocumentRecord[]>;
  upsert(record: AuthoringWorkingDocumentRecord): Promise<AuthoringWorkingDocumentRecord>;
}

/** One applied scoped effect; the host derives the compensating update at apply time. */
export interface AgentAppliedTicket {
  /** Live document state vector after the effect applied. */
  readonly stateVector: Uint8Array;
  /** Full persisted working-document update after the effect. */
  readonly update: Uint8Array;
  /** Compensating (inverse) update reverting exactly this effect's changes. */
  readonly compensatingUpdate: Uint8Array;
}

/**
 * Working-layer Yjs document operations. The store owns the Yjs mechanics
 * (merge, diff, compensating-update derivation); callers only ever see opaque
 * byte payloads and state vectors, and never touch files, Git, or the
 * accepted Core projection.
 */
export interface AgentDocumentPort {
  /** Load the persisted working document; null when it has no working state yet. */
  load(key: YjsDocumentKey): Promise<WorkingDocumentState | null>;
  /**
   * Apply a scoped update under a compare-and-swap guard: the live document
   * state vector must equal `expectedBaseVector` AND the human-presence
   * generation must still equal `expectedHumanPresenceGeneration` (observed
   * when the caller prechecked presence). Both are validated atomically
   * inside the document's own mutation critical section. The host derives and
   * returns the compensating update for exactly this effect. A moved vector
   * returns a stale verdict; a presence transition returns a paused verdict;
   * nothing is applied and nothing is rewound.
   */
  applyScopedUpdate(input: {
    readonly projectId: string;
    readonly documentId: string;
    readonly expectedBaseVector: Uint8Array;
    readonly update: Uint8Array;
    /** Human-presence generation observed at precheck time; a newer one rejects the mutation. */
    readonly expectedHumanPresenceGeneration: number;
  }): Promise<
    | { readonly ok: true; readonly ticket: AgentAppliedTicket }
    | { readonly ok: false; readonly reason: 'stale-vector'; readonly liveStateVector: Uint8Array }
    | {
        readonly ok: false;
        readonly reason: 'human-presence-changed';
        readonly liveStateVector: Uint8Array;
      }
  >;
  /**
   * Apply the compensating update for one previously applied effect, guarded
   * by the post-effect state vector CAS and the same atomic human-presence
   * generation check. Only the effect's own changes are compensated — never a
   * whole-document rewind.
   */
  applyCompensatingUpdate(input: {
    readonly projectId: string;
    readonly documentId: string;
    readonly expectedVector: Uint8Array;
    readonly compensatingUpdate: Uint8Array;
    /** Human-presence generation observed at precheck time; a newer one rejects the mutation. */
    readonly expectedHumanPresenceGeneration: number;
  }): Promise<
    | { readonly ok: true; readonly stateVector: Uint8Array }
    | { readonly ok: false; readonly reason: 'stale-vector'; readonly liveStateVector: Uint8Array }
    | {
        readonly ok: false;
        readonly reason: 'human-presence-changed';
        readonly liveStateVector: Uint8Array;
      }
  >;
}

export interface AuthoringWorkingDocumentStoreOptions {
  readonly projectId: string;
  /** Shared per-key working-document core — the SAME instance the browser gateway binds. */
  readonly core: YjsWorkingDocumentCore;
  /** Durable catalog metadata; omitted only for isolated in-memory callers. */
  readonly catalog?: AuthoringDocumentCatalogPort;
  /** Timestamp source; defaults to the host clock. */
  readonly now?: () => string;
  /**
   * Live human-presence generation accessor (wired from the bound
   * ProjectSession). The atomic mutation guard rejects an effect when the
   * generation moved between the caller's observation and the mutation.
   */
  readonly presenceGeneration?: () => number;
}

/** What changed in the working layer, delivered after every successful persist. */
export interface AuthoringWorkingLayerChange {
  readonly workingDirty: boolean;
  readonly workspaceDigest: string | null;
}

/**
 * The production working-document store. Implements the Phase-0
 * {@link AuthoringDocumentMaterializer} (logical path resolution +
 * materialization) plus the scoped working-document mutation port and the
 * coordinator-facing catalog/digest surface. All mutation enters the shared
 * core's per-key serialized sections; nothing here touches files, Git, or the
 * accepted Core projection.
 */
export interface AuthoringWorkingDocumentStore
  extends AuthoringDocumentMaterializer,
    AgentDocumentPort {
  readonly projectId: string;
  /** Seed/rebase the document catalog from the accepted source snapshot. */
  seedFromAccepted(snapshot: ProjectSourceSnapshotV1 | null): Promise<void>;
  /** Register one extra working document (e.g. an adopted scene) not in the accepted snapshot. */
  registerDocument(input: {
    readonly documentId: string;
    readonly logicalPath: string;
    readonly kind: 'prose' | 'raw-yaml';
  }): void;
  createDocument(input: {
    readonly documentId?: string;
    readonly logicalPath: string;
    readonly kind: 'prose' | 'raw-yaml';
  }): Promise<AuthoringDocumentDescriptor>;
  /** Move one active document to another manifest-admitted logical path. */
  moveDocument(input: {
    readonly documentId: string;
    readonly logicalPath: string;
  }): Promise<AuthoringDocumentDescriptor>;
  /** Mark one document as a reversible tombstone. */
  deleteDocument(documentId: string): Promise<AuthoringDocumentDescriptor>;
  /** All catalog descriptors in stable logical-path order. */
  descriptors(): readonly AuthoringDocumentDescriptor[];
  /** One catalog descriptor, or null for an unknown document id. */
  descriptor(documentId: string): AuthoringDocumentDescriptor | null;
  /** Accepted (base) content for a logical path, or null when not in the accepted snapshot. */
  acceptedContent(logicalPath: string): string | null;
  /** Accepted (base) content hash for a logical path, or null when not in the accepted snapshot. */
  acceptedContentHash(logicalPath: string): string | null;
  /** Logical paths of the accepted snapshot, stable order. */
  acceptedPaths(): readonly string[];
  /** True when the working layer differs from the accepted source. */
  isWorkingDirty(): Promise<boolean>;
  /** Current stable workspace digest, or null when the catalog is empty. */
  workspaceDigest(): Promise<AuthoringWorkspaceDigestV1 | null>;
  /** Materialize one document's working text; null when it has no working state. */
  materializeDocument(documentId: string): Promise<string | null>;
  /** Per-document working content hash; null when the document has no working state. */
  workingContentHash(documentId: string): Promise<string | null>;
  /**
   * Working-layer change notification. Fires after every successful persist
   * (browser or Agent origin) with the recomputed dirty flag and digest.
   */
  onChange(listener: (change: AuthoringWorkingLayerChange) => void): () => void;
  /** Drop in-memory state (the shared core's docs stay for the gateway). */
  dispose(): void;
}

function sha256Hex(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function vectorsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** SHA-256 of the empty Yjs state vector — the digest identity of a clean document. */
const EMPTY_STATE_VECTOR_HASH = sha256Hex(Y.encodeStateVector(new Y.Doc()));

function textOf(update: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc.getText(WORKING_TEXT_TYPE).toString();
}

/**
 * Compensating (inverse) update: a full-state update of a scratch document
 * whose text has been restored to the pre-effect content. Applying it to a
 * live document whose state equals the post-effect state (the revert CAS
 * guarantees this) yields exactly the pre-effect content; Yjs skips ops the
 * live document already covers. The restore is a common-prefix/suffix
 * replacement — correct, never a whole-document rewind, and never a minimal
 * diff.
 */
function computeCompensatingUpdate(before: Y.Doc, after: Y.Doc): Uint8Array {
  const beforeText = before.getText(WORKING_TEXT_TYPE).toString();
  const afterText = after.getText(WORKING_TEXT_TYPE).toString();
  if (beforeText === afterText) return new Uint8Array();
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(after));
  const text = scratch.getText(WORKING_TEXT_TYPE);
  const current = text.toString();
  let prefix = 0;
  const maxPrefix = Math.min(current.length, beforeText.length);
  while (prefix < maxPrefix && current[prefix] === beforeText[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(current.length, beforeText.length) - prefix;
  while (
    suffix < maxSuffix &&
    current[current.length - 1 - suffix] === beforeText[beforeText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const currentMiddle = current.length - prefix - suffix;
  const targetMiddle = beforeText.length - prefix - suffix;
  if (currentMiddle > 0) text.delete(prefix, currentMiddle);
  if (targetMiddle > 0) text.insert(prefix, beforeText.slice(prefix, prefix + targetMiddle));
  return Y.encodeStateAsUpdate(scratch);
}

interface CatalogEntry {
  readonly documentId: string;
  logicalPath: string;
  readonly kind: 'prose' | 'raw-yaml';
  state: WorkingDocumentPhase;
  catalogRevision: number;
}
function createAuthoringDocumentStoreImpl(
  options: AuthoringWorkingDocumentStoreOptions,
): AuthoringWorkingDocumentStore {
  const { projectId, core } = options;
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new TypeError('AuthoringWorkingDocumentStore requires a non-empty projectId');
  }
  if (core === null || typeof core !== 'object' || typeof core.enqueue !== 'function') {
    throw new TypeError(
      'AuthoringWorkingDocumentStore requires an injected YjsWorkingDocumentCore',
    );
  }
  const now = options.now ?? (() => new Date().toISOString());
  const presenceGeneration = options.presenceGeneration ?? (() => 0);
  const catalogPort = options.catalog;
  /** documentId → catalog entry (accepted seed + registered extras). */
  const catalog = new Map<string, CatalogEntry>();
  /** logicalPath → accepted base content hash (from the last accepted snapshot). */
  const acceptedContentHashes = new Map<string, string>();
  /** logicalPath → accepted base content (from the last accepted snapshot). */
  const acceptedContents = new Map<string, string>();
  /** documentIds with persisted or in-memory working state. */
  const knownWorking = new Set<string>();
  const changeListeners = new Set<(change: AuthoringWorkingLayerChange) => void>();
  let disposed = false;
  let catalogLoaded = false;
  const keyOf = (documentId: string): YjsDocumentKey => ({ projectId, documentId });
  async function ensureCatalogLoaded(): Promise<void> {
    if (catalogLoaded) return;
    catalogLoaded = true;
    if (catalogPort === undefined) return;
    let records: readonly AuthoringWorkingDocumentRecord[];
    try {
      records = await catalogPort.list(projectId);
    } catch {
      throw new AuthoringDocumentStoreError(
        'document.catalog_unavailable',
        'Working document catalog is unavailable',
      );
    }
    for (const record of records) {
      if (
        record.projectId !== projectId ||
        record.documentId.length === 0 ||
        record.logicalPath.length === 0
      ) {
        continue;
      }
      catalog.set(record.documentId, {
        documentId: record.documentId,
        logicalPath: record.logicalPath,
        kind: record.kind === 'prose' ? 'prose' : 'raw-yaml',
        state: record.state === 'tombstone' ? 'tombstone' : 'active',
        catalogRevision:
          Number.isInteger(record.catalogRevision) && record.catalogRevision > 0
            ? record.catalogRevision
            : 1,
      });
    }
  }

  async function persistCatalog(entry: CatalogEntry): Promise<void> {
    if (catalogPort === undefined) return;
    await catalogPort.upsert({
      projectId,
      documentId: entry.documentId,
      logicalPath: entry.logicalPath,
      kind: entry.kind,
      state: entry.state,
      catalogRevision: entry.catalogRevision,
      updatedAt: now(),
    });
  }

  /** Materialize one document's working text from its persisted state; null when clean. */
  async function materializeWorkingText(documentId: string): Promise<string | null> {
    const state = await core.load(keyOf(documentId));
    if (state === null) return null;
    return textOf(state.update);
  }

  async function workingContentHashOf(documentId: string): Promise<string | null> {
    const text = await materializeWorkingText(documentId);
    return text === null ? null : computeSourceDocumentHash(text);
  }

  async function recomputeAndNotify(): Promise<void> {
    if (disposed) return;
    const dirty = await isWorkingDirty();
    const digest = await computeWorkspaceDigest();
    const change: AuthoringWorkingLayerChange = {
      workingDirty: dirty,
      workspaceDigest: digest === null ? null : digest.digest,
    };
    for (const listener of changeListeners) listener(change);
  }

  async function computeWorkspaceDigest(): Promise<AuthoringWorkspaceDigestV1 | null> {
    const entries = [...catalog.values()].sort((a, b) =>
      compareLogicalPaths(a.logicalPath, b.logicalPath),
    );
    if (entries.length === 0) return null;
    const documents: AuthoringDocumentDigestV1[] = [];
    for (const entry of entries) {
      const state = await core.load(keyOf(entry.documentId));
      documents.push({
        logicalPath: entry.logicalPath,
        stateVectorHash: state === null ? EMPTY_STATE_VECTOR_HASH : sha256Hex(state.stateVector),
      });
    }
    const digest = sha256Hex(
      Buffer.from(
        entries
          .map((entry, index) => {
            const document = documents[index];
            return `${document.logicalPath}\u0000${document.stateVectorHash}\u0000${entry.state}\u0000`;
          })
          .join(''),
        'utf8',
      ),
    );
    return {
      version: AUTHORING_CONTRACT_VERSION,
      projectId,
      documents,
      digest,
      generatedAt: now(),
    };
  }

  async function isWorkingDirty(): Promise<boolean> {
    for (const entry of catalog.values()) {
      if (entry.state === 'tombstone') {
        if (acceptedContentHashes.has(entry.logicalPath)) return true;
        continue;
      }
      const working = await materializeWorkingText(entry.documentId);
      if (working === null) continue;
      const accepted = acceptedContentHashes.get(entry.logicalPath);
      if (accepted === undefined || computeSourceDocumentHash(working) !== accepted) return true;
    }
    return false;
  }

  // The working layer changed through ANY writer (browser gateway or this
  // store): refresh the known-working set and notify change listeners.
  const unsubscribePersist = core.onPersist((key) => {
    if (key.projectId !== projectId) return;
    knownWorking.add(key.documentId);
    void recomputeAndNotify();
  });

  return {
    projectId,

    // ── Catalog / accepted base ──────────────────────────────────────────

    async seedFromAccepted(snapshot) {
      await ensureCatalogLoaded();
      if (snapshot === null) {
        acceptedContentHashes.clear();
        acceptedContents.clear();
        return;
      }
      const acceptedPaths = new Set(snapshot.documents.map((document) => document.logicalPath));
      for (const logicalPath of [...acceptedContentHashes.keys()]) {
        if (acceptedPaths.has(logicalPath)) continue;
        acceptedContentHashes.delete(logicalPath);
        acceptedContents.delete(logicalPath);
        for (const [documentId, entry] of catalog) {
          if (entry.logicalPath === logicalPath && entry.state !== 'tombstone')
            catalog.delete(documentId);
        }
      }
      for (const document of snapshot.documents) {
        const existing = [...catalog.values()].find(
          (entry) => entry.logicalPath === document.logicalPath,
        );
        if (existing === undefined) {
          const entry: CatalogEntry = {
            documentId: document.logicalPath,
            logicalPath: document.logicalPath,
            kind: 'raw-yaml',
            state: 'active',
            catalogRevision: 1,
          };
          catalog.set(entry.documentId, entry);
        }
        acceptedContentHashes.set(document.logicalPath, document.contentHash);
        acceptedContents.set(document.logicalPath, document.content);
      }
      for (const entry of catalog.values()) {
        if (entry.state === 'tombstone') continue;
        const accepted = acceptedContents.get(entry.logicalPath);
        if (accepted !== undefined) {
          const key = keyOf(entry.documentId);
          await core.enqueue(key, async () => {
            const created = await core.getOrCreate(key);
            if (created === null) {
              throw new AuthoringDocumentStoreError(
                'document.storage_unavailable',
                'Working document storage is unavailable',
              );
            }
            if (created.stored !== null) return;
            const text = created.doc.getText(WORKING_TEXT_TYPE);
            if (text.length === 0 && accepted.length > 0) text.insert(0, accepted);
            await core.persist(key, created.doc);
            knownWorking.add(entry.documentId);
          });
        }
        await persistCatalog(entry);
      }
    },

    registerDocument(input) {
      if (typeof input.documentId !== 'string' || input.documentId.length === 0) {
        throw new TypeError('registerDocument requires a non-empty documentId');
      }
      if (typeof input.logicalPath !== 'string' || input.logicalPath.length === 0) {
        throw new TypeError('registerDocument requires a non-empty logicalPath');
      }
      const entry: CatalogEntry = {
        documentId: input.documentId,
        logicalPath: input.logicalPath,
        kind: input.kind,
        state: 'active',
        catalogRevision: 1,
      };
      catalog.set(input.documentId, entry);
      void persistCatalog(entry);
    },

    async createDocument(input) {
      const classification = classifyAuthoringPath(input.logicalPath);
      if (!classification.ok) {
        throw new AuthoringDocumentStoreError('document.invalid_path', classification.message);
      }
      const existing = [...catalog.values()].find(
        (entry) => entry.logicalPath === input.logicalPath,
      );
      if (existing !== undefined) {
        if (existing.state === 'tombstone') {
          existing.state = 'active';
          existing.catalogRevision += 1;
          await persistCatalog(existing);
          return this.descriptor(existing.documentId) as AuthoringDocumentDescriptor;
        }
        throw new AuthoringDocumentStoreError(
          'document.already_exists',
          'A working document already uses that logical path.',
        );
      }
      const documentId =
        typeof input.documentId === 'string' && input.documentId.length > 0
          ? input.documentId
          : `document-${catalog.size + 1}`;
      if (catalog.has(documentId)) {
        throw new AuthoringDocumentStoreError(
          'document.already_exists',
          'The allocated document identity already exists.',
        );
      }
      const entry: CatalogEntry = {
        documentId,
        logicalPath: input.logicalPath,
        kind: classification.kind === 'scene-md' ? 'prose' : input.kind,
        state: 'active',
        catalogRevision: 1,
      };
      catalog.set(documentId, entry);
      const key = keyOf(documentId);
      await core.enqueue(key, async () => {
        const created = await core.getOrCreate(key);
        if (created === null)
          throw new AuthoringDocumentStoreError(
            'document.storage_unavailable',
            'Working document storage is unavailable',
          );
        if (created.stored === null) await core.persist(key, created.doc);
      });
      await persistCatalog(entry);
      return this.descriptor(documentId) as AuthoringDocumentDescriptor;
    },

    async moveDocument(input) {
      const classification = classifyAuthoringPath(input.logicalPath);
      if (!classification.ok) {
        throw new AuthoringDocumentStoreError('document.invalid_path', classification.message);
      }
      const entry = catalog.get(input.documentId);
      if (entry === undefined || entry.state !== 'active') {
        throw new AuthoringDocumentStoreError(
          'document.not_found',
          'The working document is unavailable.',
        );
      }
      const existing = [...catalog.values()].find(
        (candidate) => candidate.state === 'active' && candidate.logicalPath === input.logicalPath,
      );
      if (existing !== undefined && existing.documentId !== input.documentId) {
        throw new AuthoringDocumentStoreError(
          'document.already_exists',
          'A working document already uses that logical path.',
        );
      }
      entry.logicalPath = input.logicalPath;
      entry.catalogRevision += 1;
      await persistCatalog(entry);
      return this.descriptor(input.documentId) as AuthoringDocumentDescriptor;
    },

    async deleteDocument(documentId) {
      const entry = catalog.get(documentId);
      if (entry === undefined || entry.state !== 'active') {
        throw new AuthoringDocumentStoreError(
          'document.not_found',
          'The working document is unavailable.',
        );
      }
      if ((ROOT_AUTHORING_FILES as readonly string[]).includes(entry.logicalPath)) {
        throw new AuthoringDocumentStoreError(
          'document.required',
          'Required authoring documents cannot be deleted.',
        );
      }
      entry.state = 'tombstone';
      entry.catalogRevision += 1;
      await persistCatalog(entry);
      return this.descriptor(documentId) as AuthoringDocumentDescriptor;
    },

    descriptors() {
      return [...catalog.values()]
        .sort((a, b) => compareLogicalPaths(a.logicalPath, b.logicalPath))
        .map((entry) => ({
          projectId,
          documentId: entry.documentId,
          logicalPath: entry.logicalPath,
          kind: entry.kind,
          state: entry.state,
          available:
            entry.state === 'active' &&
            (core.peek(keyOf(entry.documentId)) !== null || knownWorking.has(entry.documentId)),
        }));
    },

    descriptor(documentId) {
      const entry = catalog.get(documentId);
      if (entry === undefined) return null;
      return {
        projectId,
        documentId: entry.documentId,
        logicalPath: entry.logicalPath,
        kind: entry.kind,
        state: entry.state,
        available:
          entry.state === 'active' &&
          (core.peek(keyOf(documentId)) !== null || knownWorking.has(documentId)),
      };
    },
    acceptedContent(logicalPath) {
      return acceptedContents.get(logicalPath) ?? null;
    },

    acceptedContentHash(logicalPath) {
      return acceptedContentHashes.get(logicalPath) ?? null;
    },

    acceptedPaths() {
      return [...acceptedContentHashes.keys()].sort(compareLogicalPaths);
    },

    isWorkingDirty,
    workspaceDigest: computeWorkspaceDigest,
    materializeDocument: materializeWorkingText,
    workingContentHash: workingContentHashOf,

    // ── Materializer (Phase-0 port) ──────────────────────────────────────

    logicalPath(key) {
      return catalog.get(key.documentId)?.logicalPath ?? null;
    },

    async materialize(input) {
      if (input.projectId !== projectId) {
        throw new AuthoringDocumentStoreError(
          'document.invalid_project',
          `Materializer project "${input.projectId}" does not match the store project "${projectId}"`,
        );
      }
      const entries: { logicalPath: string; content: string }[] = [];
      for (const requested of input.documents) {
        const entry = catalog.get(requested.documentId);
        if (entry === undefined || entry.logicalPath !== requested.logicalPath) {
          throw new AuthoringDocumentStoreError(
            'document.invalid_key',
            `Unknown working document ${JSON.stringify(requested.documentId)} for logical path ${JSON.stringify(requested.logicalPath)}`,
          );
        }
        if (entry.state === 'tombstone') continue;
        const working = await materializeWorkingText(requested.documentId);
        if (working !== null) {
          entries.push({ logicalPath: requested.logicalPath, content: working });
          continue;
        }
        const accepted = acceptedContents.get(requested.logicalPath);
        if (accepted === undefined) {
          throw new AuthoringDocumentStoreError(
            'document.unknown_base',
            `No accepted base for working document ${JSON.stringify(requested.documentId)}`,
          );
        }
        entries.push({ logicalPath: requested.logicalPath, content: accepted });
      }
      entries.sort((a, b) => compareLogicalPaths(a.logicalPath, b.logicalPath));
      return { entries };
    },

    // ── Scoped working-document mutation port ───────────────────────────

    async load(key) {
      if (key.projectId !== projectId) return null;
      const state = await core.load(key);
      if (state !== null) knownWorking.add(key.documentId);
      return state;
    },

    async applyScopedUpdate(input) {
      if (input.projectId !== projectId) {
        throw new AuthoringDocumentStoreError(
          'document.invalid_project',
          `Scoped update project "${input.projectId}" does not match the store project "${projectId}"`,
        );
      }
      if (typeof input.documentId !== 'string' || input.documentId.length === 0) {
        throw new AuthoringDocumentStoreError(
          'document.invalid_key',
          'applyScopedUpdate requires a non-empty documentId',
        );
      }
      if (
        !(input.expectedBaseVector instanceof Uint8Array) ||
        !(input.update instanceof Uint8Array)
      ) {
        throw new AuthoringDocumentStoreError(
          'document.invalid_key',
          'applyScopedUpdate requires expectedBaseVector and update as Uint8Array',
        );
      }
      const key = keyOf(input.documentId);
      return core.enqueue(key, async () => {
        if (core.closed) {
          throw new AuthoringDocumentStoreError(
            'document.store_closed',
            'Document store is closed',
          );
        }
        const created = await core.getOrCreate(key);
        if (created === null) {
          throw new AuthoringDocumentStoreError(
            'document.storage_unavailable',
            'Working document storage is unavailable',
          );
        }
        const liveVector = Y.encodeStateVector(created.doc);
        if (!vectorsEqual(liveVector, input.expectedBaseVector)) {
          return {
            ok: false as const,
            reason: 'stale-vector' as const,
            liveStateVector: liveVector,
          };
        }
        // Atomic human-presence generation guard: a human that started or
        // stopped editing between the caller's observation and this mutation
        // rejects the effect without applying anything.
        if (presenceGeneration() !== input.expectedHumanPresenceGeneration) {
          return {
            ok: false as const,
            reason: 'human-presence-changed' as const,
            liveStateVector: liveVector,
          };
        }
        // Apply onto a scratch copy: a corrupt update must never advance the
        // canonical document.
        const merged = new Y.Doc();
        try {
          Y.applyUpdate(merged, Y.encodeStateAsUpdate(created.doc));
          Y.applyUpdate(merged, input.update);
        } catch {
          throw new AuthoringDocumentStoreError(
            'document.update_invalid',
            'Scoped agent update failed Yjs validation',
          );
        }
        let _state: WorkingDocumentState;
        try {
          _state = await core.persist(key, merged);
        } catch {
          throw new AuthoringDocumentStoreError(
            'document.storage_unavailable',
            'Working document persistence failed',
          );
        }
        knownWorking.add(input.documentId);
        const ticket: AgentAppliedTicket = {
          stateVector: Y.encodeStateVector(merged),
          update: Y.encodeStateAsUpdate(merged),
          compensatingUpdate: computeCompensatingUpdate(created.doc, merged),
        };
        return { ok: true as const, ticket };
      });
    },

    async applyCompensatingUpdate(input) {
      if (input.projectId !== projectId) {
        throw new AuthoringDocumentStoreError(
          'document.invalid_project',
          `Compensating update project "${input.projectId}" does not match the store project "${projectId}"`,
        );
      }
      if (typeof input.documentId !== 'string' || input.documentId.length === 0) {
        throw new AuthoringDocumentStoreError(
          'document.invalid_key',
          'applyCompensatingUpdate requires a non-empty documentId',
        );
      }
      if (
        !(input.expectedVector instanceof Uint8Array) ||
        !(input.compensatingUpdate instanceof Uint8Array)
      ) {
        throw new AuthoringDocumentStoreError(
          'document.invalid_key',
          'applyCompensatingUpdate requires expectedVector and compensatingUpdate as Uint8Array',
        );
      }
      const key = keyOf(input.documentId);
      return core.enqueue(key, async () => {
        if (core.closed) {
          throw new AuthoringDocumentStoreError(
            'document.store_closed',
            'Document store is closed',
          );
        }
        const created = await core.getOrCreate(key);
        if (created === null) {
          throw new AuthoringDocumentStoreError(
            'document.storage_unavailable',
            'Working document storage is unavailable',
          );
        }
        const liveVector = Y.encodeStateVector(created.doc);
        if (!vectorsEqual(liveVector, input.expectedVector)) {
          return {
            ok: false as const,
            reason: 'stale-vector' as const,
            liveStateVector: liveVector,
          };
        }
        if (presenceGeneration() !== input.expectedHumanPresenceGeneration) {
          return {
            ok: false as const,
            reason: 'human-presence-changed' as const,
            liveStateVector: liveVector,
          };
        }
        const merged = new Y.Doc();
        try {
          Y.applyUpdate(merged, Y.encodeStateAsUpdate(created.doc));
          Y.applyUpdate(merged, input.compensatingUpdate);
        } catch {
          throw new AuthoringDocumentStoreError(
            'document.update_invalid',
            'Compensating update failed Yjs validation',
          );
        }
        try {
          await core.persist(key, merged);
        } catch {
          throw new AuthoringDocumentStoreError(
            'document.storage_unavailable',
            'Working document persistence failed',
          );
        }
        return { ok: true as const, stateVector: Y.encodeStateVector(merged) };
      });
    },

    // ── Change notification / lifecycle ───────────────────────────────────

    onChange(listener) {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribePersist();
      changeListeners.clear();
      knownWorking.clear();
    },
  };
}

/**
 * Create one production working-document store over a shared per-key core.
 * Fails closed on malformed options: a store without the shared core or a
 * project identity could never merge with the browser gateway.
 */
export function createAuthoringDocumentStore(
  options: AuthoringWorkingDocumentStoreOptions,
): AuthoringWorkingDocumentStore {
  return createAuthoringDocumentStoreImpl(options);
}
