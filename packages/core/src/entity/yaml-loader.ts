import * as path from 'node:path';
import YAML from 'yaml';
import type { ZodType } from 'zod';
import { ConfigError } from '../errors.js';
import { FsStorage, type Storage } from '../storage/index.ts';

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
