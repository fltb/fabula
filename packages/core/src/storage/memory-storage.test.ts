// ============================================================================
// MemoryStorage — Unit Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import { MemoryStorage } from './memory-storage.ts';

describe('MemoryStorage', () => {
  // ── exists ─────────────────────────────────────────────────────────────────
  describe('exists()', () => {
    it('returns false for non-existent path', () => {
      const s = new MemoryStorage();
      expect(s.exists('/nonexistent')).toBe(false);
    });

    it('returns true for a written file', () => {
      const s = new MemoryStorage();
      s.write('/test.txt', 'hello');
      expect(s.exists('/test.txt')).toBe(true);
    });

    it('returns true for a created directory', () => {
      const s = new MemoryStorage();
      s.mkdirp('/some/dir');
      expect(s.exists('/some/dir')).toBe(true);
      expect(s.exists('/some')).toBe(true);
    });
  });

  // ── read ───────────────────────────────────────────────────────────────────
  describe('read()', () => {
    it('returns content of a written file', () => {
      const s = new MemoryStorage();
      s.write('/greeting.txt', 'Hello, World!');
      expect(s.read('/greeting.txt')).toBe('Hello, World!');
    });

    it('throws when file does not exist', () => {
      const s = new MemoryStorage();
      expect(() => s.read('/missing.txt')).toThrow('File not found');
    });
  });

  // ── readOptional ──────────────────────────────────────────────────────────
  describe('readOptional()', () => {
    it('returns content of existing file', () => {
      const s = new MemoryStorage();
      s.write('/existing.txt', 'data');
      expect(s.readOptional('/existing.txt')).toBe('data');
    });

    it('returns null for non-existent file', () => {
      const s = new MemoryStorage();
      expect(s.readOptional('/ghost.txt')).toBeNull();
    });
  });

  // ── write ─────────────────────────────────────────────────────────────────
  describe('write()', () => {
    it('creates a file and allows reading it back', () => {
      const s = new MemoryStorage();
      s.write('/new.txt', 'content');
      expect(s.read('/new.txt')).toBe('content');
    });

    it('overwrites existing file content', () => {
      const s = new MemoryStorage();
      s.write('/data.txt', 'old');
      s.write('/data.txt', 'new');
      expect(s.read('/data.txt')).toBe('new');
    });
  });

  // ── mkdirp ────────────────────────────────────────────────────────────────
  describe('mkdirp()', () => {
    it('creates intermediate directory entries', () => {
      const s = new MemoryStorage();
      s.mkdirp('/a/b/c');
      expect(s.exists('/a')).toBe(true);
      expect(s.exists('/a/b')).toBe(true);
      expect(s.exists('/a/b/c')).toBe(true);
    });

    it('allows writing files after creating directories', () => {
      const s = new MemoryStorage();
      s.mkdirp('/project/definitions');
      s.write('/project/definitions/character.yaml', 'camille');
      expect(s.exists('/project/definitions/character.yaml')).toBe(true);
    });
  });

  // ── list ──────────────────────────────────────────────────────────────────
  describe('list()', () => {
    it('returns files and directories in a path', () => {
      const s = new MemoryStorage();
      s.mkdirp('/root/sub');
      s.write('/root/file1.txt', 'a');
      s.write('/root/file2.txt', 'b');

      const entries = s.list('/root');
      expect(entries).toHaveLength(3);

      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(['file1.txt', 'file2.txt', 'sub']);

      const file1 = entries.find((e) => e.name === 'file1.txt')!;
      expect(file1.isFile()).toBe(true);
      expect(file1.isDirectory()).toBe(false);

      const sub = entries.find((e) => e.name === 'sub')!;
      expect(sub.isFile()).toBe(false);
      expect(sub.isDirectory()).toBe(true);
    });

    it('returns empty array for empty directory', () => {
      const s = new MemoryStorage();
      s.mkdirp('/empty');
      expect(s.list('/empty')).toEqual([]);
    });
  });

  // ── listFiles ─────────────────────────────────────────────────────────────
  describe('listFiles()', () => {
    it('lists only files, not directories', () => {
      const s = new MemoryStorage();
      s.mkdirp('/root/sub');
      s.write('/root/a.txt', 'x');
      s.write('/root/b.txt', 'y');

      const files = s.listFiles('/root');
      expect(files).toEqual(['a.txt', 'b.txt']);
    });

    it('returns empty array when only directories exist', () => {
      const s = new MemoryStorage();
      s.mkdirp('/a/b');
      expect(s.listFiles('/a')).toEqual([]);
    });
  });

  // ── remove ────────────────────────────────────────────────────────────────
  describe('remove()', () => {
    it('deletes a single file', () => {
      const s = new MemoryStorage();
      s.write('/temp.txt', 'data');
      s.remove('/temp.txt');
      expect(s.exists('/temp.txt')).toBe(false);
    });

    it('does not throw when removing non-existent file', () => {
      const s = new MemoryStorage();
      expect(() => s.remove('/phantom.txt')).not.toThrow();
    });
  });

  // ── removeAll ─────────────────────────────────────────────────────────────
  describe('removeAll()', () => {
    it('removes a directory and all its contents', () => {
      const s = new MemoryStorage();
      s.mkdirp('/project/sub');
      s.write('/project/file.txt', 'data');
      s.write('/project/sub/nested.txt', 'nested');

      s.removeAll('/project');
      expect(s.exists('/project')).toBe(false);
      expect(s.exists('/project/file.txt')).toBe(false);
      expect(s.exists('/project/sub')).toBe(false);
      expect(s.exists('/project/sub/nested.txt')).toBe(false);
    });

    it('removes a single file when given a file path', () => {
      const s = new MemoryStorage();
      s.write('/only.txt', 'content');
      s.removeAll('/only.txt');
      expect(s.exists('/only.txt')).toBe(false);
    });

    it('does not affect siblings when removing a subdirectory', () => {
      const s = new MemoryStorage();
      s.mkdirp('/parent/a');
      s.mkdirp('/parent/b');
      s.write('/parent/keep.txt', 'keep');

      s.removeAll('/parent/a');
      expect(s.exists('/parent')).toBe(true);
      expect(s.exists('/parent/b')).toBe(true);
      expect(s.exists('/parent/keep.txt')).toBe(true);
      expect(s.exists('/parent/a')).toBe(false);
    });
  });
});
