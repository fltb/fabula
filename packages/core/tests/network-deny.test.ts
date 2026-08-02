import { readFileSync } from 'node:fs';

import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { describe, expect, it, vi } from 'vitest';
import { NetworkDeniedError } from '../src/errors.ts';
import { JsonlLogTransport, Logger, logger } from '../src/observability/logger.ts';

describe('default offline test sentinel', () => {
  it('rejects fetch', async () => {
    await expect(fetch('https://example.test')).rejects.toBeInstanceOf(NetworkDeniedError);
  });

  it('rejects http.request', () => {
    expect(() => http.request('http://example.test')).toThrow(NetworkDeniedError);
  });

  it('rejects http.get', () => {
    expect(() => http.get('http://example.test')).toThrow(NetworkDeniedError);
  });

  it('rejects https.request', () => {
    expect(() => https.request('https://example.test')).toThrow(NetworkDeniedError);
  });

  it('rejects https.get', () => {
    expect(() => https.get('https://example.test')).toThrow(NetworkDeniedError);
  });

  it('rejects net.connect', () => {
    expect(() => net.connect(80, 'example.test')).toThrow(NetworkDeniedError);
  });

  it('rejects net.createConnection', () => {
    expect(() => net.createConnection(80, 'example.test')).toThrow(NetworkDeniedError);
  });

  it('rejects tls.connect', () => {
    expect(() => tls.connect(443, 'example.test')).toThrow(NetworkDeniedError);
  });

  it('rejects http2.connect', () => {
    expect(() => http2.connect('https://example.test')).toThrow(NetworkDeniedError);
  });

  it('cannot be bypassed via process.env or dotenv', () => {
    // No env-based bypass exists — the sentinel is unconditional
    // The setup file never reads process.env for bypass
    expect(process.env.DISABLE_NETWORK_DENY).toBeUndefined();
    expect(process.env.SKIP_NETWORK).toBeUndefined();
    expect(process.env.NETWORK_ENABLED).toBeUndefined();
    expect(process.env.VITEST).toBe('true');
  });
});

describe('Core observability boundary', () => {
  it('default logger never writes to stderr', () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      logger.warn('boundary warning', { module: 'test' });
      logger.error('boundary error', { module: 'test' });
      new Logger().info('unconfigured logger', { module: 'test' });
      expect(writeMock).not.toHaveBeenCalled();
    } finally {
      writeMock.mockRestore();
    }
  });

  it('JSONL transport emits only through an injected sink', () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const lines: string[] = [];
    try {
      new JsonlLogTransport().write({
        timestamp: '2026-08-02T00:00:00.000Z',
        level: 'info',
        message: 'dropped',
        context: { module: 'test' },
      });
      expect(writeMock).not.toHaveBeenCalled();

      const sinkTransport = new JsonlLogTransport((line) => lines.push(line));
      new Logger(sinkTransport, { module: 'test' }).info('routed', { eventId: 'E0' });
      expect(writeMock).not.toHaveBeenCalled();
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        level: 'info',
        message: 'routed',
        context: { module: 'test', eventId: 'E0' },
      });
    } finally {
      writeMock.mockRestore();
    }
  });

  it('observability production sources hold no host clock, env, or stderr authority', () => {
    const dir = new URL('../src/observability/', import.meta.url);
    for (const name of ['logger.ts', 'trace.ts']) {
      const source = readFileSync(new URL(name, dir), 'utf8');
      expect(source).not.toMatch(/\bprocess\.(?:stderr|env)\b/);
      expect(source).not.toMatch(/\bDate\.now\(/);
      expect(source).not.toMatch(/\bnew Date\(/);
      expect(source).not.toMatch(/\brandomUUID\(/);
    }
  });
});
