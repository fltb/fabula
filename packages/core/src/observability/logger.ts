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

export class JsonlLogTransport implements LogTransport {
  write(entry: LogEntry): void {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
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

export class Logger {
  constructor(
    private readonly transport: LogTransport = new JsonlLogTransport(),
    private readonly context: LogContext = { module: 'core' },
  ) {}

  child(context: Partial<LogContext>): Logger {
    return new Logger(this.transport, sanitizeContext({ ...this.context, ...context }));
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
      timestamp: new Date().toISOString(),
      level,
      message,
      context: sanitizeContext({ ...this.context, ...context }),
    });
  }
}

export const logger = new Logger();
