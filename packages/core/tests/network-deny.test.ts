import { describe, expect, it } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import http2 from 'node:http2';
import { NetworkDeniedError } from '../src/errors.ts';

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
