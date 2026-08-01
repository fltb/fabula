import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type {
  Storage,
  StorageTransaction,
  StorageWrite,
  TransactionReadExpectation,
} from '../storage/types.ts';
import type { ProjectPaths } from './paths.ts';

export interface ProjectTransactionInput {
  transactionId?: string;
  readSet?: readonly TransactionReadExpectation[];
  writes: readonly StorageWrite[];
}

/** Constructs every authoritative workspace transaction with one lock/journal policy. */
export class ProjectTransactionCoordinator {
  constructor(
    readonly storage: Storage,
    readonly paths: ProjectPaths,
  ) {}

  commit(input: ProjectTransactionInput): string {
    const transactionId = input.transactionId ?? crypto.randomUUID();
    const transaction: StorageTransaction = {
      transactionId,
      lockPath: this.paths.transactionLockPath,
      journalPath: path.join(this.paths.transactionsDir, `${transactionId}.json`),
      conflictDir: this.paths.conflictsDir,
      readSet: input.readSet ?? [],
      writes: input.writes,
    };
    this.storage.commitBatch(transaction);
    return transactionId;
  }
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
