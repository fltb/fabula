import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  MockPass2Provider,
  type MockPass2Entry,
  type MockPass2Options,
} from '@novalistically/core/testing';

export interface FileMockPass2Options extends MockPass2Options {
  /** Directory containing `<eventId>.json` deterministic render fixtures. */
  readonly referenceDir: string;
}

/**
 * Node-host fixture adapter. It materializes reference files before creating
 * Core's pure, in-memory MockPass2Provider; Core itself never receives a path.
 */
export class FileMockPass2Provider extends MockPass2Provider {
  constructor(options: FileMockPass2Options) {
    const loaded = loadReferenceEntries(options.referenceDir);
    super({
      latencyMs: options.latencyMs,
      entries: { ...loaded, ...options.entries },
    });
  }
}

export function loadReferenceEntries(referenceDir: string): Record<string, MockPass2Entry> {
  const root = resolve(referenceDir);
  const entries: Record<string, MockPass2Entry> = {};
  for (const file of readdirSync(root).filter((entry) => entry.endsWith('.json')).sort()) {
    const filePath = join(root, file);
    const value: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      !('prose' in value) ||
      typeof value.prose !== 'string' ||
      !('analysis' in value) ||
      value.analysis === null
    ) {
      throw new Error(`Invalid mock reference fixture: ${filePath}`);
    }
    entries[basename(file, '.json')] = value as MockPass2Entry;
  }
  return entries;
}
