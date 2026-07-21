import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import { TraceCollector } from '../../src/observability/trace.ts';

describe('TraceCollector', () => {
  it('writes safe JSONL traces with job and event correlation', () => {
    const traces = new TraceCollector('run-1');
    traces.record({ spanId: 'pass1-E0', eventId: 'E0', phase: 'pass1', state: 'start' });
    traces.record({ spanId: 'pass1-E0', eventId: 'E0', phase: 'pass1', state: 'end', durationMs: 9 });
    const storage = new MemoryStorage();
    traces.write(storage, '/project');

    const lines = storage.read('/project/.nova/traces/run-1.jsonl').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ jobId: 'run-1', traceId: 'run-1', eventId: 'E0', phase: 'pass1' });
    expect(lines[1].durationMs).toBe(9);
  });
});
