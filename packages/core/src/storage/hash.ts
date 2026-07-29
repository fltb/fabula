import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { Storage } from './types.ts';

export function computeContentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function computeFileHash(storage: Storage, filePath: string): string | null {
  const content = storage.readOptional(filePath);
  return content === null ? null : computeContentHash(content);
}

/** Stable recursive manifest hash. Missing and empty directories are distinct. */
export function computeDirectoryManifestHash(storage: Storage, directory: string): string {
  const entries: Array<{ path: string; type: 'file' | 'directory'; hash?: string }> = [];
  if (!storage.exists(directory)) {
    return computeContentHash(JSON.stringify({ exists: false, entries }));
  }

  const visit = (current: string, relative: string): void => {
    for (const entry of [...storage.list(current)].sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(current, entry.name);
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        entries.push({ path: childRelative, type: 'directory' });
        visit(child, childRelative);
      } else {
        entries.push({
          path: childRelative,
          type: 'file',
          hash: computeContentHash(storage.read(child)),
        });
      }
    }
  };

  visit(directory, '');
  return computeContentHash(JSON.stringify({ exists: true, entries }));
}
