import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type {
  JsonValue,
  ProjectSourceSnapshotV1,
  SourceDiagnosticV1,
  SourceDocumentV1,
  SourceParseResultV1,
} from '@novalistically/core';
import {
  compareLogicalPaths,
  computeSourceDocumentHash,
  computeSourceHash,
} from '@novalistically/core/source';
import YAML from 'yaml';
import {
  type FileProjectSourceLoader as FileProjectSourceLoaderContract,
  type FileProjectSourceLoaderOptions,
  SourcePathError,
} from './types.js';

const ENTITY_DIRS = [
  'characters',
  'locations',
  'items',
  'factions',
  'relationships',
  'rules',
  'narrators',
  'assertions',
];
const ROOT_FILES = ['nova.yaml', 'definitions/state_initial.yaml', 'definitions/entity-types.yaml'];
function parseJsonValue(value: unknown): JsonValue | null {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}
function assertContained(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new SourcePathError(`Path escapes project root: ${target}`);
}

/** Reject absolute, traversal, backslash, and empty-part logical paths. */
function assertLogicalPath(path: string): void {
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new SourcePathError(`Invalid authoring logical path: ${path}`);
  }
}

export class FileProjectSourceLoader implements FileProjectSourceLoaderContract {
  private readonly parse: (content: string, logicalPath: string) => unknown;
  constructor(options: FileProjectSourceLoaderOptions = {}) {
    this.parse = options.parse ?? ((content) => YAML.parse(content));
  }

  load(projectRoot: string): ProjectSourceSnapshotV1 {
    const root = realpathSync(projectRoot);
    const paths = new Set<string>();
    for (const path of ROOT_FILES) paths.add(path);
    for (const path of ['definitions/discourse-ledger.yaml']) paths.add(path);
    for (const dir of ENTITY_DIRS) this.collect(root, `definitions/${dir}`, paths);
    this.collectChapters(root, paths);
    const documents: SourceDocumentV1[] = [...paths]
      .filter((p) => this.existsFile(root, p))
      .sort(compareLogicalPaths)
      .map((p) => this.document(root, p));
    return { version: 1, documents, sourceHash: computeSourceHash(documents) };
  }

  private existsFile(root: string, logical: string): boolean {
    const target = join(root, ...logical.split('/'));
    assertContained(root, target);
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink())
        throw new SourcePathError(`Symlink source path rejected: ${logical}`);
      return stat.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  private collect(root: string, logicalDir: string, paths: Set<string>): void {
    const target = join(root, ...logicalDir.split('/'));
    assertContained(root, target);
    let entries: Dirent[];
    try {
      entries = readdirSync(target, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => compareLogicalPaths(a.name, b.name))) {
      const child = `${logicalDir}/${entry.name}`;
      assertLogicalPath(child);
      if (entry.isSymbolicLink())
        throw new SourcePathError(`Symlink source path rejected: ${child}`);
      if (entry.isDirectory()) this.collect(root, child, paths);
      else if (entry.isFile() && entry.name.endsWith('.yaml')) paths.add(child);
    }
  }
  private collectChapters(root: string, paths: Set<string>): void {
    const base = join(root, 'chapters');
    let entries: Dirent[];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => compareLogicalPaths(a.name, b.name))) {
      if (entry.isSymbolicLink())
        throw new SourcePathError(`Symlink source path rejected: chapters/${entry.name}`);
      if (!entry.isDirectory() || !/^chapter_[0-9]{2}$/.test(entry.name)) continue;
      const dir = `chapters/${entry.name}`;
      const target = join(base, entry.name);
      for (const file of readdirSync(target, { withFileTypes: true }).sort((a, b) =>
        compareLogicalPaths(a.name, b.name),
      )) {
        const path = `${dir}/${file.name}`;
        assertLogicalPath(path);
        if (file.isSymbolicLink())
          throw new SourcePathError(`Symlink source path rejected: ${path}`);
        if (
          file.isFile() &&
          (/^_chapter\.yaml$/.test(file.name) || /^E[^/]+\.yaml$/.test(file.name))
        )
          paths.add(path);
      }
    }
  }
  private document(root: string, path: string): SourceDocumentV1 {
    const content = readFileSync(join(root, ...path.split('/'))).toString('utf8');
    const diagnostics: SourceDiagnosticV1[] = [];
    let parseResult: SourceParseResultV1;
    try {
      const parsed = this.parse(content, path);
      const value = parseJsonValue(parsed);
      if (parsed === null || parsed === undefined || value === null) {
        diagnostics.push({
          code: 'yaml_empty_document',
          severity: 'error',
          message: 'YAML document must contain a value',
          logicalPath: path,
        });
        parseResult = { status: 'invalid', value: null };
      } else {
        parseResult = { status: 'parsed', value };
      }
    } catch (error) {
      diagnostics.push({
        code: 'yaml_parse_error',
        severity: 'error',
        message: String(error),
        logicalPath: path,
      });
      parseResult = { status: 'invalid', value: null };
    }
    return {
      version: 1,
      logicalPath: path,
      content,
      contentHash: computeSourceDocumentHash(content),
      parseResult,
      diagnostics,
    };
  }
}

export { FileProjectSourceLoader as FileProjectSourceLoaderImpl };
