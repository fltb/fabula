import type { ProjectSourceSnapshotV1, SourceChangeV1 } from '@novalistically/core';

export interface FileProjectSourceLoaderOptions {
  /** Optional parser hook; the default parser is YAML.parse. */
  readonly parse?: (content: string, logicalPath: string) => unknown;
}

export interface FileProjectSourceWriterOptions {
  readonly loader?: FileProjectSourceLoader;
}

export interface FileProjectSourceLoader {
  load(projectRoot: string): ProjectSourceSnapshotV1;
}

export interface FileProjectSourceWriter {
  apply(
    projectRoot: string,
    expectedSourceHash: string,
    changes: readonly SourceChangeV1[],
  ): Promise<ProjectSourceSnapshotV1>;
}

export class SourcePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourcePathError';
  }
}

export class SourceConflictError extends Error {
  readonly expectedSourceHash: string;
  readonly actualSourceHash: string;

  constructor(expectedSourceHash: string, actualSourceHash: string) {
    super(`Source hash conflict: expected ${expectedSourceHash}, found ${actualSourceHash}`);
    this.name = 'SourceConflictError';
    this.expectedSourceHash = expectedSourceHash;
    this.actualSourceHash = actualSourceHash;
  }
}
