import * as path from 'node:path';
import YAML from 'yaml';
import type { ZodType } from 'zod';
import { ConfigError } from '../errors.js';
import { FsStorage, type Storage } from '../storage/index.ts';
import { migrateToLatest, CURRENT_SCHEMA_VERSION } from '../migration/registry.js';
import { projectConfigSchema } from '../schemas/project.js';
import type { ProjectConfig } from '../types/chapter.js';

export interface ReadYamlOptions<T> {
  filePath: string;
  schema: ZodType<T>;
  storage?: Storage;
  optional?: boolean;
}

/** Reads YAML through one strict, path-aware compiler boundary. */
export function readYamlFile<T>({ filePath, schema, storage, optional = false }: ReadYamlOptions<T>): T | null {
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
    throw new ConfigError(`YAML schema validation failed at ${yamlPath || '<root>'}: ${issue?.message ?? 'unknown issue'}`, { path: yamlPath ? `${filePath}:${yamlPath}` : filePath });
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
 * Load a nova.yaml project config with automatic schema migration.
 *
 * Parses the YAML, checks schemaVersion, runs any pending migrations,
 * then validates against the current projectConfigSchema.
 *
 * @returns The validated ProjectConfig, or null if the file is optional and missing
 * @throws ConfigError on parse/validation failure, or on future version
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

  // Check schemaVersion and migrate if needed
  const raw = document as Record<string, unknown>;
  const currentVersion =
    typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;

  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new ConfigError(
      `Project schema version ${currentVersion} is newer than supported ${CURRENT_SCHEMA_VERSION}. Please upgrade Novalistically.`,
      { path: filePath },
    );
  }

  let migrated = raw;
  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    migrated = migrateToLatest(raw, currentVersion, CURRENT_SCHEMA_VERSION);
  }

  // Validate migrated data against the current schema
  const parsed = projectConfigSchema.safeParse(migrated);
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

/**
 * Migrate a project config file in-place.
 *
 * Reads the file, detects the current schema version, runs any needed
 * migrations, and writes the migrated YAML back to the same path.
 *
 * @returns The detected schema version before migration, or 0 if absent
 * @throws ConfigError if the file is at a newer version than supported
 */
export function migrateProjectFile(filePath: string, storage?: Storage): number {
  const st = storage ?? new FsStorage();
  if (!st.exists(filePath)) {
    throw new ConfigError('Project config file not found', { path: filePath });
  }

  const rawContent = st.read(filePath);

  let document: unknown;
  try {
    document = YAML.parse(rawContent);
  } catch {
    throw new ConfigError('YAML parsing failed', { path: filePath });
  }

  if (typeof document !== 'object' || document === null) {
    throw new ConfigError('Project config must be a YAML object', { path: filePath });
  }

  const raw = document as Record<string, unknown>;
  const currentVersion =
    typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;

  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new ConfigError(
      `Project schema version ${currentVersion} is newer than supported ${CURRENT_SCHEMA_VERSION}. Please upgrade Novalistically.`,
      { path: filePath },
    );
  }

  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return currentVersion;
  }

  // Run migration
  let migrated = migrateToLatest(raw, currentVersion, CURRENT_SCHEMA_VERSION);

  // Validate migrated data
  const parsed = projectConfigSchema.safeParse(migrated);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const yamlPath = issue?.path.join('.') ?? '';
    throw new ConfigError(
      `Project config validation failed after migration at ${yamlPath || '<root>'}: ${issue?.message ?? 'unknown issue'}`,
      { path: yamlPath ? `${filePath}:${yamlPath}` : filePath },
    );
  }

  // Write migrated data back as YAML
  const newYaml = YAML.stringify(migrated, { lineWidth: 120 });
  st.write(filePath, newYaml);

  return currentVersion;
}
