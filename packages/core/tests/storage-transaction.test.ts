import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../src/storage/memory-storage.ts';

describe('Storage.commitBatch', () => {
  it('publishes every memory write together', () => {
    const storage = new MemoryStorage();
    storage.write('run/old.txt', 'old');
    storage.commitBatch([{ path: 'run/a.txt', content: 'a' }, { path: 'run/b.txt', content: 'b' }]);
    expect(storage.read('run/a.txt')).toBe('a');
    expect(storage.read('run/b.txt')).toBe('b');
    expect(storage.read('run/old.txt')).toBe('old');
  });
});
