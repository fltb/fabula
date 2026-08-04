/**
 * Workbench Host process entry. Human-readable diagnostics stay on stdout/stderr;
 * the inherited descriptor 3 is a private, versioned control stream for
 * supervisors. Importing this module remains side-effect free.
 */

import { createReadStream, fstatSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import {
  HOST_CONTROL_MAX_FRAME_BYTES,
  HOST_PROTOCOL_VERSION_V1,
  type HostBuildIdentityV1,
  type HostControlFrameV1,
  type HostShutdownMessageV1,
  type HostStoppedMessageV1,
} from '@novalistically/workbench-protocol';
import type { HostListenerHandle, HostServer, HostServerOptions } from './server.js';
import { createHostServer } from './server.js';
import {
  parseWorkbenchLaunchConfig,
  startWorkbench,
  type WorkbenchLaunchHandle,
} from './workbench-launch.js';

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

/** Format a listener address without placing a local Unix path in a payload. */
function formatEndpoint(handle: HostListenerHandle): string {
  if (handle.mode === 'unix') return 'http+unix://socket';
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

type ShutdownHandler = (frame: HostShutdownMessageV1) => void;
type FatalHandler = (code: string, message: string) => void;

/**
 * Strict incremental parser for the supervisor-to-child half of the control
 * stream. The shared union describes both directions, so this parser performs
 * the direction check explicitly rather than accepting any union member.
 */
class HostControlParser {
  #buffer = Buffer.alloc(0);
  #decoder = new TextDecoder('utf-8', { fatal: true });
  #failed = false;
  readonly #onShutdown: ShutdownHandler;
  readonly #onFatal: FatalHandler;

  constructor(onShutdown: ShutdownHandler, onFatal: FatalHandler) {
    this.#onShutdown = onShutdown;
    this.#onFatal = onFatal;
  }

  push(chunk: Uint8Array): void {
    if (this.#failed || chunk.byteLength === 0) return;
    if (
      this.#buffer.indexOf(0x0a) < 0 &&
      chunk.indexOf(0x0a) < 0 &&
      this.#buffer.byteLength + chunk.byteLength >= HOST_CONTROL_MAX_FRAME_BYTES
    ) {
      this.#fail('CONTROL_FRAME_OVERSIZED', 'control frame exceeds the 64-KiB limit');
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.byteLength >= HOST_CONTROL_MAX_FRAME_BYTES) {
          this.#fail('CONTROL_FRAME_OVERSIZED', 'control frame exceeds the 64-KiB limit');
        }
        return;
      }
      const frameBytes = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (frameBytes.byteLength + 1 > HOST_CONTROL_MAX_FRAME_BYTES) {
        this.#fail('CONTROL_FRAME_OVERSIZED', 'control frame exceeds the 64-KiB limit');
        return;
      }
      let text: string;
      try {
        text = this.#decoder.decode(frameBytes);
      } catch {
        this.#fail('CONTROL_FRAME_MALFORMED', 'control frame is not valid UTF-8');
        return;
      }
      if (text.trim().length === 0) {
        this.#fail('CONTROL_FRAME_MALFORMED', 'control frame is empty');
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        this.#fail('CONTROL_FRAME_MALFORMED', 'control frame is not valid JSON');
        return;
      }
      this.#dispatch(value);
      if (this.#failed) return;
    }
  }

  finish(): void {
    if (this.#failed || this.#buffer.byteLength === 0) return;
    this.#fail('CONTROL_FRAME_MALFORMED', 'control stream ended with a partial frame');
  }

  #dispatch(value: unknown): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.#fail('CONTROL_FRAME_MALFORMED', 'control frame must be a JSON object');
      return;
    }
    const version = 'version' in value ? value.version : undefined;
    if (version !== HOST_PROTOCOL_VERSION_V1) {
      this.#fail('CONTROL_VERSION_UNSUPPORTED', 'unsupported control protocol version');
      return;
    }
    const type = 'type' in value ? value.type : undefined;
    if (type !== 'shutdown') {
      if (type === 'ready' || type === 'stopped' || type === 'fatal') {
        this.#fail('CONTROL_DIRECTION_INVALID', 'child-to-supervisor frame received on input');
      } else {
        this.#fail('CONTROL_TYPE_UNKNOWN', 'unknown control frame type');
      }
      return;
    }
    const keys = Object.keys(value).sort();
    const requestId = 'requestId' in value ? value.requestId : undefined;
    const deadlineMs = 'deadlineMs' in value ? value.deadlineMs : undefined;
    if (
      keys.length !== 4 ||
      keys[0] !== 'deadlineMs' ||
      keys[1] !== 'requestId' ||
      keys[2] !== 'type' ||
      keys[3] !== 'version' ||
      typeof requestId !== 'string' ||
      requestId.length === 0 ||
      requestId.length > 256 ||
      typeof deadlineMs !== 'number' ||
      !Number.isFinite(deadlineMs) ||
      !Number.isInteger(deadlineMs) ||
      deadlineMs < 0
    ) {
      this.#fail('CONTROL_FRAME_MALFORMED', 'shutdown frame fields are invalid');
      return;
    }
    this.#onShutdown({
      version: HOST_PROTOCOL_VERSION_V1,
      type: 'shutdown',
      requestId,
      deadlineMs,
    });
  }

  #fail(code: string, message: string): void {
    this.#failed = true;
    this.#onFatal(code, message);
  }
}

async function verifyHostHealth(
  endpoint: string,
  healthPath: string,
  running: boolean,
): Promise<void> {
  if (endpoint.startsWith('http+unix://')) {
    if (!running) throw new Error('Host listener is not running');
    return;
  }
  const response = await fetch(`${endpoint}${healthPath}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Host health returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    !('status' in payload) ||
    payload.status !== 'ok'
  ) {
    throw new Error('Host health payload is not ready');
  }
}

function hasControlFd3(): boolean {
  if (process.env.WORKBENCH_CONTROL_FD3 === 'disabled') return false;
  try {
    fstatSync(3);
    return true;
  } catch {
    return false;
  }
}

function sendControlFrame(frame: HostControlFrameV1): void {
  if (!hasControlFd3()) return;
  try {
    writeSync(3, Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8'));
  } catch {
    // A lost supervisor is handled by the read-side EOF path; never turn a
    // broken control pipe into an unhandled exception in the Host.
  }
}

function buildIdentity(): HostBuildIdentityV1 {
  const raw = process.env.WORKBENCH_BUILD_ID;
  const buildId = raw !== undefined && /^[A-Za-z0-9._-]{1,128}$/.test(raw) ? raw : 'development';
  return {
    version: 1,
    packageId: '@novalistically/workbench',
    buildId,
    protocolVersion: HOST_PROTOCOL_VERSION_V1,
  };
}

function deadlineDuration(deadlineMs: number | undefined): number {
  if (deadlineMs === undefined) return 5_000;
  return Math.min(Math.max(deadlineMs, 1), 30_000);
}

async function closeWithDeadline(
  close: () => Promise<void>,
  deadlineMs?: number,
): Promise<boolean> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, deadlineDuration(deadlineMs));
      }),
    ]);
  } catch (error) {
    console.error('[workbench-host] shutdown failed:', error);
  } finally {
    clearTimeout(timer);
  }
  return timedOut;
}

async function main(): Promise<void> {
  const mode = process.env.WORKBENCH_MODE;
  if (mode !== 'listener' && mode !== 'workbench') {
    throw new Error(
      'Set WORKBENCH_MODE=workbench for Workbench or WORKBENCH_MODE=listener for smoke mode',
    );
  }
  let runtime: HostStartHandle | WorkbenchLaunchHandle | undefined;
  let healthPath = '/health';
  let bootstrapRequired = false;
  try {
    if (mode === 'listener') {
      runtime = await startHostServer();
      healthPath = runtime.healthPath;
    } else {
      const config = parseWorkbenchLaunchConfig();
      healthPath = config.healthPath ?? '/health';
      runtime = await startWorkbench(config);
      bootstrapRequired = runtime.projectId === null;
    }
    await verifyHostHealth(
      runtime.endpoint,
      healthPath,
      'server' in runtime ? runtime.server.status().running : runtime.host.status().running,
    );
  } catch (error) {
    sendControlFrame({
      version: 1,
      type: 'fatal',
      code: 'HOST_START_FAILED',
      message: 'Host failed to start or pass its health check',
    });
    if (runtime !== undefined) await runtime.close().catch(() => undefined);
    throw error;
  }
  if (runtime === undefined) throw new Error('Host runtime was not created');
  const activeRuntime = runtime;

  const controlAvailable = hasControlFd3();
  let shuttingDown = false;
  let shutdownRequestId: string | null = null;
  let shutdownTask: Promise<HostStoppedMessageV1> | null = null;
  let terminalStopped: HostStoppedMessageV1 | null = null;
  let fatalSent = false;

  const closeRuntime = (
    requestId: string,
    reason: string,
    deadlineMs?: number,
  ): Promise<HostStoppedMessageV1> => {
    if (terminalStopped !== null) return Promise.resolve(terminalStopped);
    if (shutdownTask !== null) return shutdownTask;
    shuttingDown = true;
    shutdownRequestId = requestId;
    shutdownTask = closeWithDeadline(activeRuntime.close, deadlineMs).then((timedOut) => {
      terminalStopped = {
        version: 1,
        type: 'stopped',
        requestId,
        reason: timedOut ? 'shutdown-timeout' : reason,
      };
      return terminalStopped;
    });
    return shutdownTask;
  };

  const shutdown = (requestId: string, reason: string, deadlineMs?: number): void => {
    if (terminalStopped !== null) {
      if (terminalStopped.requestId === requestId) sendControlFrame(terminalStopped);
      return;
    }
    if (shutdownRequestId !== null) {
      // The first request wins. A repeated ID is replayed after the original
      // drain; a different ID is intentionally ignored.
      if (shutdownRequestId === requestId && shutdownTask !== null) {
        void shutdownTask.then(sendControlFrame);
      }
      return;
    }
    void closeRuntime(requestId, reason, deadlineMs).then((stopped) => {
      sendControlFrame(stopped);
      process.exitCode = stopped.reason === 'shutdown-timeout' ? 1 : 0;
      setImmediate(() => process.exit());
    });
  };

  const protocolFatal: FatalHandler = (code, message) => {
    if (fatalSent) return;
    fatalSent = true;
    sendControlFrame({ version: 1, type: 'fatal', code, message });
    void closeWithDeadline(activeRuntime.close).finally(() => {
      process.exitCode = 1;
      process.exit();
    });
  };

  if (controlAvailable) {
    const parser = new HostControlParser(
      (frame) => shutdown(frame.requestId, 'shutdown', frame.deadlineMs),
      protocolFatal,
    );
    const control = createReadStream('/dev/null', { fd: 3, autoClose: false });
    control.on('data', (chunk: Buffer) => parser.push(chunk));
    control.on('end', () => {
      parser.finish();
      if (!shuttingDown && !fatalSent) shutdown('control-eof', 'control-eof');
    });
    control.on('error', () => {
      if (!shuttingDown && !fatalSent) shutdown('control-eof', 'control-eof');
    });
  }

  const endpoint = activeRuntime.endpoint;
  const controlEndpoint = endpoint.startsWith('http+unix://') ? 'http+unix://socket' : endpoint;
  console.log(`[workbench-host] ${mode} listening on ${endpoint}`);
  if (mode === 'workbench') console.log(`[workbench-host] browser: ${endpoint}/`);
  sendControlFrame({
    version: 1,
    type: 'ready',
    endpoint: controlEndpoint,
    build: buildIdentity(),
    pid: process.pid,
    listenerMode: mode,
    bootstrapRequired,
  });

  const onSignal = (signal: NodeJS.Signals): void => {
    if (!shuttingDown && !fatalSent) shutdown(`signal:${signal}`, signal);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

const isEntry =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  void main().catch((error) => {
    console.error('[workbench-host] failed to start:', error);
    process.exitCode = 1;
  });
}
