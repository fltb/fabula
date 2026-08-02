import type { LLMProvider } from '@novalistically/core';
import { describe, expect, it } from 'vitest';
import {
  createFileCoreRuntimeServices,
  FileExecutionRepository,
  FileRenderCacheRepository,
  FileStateLogRepository,
  FileStateSnapshotRepository,
} from '../src/index.js';
import { withTempProject } from './cache-fixtures.js';

const provider: LLMProvider = {
  name: 'test-provider',
  async complete() {
    return {
      content: 'unused',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: 'test-model',
    };
  },
};

describe('createFileCoreRuntimeServices', () => {
  it('composes project-private semantic ports and explicit host dependencies', async () => {
    await withTempProject(async (root) => {
      const runtime = createFileCoreRuntimeServices(root, {
        provider,
        promptTemplates: [{ name: 'scene', version: 'v1', template: 'Write {{scene}}.' }],
        now: () => '2026-08-02T00:00:00.000Z',
        nextId: (kind) => `${kind ?? 'id'}-1`,
      });

      expect(runtime.execution).toBeInstanceOf(FileExecutionRepository);
      expect(runtime.renderCache).toBeInstanceOf(FileRenderCacheRepository);
      expect(runtime.stateLog).toBeInstanceOf(FileStateLogRepository);
      expect(runtime.stateSnapshots).toBeInstanceOf(FileStateSnapshotRepository);
      expect(runtime.llm).toBe(provider);
      expect(runtime.clock.now()).toBe('2026-08-02T00:00:00.000Z');
      expect(runtime.ids.next({ kind: 'operation' })).toBe('operation-1');
      await expect(runtime.promptTemplates.get({ name: 'scene', version: 'v1' })).resolves.toEqual({
        name: 'scene',
        version: 'v1',
        template: 'Write {{scene}}.',
      });
    });
  });
});
