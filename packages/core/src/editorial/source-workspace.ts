// ============================================================================
// SourceWorkspace — author-source registry, overlay preview, and atomic apply.
//
// Approves and tracks project source document paths, validates change sets,
// runs whole-project EntityMapper compilation on overlay, and commits changes
// atomically through ProjectTransactionCoordinator.
// ============================================================================

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import YAML from 'yaml';
import type { ZodType } from 'zod';
import { EntityMapper } from '../entity/index.ts';
import {
  editorialOperationV1Schema,
  publicationManifestV1Schema,
  sourceChangePreviewV1Schema,
  sourceChangeSetV1Schema,
  sourceHeadV1Schema,
  sourceRevisionV1Schema,
} from '../schemas/editorial.ts';
import {
  chapterMetadataSchema,
  characterDefinitionSchema,
  eventFileSchema,
  factionDefinitionSchema,
  itemDefinitionSchema,
  locationDefinitionSchema,
  narratorAssertionSchema,
  narratorProfileSchema,
  plannedDiscourseLedgerSchema,
  projectConfigSchema,
  relationshipDefinitionSchema,
  ruleDefinitionSchema,
  worldInitialStateSchema,
} from '../schemas/index.ts';
import { computeContentHash, computeFileHash } from '../storage/hash.ts';
import type {
  DirEntry,
  Storage,
  StorageWrite,
  TransactionReadExpectation,
} from '../storage/types.ts';
import type {
  EditorialError,
  EditorialOperationV1,
  PublicationManifestV1,
  PublicationResult,
  SourceChangePreviewV1,
  SourceChangeResultV1,
  SourceChangeSetV1,
  SourceDocumentChange,
  SourceDocumentKind,
  SourceDocumentV1,
  SourceHeadV1,
  SourceRevisionDocumentV1,
  SourceRevisionV1,
} from '../types/editorial.ts';
import { EditorialOperationError, toEditorialError } from './errors.ts';
import { OverlayStorage } from './overlay-storage.ts';
import type { ProjectPaths } from './paths.ts';
import { ProjectTransactionCoordinator, stableJson } from './transaction.ts';

// ─── Source path registry ────────────────────────────────────────────────────

interface RegistryEntry {
  kind: SourceDocumentKind;
  /** literal file path, or directory prefix + '*' */
  pattern: string;
  /** Zod schema for YAML validation, or null. */
  schema: ZodType<unknown> | null;
}

const SOURCE_PATH_REGISTRY: readonly RegistryEntry[] = [
  {
    kind: 'project',
    pattern: 'nova.yaml',
    schema: projectConfigSchema as unknown as ZodType<unknown>,
  },
  {
    kind: 'initial_state',
    pattern: 'definitions/state_initial.yaml',
    schema: worldInitialStateSchema as unknown as ZodType<unknown>,
  },
  {
    kind: 'character',
    pattern: 'definitions/characters/*',
    schema: characterDefinitionSchema as unknown as ZodType<unknown>,
  },
  {
    kind: 'location',
    pattern: 'definitions/locations/*',
    schema: locationDefinitionSchema as unknown as ZodType<unknown>,
  },
  {
    kind: 'item',
    pattern: 'definitions/items/*',
    schema: itemDefinitionSchema as unknown as ZodType<unknown>,
  },
  {
    kind: 'faction',
    pattern: 'definitions/factions/*',
    schema: factionDefinitionSchema as unknown as ZodType<unknown>,
  },
  {
    kind: 'relationship',
    pattern: 'definitions/relationships/*',
    schema: relationshipDefinitionSchema as unknown as ZodType<unknown>,
  },
  {
    kind: 'rule',
    pattern: 'definitions/rules/*',
    schema: ruleDefinitionSchema as unknown as ZodType<unknown>,
  },
  {
    kind: 'narrator',
    pattern: 'definitions/narrators/*',
    schema: narratorProfileSchema as unknown as ZodType<unknown>,
  },
  {
    kind: 'assertion',
    pattern: 'definitions/assertions/*',
    schema: narratorAssertionSchema as unknown as ZodType<unknown>,
  },
  {
    kind: 'discourse_ledger',
    pattern: 'definitions/discourse-ledger.yaml',
    schema: plannedDiscourseLedgerSchema as unknown as ZodType<unknown>,
  },
  {
    kind: 'chapter',
    pattern: 'chapters/*/_chapter.yaml',
    schema: chapterMetadataSchema as unknown as ZodType<unknown>,
  },
  {
    kind: 'event',
    pattern: 'chapters/*/E*.yaml',
    schema: eventFileSchema as unknown as ZodType<unknown>,
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Map a relative source path to its RegistryEntry, or null. */
function matchRegistry(relPath: string): RegistryEntry | null {
  for (const entry of SOURCE_PATH_REGISTRY) {
    const pattern = entry.pattern;
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1);
      if (
        relPath.startsWith(prefix) &&
        relPath.length > prefix.length &&
        (relPath.endsWith('.yaml') || relPath.endsWith('.yml'))
      ) {
        return entry;
      }
    } else if (
      pattern.endsWith('/_chapter.yaml') &&
      /^chapters\/chapter_\d{2}\/_chapter\.yaml$/.test(relPath)
    ) {
      return entry;
    } else if (
      pattern.endsWith('/E*.yaml') &&
      /^chapters\/chapter_\d{2}\/E[^/]*\.yaml$/.test(relPath)
    ) {
      return entry;
    } else if (relPath === pattern) {
      return entry;
    }
  }
  return null;
}

/** Strip projectDir prefix from a full path to get the relative source path. */
function _stripPrefix(fullPath: string, projectDir: string): string {
  const dir = projectDir.endsWith('/') ? projectDir : `${projectDir}/`;
  if (fullPath.startsWith(dir)) return fullPath.slice(dir.length);
  return fullPath;
}

/** Reject invalid change paths. Returns the kind on success, throws on rejection. */
function validateChangePath(
  changePath: string,
  projectDir: string,
  storage: Storage,
): SourceDocumentKind {
  if (path.isAbsolute(changePath)) {
    throw new EditorialOperationError(
      'INVALID_SOURCE_CHANGE',
      `Absolute path rejected: ${changePath}`,
      { path: changePath },
    );
  }
  const normalised = changePath.replace(/\\/g, '/');
  const segments = normalised.split('/');
  if (
    normalised.length === 0 ||
    normalised.includes('\0') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    path.posix.normalize(normalised) !== normalised
  ) {
    throw new EditorialOperationError(
      'INVALID_SOURCE_CHANGE',
      `Invalid or traversing source path: ${changePath}`,
      { path: changePath },
    );
  }

  const entry = matchRegistry(normalised);
  if (entry === null) {
    throw new EditorialOperationError(
      'INVALID_SOURCE_CHANGE',
      `Path is not a recognised source path: ${changePath}`,
      { path: changePath },
    );
  }

  const resolvedProject = storage.resolvePath(projectDir);
  const resolved = storage.resolvePath(path.join(projectDir, normalised));
  const relative = path.relative(resolvedProject, resolved);
  if (
    relative === '' ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new EditorialOperationError(
      'INVALID_SOURCE_CHANGE',
      `Path escapes project root: ${changePath}`,
      { path: changePath },
    );
  }
  return entry.kind;
}

/** Compute a stable project-source hash from a set of document hashes. */
function projectSourceHash(documents: Record<string, string>): string {
  const sorted = Object.entries(documents).sort(([a], [b]) => a.localeCompare(b));
  const h = crypto.createHash('sha256');
  for (const [p, hsh] of sorted) {
    h.update(`${p}\0${hsh}\0`);
  }
  return h.digest('hex');
}

/** Build a path→hash map from the storage for all registry-matching files. */
function collectDocumentHashes(storage: Storage, projectDir: string): Record<string, string> {
  const documents: Record<string, string> = {};
  if (!storage.exists(projectDir)) return documents;

  const walk = (fullDir: string, relativeDir: string): void => {
    const entries = [...storage.list(fullDir)].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const fullPath = path.join(fullDir, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile() || matchRegistry(relativePath) === null) continue;
      try {
        validateChangePath(relativePath, projectDir, storage);
        const content = storage.readOptional(fullPath);
        if (content !== null) documents[relativePath] = computeContentHash(content);
      } catch {
        // Escaped symlinks and invalid registry paths are never source documents.
      }
    }
  };

  walk(projectDir, '');
  return documents;
}

/** Collect hashes from an OverlayStorage (uses full paths). */
function collectOverlayHashes(overlay: OverlayStorage, projectDir: string): Record<string, string> {
  const _dir = projectDir.endsWith('/') ? projectDir : `${projectDir}/`;

  return collectDocumentHashes(
    {
      exists(fp: string) {
        return overlay.exists(fp);
      },
      read(fp: string) {
        return overlay.read(fp);
      },
      readOptional(fp: string) {
        return overlay.readOptional(fp);
      },
      list(dp: string): DirEntry[] {
        return overlay.list(dp);
      },
      listFiles(dp: string): string[] {
        return overlay.listFiles(dp);
      },
      resolvePath(fp: string) {
        return overlay.resolvePath(fp);
      },
      write(_fp: string, _c: string) {
        throw new Error('read-only');
      },
      mkdirp(_dp: string) {
        throw new Error('read-only');
      },
      remove(_fp: string) {
        throw new Error('read-only');
      },
      removeAll(_dp: string) {
        throw new Error('read-only');
      },
      commitBatch() {
        throw new Error('read-only');
      },
    } as Storage,
    projectDir,
  );
}

/** YAML parse + Zod validation helper. */
function parseYamlWithSchema(
  content: string,
  schema: ZodType<unknown> | null,
): { parsedValue: unknown; diagnostics: EditorialError[] } {
  if (!schema) return { parsedValue: content, diagnostics: [] };
  try {
    const raw = YAML.parse(content) as unknown;
    const result = schema.safeParse(raw);
    if (result.success) return { parsedValue: result.data, diagnostics: [] };
    const diagnostics: EditorialError[] = result.error.issues.map((issue) => ({
      code: 'INVALID_SOURCE_CHANGE' as const,
      message: issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    }));
    return { parsedValue: null, diagnostics };
  } catch (parseErr) {
    return {
      parsedValue: null,
      diagnostics: [
        {
          code: 'INVALID_SOURCE_CHANGE' as const,
          message: `YAML parse error: ${(parseErr as Error).message}`,
        },
      ],
    };
  }
}

// ─── SourceWorkspace ─────────────────────────────────────────────────────────

export class SourceWorkspace {
  constructor(
    readonly storage: Storage,
    readonly paths: ProjectPaths,
    readonly workDir: string = paths.workDir,
  ) {}

  /** Full path for a project-relative source path. */
  private fp(relPath: string): string {
    return path.join(this.paths.projectDir, relPath);
  }

  /** Return the kind for a recognised source path, or null. */
  resolveKind(relPath: string): SourceDocumentKind | null {
    try {
      return validateChangePath(relPath, this.paths.projectDir, this.storage);
    } catch {
      return null;
    }
  }

  /** True if the path matches a known source pattern and passes containment checks. */
  isValidSourcePath(relPath: string): boolean {
    try {
      validateChangePath(relPath, this.paths.projectDir, this.storage);
      return true;
    } catch {
      return false;
    }
  }

  // ── Document access ─────────────────────────────────────────────────────

  /** List all source documents currently in the project. */
  list(): SourceDocumentV1[] {
    const hashes = collectDocumentHashes(this.storage, this.paths.projectDir);
    const head = this.readCurrentHead();
    return Object.keys(hashes)
      .sort((left, right) => left.localeCompare(right))
      .map((relPath) => {
        const content = this.storage.read(this.fp(relPath));
        const entry = matchRegistry(relPath);
        if (!entry) {
          throw new EditorialOperationError(
            'SOURCE_DOCUMENT_NOT_FOUND',
            `Source registry entry disappeared for ${relPath}`,
            { path: relPath },
          );
        }
        const { parsedValue, diagnostics } = parseYamlWithSchema(content, entry.schema);
        const contentHash = computeContentHash(content);
        const tracked = head?.documents[relPath] === contentHash;
        return {
          version: 1,
          path: relPath,
          kind: entry.kind,
          content,
          contentHash,
          parsedValue,
          diagnostics,
          sourceRevisionId: tracked ? head.revisionId : null,
          tracked,
        };
      });
  }

  /** Get a single source document by relative path, or null if missing/unrecognised. */
  get(relPath: string): SourceDocumentV1 | null {
    const normalised = relPath.replace(/\\/g, '/');
    let kind: SourceDocumentKind;
    try {
      kind = validateChangePath(normalised, this.paths.projectDir, this.storage);
    } catch {
      return null;
    }
    const fullPath = this.fp(normalised);
    const content = this.storage.readOptional(fullPath);
    if (content === null) return null;
    const entry = matchRegistry(normalised);
    if (!entry) return null;
    const { parsedValue, diagnostics } = parseYamlWithSchema(content, entry.schema);
    const contentHash = computeContentHash(content);
    const head = this.readCurrentHead();
    const tracked = head?.documents[normalised] === contentHash;
    return {
      version: 1,
      path: normalised,
      kind,
      content,
      contentHash,
      parsedValue,
      diagnostics,
      sourceRevisionId: tracked ? head.revisionId : null,
      tracked,
    };
  }

  // ── Preview ─────────────────────────────────────────────────────────────

  /**
   * Preview a set of source changes.
   *
   * 1. Validate paths, CAS expectations, and unique paths.
   * 2. Create an overlay with the proposed changes.
   * 3. Run EntityMapper on the overlay to detect compilation errors.
   * 4. Compute before/after hashes and impact.
   * 5. Return a deterministic preview.
   */
  preview(changeSet: SourceChangeSetV1): SourceChangePreviewV1 {
    const parsed = sourceChangeSetV1Schema.parse(changeSet) as SourceChangeSetV1;

    // Collect current document hashes
    const beforeHashes = collectDocumentHashes(this.storage, this.paths.projectDir);
    const currentProjectHash = projectSourceHash(beforeHashes);

    if (parsed.expectedProjectSourceHash !== currentProjectHash) {
      throw new EditorialOperationError(
        'STORAGE_CONFLICT',
        `Expected project hash ${parsed.expectedProjectSourceHash} does not match current ${currentProjectHash}`,
      );
    }

    // Validate paths and per-file CAS
    for (const change of parsed.changes) {
      validateChangePath(change.path, this.paths.projectDir, this.storage);
      if (change.type === 'put') {
        const currentHash = beforeHashes[change.path] ?? null;
        if (change.expectedHash === null && currentHash !== null) {
          throw new EditorialOperationError(
            'STORAGE_CONFLICT',
            `Create-only put rejected for existing source path: ${change.path}`,
            { path: change.path },
          );
        }
        if (change.expectedHash !== null && currentHash !== change.expectedHash) {
          throw new EditorialOperationError(
            'STORAGE_CONFLICT',
            `CAS mismatch for ${change.path}: expected ${change.expectedHash}, current ${currentHash}`,
            { path: change.path },
          );
        }
      } else {
        // delete
        const currentHash = beforeHashes[change.path];
        if (!currentHash) {
          throw new EditorialOperationError(
            'INVALID_SOURCE_CHANGE',
            `Cannot delete non-existent source path: ${change.path}`,
            { path: change.path },
          );
        }
        if (change.expectedHash !== currentHash) {
          throw new EditorialOperationError(
            'STORAGE_CONFLICT',
            `CAS mismatch for delete ${change.path}: expected ${change.expectedHash}, current ${currentHash}`,
            { path: change.path },
          );
        }
      }
    }

    // Build overlay
    const overlay = new OverlayStorage(this.storage);
    for (const change of parsed.changes) {
      if (change.type === 'put') {
        overlay.setOverlay(this.fp(change.path), change.content);
      } else {
        overlay.setOverlay(this.fp(change.path), null);
      }
    }

    // Compute after hashes from overlay
    const afterHashes = collectOverlayHashes(overlay, this.paths.projectDir);

    // Validate YAML content and run EntityMapper
    const validation = this.compileOverlay(overlay, parsed.changes);

    // Determine affected event IDs
    const affectedEventIds = this.computeAffectedEventIds(beforeHashes, afterHashes);

    // Build document diff
    const documents: Array<{
      path: string;
      beforeContent: string | null;
      afterContent: string | null;
    }> = [];
    for (const change of parsed.changes) {
      const fullPath = this.fp(change.path);
      const beforeContent = this.storage.readOptional(fullPath) ?? null;
      const afterContent = change.type === 'put' ? change.content : null;
      documents.push({ path: change.path, beforeContent, afterContent });
    }

    const previewToken = computeContentHash(
      stableJson({
        compilerIdentity: 'source-workspace-v1:strict-schema+entity-mapper+impact-v1',
        beforeManifest: Object.fromEntries(
          Object.entries(beforeHashes).sort(([a], [b]) => a.localeCompare(b)),
        ),
        changes: parsed.changes,
        afterManifest: Object.fromEntries(
          Object.entries(afterHashes).sort(([a], [b]) => a.localeCompare(b)),
        ),
        affectedEventIds,
        validation,
      }),
    );

    return sourceChangePreviewV1Schema.parse({
      version: 1,
      changeSet: parsed,
      previewToken,
      documents,
      projectBeforeHash: currentProjectHash,
      projectAfterHash: projectSourceHash(afterHashes),
      affectedEventIds,
      validation,
    }) as SourceChangePreviewV1;
  }

  // ── Apply ───────────────────────────────────────────────────────────────

  /**
   * Apply a previously previewed change set.
   *
   * 1. Verify preview token.
   * 2. Re-validate and re-preview.
   * 3. Atomically write YAML changes + SourceRevision + SourceHead +
   *    stale publication + terminal operation via ProjectTransactionCoordinator.
   */
  apply(
    changeSet: SourceChangeSetV1,
    previewToken: string,
    context: { operationId: string; actorId: string },
    note?: string,
  ): SourceChangeResultV1 {
    const operationPath = path.join(this.paths.operationsDir, `${context.operationId}.json`);
    const existingOperationRaw = this.storage.readOptional(operationPath);
    if (existingOperationRaw !== null) {
      try {
        const operation = editorialOperationV1Schema.parse(
          JSON.parse(existingOperationRaw),
        ) as EditorialOperationV1;
        if (
          operation.kind === 'apply_source' &&
          operation.status === 'succeeded' &&
          operation.requestHash === previewToken &&
          operation.result !== null
        ) {
          return operation.result as SourceChangeResultV1;
        }
      } catch {
        // Existing malformed or non-idempotent records are rejected below.
      }
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Operation ${context.operationId} already exists with a different request or result`,
        { operationId: context.operationId },
      );
    }

    const previewResult = this.preview(changeSet);
    if (previewResult.previewToken !== previewToken) {
      throw new EditorialOperationError(
        'STORAGE_CONFLICT',
        'Preview token is stale — re-preview required',
      );
    }
    if (!previewResult.validation.valid) {
      throw new EditorialOperationError(
        'INVALID_SOURCE_CHANGE',
        `Cannot apply changes with compilation errors: ${previewResult.validation.errors.map((error) => error.message).join('; ')}`,
      );
    }

    const now = new Date().toISOString();
    const beforeHashes = collectDocumentHashes(this.storage, this.paths.projectDir);
    const afterHashes = { ...beforeHashes };
    const revisionDocuments: SourceRevisionDocumentV1[] = changeSet.changes.map((change) => {
      const beforeContent = this.storage.readOptional(this.fp(change.path));
      if (change.type === 'put') {
        const afterHash = computeContentHash(change.content);
        afterHashes[change.path] = afterHash;
        return {
          path: change.path,
          beforeHash: beforeHashes[change.path] ?? null,
          afterHash,
          beforeContent,
          afterContent: change.content,
        };
      }
      delete afterHashes[change.path];
      return {
        path: change.path,
        beforeHash: beforeHashes[change.path] ?? null,
        afterHash: null,
        beforeContent,
        afterContent: null,
      };
    });

    const currentHead = this.readCurrentHead();
    const expectedHeadHash = computeFileHash(this.storage, this.paths.sourceHeadPath);
    const baselineRevisionId = currentHead === null ? crypto.randomUUID() : null;
    const revisionId = crypto.randomUUID();
    const projectAfterHash = projectSourceHash(afterHashes);
    const revision = sourceRevisionV1Schema.parse({
      version: 1,
      revisionId,
      parentRevisionId: currentHead?.revisionId ?? baselineRevisionId,
      operationId: context.operationId,
      actorId: context.actorId,
      origin: 'api_edit',
      ...(note !== undefined ? { note } : {}),
      projectBeforeHash: previewResult.projectBeforeHash,
      projectAfterHash,
      changeSetHash: computeContentHash(stableJson(changeSet)),
      documents: revisionDocuments,
      affectedEventIds: previewResult.affectedEventIds,
      createdAt: now,
    }) as SourceRevisionV1;
    const newHead = sourceHeadV1Schema.parse({
      version: 1,
      revisionId,
      projectSourceHash: projectAfterHash,
      documents: afterHashes,
    }) as SourceHeadV1;

    const writes: StorageWrite[] = [];
    const readSet: TransactionReadExpectation[] = [];
    for (const change of changeSet.changes) {
      const fullPath = this.fp(change.path);
      writes.push(
        change.type === 'put'
          ? {
              type: 'put',
              path: fullPath,
              content: change.content,
              expectedHash: change.expectedHash,
            }
          : {
              type: 'delete',
              path: fullPath,
              expectedHash: change.expectedHash,
            },
      );
      readSet.push({
        kind: 'file',
        path: fullPath,
        expectedHash: change.expectedHash,
      });
    }

    if (baselineRevisionId !== null) {
      const baseline = sourceRevisionV1Schema.parse({
        version: 1,
        revisionId: baselineRevisionId,
        parentRevisionId: null,
        operationId: context.operationId,
        actorId: context.actorId,
        origin: 'external_edit',
        note: 'Automatic baseline before the first controlled source mutation',
        projectBeforeHash: previewResult.projectBeforeHash,
        projectAfterHash: previewResult.projectBeforeHash,
        changeSetHash: computeContentHash(
          stableJson({
            origin: 'external_edit',
            documents: beforeHashes,
          }),
        ),
        documents: Object.keys(beforeHashes)
          .sort((left, right) => left.localeCompare(right))
          .map((sourcePath) => {
            const content = this.storage.read(this.fp(sourcePath));
            return {
              path: sourcePath,
              beforeHash: null,
              afterHash: beforeHashes[sourcePath],
              beforeContent: null,
              afterContent: content,
            };
          }),
        affectedEventIds: [],
        createdAt: now,
      }) as SourceRevisionV1;
      const baselinePath = path.join(this.paths.sourceRevisionsDir, `${baselineRevisionId}.json`);
      writes.push({
        type: 'put',
        path: baselinePath,
        content: stableJson(baseline),
        expectedHash: null,
      });
      readSet.push({ kind: 'file', path: baselinePath, expectedHash: null });
    }

    const revisionPath = path.join(this.paths.sourceRevisionsDir, `${revisionId}.json`);
    writes.push({
      type: 'put',
      path: revisionPath,
      content: stableJson(revision),
      expectedHash: null,
    });
    readSet.push({ kind: 'file', path: revisionPath, expectedHash: null });

    writes.push({
      type: 'put',
      path: this.paths.sourceHeadPath,
      content: stableJson(newHead),
      expectedHash: expectedHeadHash,
    });
    readSet.push({
      kind: 'file',
      path: this.paths.sourceHeadPath,
      expectedHash: expectedHeadHash,
    });

    const publication = this.appendPublicationStale(writes);
    const result: SourceChangeResultV1 = {
      operationId: context.operationId,
      sourceRevisionId: revisionId,
      projectSourceHash: projectAfterHash,
      changedDocuments: revisionDocuments.map((document) => ({
        path: document.path,
        contentHash: document.afterHash,
      })),
      affectedEventIds: previewResult.affectedEventIds,
      publication,
    };
    const operation: EditorialOperationV1 = {
      version: 1,
      operationId: context.operationId,
      kind: 'apply_source',
      actorId: context.actorId,
      requestHash: previewToken,
      status: 'succeeded',
      startedAt: now,
      heartbeatAt: now,
      leaseExpiresAt: now,
      completedAt: now,
      result,
      errors: [],
    };
    editorialOperationV1Schema.parse(operation);
    writes.push({
      type: 'put',
      path: operationPath,
      content: stableJson(operation),
      expectedHash: null,
    });
    readSet.push({ kind: 'file', path: operationPath, expectedHash: null });

    new ProjectTransactionCoordinator(this.storage, this.paths).commit({
      readSet,
      writes,
    });
    return result;
  }

  // ── Reconcile ───────────────────────────────────────────────────────────

  /**
   * Detect and accept valid external edits to source files.
   * Invalid edits are reported without writing.
   */
  reconcile(context: { operationId: string; actorId: string }): SourceChangeResultV1 | null {
    const currentHead = this.readCurrentHead();
    const currentHashes = collectDocumentHashes(this.storage, this.paths.projectDir);
    const currentProjectHash = projectSourceHash(currentHashes);
    const operationPath = path.join(this.paths.operationsDir, `${context.operationId}.json`);
    const existingOperationRaw = this.storage.readOptional(operationPath);
    if (existingOperationRaw !== null) {
      try {
        const operation = editorialOperationV1Schema.parse(
          JSON.parse(existingOperationRaw),
        ) as EditorialOperationV1;
        if (operation.kind === 'apply_source' && operation.status === 'succeeded') {
          if (operation.result === null && currentHead?.projectSourceHash === currentProjectHash) {
            return null;
          }
          if (
            operation.result !== null &&
            (operation.result as SourceChangeResultV1).projectSourceHash === currentProjectHash
          ) {
            return operation.result as SourceChangeResultV1;
          }
        }
      } catch {
        // Reject malformed or non-idempotent records below.
      }
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Operation ${context.operationId} already exists with a different reconciliation state`,
        { operationId: context.operationId },
      );
    }

    const documentErrors = this.list().flatMap((document) =>
      document.diagnostics.map((error) => ({ ...error, path: document.path })),
    );
    if (documentErrors.length > 0) {
      throw new EditorialOperationError(
        'INVALID_SOURCE_CHANGE',
        `External source working copy is invalid: ${documentErrors.map((error) => `${error.path}: ${error.message}`).join('; ')}`,
      );
    }
    try {
      new EntityMapper(this.paths.projectDir, this.storage).loadProject();
    } catch (error) {
      throw new EditorialOperationError(
        'INVALID_SOURCE_CHANGE',
        `External source working copy does not compile: ${toEditorialError(error).message}`,
      );
    }

    const changedPaths =
      currentHead === null
        ? Object.keys(currentHashes).sort((left, right) => left.localeCompare(right))
        : [...new Set([...Object.keys(currentHead.documents), ...Object.keys(currentHashes)])]
            .filter((sourcePath) => currentHead.documents[sourcePath] !== currentHashes[sourcePath])
            .sort((left, right) => left.localeCompare(right));
    const now = new Date().toISOString();
    const requestHash = computeContentHash(
      stableJson({
        kind: 'reconcile_source',
        before: currentHead?.projectSourceHash ?? null,
        after: currentProjectHash,
        changedPaths,
      }),
    );
    const writes: StorageWrite[] = [];
    const readSet: TransactionReadExpectation[] = [
      { kind: 'file', path: operationPath, expectedHash: null },
    ];
    let result: SourceChangeResultV1 | null = null;

    if (currentHead === null || changedPaths.length > 0) {
      const revisionId = crypto.randomUUID();
      const revisionDocuments = changedPaths.map((sourcePath) => {
        const afterContent = this.storage.readOptional(this.fp(sourcePath));
        return {
          path: sourcePath,
          beforeHash: currentHead?.documents[sourcePath] ?? null,
          afterHash: currentHashes[sourcePath] ?? null,
          beforeContent: currentHead?.revisionId
            ? this.readTrackedContent(sourcePath, currentHead.revisionId)
            : null,
          afterContent,
        };
      });
      const affectedEventIds =
        currentHead === null
          ? Object.keys(currentHashes)
              .map(
                (sourcePath) => sourcePath.match(/^chapters\/chapter_\d{2}\/(E[^/]*)\.yaml$/)?.[1],
              )
              .filter((eventId): eventId is string => eventId !== undefined)
              .sort()
          : this.computeAffectedEventIds(currentHead.documents, currentHashes);
      const revision = sourceRevisionV1Schema.parse({
        version: 1,
        revisionId,
        parentRevisionId: currentHead?.revisionId ?? null,
        operationId: context.operationId,
        actorId: context.actorId,
        origin: 'external_edit',
        note:
          currentHead === null
            ? 'Automatic baseline of the external source working copy'
            : 'Reconciled external source working-copy edits',
        projectBeforeHash: currentHead?.projectSourceHash ?? currentProjectHash,
        projectAfterHash: currentProjectHash,
        changeSetHash: computeContentHash(stableJson(revisionDocuments)),
        documents: revisionDocuments,
        affectedEventIds,
        createdAt: now,
      }) as SourceRevisionV1;
      const head = sourceHeadV1Schema.parse({
        version: 1,
        revisionId,
        projectSourceHash: currentProjectHash,
        documents: currentHashes,
      }) as SourceHeadV1;
      const revisionPath = path.join(this.paths.sourceRevisionsDir, `${revisionId}.json`);
      const expectedHeadHash = computeFileHash(this.storage, this.paths.sourceHeadPath);
      writes.push(
        {
          type: 'put',
          path: revisionPath,
          content: stableJson(revision),
          expectedHash: null,
        },
        {
          type: 'put',
          path: this.paths.sourceHeadPath,
          content: stableJson(head),
          expectedHash: expectedHeadHash,
        },
      );
      readSet.push(
        { kind: 'file', path: revisionPath, expectedHash: null },
        {
          kind: 'file',
          path: this.paths.sourceHeadPath,
          expectedHash: expectedHeadHash,
        },
      );
      const publication = this.appendPublicationStale(writes);
      result = {
        operationId: context.operationId,
        sourceRevisionId: revisionId,
        projectSourceHash: currentProjectHash,
        changedDocuments: revisionDocuments.map((document) => ({
          path: document.path,
          contentHash: document.afterHash,
        })),
        affectedEventIds,
        publication,
      };
    }

    const operation: EditorialOperationV1 = {
      version: 1,
      operationId: context.operationId,
      kind: 'apply_source',
      actorId: context.actorId,
      requestHash,
      status: 'succeeded',
      startedAt: now,
      heartbeatAt: now,
      leaseExpiresAt: now,
      completedAt: now,
      result,
      errors: [],
    };
    editorialOperationV1Schema.parse(operation);
    writes.push({
      type: 'put',
      path: operationPath,
      content: stableJson(operation),
      expectedHash: null,
    });
    new ProjectTransactionCoordinator(this.storage, this.paths).commit({
      readSet,
      writes,
    });
    return result;
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private readCurrentHead(): SourceHeadV1 | null {
    const content = this.storage.readOptional(this.paths.sourceHeadPath);
    if (content === null) return null;
    try {
      return sourceHeadV1Schema.parse(JSON.parse(content)) as SourceHeadV1;
    } catch {
      return null;
    }
  }

  private readTrackedContent(sourcePath: string, revisionId: string): string | null {
    const visited = new Set<string>();
    let currentRevisionId: string | null = revisionId;
    while (currentRevisionId !== null && !visited.has(currentRevisionId)) {
      visited.add(currentRevisionId);
      const revisionPath = path.join(this.paths.sourceRevisionsDir, `${currentRevisionId}.json`);
      const raw = this.storage.readOptional(revisionPath);
      if (raw === null) return null;
      let revision: SourceRevisionV1;
      try {
        revision = sourceRevisionV1Schema.parse(JSON.parse(raw)) as SourceRevisionV1;
      } catch {
        return null;
      }
      const document = revision.documents.find((candidate) => candidate.path === sourcePath);
      if (document) return document.afterContent;
      currentRevisionId = revision.parentRevisionId;
    }
    return null;
  }

  /** Run EntityMapper on the overlay to detect compilation problems.
   *
   * Checks YAML parseability of changed files and runs the full project
   * EntityMapper. Schema validation errors from the mapper are captured as
   * compilation errors when they indicate structural problems (missing files,
   * YAML parse failures). Individual field validation is deferred to the
   * SourceDocumentV1 diagnostics surfaced by get()/list(). */
  private compileOverlay(
    overlay: OverlayStorage,
    changes: readonly SourceDocumentChange[],
  ): { valid: boolean; errors: EditorialError[] } {
    const errors: EditorialError[] = [];
    for (const change of changes) {
      if (change.type !== 'put') continue;
      const entry = matchRegistry(change.path);
      const result = parseYamlWithSchema(change.content, entry?.schema ?? null);
      errors.push(...result.diagnostics.map((error) => ({ ...error, path: change.path })));
    }
    if (errors.length > 0) return { valid: false, errors };

    try {
      new EntityMapper(this.paths.projectDir, overlay as unknown as Storage).loadProject();
      return { valid: true, errors: [] };
    } catch (error) {
      const editorialError = toEditorialError(error);
      return {
        valid: false,
        errors: [
          {
            ...editorialError,
            code: 'INVALID_SOURCE_CHANGE',
          },
        ],
      };
    }
  }

  /** Determine affected event IDs from before/after hash comparison. */
  private computeAffectedEventIds(
    beforeHashes: Record<string, string>,
    afterHashes: Record<string, string>,
  ): string[] {
    const allPaths = new Set([...Object.keys(beforeHashes), ...Object.keys(afterHashes)]);
    const changedPaths = [...allPaths].filter(
      (sourcePath) => beforeHashes[sourcePath] !== afterHashes[sourcePath],
    );
    const authoredEvents = [...allPaths]
      .map((sourcePath) => sourcePath.match(/^chapters\/(chapter_\d{2})\/(E[^/]*)\.yaml$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => ({ chapterDir: match[1], eventId: match[2] }));

    const affected = new Set<string>();
    for (const changedPath of changedPaths) {
      const eventMatch = changedPath.match(/^chapters\/(chapter_\d{2})\/(E[^/]*)\.yaml$/);
      if (eventMatch) {
        affected.add(eventMatch[2]);
        continue;
      }
      const chapterMatch = changedPath.match(/^chapters\/(chapter_\d{2})\/_chapter\.yaml$/);
      if (chapterMatch) {
        for (const event of authoredEvents) {
          if (event.chapterDir === chapterMatch[1]) affected.add(event.eventId);
        }
        continue;
      }
      for (const event of authoredEvents) affected.add(event.eventId);
    }
    return [...affected].sort();
  }

  /** Append publication stale write to the writes array. */
  private appendPublicationStale(writes: StorageWrite[]): PublicationResult {
    const publicationPath = this.paths.publicationPath;
    const existingContent = this.storage.readOptional(publicationPath);
    let manifest: PublicationManifestV1;
    let expectedHash: string | null = null;
    if (existingContent !== null) {
      expectedHash = computeContentHash(existingContent);
      let parsed: PublicationManifestV1;
      try {
        parsed = publicationManifestV1Schema.parse(
          JSON.parse(existingContent),
        ) as PublicationManifestV1;
      } catch (error) {
        throw new EditorialOperationError(
          'INVALID_OPERATION',
          `Invalid publication manifest: ${error instanceof Error ? error.message : String(error)}`,
          { path: publicationPath },
        );
      }
      const reasons = parsed.reasons.some((reason) => reason.code === 'SOURCE_CHANGED')
        ? parsed.reasons
        : [
            ...parsed.reasons,
            {
              code: 'SOURCE_CHANGED' as const,
              message: 'Source documents updated via SourceWorkspace',
            },
          ];
      manifest = { ...parsed, status: 'stale', reasons };
    } else {
      manifest = {
        version: 1,
        status: 'stale',
        branch_scope_hash: computeContentHash(''),
        novel_hash: null,
        revision_ids: {},
        last_assembled_at: null,
        reasons: [
          {
            code: 'SOURCE_CHANGED',
            message: 'Source documents updated via SourceWorkspace',
          },
        ],
      };
    }

    const parsedManifest = publicationManifestV1Schema.parse(manifest) as PublicationManifestV1;
    writes.push({
      type: 'put',
      path: publicationPath,
      content: stableJson(parsedManifest),
      expectedHash,
    });
    return {
      status: 'stale',
      outputPath: this.paths.novelPath,
      novelHash: parsedManifest.novel_hash,
      reasons: [...parsedManifest.reasons],
    };
  }
}
