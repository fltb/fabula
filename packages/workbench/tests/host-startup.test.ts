import { afterEach, describe, expect, it } from 'vitest';
import type { HostStartHandle } from '../src/host/main.js';
import { startHostServer } from '../src/host/main.js';

const open: HostStartHandle[] = [];

const track = (host: HostStartHandle): HostStartHandle => {
  open.push(host);
  return host;
};

afterEach(async () => {
  await Promise.all(open.splice(0).map((host) => host.close()));
});

describe('Host process startup', () => {
  it('starts the default loopback listener on an ephemeral port and serves health', async () => {
    const host = track(await startHostServer({ port: 0 }));

    expect(host.handle.mode).toBe('loopback');
    expect(host.handle.host).toBe('127.0.0.1');
    expect(host.handle.port).toBeGreaterThan(0);
    expect(host.healthPath).toBe('/health');
    expect(host.endpoint).toBe(`http://127.0.0.1:${host.handle.port}`);

    expect(host.server.status()).toMatchObject({
      running: true,
      mode: 'loopback',
      host: '127.0.0.1',
      lan: false,
      tls: false,
      trustForwardedHeaders: false,
    });

    const res = await host.server.app.request(host.healthPath);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ok',
      listener: { running: true, mode: 'loopback' },
      protocol: { protocol: 'http', source: 'socket', trustForwardedHeaders: false },
    });
  });

  it('closes cleanly and idempotently', async () => {
    const host = track(await startHostServer({ port: 0 }));
    await host.close();
    expect(host.server.status().running).toBe(false);
    await expect(host.close()).resolves.toBeUndefined();
  });
});
