/**
 * Workbench Host process entry: constructs the default loopback Host server,
 * starts it, prints the resolved non-secret endpoint, and closes gracefully
 * on SIGINT/SIGTERM. LAN binding, TLS, and proxy header trust remain disabled
 * unless the Host listener config explicitly opts in; the default entry
 * passes no configuration, so it always runs loopback HTTP.
 *
 * Importing this module is side-effect free: the server only starts when the
 * file is executed directly (the emitted `start:host` target). Integration
 * tests import `startHostServer` instead.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostListenerHandle, HostServer, HostServerOptions } from './server.js';
import { createHostServer } from './server.js';

/** Resolved launch of a Host server: bind handle, endpoint, health path, close. */
export interface HostStartHandle {
  readonly server: HostServer;
  readonly handle: HostListenerHandle;
  /** Resolved non-secret HTTP endpoint, e.g. `http://127.0.0.1:8787`. */
  readonly endpoint: string;
  /** Health check path served by the running listener. */
  readonly healthPath: string;
  close(): Promise<void>;
}

/** Format the resolved listener address as a non-secret HTTP endpoint. */
function formatEndpoint(handle: HostListenerHandle): string {
  if (handle.mode === 'unix') {
    return typeof handle.address === 'string'
      ? `http+unix://${handle.address}`
      : 'http+unix://socket';
  }
  const host =
    handle.host.includes(':') && !handle.host.startsWith('[') ? `[${handle.host}]` : handle.host;
  return `http://${host}:${handle.port}`;
}

/**
 * Construct and start a Host server. Defaults to the listener's fail-closed
 * loopback HTTP config; LAN/TLS/proxy trust only activate through explicit
 * `options` opt-ins. Tests pass `{ port: 0 }` for an ephemeral loopback port.
 */
export async function startHostServer(options: HostServerOptions = {}): Promise<HostStartHandle> {
  const server = createHostServer(options);
  const handle = await server.start();
  return {
    server,
    handle,
    endpoint: formatEndpoint(handle),
    healthPath: server.endpoints().health.path,
    close: () => server.close(),
  };
}

async function main(): Promise<void> {
  const host = await startHostServer();
  console.log(`[workbench-host] listening on ${host.endpoint}`);
  console.log(`[workbench-host] health check: ${host.endpoint}${host.healthPath}`);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[workbench-host] ${signal} received; closing listener`);
    try {
      await host.close();
      process.exit(0);
    } catch (error) {
      console.error('[workbench-host] shutdown failed:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const isEntry =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  void main().catch((error) => {
    console.error('[workbench-host] failed to start:', error);
    process.exit(1);
  });
}
