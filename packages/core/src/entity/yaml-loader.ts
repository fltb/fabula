import * as path from 'node:path';
import YAML from 'yaml';
import type { ZodType } from 'zod';
import { ConfigError } from '../errors.js';
import { projectConfigSchema } from '../schemas/project.js';
import { FsStorage, type Storage } from '../storage/index.ts';
import type { ProjectConfig } from '../types/chapter.js';

export interface ReadYamlOptions<T> {
  filePath: string;
  schema: ZodType<T>;
  storage?: Storage;
  optional?: boolean;
}

/** Reads YAML through one strict, path-aware compiler boundary. */
export function readYamlFile<T>({
  filePath,
  schema,
  storage,
  optional = false,
}: ReadYamlOptions<T>): T | null {
  const st = storage ?? new FsStorage();
  if (!st.exists(filePath)) {
    if (optional) return null;
    throw new ConfigError('Required YAML file is missing', { path: filePath });
  }

  let document: unknown;
  try {
    document = YAML.parse(st.read(filePath));
  } catch {
    throw new ConfigError('YAML parsing failed', { path: filePath });
  }

  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const yamlPath = issue?.path.join('.') ?? '';
    throw new ConfigError(
      `YAML schema validation failed at ${yamlPath || '<root>'}: ${issue?.message ?? 'unknown issue'}`,
      { path: yamlPath ? `${filePath}:${yamlPath}` : filePath },
    );
  }
  return parsed.data;
}

export function readYamlFilesInDir<T>(dirPath: string, schema: ZodType<T>, storage?: Storage): T[] {
  const st = storage ?? new FsStorage();
  if (!st.exists(dirPath)) return [];
  const results: T[] = [];
  for (const entry of st.list(dirPath)) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...readYamlFilesInDir(fullPath, schema, st));
    } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      const parsed = readYamlFile({ filePath: fullPath, schema, storage: st });
      if (parsed) results.push(parsed);
    }
  }
  return results;
}

/**
 * Load a nova.yaml project config against the current schema.
 *
 * Parses the YAML and validates it strictly against the current
 * projectConfigSchema. No version negotiation or automatic migration:
 * files that do not match the current shape fail with ConfigError.
 *
 * @returns The validated ProjectConfig, or null if the file is optional and missing
 * @throws ConfigError on parse/validation failure
 */
export function loadProjectConfig(filePath: string, storage?: Storage): ProjectConfig | null {
  const st = storage ?? new FsStorage();
  if (!st.exists(filePath)) {
    return null;
  }

  let document: unknown;
  try {
    document = YAML.parse(st.read(filePath));
  } catch {
    throw new ConfigError('YAML parsing failed', { path: filePath });
  }

  if (typeof document !== 'object' || document === null) {
    throw new ConfigError('Project config must be a YAML object', { path: filePath });
  }

  // Validate directly against the current schema — no version negotiation,
  // dual reads, or automatic migration. Old shapes fail here with ConfigError.
  const parsed = projectConfigSchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const yamlPath = issue?.path.join('.') ?? '';
    throw new ConfigError(
      `Project config validation failed at ${yamlPath || '<root>'}: ${issue?.message ?? 'unknown issue'}`,
      { path: yamlPath ? `${filePath}:${yamlPath}` : filePath },
    );
  }

  return parsed.data;
}
