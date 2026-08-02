import type { Clock } from '../ports/runtime-services.ts';

export interface LogContext {
  module: string;
  eventId?: string;
  jobId?: string;
  traceId?: string;
  spanId?: string;
  [key: string]: boolean | number | string | undefined;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: LogContext;
}

export interface LogTransport {
  write(entry: LogEntry): void;
}

const forbiddenField =
  /(?:api[_-]?key|authorization|credential|cookie|secret|token|prompt|prose|sceneBrief|reference)/i;
const permittedField =
  /^(?:module|eventId|jobId|traceId|spanId|durationMs|promptTokens|completionTokens|totalTokens|calls|attempts|cacheHit|model|version|hash|code|path|validator|category|entityId|attribute|severity|issueCount|phase|rejection)$/;

function sanitizeContext(context: LogContext): LogContext {
  const safe: LogContext = { module: context.module };
  for (const [key, value] of Object.entries(context)) {
    if (key === 'module' || value === undefined) continue;
    if (permittedField.test(key) && !forbiddenField.test(key)) safe[key] = value;
  }
  return safe;
}

export class MemoryLogTransport implements LogTransport {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

/**
 * Serializes entries as JSONL and forwards each line to an explicitly
 * injected sink. Core never chooses an output destination itself: the
 * default sink discards, and hosts that want emission (for example a
 * Node stderr writer in the node-host package) supply their own sink.
 */
export class JsonlLogTransport implements LogTransport {
  constructor(private readonly sink: (line: string) => void = () => {}) {}

  write(entry: LogEntry): void {
    this.sink(`${JSON.stringify(entry)}\n`);
  }
}

const LOG_LEVEL_ORDER: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Wraps another transport, dropping entries below minLevel. Used to keep
 *  normal (non---trace) runs quiet on the success path while still
 *  surfacing warnings/errors in real time. */
export class LevelFilterTransport implements LogTransport {
  constructor(
    private readonly inner: LogTransport,
    private readonly minLevel: LogLevel = 'warn',
  ) {}

  write(entry: LogEntry): void {
    if (LOG_LEVEL_ORDER.indexOf(entry.level) >= LOG_LEVEL_ORDER.indexOf(this.minLevel)) {
      this.inner.write(entry);
    }
  }
}

/**
 * Deterministic placeholder clock. Core never reads the host clock on
 * its own authority; hosts MUST inject a real Clock when wall-clock
 * timestamps are wanted. Without one, every entry carries this fixed
 * sentinel timestamp.
 */
const FALLBACK_CLOCK: Clock = { now: () => '1970-01-01T00:00:00.000Z' };

export class Logger {
  private readonly transport: LogTransport;
  private readonly context: LogContext;
  private readonly clock: Clock;

  constructor(
    transport?: LogTransport,
    context: LogContext = { module: 'core' },
    clock?: Clock,
  ) {
    // Default transport is non-emitting: logging only happens where a
    // host explicitly injects one.
    this.transport = transport ?? new JsonlLogTransport();
    this.context = context;
    this.clock = clock ?? FALLBACK_CLOCK;
  }

  child(context: Partial<LogContext>): Logger {
    return new Logger(this.transport, sanitizeContext({ ...this.context, ...context }), this.clock);
  }

  debug(message: string, context: Partial<LogContext> = {}): void {
    this.write('debug', message, context);
  }
  info(message: string, context: Partial<LogContext> = {}): void {
    this.write('info', message, context);
  }
  warn(message: string, context: Partial<LogContext> = {}): void {
    this.write('warn', message, context);
  }
  error(message: string, context: Partial<LogContext> = {}): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context: Partial<LogContext>): void {
    this.transport.write({
      timestamp: this.clock.now(),
      level,
      message,
      context: sanitizeContext({ ...this.context, ...context }),
    });
  }
}

/**
 * Default non-emitting logger. Core never writes to host stderr on its
 * own authority; hosts attach a transport (or an injected sink) when
 * logs should reach a destination.
 */
export const logger = new Logger();
