import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';

// ============================================================================
// YAML File Helpers
// ============================================================================

export function readYamlFile<T>(filePath: string): T | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return YAML.parse(content) as T;
  } catch {
    return null;
  }
}

export function readYamlFilesInDir<T>(dirPath: string): T[] {
  if (!fs.existsSync(dirPath)) return [];
  const results: T[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...readYamlFilesInDir<T>(fullPath));
    } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      const parsed = readYamlFile<T>(fullPath);
      if (parsed !== null) results.push(parsed);
    }
  }
  return results;
}
