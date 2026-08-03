import { createHash, randomUUID } from 'node:crypto';
import {
  type Dirent,
  createReadStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import * as path from 'node:path';

import {
  type FileProjectReferenceStore as FileProjectReferenceStoreContract,
  type FileProjectReferenceStoreOptions,
  type ReferenceContent,
  type ReferenceContentReadOptions,
  type ReferenceContentReadV1,
  type ReferenceLibraryDeleteInput,
  type ReferenceLibraryImportInput,
  type ReferenceLibraryItemV1,
  type ReferenceLibraryManifestV1,
  type ReferenceLibraryReadV1,
  type ReferenceLibraryVerificationReport,
  SourceInputError,
} from './types.js';
import { contained } from '../execution/types.js';

const MANIFEST_PATH = path.join('references', 'library.json');

/** Valid media type pattern: `type/subtype` with optional `+suffix`. */
const MEDIA_TYPE_RE = /^[a-z][a-z0-9!#$&^_.+-]*\/[a-z][a-z0-9!#$&^_.+-]*(\+[a-z][a-z0-9]+)?$/i;

/** Disallowed filename characters in reference object keys and manifest paths. */
const UNSAFE_FILENAME_RE = /[\0/\\:*?"<>|]/;

/** SHA-256 hex length. */
const HASH_LEN = 64;
/** Bound manifest parsing so malformed projects cannot force unbounded memory. */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/**
 * Canonical JSON — arrays preserve order, plain-object keys sorted
 * lexicographically, undefined members omitted.
 */
function canonicalJson(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Assert that `target` is contained within `root` and has no symlink
 * components in its relative path. This is checked before any directory is
 * created so a symlink cannot redirect a write outside the project.
 */
function assertSafePath(root: string, relPath: string): void {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relPath);
  if (!contained(resolvedRoot, target)) {
    throw new SourceInputError(`Reference path escapes project root: ${relPath}`);
  }
  let current = resolvedRoot;
  const parts = path.relative(resolvedRoot, target).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    if (!contained(resolvedRoot, current)) {
      throw new SourceInputError(`Reference path escapes project root: ${relPath}`);
    }
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new SourceInputError(`Symlink rejected in reference path: ${relPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;

function assertSafeText(value: unknown, label: string, required = true): asserts value is string {
  if (typeof value !== 'string' || (required && value.length === 0)) {
    throw new SourceInputError(`${label} must be a${required ? ' non-empty' : 'n'} string`);
  }
  if (CONTROL_RE.test(value)) {
    throw new SourceInputError(`${label} contains control characters`);
  }
}

function assertValidReferenceId(referenceId: unknown): asserts referenceId is string {
  assertSafeText(referenceId, 'Reference ID');
  if (referenceId === '.' || referenceId === '..') {
    throw new SourceInputError('Reference ID must not be a traversal component');
  }
  if (referenceId.includes('/') || referenceId.includes('\\')) {
    throw new SourceInputError('Reference ID must not contain path separators');
  }
  if (UNSAFE_FILENAME_RE.test(referenceId)) {
    throw new SourceInputError('Reference ID contains unsafe characters');
  }
}

function assertValidOriginalName(name: unknown, label = 'Original name'): asserts name is string {
  assertSafeText(name, label);
  if (name === '.' || name === '..') {
    throw new SourceInputError(`${label} must not be a traversal component`);
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new SourceInputError(`${label} must not contain path separators`);
  }
  if (UNSAFE_FILENAME_RE.test(name)) {
    throw new SourceInputError(`${label} contains unsafe characters`);
  }
}

function assertValidMediaType(mediaType: unknown): asserts mediaType is string {
  assertSafeText(mediaType, 'Media type');
  if (!MEDIA_TYPE_RE.test(mediaType)) {
    throw new SourceInputError(`Invalid media type: ${mediaType}`);
  }
}

function assertSafeProjectId(projectId: unknown): asserts projectId is string {
  assertSafeText(projectId, 'Project ID');
  if (projectId.includes('/') || projectId.includes('\\')) {
    throw new SourceInputError('Project ID must not contain path separators');
  }
}

function assertLimit(value: unknown, label: string): asserts value is number {
  if (
    value !== undefined &&
    (typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0)
  ) {
    throw new SourceInputError(`${label} must be a non-negative safe integer`);
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SourceInputError(`${label} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new SourceInputError(`${label} contains unknown field: ${key}`);
    }
  }
}

/**
 * Validate that the manifest's projectId matches the expected projectId.
 */
function assertProjectIdMatch(manifest: ReferenceLibraryManifestV1, expected: string): void {
  assertSafeProjectId(expected);
  if (manifest.projectId !== expected) {
    throw new SourceInputError(
      `Manifest project ID "${manifest.projectId}" does not match expected "${expected}"`,
    );
  }
}

const MANIFEST_KEYS = new Set(['version', 'projectId', 'revision', 'items']);
const ITEM_KEYS = new Set([
  'referenceId',
  'displayName',
  'originalName',
  'mediaType',
  'contentHash',
  'byteLength',
  'objectKey',
  'createdAt',
  'updatedAt',
  'title',
  'authors',
  'sourceUrl',
  'license',
  'tags',
]);

function parseManifestItem(value: unknown, index: number): ReferenceLibraryItemV1 {
  assertRecord(value, `Manifest item ${index}`);
  assertExactKeys(value, ITEM_KEYS, `Manifest item ${index}`);
  assertValidReferenceId(value.referenceId);
  assertValidOriginalName(value.displayName, `Manifest item ${index} displayName`);
  assertValidOriginalName(value.originalName, `Manifest item ${index} originalName`);
  assertValidMediaType(value.mediaType);
  if (typeof value.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.contentHash)) {
    throw new SourceInputError(`Manifest item ${index} has invalid contentHash`);
  }
  if (
    typeof value.byteLength !== 'number' ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0
  ) {
    throw new SourceInputError(`Manifest item ${index} has invalid byteLength`);
  }
  const expectedObjectKey = `sha256/${value.contentHash.slice(0, 2)}/${value.contentHash}`;
  if (value.objectKey !== expectedObjectKey) {
    throw new SourceInputError(`Manifest item ${index} has invalid objectKey`);
  }
  assertSafeText(value.createdAt, `Manifest item ${index} createdAt`);
  assertSafeText(value.updatedAt, `Manifest item ${index} updatedAt`);
  const optional: {
    title?: string;
    authors?: readonly string[];
    sourceUrl?: string;
    license?: string;
    tags?: readonly string[];
  } = {};
  for (const key of ['title', 'sourceUrl', 'license'] as const) {
    if (value[key] !== undefined) {
      assertSafeText(value[key], `Manifest item ${index} ${key}`, false);
      optional[key] = value[key];
    }
  }
  for (const key of ['authors', 'tags'] as const) {
    if (value[key] !== undefined) {
      if (
        !Array.isArray(value[key]) ||
        value[key].some((entry: unknown) => typeof entry !== 'string')
      ) {
        throw new SourceInputError(`Manifest item ${index} ${key} must be an array of strings`);
      }
      const entries = value[key] as unknown[];
      for (const entry of entries) {
        assertSafeText(entry, `Manifest item ${index} ${key} entry`);
      }
      optional[key] = entries as readonly string[];
    }
  }
  return {
    referenceId: value.referenceId,
    displayName: value.displayName,
    originalName: value.originalName,
    mediaType: value.mediaType,
    contentHash: value.contentHash,
    byteLength: value.byteLength,
    objectKey: value.objectKey,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...optional,
  };
}

/**
 * Read and parse the manifest file. Returns `null` if the file does not
 * exist. Throws on parse errors, wrong version, bad structure, or
 * traversal/symlink violations.
 */
async function readManifest(
  projectRoot: string,
): Promise<{ manifest: ReferenceLibraryManifestV1; hash: string } | null> {
  const manifestPath = path.resolve(projectRoot, MANIFEST_PATH);
  assertSafePath(projectRoot, MANIFEST_PATH);

  let raw: string;
  try {
    const stat = await fs.stat(manifestPath);
    if (!stat.isFile()) throw new SourceInputError('Reference manifest is not a regular file');
    if (stat.size > MAX_MANIFEST_BYTES) {
      throw new SourceInputError(`Reference manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SourceInputError('Reference manifest is not valid JSON');
  }
  assertRecord(parsed, 'Reference manifest');
  assertExactKeys(parsed, MANIFEST_KEYS, 'Reference manifest');
  if (parsed.version !== 1) {
    throw new SourceInputError(
      `Unsupported manifest version: ${parsed.version}. Expected 1.`,
    );
  }
  assertSafeProjectId(parsed.projectId);
  if (
    typeof parsed.revision !== 'number' ||
    !Number.isSafeInteger(parsed.revision) ||
    parsed.revision < 0
  ) {
    throw new SourceInputError('Manifest revision must be a non-negative safe integer');
  }
  if (!Array.isArray(parsed.items)) {
    throw new SourceInputError('Manifest items must be an array');
  }
  const seen = new Set<string>();
  const items = parsed.items.map((item, index) => {
    const parsedItem = parseManifestItem(item, index);
    if (seen.has(parsedItem.referenceId)) {
      throw new SourceInputError(`Manifest contains duplicate referenceId: ${parsedItem.referenceId}`);
    }
    seen.add(parsedItem.referenceId);
    return parsedItem;
  });
  const result: ReferenceLibraryManifestV1 = {
    version: 1,
    projectId: parsed.projectId,
    revision: parsed.revision,
    items,
  };
  const hash = sha256Hex(canonicalJson(result));
  return { manifest: result, hash };
}


/**
 * Atomically write the manifest. Uses the project-root journal pattern
 * for crash safety. Verifies the expected manifest hash (CAS) before
 * committing.
 */
async function writeManifest(
  projectRoot: string,
  manifest: ReferenceLibraryManifestV1,
  expectedHash: string | null,
): Promise<string> {
  const manifestPath = path.resolve(projectRoot, MANIFEST_PATH);
  const referencesDir = path.resolve(projectRoot, 'references');
  const manifestHash = sha256Hex(canonicalJson(manifest));

  // Read current manifest to verify CAS
  if (expectedHash !== null) {
    const current = await readManifest(projectRoot);
    if (current === null) {
      throw new SourceInputError('Cannot CAS update: manifest does not exist');
    }
    if (current.hash !== expectedHash) {
      throw new SourceInputError(
        `Manifest hash mismatch: expected ${expectedHash}, found ${current.hash}`,
      );
    }
  } else {
    // When expectedHash is null, the manifest must not already exist
    const current = await readManifest(projectRoot);
    if (current !== null) {
      throw new SourceInputError(
        'Cannot create manifest: one already exists (use expectedManifestHash)',
      );
    }
  }

  // Ensure references directory exists with safety checks before creation.
  assertSafePath(projectRoot, 'references');
  mkdirSync(referencesDir, { recursive: true, mode: 0o700 });
  assertSafePath(projectRoot, 'references');

  // Atomic write via journal pattern
  const journal = path.join(referencesDir, '.library.journal.json');
  const content = canonicalJson(manifest);
  const relative = path.relative(referencesDir, manifestPath);
  await fs.writeFile(
    journal,
    JSON.stringify({ version: 1, target: relative, content }),
    { encoding: 'utf8', mode: 0o600 },
  );
  const temporary = `${manifestPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, manifestPath);
    await fs.unlink(journal);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }

  return manifestHash;
}

/**
 * Resolve the object path for a given content hash.
 * Structure: `references/objects/sha256/<first-two>/<full-hash>`.
 */
function objectPath(projectRoot: string, contentHash: string): string {
  if (contentHash.length !== HASH_LEN || !/^[0-9a-f]+$/.test(contentHash)) {
    throw new SourceInputError(`Invalid content hash: ${contentHash}`);
  }
  const prefix = contentHash.slice(0, 2);
  const relative = path.join('references', 'objects', 'sha256', prefix, contentHash);
  assertSafePath(projectRoot, relative);
  return path.resolve(projectRoot, relative);
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset);
    offset += result.bytesWritten;
  }
}

function contentChunk(value: unknown): Buffer {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new SourceInputError('Reference content chunks must be Uint8Array values');
}

/**
 * Stream content into an object temporary file while computing its digest and
 * byte count. At no point are all chunks retained in memory.
 */
async function consumeContent(
  content: ReferenceContent,
  temporary: string,
  maxBytes: number | undefined,
): Promise<{ byteLength: number; hash: string }> {
  const handle = await fs.open(temporary, 'wx', 0o400);
  const hasher = createHash('sha256');
  let byteLength = 0;
  const append = async (value: unknown): Promise<void> => {
    const chunk = contentChunk(value);
    if (chunk.length > Number.MAX_SAFE_INTEGER - byteLength) {
      throw new SourceInputError('Reference content is too large');
    }
    const nextLength = byteLength + chunk.length;
    if (maxBytes !== undefined && nextLength > maxBytes) {
      throw new SourceInputError(`Reference content exceeds the ${maxBytes}-byte limit`);
    }
    hasher.update(chunk);
    await writeAll(handle, chunk);
    byteLength = nextLength;
  };
  try {
    if (content instanceof Uint8Array) {
      await append(content);
    } else if (
      content !== null &&
      typeof content === 'object' &&
      typeof (content as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
    ) {
      for await (const chunk of content as AsyncIterable<unknown>) await append(chunk);
    } else if (
      content !== null &&
      typeof content === 'object' &&
      typeof (content as Iterable<unknown>)[Symbol.iterator] === 'function'
    ) {
      for (const chunk of content as Iterable<unknown>) await append(chunk);
    } else {
      throw new SourceInputError('Unsupported reference content type');
    }
    return { byteLength, hash: hasher.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function hashObject(filePath: string): Promise<{ byteLength: number; hash: string }> {
  const hasher = createHash('sha256');
  let byteLength = 0;
  const stream = createReadStream(filePath);
  try {
    for await (const chunk of stream) {
      const buffer = contentChunk(chunk);
      byteLength += buffer.length;
      hasher.update(buffer);
    }
  } finally {
    stream.destroy();
  }
  return { byteLength, hash: hasher.digest('hex') };
}

/**
 * Atomically commit an immutable object temporary. Existing objects are
 * never overwritten; a pre-existing object must itself have the expected
 * digest and length to be accepted as deduplication.
 */
async function writeObject(
  projectRoot: string,
  temporary: string,
  contentHash: string,
  byteLength: number,
): Promise<void> {
  const target = objectPath(projectRoot, contentHash);
  const dir = path.dirname(target);
  assertSafePath(projectRoot, path.relative(projectRoot, dir));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertSafePath(projectRoot, path.relative(projectRoot, dir));
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SourceInputError(`Reference object is not a regular file: ${contentHash}`);
    }
    const existing = await hashObject(target);
    if (existing.hash !== contentHash || existing.byteLength !== byteLength) {
      throw new SourceInputError(`Reference object integrity conflict: ${contentHash}`);
    }
    await fs.rm(temporary, { force: true });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // A rename would replace a concurrently-created target on POSIX systems.
  // Hard-linking is the exclusive-create primitive here: it either installs
  // this immutable object or reports EEXIST without ever overwriting bytes.
  try {
    await fs.link(temporary, target);
    await fs.rm(temporary, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(target);
    } catch (targetError) {
      if ((targetError as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SourceInputError(`Reference object commit race: ${contentHash}`);
      }
      throw targetError;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SourceInputError(`Reference object is not a regular file: ${contentHash}`);
    }
    const existing = await hashObject(target);
    if (existing.hash !== contentHash || existing.byteLength !== byteLength) {
      throw new SourceInputError(`Reference object integrity conflict: ${contentHash}`);
    }
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Delete orphaned objects: objects whose contentHash is not in the
 * `retained` set. Only scans the project's object store.
 */
async function gcObjects(
  projectRoot: string,
  retained: Set<string>,
): Promise<{ removed: string[]; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];
  const objRoot = path.resolve(projectRoot, 'references', 'objects', 'sha256');

  let prefixDirs: Dirent[];
  try {
    prefixDirs = readdirSync(objRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed, errors };
    throw error;
  }

  for (const prefixDir of prefixDirs) {
    if (!prefixDir.isDirectory() || !/^[0-9a-f]{2}$/.test(prefixDir.name)) continue;
    const prefixPath = path.join(objRoot, prefixDir.name);

    let files: Dirent[];
    try {
      files = readdirSync(prefixPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      errors.push(`Failed to read ${prefixDir.name}: ${(error as Error).message}`);
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || file.isSymbolicLink()) continue;
      if (!/^[0-9a-f]{64}$/.test(file.name)) continue;
      if (!retained.has(file.name)) {
        const filePath = path.join(prefixPath, file.name);
        try {
          unlinkSync(filePath);
          removed.push(file.name);
        } catch (error) {
          errors.push(`Failed to remove orphan ${file.name}: ${(error as Error).message}`);
        }
      }
    }
  }

  return { removed, errors };
}

/**
 * Synchronous, portable file-system-backed reference library store.
 *
 * The manifest lives at `<projectRoot>/references/library.json` as a
 * strict V1 JSON document. Objects are content-addressed under
 * `references/objects/sha256/<first-two>/<sha256>`.
 *
 * Concurrency is handled by the project-root directory lock (callers
 * should use `withDirectoryLock` for cross-process safety) and the
 * journal-based atomic write for the manifest.
 */
export class FileProjectReferenceStore implements FileProjectReferenceStoreContract {
  readonly #now: () => string;
  readonly #maxFileBytes: number | undefined;
  readonly #maxBytesPerProject: number | undefined;
  readonly #maxItemsPerProject: number | undefined;
  readonly #maxReadBytes: number | undefined;

  constructor(options: FileProjectReferenceStoreOptions = {}) {
    for (const [label, value] of [
      ['maxFileBytes', options.maxFileBytes],
      ['maxImportBytes', options.maxImportBytes],
      ['maxBytesPerProject', options.maxBytesPerProject],
      ['maxProjectBytes', options.maxProjectBytes],
      ['maxItemsPerProject', options.maxItemsPerProject],
      ['maxReadBytes', options.maxReadBytes],
    ] as const) {
      assertLimit(value, label);
    }
    this.#now = options.now ?? nowIso;
    this.#maxFileBytes = options.maxFileBytes ?? options.maxImportBytes;
    this.#maxBytesPerProject = options.maxBytesPerProject ?? options.maxProjectBytes;
    this.#maxItemsPerProject = options.maxItemsPerProject;
    this.#maxReadBytes = options.maxReadBytes;
  }

  async read(projectId: string, projectRoot: string): Promise<ReferenceLibraryReadV1 | null> {
    const root = path.resolve(projectRoot);
    const result = await readManifest(root);
    if (result === null) return null;
    assertProjectIdMatch(result.manifest, projectId);
    return { manifest: result.manifest, manifestHash: result.hash };
  }

  async import(
    input: ReferenceLibraryImportInput,
    projectId: string,
    projectRoot: string,
  ): Promise<ReferenceLibraryReadV1> {
    const root = path.resolve(projectRoot);
    const now = input.now ?? this.#now();
    assertSafeProjectId(projectId);
    assertValidReferenceId(input.referenceId);
    assertValidOriginalName(input.originalName);
    assertValidOriginalName(input.displayName ?? input.originalName, 'Display name');
    assertValidMediaType(input.mediaType);
    assertSafeText(now, 'Timestamp');
    for (const [key, value] of [
      ['maxBytes', input.maxBytes],
      ['maxFileBytes', input.maxFileBytes],
      ['maxBytesPerProject', input.maxBytesPerProject],
      ['maxProjectBytes', input.maxProjectBytes],
      ['maxItemsPerProject', input.maxItemsPerProject],
    ] as const) {
      assertLimit(value, key);
    }
    if (input.maxBytes !== undefined && input.maxFileBytes !== undefined && input.maxBytes !== input.maxFileBytes) {
      throw new SourceInputError('maxBytes and maxFileBytes must match when both are supplied');
    }
    if (
      input.maxBytesPerProject !== undefined &&
      input.maxProjectBytes !== undefined &&
      input.maxBytesPerProject !== input.maxProjectBytes
    ) {
      throw new SourceInputError(
        'maxBytesPerProject and maxProjectBytes must match when both are supplied',
      );
    }
    if (input.title !== undefined) assertSafeText(input.title, 'Title', false);
    if (input.sourceUrl !== undefined) assertSafeText(input.sourceUrl, 'Source URL', false);
    if (input.license !== undefined) assertSafeText(input.license, 'License', false);
    for (const [label, values] of [
      ['authors', input.authors],
      ['tags', input.tags],
    ] as const) {
      if (
        values !== undefined &&
        (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
      ) {
        throw new SourceInputError(`${label} must be an array of strings`);
      }
      for (const value of values ?? []) assertSafeText(value, `${label} entry`);
    }

    const current = await readManifest(root);
    if (current !== null) assertProjectIdMatch(current.manifest, projectId);
    const existingItems = current?.manifest.items ?? [];
    const replaced = existingItems.find((item) => item.referenceId === input.referenceId);
    const maxItems = input.maxItemsPerProject ?? this.#maxItemsPerProject;
    if (maxItems !== undefined && replaced === undefined && existingItems.length >= maxItems) {
      throw new SourceInputError(`Reference item quota exceeded: ${maxItems}`);
    }
    const maxFileBytes = input.maxBytes ?? input.maxFileBytes ?? this.#maxFileBytes;
    const maxBytesPerProject =
      input.maxBytesPerProject ??
      input.maxProjectBytes ??
      this.#maxBytesPerProject;
    const referencesDir = path.resolve(root, 'references');
    assertSafePath(root, 'references');
    mkdirSync(referencesDir, { recursive: true, mode: 0o700 });
    assertSafePath(root, 'references');
    const temporary = path.join(referencesDir, `.library.${process.pid}.${randomUUID()}.tmp`);
    assertSafePath(root, path.relative(root, temporary));
    let consumed: { byteLength: number; hash: string };
    try {
      consumed = await consumeContent(input.content, temporary, maxFileBytes);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    const existingBytes = existingItems.reduce(
      (total, item) => total + (item.referenceId === input.referenceId ? 0 : item.byteLength),
      0,
    );
    if (
      maxBytesPerProject !== undefined &&
      existingBytes > maxBytesPerProject - consumed.byteLength
    ) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw new SourceInputError(`Project reference byte quota exceeded: ${maxBytesPerProject}`);
    }
    await writeObject(root, temporary, consumed.hash, consumed.byteLength);
    const item: ReferenceLibraryItemV1 = {
      referenceId: input.referenceId,
      displayName: input.displayName ?? input.originalName,
      originalName: input.originalName,
      mediaType: input.mediaType,
      contentHash: consumed.hash,
      byteLength: consumed.byteLength,
      objectKey: `sha256/${consumed.hash.slice(0, 2)}/${consumed.hash}`,
      createdAt: now,
      updatedAt: now,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.authors !== undefined ? { authors: input.authors } : {}),
      ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.license !== undefined ? { license: input.license } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    };
    const newManifest: ReferenceLibraryManifestV1 = {
      version: 1,
      projectId,
      revision: current !== null ? current.manifest.revision + 1 : 1,
      items: [...existingItems.filter((entry) => entry.referenceId !== input.referenceId), item],
    };
    const manifestHash = await writeManifest(root, newManifest, input.expectedManifestHash);
    return { manifest: newManifest, manifestHash };
  }

  async readContent(
    projectId: string,
    projectRoot: string,
    referenceId: string,
    options: ReferenceContentReadOptions = {},
  ): Promise<ReferenceContentReadV1> {
    const root = path.resolve(projectRoot);
    assertValidReferenceId(referenceId);
    assertLimit(options.start, 'Range start');
    assertLimit(options.endExclusive, 'Range endExclusive');
    assertLimit(options.maxBytes, 'Read maxBytes');
    const current = await readManifest(root);
    if (current === null) throw new SourceInputError('Cannot read from non-existent manifest');
    assertProjectIdMatch(current.manifest, projectId);
    const item = current.manifest.items.find((entry) => entry.referenceId === referenceId);
    if (item === undefined) throw new SourceInputError(`Reference not found: ${referenceId}`);
    const objPath = objectPath(root, item.contentHash);
    let stat;
    try {
      stat = lstatSync(objPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SourceInputError(`Reference object is missing: ${item.contentHash}`);
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SourceInputError(`Reference object is not a regular file: ${item.contentHash}`);
    }
    if (stat.size !== item.byteLength) {
      throw new SourceInputError(`Reference object length mismatch: ${item.contentHash}`);
    }
    const actual = await hashObject(objPath);
    if (actual.hash !== item.contentHash || actual.byteLength !== item.byteLength) {
      throw new SourceInputError(`Reference object integrity mismatch: ${item.contentHash}`);
    }
    const start = options.start ?? 0;
    const endExclusive = options.endExclusive ?? item.byteLength;
    if (endExclusive < start || endExclusive > item.byteLength) {
      throw new SourceInputError('Reference range is outside object bounds');
    }
    const length = endExclusive - start;
    const maxBytes = options.maxBytes ?? this.#maxReadBytes;
    if (maxBytes !== undefined && length > maxBytes) {
      throw new SourceInputError(`Reference read exceeds the ${maxBytes}-byte limit`);
    }
    const content =
      length === 0
        ? Readable.from([] as Buffer[])
        : createReadStream(objPath, { start, end: endExclusive - 1 });
    return {
      content,
      contentHash: item.contentHash,
      byteLength: length,
      start,
      endExclusive,
    };
  }

  async readRange(
    projectId: string,
    projectRoot: string,
    referenceId: string,
    start: number,
    endExclusive: number,
    maxBytes?: number,
  ): Promise<ReferenceContentReadV1> {
    return this.readContent(projectId, projectRoot, referenceId, {
      start,
      endExclusive,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    });
  }

  async delete(
    input: ReferenceLibraryDeleteInput,
    projectId: string,
    projectRoot: string,
  ): Promise<ReferenceLibraryReadV1> {
    const root = path.resolve(projectRoot);
    assertValidReferenceId(input.referenceId);
    const current = await readManifest(root);
    if (current === null) throw new SourceInputError('Cannot delete from non-existent manifest');
    assertProjectIdMatch(current.manifest, projectId);
    if (!current.manifest.items.some((item) => item.referenceId === input.referenceId)) {
      throw new SourceInputError(`Reference not found: ${input.referenceId}`);
    }
    const newManifest: ReferenceLibraryManifestV1 = {
      version: 1,
      projectId,
      revision: current.manifest.revision + 1,
      items: current.manifest.items.filter((item) => item.referenceId !== input.referenceId),
    };
    const manifestHash = await writeManifest(root, newManifest, input.expectedManifestHash);
    await gcObjects(root, new Set(newManifest.items.map((item) => item.contentHash)));
    return { manifest: newManifest, manifestHash };
  }

  async verify(projectId: string, projectRoot: string): Promise<ReferenceLibraryVerificationReport> {
    const root = path.resolve(projectRoot);
    const current = await readManifest(root);
    if (current === null) return { manifest: null, missing: [], corrupt: [], orphan: [] };
    assertProjectIdMatch(current.manifest, projectId);
    const missing: string[] = [];
    const corrupt: string[] = [];
    for (const item of current.manifest.items) {
      try {
        const objPath = objectPath(root, item.contentHash);
        const stat = lstatSync(objPath);
        if (stat.isSymbolicLink()) {
          corrupt.push(item.contentHash);
          continue;
        }
        if (!stat.isFile()) {
          missing.push(item.contentHash);
          continue;
        }
        const actual = await hashObject(objPath);
        if (actual.hash !== item.contentHash || actual.byteLength !== item.byteLength) {
          corrupt.push(item.contentHash);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.push(item.contentHash);
        else corrupt.push(item.contentHash);
      }
    }
    const orphan: string[] = [];
    const referenced = new Set(current.manifest.items.map((item) => item.contentHash));
    const objRoot = path.resolve(root, 'references', 'objects', 'sha256');
    assertSafePath(root, path.relative(root, objRoot));
    try {
      const prefixDirs = readdirSync(objRoot, { withFileTypes: true });
      for (const prefixDir of prefixDirs) {
        if (!prefixDir.isDirectory() || !/^[0-9a-f]{2}$/.test(prefixDir.name)) continue;
        const prefixPath = path.join(objRoot, prefixDir.name);
        let files: Dirent[];
        try {
          files = readdirSync(prefixPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.isFile() || file.isSymbolicLink()) continue;
          if (/^[0-9a-f]{64}$/.test(file.name) && !referenced.has(file.name)) {
            orphan.push(file.name);
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return {
      manifest: { manifest: current.manifest, manifestHash: current.hash },
      missing,
      corrupt,
      orphan,
    };
  }
}

export { FileProjectReferenceStore as FileProjectReferenceStoreImpl };