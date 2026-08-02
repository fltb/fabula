import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { ProjectSourceSnapshotV1, SourceChangeV1 } from '@novalistically/core';
import { computeSourceDocumentHash } from '@novalistically/core/source';
import { isMissing, prepareDirectory, withDirectoryLock } from '../execution/types.js';
import { FileProjectSourceLoaderImpl } from './file-project-source-loader.js';
import { SourceConflictError, SourceInputError, SourcePathError, type FileProjectSourceLoader as FileProjectSourceLoaderContract, type FileProjectSourceWriter as FileProjectSourceWriterContract, type FileProjectSourceWriterOptions } from './types.js';

const approved = (path: string): boolean =>
  ['nova.yaml', 'definitions/state_initial.yaml', 'definitions/entity-types.yaml', 'definitions/discourse-ledger.yaml'].includes(path) ||
  /^definitions\/(characters|locations|items|factions|relationships|rules|narrators|assertions)\/[^/].*\.yaml$/.test(path) ||
  /^chapters\/chapter_[0-9]{2}\/(_chapter|E[^/]+)\.yaml$/.test(path);

function validateLogicalPath(path: string): void {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..') || !approved(path)) {
    throw new SourcePathError(`Invalid authoring logical path: ${path}`);
  }
}

/**
 * Reject changes that violate sourceChangeV1Schema pairing or content-hash
 * identity before any byte is touched. Non-null content MUST carry its exact
 * canonical Core document hash; deletions require both sides null.
 */
function validateChangeInput(change: SourceChangeV1): void {
  const { logicalPath, beforeContent, beforeHash, afterContent, afterHash } = change;
  if ((beforeContent === null) !== (beforeHash === null)) {
    throw new SourceInputError(`Invalid source change ${logicalPath}: beforeContent and beforeHash must be both present or both null`);
  }
  if ((afterContent === null) !== (afterHash === null)) {
    throw new SourceInputError(`Invalid source change ${logicalPath}: afterContent and afterHash must be both present or both null`);
  }
  if (beforeContent !== null && beforeHash !== computeSourceDocumentHash(beforeContent)) {
    throw new SourceInputError(`Invalid source change ${logicalPath}: beforeHash does not match beforeContent`);
  }
  if (afterContent !== null && afterHash !== computeSourceDocumentHash(afterContent)) {
    throw new SourceInputError(`Invalid source change ${logicalPath}: afterHash does not match afterContent`);
  }
}

function contained(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(target) !== target && rel.startsWith('..')) throw new SourcePathError(`Path escapes project root: ${target}`);
}

export class FileProjectSourceWriter implements FileProjectSourceWriterContract {
  private readonly loader: FileProjectSourceLoaderContract;
  constructor(options: FileProjectSourceWriterOptions = {}) { this.loader = options.loader ?? new FileProjectSourceLoaderImpl(); }

  async apply(
    projectRoot: string,
    expectedSourceHash: string,
    changes: readonly SourceChangeV1[],
  ): Promise<ProjectSourceSnapshotV1> {
    const root = resolve(projectRoot);
    const lockDirectory = join(root, '.nova', 'locks');
    await prepareDirectory(root, lockDirectory);
    return withDirectoryLock(root, lockDirectory, () =>
      this.applyLocked(root, expectedSourceHash, changes),
    );
  }

  private applyLocked(
    root: string,
    expectedSourceHash: string,
    changes: readonly SourceChangeV1[],
  ): ProjectSourceSnapshotV1 {
    const current = this.loader.load(root);
    if (current.sourceHash !== expectedSourceHash) {
      throw new SourceConflictError(expectedSourceHash, current.sourceHash);
    }
    const byPath = new Map(current.documents.map((document) => [document.logicalPath, document]));
    const seen = new Set<string>();
    for (const change of changes) {
      validateLogicalPath(change.logicalPath);
      validateChangeInput(change);
      if (seen.has(change.logicalPath)) {
        throw new SourcePathError(`Duplicate change target: ${change.logicalPath}`);
      }
      seen.add(change.logicalPath);
      const existing = byPath.get(change.logicalPath);
      const actualContent = existing?.content ?? null;
      const actualHash = existing?.contentHash ?? null;
      if (actualContent !== change.beforeContent || actualHash !== change.beforeHash) {
        throw new SourceConflictError(change.beforeHash ?? 'null', actualHash ?? 'null');
      }
    }
    for (const change of changes) {
      const target = join(root, ...change.logicalPath.split('/'));
      contained(root, target);
      this.assertNoSymlinkEscape(root, target);
      if (change.afterContent === null) {
        if (lstatSync(target, { throwIfNoEntry: false })) unlinkSync(target);
        continue;
      }
      mkdirSync(join(target, '..'), { recursive: true });
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, Buffer.from(change.afterContent, 'utf8'), {
          flag: 'wx',
          mode: 0o600,
        });
        renameSync(temp, target);
      } finally {
        try {
          unlinkSync(temp);
        } catch {
          // The successful rename already removed the temporary path.
        }
      }
    }
    return this.loader.load(root);
  }

  private assertNoSymlinkEscape(root: string, target: string): void {
    let current = root;
    const rel = relative(root, target);
    for (const part of rel.split(sep)) {
      current = join(current, part);
      contained(root, current);
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new SourcePathError(`Symlink source path rejected: ${rel}`);
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    try {
      readFileSync(target);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export { FileProjectSourceWriter as FileProjectSourceWriterImpl };
