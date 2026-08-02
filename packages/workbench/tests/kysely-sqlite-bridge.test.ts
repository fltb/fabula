import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  createKyselySqliteDatabase,
  KyselySqliteBridge,
} from '../src/persistence/kysely-sqlite-bridge.js';

describe('Kysely SQLite bridge', () => {
  it('forwards positional null/blob/bigint parameters', () => {
    const calls: unknown[][] = [];
    const bridge = new KyselySqliteBridge({
      all: (...args) => {
        calls.push(args);
        return [];
      },
      run: (...args) => {
        calls.push(args);
        return { changes: 1, lastInsertRowid: 1n };
      },
    });
    const blob = new Uint8Array([1, 2]);
    bridge.run([null, blob, 9n]);
    expect(calls).toEqual([[null, blob, 9n]]);
  });

  it('forwards named parameters without constructing SQL', () => {
    const calls: unknown[][] = [];
    const bridge = new KyselySqliteBridge({
      all: (...args) => {
        calls.push(args);
        return [];
      },
      run: (...args) => {
        calls.push(args);
        return { changes: 0, lastInsertRowid: 0n };
      },
    });
    bridge.all({ ':id': 'x', ':value': null });
    expect(calls).toEqual([[{ ':id': 'x', ':value': null }]]);
  });

  it('preserves transaction and savepoint statements through the same private bridge', () => {
    const sql: string[] = [];
    const bridge = new KyselySqliteBridge({
      run: (...args) => {
        sql.push(String(args[0]));
        return { changes: 0, lastInsertRowid: 0n };
      },
    });
    bridge.run(['BEGIN IMMEDIATE']);
    bridge.run(['SAVEPOINT domain_write']);
    bridge.run(['RELEASE SAVEPOINT domain_write']);
    bridge.run(['COMMIT']);
    expect(sql).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT domain_write',
      'RELEASE SAVEPOINT domain_write',
      'COMMIT',
    ]);
  });
});

describe('Kysely SQLite bridge against a real StatementSync', () => {
  it('flattens Kysely batch arrays so the real statement binds them positionally instead of as a named-parameter object', () => {
    // A raw `StatementSync.run(['one'])` treats the array as a named-parameter
    // object (key '0') and throws "Unknown named parameter '0'". The bridge
    // must flatten the batch so Kysely's array-shaped calls actually bind.
    const db = new DatabaseSync(':memory:', { readBigInts: true });
    try {
      db.exec(
        'CREATE TABLE payloads (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, data BLOB, count INTEGER)',
      );
      const adapter = createKyselySqliteDatabase(db);
      const insert = adapter.prepare('INSERT INTO payloads(label, data, count) VALUES (?, ?, ?)');
      insert.run([null, new Uint8Array([1, 2]), 9n]); // Kysely batch shape
      insert.run('positional', new Uint8Array([3, 4]), 5n); // worker variadic shape
      const rows = adapter
        .prepare('SELECT label, data, count FROM payloads ORDER BY id')
        .all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows[0].label).toBeNull();
      expect(rows[0].data).toEqual(new Uint8Array([1, 2]));
      expect(rows[0].count).toBe(9n);
      expect(rows[1].label).toBe('positional');
      expect(rows[1].data).toEqual(new Uint8Array([3, 4]));
      expect(rows[1].count).toBe(5n);
    } finally {
      db.close();
    }
  });

  it('forwards a named-object as a single argument so the real statement binds by name', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE things (id TEXT PRIMARY KEY, value TEXT)');
      const adapter = createKyselySqliteDatabase(db);
      adapter
        .prepare('INSERT INTO things(id, value) VALUES (@id, @value)')
        .run({ '@id': 'k1', '@value': null });
      const row = adapter
        .prepare('SELECT id, value FROM things WHERE id = @id')
        .get({ '@id': 'k1' }) as Record<string, unknown> | undefined;
      expect(row).toEqual({ id: 'k1', value: null });
    } finally {
      db.close();
    }
  });

  it('executes transaction and savepoint statements through the same real bridge', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE ledger (id INTEGER PRIMARY KEY, value TEXT)');
      const adapter = createKyselySqliteDatabase(db);
      const prepare = (sql: string) => adapter.prepare(sql);
      prepare('BEGIN IMMEDIATE').run([]);
      prepare('INSERT INTO ledger(value) VALUES (?)').run(['one']);
      prepare('SAVEPOINT domain_write').run([]);
      prepare('INSERT INTO ledger(value) VALUES (?)').run(['two']);
      prepare('RELEASE SAVEPOINT domain_write').run([]);
      prepare('COMMIT').run([]);
      prepare('BEGIN').run([]);
      prepare('INSERT INTO ledger(value) VALUES (?)').run(['rolled-back']);
      prepare('ROLLBACK').run([]);
      const rows = adapter.prepare('SELECT value FROM ledger ORDER BY id').all() as Array<{
        value: string;
      }>;
      expect(rows.map((r) => r.value)).toEqual(['one', 'two']);
    } finally {
      db.close();
    }
  });
});
