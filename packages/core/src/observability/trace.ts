import * as path from 'node:path';
import type { Storage } from '../storage/index.ts';

type TracePhase =
  | 'pipeline'
  | 'context'
  | 'cache'
  | 'pass1'
  | 'pass2'
  | 'validator'
  | 'circuit'
  | 'output';
type TraceState = 'start' | 'end' | 'error';

export interface TraceEvent {
  timestamp: string;
  traceId: string;
  spanId: string;
  jobId: string;
  eventId?: string;
  phase: TracePhase;
  state: TraceState;
  durationMs?: number;
  code?: string;
}

export class TraceCollector {
  private readonly events: TraceEvent[] = [];

  constructor(
    readonly jobId: string,
    readonly traceId = jobId,
  ) {}

  record(event: Omit<TraceEvent, 'timestamp' | 'jobId' | 'traceId'>): void {
    this.events.push({
      ...event,
      timestamp: new Date().toISOString(),
      jobId: this.jobId,
      traceId: this.traceId,
    });
  }

  snapshot(): readonly TraceEvent[] {
    return this.events;
  }

  write(storage: Storage, projectDir: string): void {
    const dir = path.join(projectDir, '.nova', 'traces');
    storage.mkdirp(dir);
    const target = path.join(dir, `${this.jobId}.jsonl`);
    storage.write(
      target,
      this.events.map((event) => JSON.stringify(event)).join('\n') +
        (this.events.length > 0 ? '\n' : ''),
    );
  }
}
