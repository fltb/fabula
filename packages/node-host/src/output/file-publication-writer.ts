import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** Canonical publication id: the assembled novel for the trunk route. */
export const CANONICAL_PUBLICATION_ID = 'canonical' as const;

/** File name of the canonical publication artifact. */
export const CANONICAL_PUBLICATION_FILENAME = 'novel.md' as const;

/** Project-relative output directory holding publication artifacts. */
export const PUBLICATION_OUTPUT_DIRECTORY = 'output' as const;

const CANONICAL_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Raised for any publication path/id that cannot be mapped to a safe file. */
export class PublicationPathError extends Error {
  readonly code = 'PUBLICATION_PATH_INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PublicationPathError';
  }
}

/**
 * Map a publication id to its project-relative output path.
 * Only the canonical id and 64-hex custom ids (sha256 of a branch identity)
 * are accepted; anything else is rejected.
 */
export function derivePublicationRelativePath(publicationId: string): string {
  if (publicationId === CANONICAL_PUBLICATION_ID) {
    return `${PUBLICATION_OUTPUT_DIRECTORY}/${CANONICAL_PUBLICATION_FILENAME}`;
  }
  if (CANONICAL_ID_PATTERN.test(publicationId)) {
    return `${PUBLICATION_OUTPUT_DIRECTORY}/${publicationId}.md`;
  }
  throw new PublicationPathError(
    `publication id must be "${CANONICAL_PUBLICATION_ID}" or a 64-hex custom id: ${publicationId}`,
  );
}

/**
 * Validate a project-relative publication path: it must stay inside the
 * output directory with no absolute components and no traversal.
 */
export function assertSafePublicationRelativePath(relativePath: string): void {
  if (relativePath === '') {
    throw new PublicationPathError('publication relative path must not be empty');
  }
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    throw new PublicationPathError(
      `publication relative path must not be absolute: ${relativePath}`,
    );
  }
  const parts = relativePath.split(/[\\/]/);
  if (parts.some((part) => part === '..' || part === '.')) {
    throw new PublicationPathError(`publication relative path must not traverse: ${relativePath}`);
  }
  if (parts[0] !== PUBLICATION_OUTPUT_DIRECTORY || parts.length !== 2) {
    throw new PublicationPathError(
      `publication relative path must be ${PUBLICATION_OUTPUT_DIRECTORY}/<file>: ${relativePath}`,
    );
  }
}

/**
 * Normalize publication markdown bytes: CRLF runs become LF and trailing
 * newline runs collapse to exactly one, while hard-break spaces (two spaces
 * before a newline) are preserved.
 */
export function normalizePublicationMarkdown(text: string): string {
  return `${text.replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n`;
}

/** sha256 of the normalized publication markdown bytes. */
export function hashPublicationMarkdown(text: string): string {
  return createHash('sha256').update(normalizePublicationMarkdown(text), 'utf8').digest('hex');
}

export interface FilePublicationWriteInput {
  readonly publicationId: string;
  readonly markdown: string;
}

export interface FilePublicationWriteResult {
  readonly relativeOutputPath: string;
  readonly sha256: string;
  readonly byteLength: number;
}

/**
 * Writes publication artifacts under `<projectRoot>/output/` atomically
 * (temp file + rename) with the canonical single-trailing-newline bytes.
 * The output directory is created lazily only on a successful path; an
 * invalid id fails before any directory is created.
 */
export class FilePublicationWriter {
  readonly #projectRoot: string;

  constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
  }

  async write(input: FilePublicationWriteInput): Promise<FilePublicationWriteResult> {
    const relativeOutputPath = derivePublicationRelativePath(input.publicationId);
    assertSafePublicationRelativePath(relativeOutputPath);
    const content = normalizePublicationMarkdown(input.markdown);
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    const byteLength = Buffer.byteLength(content, 'utf8');

    const absolutePath = path.join(this.#projectRoot, ...relativeOutputPath.split('/'));
    const directory = path.dirname(absolutePath);
    await mkdir(directory, { recursive: true });
    const tempPath = path.join(
      directory,
      `.${path.basename(absolutePath)}.${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await writeFile(tempPath, content, 'utf8');
      await rename(tempPath, absolutePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return { relativeOutputPath, sha256, byteLength };
  }
}
