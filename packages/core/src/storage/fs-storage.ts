// ============================================================================
// FsStorage — Node.js filesystem-backed Storage implementation
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DirEntry, Storage } from './types.ts';

export class FsStorage implements Storage {
  exists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  read(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
  }

  readOptional(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  write(filePath: string, content: string): void {
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  mkdirp(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  list(dirPath: string): DirEntry[] {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isFile: () => e.isFile(),
      isDirectory: () => e.isDirectory(),
    }));
  }

  listFiles(dirPath: string): string[] {
    return fs.readdirSync(dirPath).filter((name) => {
      const fullPath = path.join(dirPath, name);
      return fs.statSync(fullPath).isFile();
    });
  }

  remove(filePath: string): void {
    fs.unlinkSync(filePath);
  }

  removeAll(dirPath: string): void {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}
