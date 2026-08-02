import { describe, expect, it } from 'vitest';
import { TraceCollector } from '../../src/observability/trace.ts';

const trace = (jobId: string, traceId = jobId) =>
  new TraceCollector(jobId, traceId, { now: () => '2026-08-02T00:00:00.000Z' });

describe('TraceCollector', () => {
  it('writes safe JSONL traces with job and event correlation', () => {
    const traces = trace('run-1');
    traces.record({ spanId: 'pass1-E0', eventId: 'E0', phase: 'pass1', state: 'start' });
    traces.record({
      spanId: 'pass1-E0',
      eventId: 'E0',
      phase: 'pass1',
      state: 'end',
      durationMs: 9,
    });
    const lines = traces
      .toJsonLines()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      jobId: 'run-1',
      traceId: 'run-1',
      eventId: 'E0',
      phase: 'pass1',
    });
    expect(lines[1].durationMs).toBe(9);
  });

  it('produces valid span nesting with matching start/end spanIds', () => {
    const traces = trace('job-1', 'trace-1');
    // Pipeline span
    traces.record({ spanId: 'E0', eventId: 'E0', phase: 'pipeline', state: 'start' });
    // Cache span (nested)
    traces.record({ spanId: 'E0:cache', eventId: 'E0', phase: 'cache', state: 'start' });
    traces.record({
      spanId: 'E0:cache',
      eventId: 'E0',
      phase: 'cache',
      state: 'end',
      durationMs: 2,
    });
    // Pass 1 span (nested)
    traces.record({ spanId: 'E0:pass1', eventId: 'E0', phase: 'pass1', state: 'start' });
    traces.record({
      spanId: 'E0:pass1',
      eventId: 'E0',
      phase: 'pass1',
      state: 'end',
      durationMs: 150,
    });
    // Pass 2 span (nested)
    traces.record({ spanId: 'E0:pass2', eventId: 'E0', phase: 'pass2', state: 'start' });
    traces.record({
      spanId: 'E0:pass2',
      eventId: 'E0',
      phase: 'pass2',
      state: 'end',
      durationMs: 200,
    });
    // Pipeline end
    traces.record({
      spanId: 'E0',
      eventId: 'E0',
      phase: 'pipeline',
      state: 'end',
      durationMs: 400,
    });

    const events = traces.snapshot();
    expect(events).toHaveLength(8);
    // Verify start/end pairs have matching spanIds
    const startEvents = events.filter((e) => e.state === 'start');
    const endEvents = events.filter((e) => e.state === 'end');
    expect(startEvents.map((e) => e.spanId).sort()).toEqual(endEvents.map((e) => e.spanId).sort());
    // Verify pipeline start is first and end is last
    expect(events[0].phase).toBe('pipeline');
    expect(events[0].state).toBe('start');
    expect(events[events.length - 1].phase).toBe('pipeline');
    expect(events[events.length - 1].state).toBe('end');
    // Verify traceId is propagated
    expect(events[0].traceId).toBe('trace-1');
    expect(events.every((e) => e.traceId === 'trace-1')).toBe(true);
  });

  it('covers all trace phase event types', () => {
    const traces = trace('job-types');
    const phases = [
      'pipeline',
      'context',
      'cache',
      'pass1',
      'pass2',
      'validator',
      'circuit',
      'output',
    ] as const;
    for (const phase of phases) {
      traces.record({ spanId: phase, eventId: 'E0', phase, state: 'start' });
      traces.record({ spanId: phase, eventId: 'E0', phase, state: 'end', durationMs: 10 });
    }
    const events = traces.snapshot();
    expect(events).toHaveLength(16);
    for (const phase of phases) {
      const phaseEvents = events.filter((e) => e.phase === phase);
      expect(phaseEvents).toHaveLength(2);
      expect(phaseEvents[0].state).toBe('start');
      expect(phaseEvents[1].state).toBe('end');
      expect(phaseEvents[1].durationMs).toBe(10);
    }
  });

  it('flush output produces valid JSONL with empty trailing newline', () => {
    const traces = trace('run-flush');
    traces.record({ spanId: 'E1', eventId: 'E1', phase: 'pipeline', state: 'start' });
    traces.record({ spanId: 'E1', eventId: 'E1', phase: 'pipeline', state: 'end', durationMs: 5 });
    const raw = traces.toJsonLines();
    expect(raw).toBeTruthy();
    // Must end with newline
    expect(raw.endsWith('\n')).toBe(true);
    // Each line is valid JSON
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('traceId');
      expect(parsed).toHaveProperty('jobId');
      expect(parsed).toHaveProperty('spanId');
      expect(parsed).toHaveProperty('phase');
      expect(parsed).toHaveProperty('state');
    }
  });

  it('handles empty trace gracefully', () => {
    const traces = trace('empty-job');
    const events = traces.snapshot();
    expect(events).toHaveLength(0);

    const raw = traces.toJsonLines();
    // Empty traces may write empty file or just newline
    expect(raw).toBeDefined();
  });

  it('records error events with code', () => {
    const traces = trace('err-job');
    traces.record({
      spanId: 'E0:cache',
      eventId: 'E0',
      phase: 'cache',
      state: 'error',
      code: 'CORRUPTED',
    });
    const events = traces.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe('CORRUPTED');
    expect(events[0].state).toBe('error');
  });

  it('supports multiple events in the same job', () => {
    const traces = trace('multi-event');
    traces.record({ spanId: 'E0', eventId: 'E0', phase: 'pipeline', state: 'start' });
    traces.record({
      spanId: 'E0',
      eventId: 'E0',
      phase: 'pipeline',
      state: 'end',
      durationMs: 100,
    });
    traces.record({ spanId: 'E1', eventId: 'E1', phase: 'pipeline', state: 'start' });
    traces.record({
      spanId: 'E1',
      eventId: 'E1',
      phase: 'pipeline',
      state: 'end',
      durationMs: 200,
    });
    const events = traces.snapshot();
    expect(events).toHaveLength(4);
    const e0Events = events.filter((e) => e.eventId === 'E0');
    const e1Events = events.filter((e) => e.eventId === 'E1');
    expect(e0Events).toHaveLength(2);
    expect(e1Events).toHaveLength(2);
  });

  it('records the injected clock timestamp verbatim for every event', () => {
    const stamps = [
      '2001-02-03T04:05:06.000Z',
      '2002-03-04T05:06:07.000Z',
      '2003-04-05T06:07:08.000Z',
    ];
    let i = 0;
    const traces = new TraceCollector('job-seq', 'trace-seq', {
      now: () => stamps[i++] ?? '2004-05-06T07:08:09.000Z',
    });
    traces.record({ spanId: 's1', phase: 'pipeline', state: 'start' });
    traces.record({ spanId: 's2', phase: 'pass1', state: 'start' });
    traces.record({ spanId: 's2', phase: 'pass1', state: 'end', durationMs: 5 });
    const events = traces.snapshot();
    expect(events.map((e) => e.timestamp)).toEqual(stamps);
    const lines = traces.toJsonLines().trim().split('\n');
    expect(lines[0]).toContain('2001-02-03T04:05:06.000Z');
    expect(lines[1]).toContain('2002-03-04T05:06:07.000Z');
  });

  it('propagates injected traceId and jobId unchanged, including error events', () => {
    const traces = new TraceCollector('job-42', 'trace-abc', {
      now: () => '2005-06-07T08:09:10.000Z',
    });
    traces.record({ spanId: 's', phase: 'pass2', state: 'start' });
    traces.record({ spanId: 's', phase: 'pass2', state: 'error', code: 'PROVIDER_ERROR' });
    const events = traces.snapshot();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.jobId).toBe('job-42');
      expect(event.traceId).toBe('trace-abc');
      expect(event.timestamp).toBe('2005-06-07T08:09:10.000Z');
    }
    expect(events[1]).toMatchObject({ state: 'error', code: 'PROVIDER_ERROR' });
  });

  it('keeps collectors with different injected clocks independent', () => {
    const early = new TraceCollector('job-a', 'trace-a', { now: () => '2001-01-01T00:00:00.000Z' });
    const late = new TraceCollector('job-b', 'trace-b', { now: () => '2002-02-02T00:00:00.000Z' });
    early.record({ spanId: 's', phase: 'pipeline', state: 'start' });
    late.record({ spanId: 's', phase: 'pipeline', state: 'start' });
    expect(early.snapshot()[0].timestamp).toBe('2001-01-01T00:00:00.000Z');
    expect(late.snapshot()[0].timestamp).toBe('2002-02-02T00:00:00.000Z');
    expect(early.toJsonLines()).not.toContain('2002');
    expect(late.toJsonLines()).not.toContain('2001');
  });
});
