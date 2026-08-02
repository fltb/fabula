import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { LayeredCacheKey, RenderCacheRecord } from '@novalistically/core';

export const cacheKey = (sourceHash = 'a'.repeat(64)): LayeredCacheKey => ({
  version: 1,
  sourceHash,
  layers: { logical: 'logical-hash', surface: 'surface-hash', validation: 'validation-hash' },
});

export const cacheRecord = (key: LayeredCacheKey): RenderCacheRecord => ({
  version: 1,
  key,
  recordHash: 'b'.repeat(64),
  output: {
    prose: 'derived output',
    analysis: {
      eventId: 'cache-event',
      protocol: { proseHash: 'c'.repeat(64) },
      observations: { quality: { disposition: 'produced', evidence: ['derived output'] } },
      analysis: { quality: { proseScore: 4 } },
    },
  },
});

export const withTempProject = async (run: (projectRoot: string) => Promise<void>): Promise<void> => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'fabula-node-host-cache-'));
  try {
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
};
