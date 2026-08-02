import type { Clock } from '../ports/runtime-services.ts';

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
    readonly traceId: string,
    private readonly clock: Clock,
  ) {}

  record(event: Omit<TraceEvent, 'timestamp' | 'jobId' | 'traceId'>): void {
    this.events.push({
      ...event,
      timestamp: this.clock.now(),
      jobId: this.jobId,
      traceId: this.traceId,
    });
  }

  snapshot(): readonly TraceEvent[] {
    return this.events;
  }

  toJsonLines(): string {
    return (
      this.events.map((event) => JSON.stringify(event)).join('\n') +
      (this.events.length > 0 ? '\n' : '')
    );
  }
}
