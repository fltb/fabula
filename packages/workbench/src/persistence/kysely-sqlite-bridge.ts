/** Private adapter between Kysely's SQLite driver shape and Node 26 StatementSync. */
export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface StatementSyncLike {
  readonly reader?: boolean;
  all(...parameters: unknown[]): unknown[];
  run(...parameters: unknown[]): RunResult;
  get?(...parameters: unknown[]): unknown;
  iterate?(...parameters: unknown[]): IterableIterator<unknown>;
}

export interface KyselySqliteDatabase {
  close(): void;
  prepare(sql: string): KyselySqliteBridge;
}

export class KyselySqliteBridge {
  readonly #statement: StatementSyncLike;
  readonly reader: boolean;

  constructor(statement: StatementSyncLike) {
    this.#statement = statement;
    this.reader = statement.reader === true;
  }

  /**
   * Accepts both Kysely's batched call shape (`run(parametersArray)`) and the
   * worker's direct positional shape (`run(a, b, c)`). A single leading array
   * is a batch; anything else is forwarded positionally.
   */
  #flatten(parameters: unknown[]): unknown[] {
    const [first, ...rest] = parameters;
    if (rest.length > 0 || !Array.isArray(first)) return parameters;
    return first;
  }

  all(...parameters: unknown[]): unknown[] {
    return this.#statement.all(...this.#flatten(parameters));
  }

  run(...parameters: unknown[]): RunResult {
    return this.#statement.run(...this.#flatten(parameters));
  }

  get(...parameters: unknown[]): unknown {
    return this.#statement.get?.(...this.#flatten(parameters));
  }

  iterate(...parameters: unknown[]): IterableIterator<unknown> {
    if (!this.#statement.iterate) throw new Error('Statement does not support iteration');
    return this.#statement.iterate(...this.#flatten(parameters));
  }
}

export function createKyselySqliteDatabase(database: {
  close(): void;
  prepare(sql: string): StatementSyncLike;
}): KyselySqliteDatabase {
  return {
    close: () => database.close(),
    prepare: (sql: string) => new KyselySqliteBridge(database.prepare(sql)),
  };
}
