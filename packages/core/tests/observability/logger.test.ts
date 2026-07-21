import { describe, expect, it } from 'vitest';
import { Logger, MemoryLogTransport } from '../../src/observability/logger.ts';

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
});
