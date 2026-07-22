import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Logger, MemoryLogTransport, JsonlLogTransport } from '../../src/observability/logger.ts';

describe('Logger', () => {
  it('emits only whitelisted safe context fields', () => {
    const transport = new MemoryLogTransport();
    const logger = new Logger(transport, { module: 'pipeline', eventId: 'E0' });
    logger.info('rendered', {
      cacheHit: true,
      durationMs: 12,
      prose: 'do not log',
      prompt: 'do not log',
      apiKey: 'do not log',
    });

    expect(transport.entries).toHaveLength(1);
    expect(transport.entries[0]).toMatchObject({ level: 'info', context: { module: 'pipeline', eventId: 'E0', cacheHit: true, durationMs: 12 } });
    expect(JSON.stringify(transport.entries[0])).not.toContain('do not log');
  });

  it('filters out all forbidden context fields even with permitted-like names', () => {
    const transport = new MemoryLogTransport();
    const logger = new Logger(transport, { module: 'test' });
    logger.info('test', {
      secretKey: 'should be filtered',
      authorization: 'should be filtered',
      cookie: 'should be filtered',
      token: 'should be filtered',
      durationMs: 42,
      spanId: 'abc',
      validator: 'reachability',
    });

    expect(transport.entries).toHaveLength(1);
    const ctx = transport.entries[0].context;
    expect(ctx.durationMs).toBe(42);
    expect(ctx.spanId).toBe('abc');
    expect(ctx.validator).toBe('reachability');
    expect(Object.keys(ctx)).not.toContain('secretKey');
    expect(Object.keys(ctx)).not.toContain('authorization');
    expect(Object.keys(ctx)).not.toContain('cookie');
    expect(Object.keys(ctx)).not.toContain('token');
  });

  it('omits undefined context values', () => {
    const transport = new MemoryLogTransport();
    const logger = new Logger(transport, { module: 'test' });
    logger.info('test', { eventId: undefined, durationMs: 10 });

    expect(transport.entries).toHaveLength(1);
    expect(Object.keys(transport.entries[0].context)).not.toContain('eventId');
    expect(transport.entries[0].context.durationMs).toBe(10);
  });

  it('always includes module in context', () => {
    const transport = new MemoryLogTransport();
    const logger = new Logger(transport, { module: 'pipeline' });
    logger.warn('something happened');

    expect(transport.entries).toHaveLength(1);
    expect(transport.entries[0].context.module).toBe('pipeline');
  });

  describe('log level filtering', () => {
    it('defaults module to core', () => {
      const transport = new MemoryLogTransport();
      const logger = new Logger(transport);
      logger.info('test');
      expect(transport.entries[0].context.module).toBe('core');
    });

    it('writes debug log entries', () => {
      const transport = new MemoryLogTransport();
      const logger = new Logger(transport, { module: 'test' });
      logger.debug('debug message', { durationMs: 1 });
      expect(transport.entries).toHaveLength(1);
      expect(transport.entries[0].level).toBe('debug');
    });

    it('writes info log entries', () => {
      const transport = new MemoryLogTransport();
      const logger = new Logger(transport, { module: 'test' });
      logger.info('info message');
      expect(transport.entries[0].level).toBe('info');
    });

    it('writes warn log entries', () => {
      const transport = new MemoryLogTransport();
      const logger = new Logger(transport, { module: 'test' });
      logger.warn('warn message');
      expect(transport.entries[0].level).toBe('warn');
    });

    it('writes error log entries', () => {
      const transport = new MemoryLogTransport();
      const logger = new Logger(transport, { module: 'test' });
      logger.error('error message');
      expect(transport.entries[0].level).toBe('error');
    });

    it('preserves message text', () => {
      const transport = new MemoryLogTransport();
      const logger = new Logger(transport, { module: 'test' });
      logger.info('hello world');
      expect(transport.entries[0].message).toBe('hello world');
    });

    it('includes timestamp', () => {
      const transport = new MemoryLogTransport();
      const logger = new Logger(transport, { module: 'test' });
      logger.info('test');
      expect(transport.entries[0].timestamp).toBeDefined();
      expect(() => new Date(transport.entries[0].timestamp)).not.toThrow();
    });
  });

  describe('child logger context inheritance', () => {
    it('inherits parent context', () => {
      const transport = new MemoryLogTransport();
      const parent = new Logger(transport, { module: 'pipeline', jobId: 'abc' });
      const child = parent.child({ eventId: 'E0' });
      child.info('test');

      expect(transport.entries).toHaveLength(1);
      expect(transport.entries[0].context).toMatchObject({
        module: 'pipeline',
        jobId: 'abc',
        eventId: 'E0',
      });
    });

    it('child overrides parent context fields', () => {
      const transport = new MemoryLogTransport();
      const parent = new Logger(transport, { module: 'pipeline', eventId: 'E0' });
      const child = parent.child({ eventId: 'E1' });
      child.info('test');

      expect(transport.entries[0].context.eventId).toBe('E1');
      expect(transport.entries[0].context.module).toBe('pipeline');
    });

    it('child sanitizes its own context additions', () => {
      const transport = new MemoryLogTransport();
      const parent = new Logger(transport, { module: 'pipeline' });
      const child = parent.child({ secret: 'should be filtered', durationMs: 5 });
      child.info('test');

      expect(transport.entries[0].context.durationMs).toBe(5);
      expect(Object.keys(transport.entries[0].context)).not.toContain('secret');
    });

    it('child sanitizes inherited forbidden fields from parent', () => {
      const transport = new MemoryLogTransport();
      // forbidden fields should not leak through child creation
      const parent = new Logger(transport, { module: 'pipeline', token: 'test', prompt: 'test' });
      const child = parent.child({ eventId: 'E0' });
      child.info('test');

      expect(Object.keys(transport.entries[0].context)).not.toContain('token');
      expect(Object.keys(transport.entries[0].context)).not.toContain('prompt');
      expect(transport.entries[0].context.eventId).toBe('E0');
    });
  });

  describe('transport switching', () => {
    it('MemoryLogTransport accumulates entries', () => {
      const transport = new MemoryLogTransport();
      const logger = new Logger(transport, { module: 'test' });
      logger.info('one');
      logger.info('two');
      expect(transport.entries).toHaveLength(2);
      expect(transport.entries[0].message).toBe('one');
      expect(transport.entries[1].message).toBe('two');
    });

    it('MemoryLogTransport entries are mutable', () => {
      const transport = new MemoryLogTransport();
      const logger = new Logger(transport, { module: 'test' });
      logger.info('test');
      transport.entries[0].context.durationMs = 100;
      expect(transport.entries[0].context.durationMs).toBe(100);
    });

    it('JsonlLogTransport writes JSON to stderr', () => {
      const writeMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const transport = new JsonlLogTransport();
      const logger = new Logger(transport, { module: 'test' });
      logger.info('jsonl test', { eventId: 'E0' });

      expect(writeMock).toHaveBeenCalledTimes(1);
      const output = writeMock.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.level).toBe('info');
      expect(parsed.message).toBe('jsonl test');
      expect(parsed.context.module).toBe('test');
      expect(parsed.context.eventId).toBe('E0');

      writeMock.mockRestore();
    });

    it('JsonlLogTransport writes newline-terminated JSON', () => {
      const writeMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const transport = new JsonlLogTransport();
      const logger = new Logger(transport, { module: 'test' });
      logger.info('line');
      const output = writeMock.mock.calls[0][0] as string;
      expect(output.endsWith('\n')).toBe(true);
      writeMock.mockRestore();
    });

    it('different transports are independent', () => {
      const transportA = new MemoryLogTransport();
      const transportB = new MemoryLogTransport();
      const loggerA = new Logger(transportA, { module: 'a' });
      const loggerB = new Logger(transportB, { module: 'b' });

      loggerA.info('from a');
      loggerB.info('from b');

      expect(transportA.entries).toHaveLength(1);
      expect(transportB.entries).toHaveLength(1);
      expect(transportA.entries[0].context.module).toBe('a');
      expect(transportB.entries[0].context.module).toBe('b');
    });

    it('transport can be swapped at construction', () => {
      const memTransport = new MemoryLogTransport();
      const jsonTransport = new JsonlLogTransport();
      const writeMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const memLogger = new Logger(memTransport, { module: 'mem' });
      memLogger.info('mem');

      const jsonLogger = new Logger(jsonTransport, { module: 'json' });
      jsonLogger.info('json');

      expect(memTransport.entries).toHaveLength(1);
      expect(memTransport.entries[0].message).toBe('mem');
      expect(writeMock).toHaveBeenCalledTimes(1);

      writeMock.mockRestore();
    });
  });

  describe('error handling', () => {
    it('handles empty context gracefully', () => {
      const transport = new MemoryLogTransport();
      const logger = new Logger(transport, { module: 'test' });
      expect(() => logger.info('empty')).not.toThrow();
      expect(transport.entries).toHaveLength(1);
    });

    it('handles empty message gracefully', () => {
      const transport = new MemoryLogTransport();
      const logger = new Logger(transport, { module: 'test' });
      expect(() => logger.warn('')).not.toThrow();
      expect(transport.entries[0].message).toBe('');
    });

    it('handles lots of context fields', () => {
      const transport = new MemoryLogTransport();
      const logger = new Logger(transport, { module: 'test' });
      const bigCtx: Record<string, string | number | boolean> = {};
      for (let i = 0; i < 100; i++) bigCtx[`field${i}`] = i;
      expect(() => logger.info('big', bigCtx)).not.toThrow();
    });
  });
});
