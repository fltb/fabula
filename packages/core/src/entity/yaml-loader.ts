import YAML from 'yaml';
import type { ZodType } from 'zod';
import { ConfigError } from '../errors.js';
import { projectConfigSchema } from '../schemas/project.js';
import type { ProjectSourceSnapshotV1 } from '../contracts/source.js';
import type { ProjectConfig } from '../types/chapter.js';

export interface ReadYamlOptions<T> {
  logicalPath: string;
  schema: ZodType<T>;
  snapshot: ProjectSourceSnapshotV1;
  optional?: boolean;
}

function documentAt(snapshot: ProjectSourceSnapshotV1, logicalPath: string) {
  return snapshot.documents.find((document) => document.logicalPath === logicalPath);
}

/** Reads and validates one YAML document from an immutable source snapshot. */
export function readYamlFile<T>({ logicalPath, schema, snapshot, optional = false }: ReadYamlOptions<T>): T | null {
  const source = documentAt(snapshot, logicalPath);
  if (!source) {
    if (optional) return null;
    throw new ConfigError('Required YAML file is missing', { path: logicalPath });
  }
  let document: unknown;
  try {
    document = YAML.parse(source.content);
  } catch {
    throw new ConfigError('YAML parsing failed', { path: logicalPath });
  }
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const yamlPath = issue?.path.join('.') ?? '';
    throw new ConfigError(
      `YAML schema validation failed at ${yamlPath || '<root>'}: ${issue?.message ?? 'unknown issue'}`,
      { path: yamlPath ? `${logicalPath}:${yamlPath}` : logicalPath },
    );
  }
  return parsed.data;
}

export function readYamlFilesInDir<T>(dirPath: string, schema: ZodType<T>, snapshot: ProjectSourceSnapshotV1): T[] {
  const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
  return snapshot.documents
    .filter((document) => document.logicalPath.startsWith(prefix) && /\.ya?ml$/i.test(document.logicalPath))
    .sort((a, b) => a.logicalPath.localeCompare(b.logicalPath))
    .map((document) => readYamlFile({ logicalPath: document.logicalPath, schema, snapshot }))
    .filter((value): value is T => value !== null);
}

export function loadProjectConfig(snapshot: ProjectSourceSnapshotV1): ProjectConfig | null {
  const document = documentAt(snapshot, 'nova.yaml');
  if (!document) return null;
  let value: unknown;
  try {
    value = YAML.parse(document.content);
  } catch {
    throw new ConfigError('YAML parsing failed', { path: 'nova.yaml' });
  }
  if (typeof value !== 'object' || value === null) {
    throw new ConfigError('Project config must be a YAML object', { path: 'nova.yaml' });
  }
  const parsed = projectConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const yamlPath = issue?.path.join('.') ?? '';
    throw new ConfigError(
      `Project config validation failed at ${yamlPath || '<root>'}: ${issue?.message ?? 'unknown issue'}`,
      { path: yamlPath ? `nova.yaml:${yamlPath}` : 'nova.yaml' },
    );
  }
  return parsed.data;
}
