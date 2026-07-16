import * as path from 'node:path';
import YAML from 'yaml';
import { FsStorage, type Storage } from '../storage/index.ts';

// ============================================================================
// YAML File Helpers
// ============================================================================

export function readYamlFile<T>(filePath: string, storage?: Storage): T | null {
  const st = storage ?? new FsStorage();
  try {
    const content = st.read(filePath);
    return YAML.parse(content) as T;
  } catch {
    return null;
  }
}

export function readYamlFilesInDir<T>(dirPath: string, storage?: Storage): T[] {
  const st = storage ?? new FsStorage();
  if (!st.exists(dirPath)) return [];
  const results: T[] = [];
  const entries = st.list(dirPath);
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...readYamlFilesInDir<T>(fullPath, st));
    } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      const parsed = readYamlFile<T>(fullPath, st);
      if (parsed !== null) results.push(parsed);
    }
  }
  return results;
}
