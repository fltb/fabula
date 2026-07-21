// ============================================================================
// FsStorage — Node.js filesystem-backed Storage implementation
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DirEntry, Storage, StorageWrite } from './types.ts';

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

  commitBatch(writes: readonly StorageWrite[]): void {
    const staged = writes.map((write, index) => ({
      ...write,
      temp: `${write.path}.tmp-${process.pid}-${index}`,
      backup: `${write.path}.bak-${process.pid}-${index}`,
      existed: fs.existsSync(write.path),
    }));
    try {
      for (const entry of staged) {
        fs.mkdirSync(path.dirname(entry.path), { recursive: true });
        fs.writeFileSync(entry.temp, entry.content, 'utf-8');
      }
      for (const entry of staged) {
        if (entry.existed) fs.renameSync(entry.path, entry.backup);
        fs.renameSync(entry.temp, entry.path);
      }
      for (const entry of staged) {
        if (fs.existsSync(entry.backup)) fs.unlinkSync(entry.backup);
      }
    } catch (error) {
      for (const entry of [...staged].reverse()) {
        if (fs.existsSync(entry.temp)) fs.unlinkSync(entry.temp);
        if (fs.existsSync(entry.backup)) {
          if (fs.existsSync(entry.path)) fs.unlinkSync(entry.path);
          fs.renameSync(entry.backup, entry.path);
        } else if (!entry.existed && fs.existsSync(entry.path)) {
          fs.unlinkSync(entry.path);
        }
      }
      throw error;
    }
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
