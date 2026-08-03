/**
 * Workbench Host supervisor: spawns the Host child process, manages the fd3
 * control frame protocol, and provides bounded shutdown and restart.
 *
 * Human-readable diagnostics go to stderr. The control channel is always the
 * inherited descriptor 3 and carries only versioned newline-delimited JSON
 * frames capped at 64 KiB. Keeping the protocol on fd3 means stdout/stderr
 * remain ordinary diagnostic streams and no pathname-based side channel can
 * leak Host state.
 */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  HOST_PROTOCOL_VERSION_V1,
  HOST_CONTROL_MAX_FRAME_BYTES,
  type HostBuildIdentityV1,
  type HostControlFrameV1,
  type HostReadyMessageV1,
  type HostFatalMessageV1,
  type HostStoppedMessageV1,
} from '@novalistically/workbench-protocol';

import type { HostLaunchDescriptorV1 } from './launch-descriptor.js';

// --- Types ------------------------------------------------------------------

export interface HostSupervisorOptions {
  readonly descriptor: HostLaunchDescriptorV1;
  /** Extra environment variables passed to the child. */
  readonly env?: Record<string, string>;
  /** Bound before a child must emit its `ready` frame. */
  readonly startupTimeoutMs?: number;
  /** Bound for SIGTERM -> SIGKILL escalation after protocol shutdown. */
  readonly terminationGraceMs?: number;
}

export type HostSupervisorState =
  | 'idle'
  | 'spawning'
  | 'ready'
  | 'shutting-down'
  | 'stopped'
  | 'fatal';

export interface HostReadyEvent {
  readonly endpoint: string;
  readonly build: HostBuildIdentityV1;
  readonly pid: number;
  readonly listenerMode: 'listener' | 'workbench';
  readonly bootstrapRequired: boolean;
}

export interface HostFatalEvent {
  readonly code: string;
  readonly message: string;
}

export interface HostStoppedEvent {
  readonly requestId: string;
  readonly reason: string;
}

// --- Control frame parser (supervisor direction) ----------------------------

type SupervisorFrameHandler = {
  onReady: (frame: HostReadyMessageV1) => void;
  onFatal: (frame: HostFatalMessageV1) => void;
  onStopped: (frame: HostStoppedMessageV1) => void;
};

type ParserErrorHandler = (code: string, message: string) => void;

/**
 * Strict incremental parser for the child-to-supervisor direction of the
 * control stream. Accepts `ready`, `fatal`, and `stopped`; rejects `shutdown`
 * (wrong direction) and any malformed or oversized frame.
 */
class SupervisorControlParser {
  #buffer = Buffer.alloc(0);
  #decoder = new TextDecoder('utf-8', { fatal: true });
  #failed = false;
  readonly #handlers: SupervisorFrameHandler;
  readonly #onError: ParserErrorHandler;

  constructor(handlers: SupervisorFrameHandler, onError: ParserErrorHandler) {
    this.#handlers = handlers;
    this.#onError = onError;
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
    const version = (value as Record<string, unknown>).version;
    if (version !== HOST_PROTOCOL_VERSION_V1) {
      this.#fail('CONTROL_VERSION_UNSUPPORTED', 'unsupported control protocol version');
      return;
    }
    const type = (value as Record<string, unknown>).type;
    switch (type) {
      case 'ready': {
        const frame = value as HostReadyMessageV1;
        const build = frame.build;
        const buildKeys =
          typeof build === 'object' && build !== null && !Array.isArray(build)
            ? Object.keys(build).sort().join(',')
            : '';
        if (
          Object.keys(value).sort().join(',') !==
            'bootstrapRequired,build,endpoint,listenerMode,pid,type,version' ||
          typeof frame.endpoint !== 'string' ||
          frame.endpoint.length === 0 ||
          typeof build !== 'object' ||
          build === null ||
          Array.isArray(build) ||
          buildKeys !== 'buildId,packageId,protocolVersion,version' ||
          (build as unknown as Record<string, unknown>).version !== 1 ||
          typeof (build as unknown as Record<string, unknown>).packageId !== 'string' ||
          frame.build.packageId.length === 0 ||
          frame.build.packageId.length > 256 ||
          typeof (build as unknown as Record<string, unknown>).buildId !== 'string' ||
          !/^[A-Za-z0-9._-]{1,128}$/.test(frame.build.buildId) ||
          (build as unknown as Record<string, unknown>).protocolVersion !== HOST_PROTOCOL_VERSION_V1 ||
          typeof frame.pid !== 'number' ||
          !Number.isInteger(frame.pid) ||
          frame.pid < 1 ||
          (frame.listenerMode !== 'listener' && frame.listenerMode !== 'workbench') ||
          typeof frame.bootstrapRequired !== 'boolean'
        ) {
          this.#fail('CONTROL_FRAME_MALFORMED', 'ready frame fields are invalid');
          return;
        }
        this.#handlers.onReady(frame);
        return;
      }
      case 'fatal': {
        const frame = value as HostFatalMessageV1;
        if (
          Object.keys(value).sort().join(',') !== 'code,message,type,version' ||
          !/^[A-Za-z0-9._-]{1,128}$/.test(frame.code) ||
          typeof frame.message !== 'string' ||
          frame.message.length === 0 ||
          frame.message.length > 2048
        ) {
          this.#fail('CONTROL_FRAME_MALFORMED', 'fatal frame fields are invalid');
          return;
        }
        this.#handlers.onFatal(frame);
        return;
      }
      case 'stopped': {
        const frame = value as HostStoppedMessageV1;
        if (
          Object.keys(value).sort().join(',') !== 'reason,requestId,type,version' ||
          typeof frame.requestId !== 'string' ||
          frame.requestId.length === 0 ||
          frame.requestId.length > 256 ||
          typeof frame.reason !== 'string' ||
          frame.reason.length === 0 ||
          frame.reason.length > 256
        ) {
          this.#fail('CONTROL_FRAME_MALFORMED', 'stopped frame fields are invalid');
          return;
        }
        this.#handlers.onStopped(frame);
        return;
      }
      case 'shutdown':
        this.#fail('CONTROL_DIRECTION_INVALID', 'supervisor-to-child frame received on control input');
        return;
      default:
        this.#fail('CONTROL_TYPE_UNKNOWN', `unknown control frame type: ${type}`);
    }
  }

  #fail(code: string, message: string): void {
    this.#failed = true;
    this.#onError(code, message);
  }
}

export class HostSupervisor {
  readonly #descriptor: HostLaunchDescriptorV1;
  readonly #mode: 'workbench' | 'listener';
  readonly #dev: boolean;
  readonly #extraEnv: Record<string, string>;
  readonly #startupTimeoutMs: number;
  readonly #terminationGraceMs: number;
  #child: ChildProcess | null = null;
  #control: Duplex | null = null;
  #state: HostSupervisorState = 'idle';
  #parser: SupervisorControlParser | null = null;
  #readyPromise: Promise<HostReadyEvent> | null = null;
  #readyResolve: ((event: HostReadyEvent) => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #stoppedPromise: Promise<HostStoppedEvent> | null = null;
  #stoppedResolve: ((event: HostStoppedEvent) => void) | null = null;
  #fatal: HostFatalEvent | null = null;
  #exitCode: number | null = null;
  #exitSignal: string | null = null;

  constructor(options: HostSupervisorOptions) {
    this.#descriptor = options.descriptor;
    this.#mode = this.#descriptor.mode;
    this.#dev = this.#descriptor.dev;
    this.#extraEnv = { ...options.env };
    this.#startupTimeoutMs = Math.min(Math.max(options.startupTimeoutMs ?? 15_000, 100), 120_000);
    this.#terminationGraceMs = Math.min(Math.max(options.terminationGraceMs ?? 3_000, 100), 30_000);
  }

  get state(): HostSupervisorState {
    return this.#state;
  }
  get descriptor(): HostLaunchDescriptorV1 {
    return this.#descriptor;
  }

  get child(): ChildProcess | null {
    return this.#child;
  }

  get fatal(): HostFatalEvent | null {
    return this.#fatal;
  }

  get exitCode(): number | null {
    return this.#exitCode;
  }

  get exitSignal(): string | null {
    return this.#exitSignal;
  }

  /** Wait for the child to signal readiness. Rejects on fatal or pre-ready exit. */
  async ready(): Promise<HostReadyEvent> {
    if (this.#readyPromise !== null) return this.#readyPromise;
    throw new Error('HostSupervisor has not been started');
  }

  /**
   * Start the Host child process. Returns a promise that resolves once the
   * child signals readiness over the control channel.
   */
  async start(): Promise<HostReadyEvent> {
    if (this.#state !== 'idle') {
      throw new Error(`Cannot start from state: ${this.#state}`);
    }
    this.#state = 'spawning';
    this.#fatal = null;

    const readyPromise = new Promise<HostReadyEvent>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    this.#readyPromise = readyPromise;

    const childEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...this.#extraEnv,
      WORKBENCH_MODE: this.#mode,
      WORKBENCH_DEV: this.#dev ? 'true' : 'false',
      WORKBENCH_CONTROL_FD3: '3',
    };

    const child = spawn(
      this.#descriptor.paths.nodePath,
      [this.#descriptor.paths.hostEntry],
      {
        cwd: resolve(this.#descriptor.paths.hostEntry, '..', '..', '..'),
        env: childEnv,
        // fd3 is a bidirectional pipe: child writes ready/fatal/stopped and
        // reads shutdown. Stdout/stderr remain ordinary diagnostics.
        stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
      },
    );
    this.#child = child;
    const control = child.stdio[3] as Duplex | null | undefined;
    if (control === null || control === undefined) {
      this.#state = 'fatal';
      const error = new Error('Host child did not expose control descriptor 3');
      this.#readyReject?.(error);
      child.kill('SIGKILL');
      return readyPromise;
    }
    this.#control = control;

    let startupTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      if (this.#state !== 'spawning') return;
      this.#state = 'fatal';
      const error = new Error(`Host child did not signal ready within ${this.#startupTimeoutMs}ms`);
      this.#fatal = { code: 'HOST_START_TIMEOUT', message: error.message };
      this.#readyReject?.(error);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (this.#child === child && !child.killed) child.kill('SIGKILL');
      }, this.#terminationGraceMs).unref();
    }, this.#startupTimeoutMs);

    const failProtocol = (code: string, message: string): void => {
      console.error(`[workbench-supervisor] control protocol error: ${code}: ${message}`);
      this.#fatal = { code, message };
      if (this.#state === 'spawning') {
        this.#state = 'fatal';
        this.#readyReject?.(new Error(`Control protocol error: ${code}: ${message}`));
      } else if (this.#state !== 'shutting-down' && this.#state !== 'stopped') {
        this.#state = 'fatal';
      }
    };

    this.#parser = new SupervisorControlParser(
      {
        onReady: (frame) => {
          if (this.#state !== 'spawning') return;
          if (
            frame.build.packageId !== this.#descriptor.build.packageId ||
            frame.build.buildId !== this.#descriptor.build.buildId ||
            frame.build.protocolVersion !== this.#descriptor.build.protocolVersion
          ) {
            failProtocol('HOST_BUILD_MISMATCH', 'Host ready frame does not match launch descriptor');
            return;
          }
          clearTimeout(startupTimer);
          startupTimer = undefined;
          this.#state = 'ready';
          this.#readyResolve?.({
            endpoint: frame.endpoint,
            build: frame.build,
            pid: frame.pid,
            listenerMode: frame.listenerMode,
            bootstrapRequired: frame.bootstrapRequired,
          });
        },
        onFatal: (frame) => {
          this.#fatal = { code: frame.code, message: frame.message };
          if (this.#state === 'spawning') {
            clearTimeout(startupTimer);
            startupTimer = undefined;
            this.#state = 'fatal';
            this.#readyReject?.(new Error(`Host fatal: ${frame.code}: ${frame.message}`));
          } else {
            this.#state = 'fatal';
          }
        },
        onStopped: (frame) => {
          this.#state = 'stopped';
          this.#stoppedResolve?.({
            requestId: frame.requestId,
            reason: frame.reason,
          });
        },
      },
      failProtocol,
    );

    control.on('data', (chunk: Buffer) => {
      this.#parser?.push(chunk);
    });
    control.on('end', () => {
      this.#parser?.finish();
      if (this.#state === 'spawning') {
        clearTimeout(startupTimer);
        startupTimer = undefined;
        this.#failWithPreReadyExit(this.#exitCode, this.#exitSignal);
      }
    });
    control.on('error', (error) => {
      if (this.#state === 'spawning') failProtocol('CONTROL_IO_ERROR', error.message);
    });
    child.on('error', (error) => {
      if (this.#child !== child) return;
      clearTimeout(startupTimer);
      startupTimer = undefined;
      if (this.#state === 'spawning') {
        this.#state = 'fatal';
        this.#readyReject?.(new Error(`Unable to spawn Host child: ${error.message}`));
      }
    });
    child.on('exit', (code, signal) => {
      if (this.#child !== child) return;
      clearTimeout(startupTimer);
      startupTimer = undefined;
      this.#exitCode = code;
      this.#exitSignal = signal;
      if (this.#state === 'spawning') {
        this.#failWithPreReadyExit(code, signal);
      } else if (this.#state === 'shutting-down') {
        this.#state = 'stopped';
      } else if (this.#state !== 'fatal') {
        this.#state = 'stopped';
      }
    });

    return readyPromise;
  }

  /**
   * Send a shutdown frame with the given deadline and wait for the child to
   * acknowledge with a `stopped` frame. Falls back to SIGTERM after the
   * deadline, then SIGKILL after an additional grace period.
   */
  async shutdown(requestId?: string, deadlineMs?: number): Promise<HostStoppedEvent> {
    if (this.#child === null || this.#state === 'idle' || this.#state === 'stopped') {
      return { requestId: requestId ?? 'none', reason: 'already-stopped' };
    }

    if (this.#state === 'shutting-down' && this.#stoppedPromise !== null) {
      return this.#stoppedPromise;
    }

    const rid = requestId ?? `shutdown-${randomUUID().slice(0, 8)}`;
    const deadline = Math.min(Math.max(deadlineMs ?? 5_000, 1), 30_000);
    this.#state = 'shutting-down';

    const stoppedPromise = new Promise<HostStoppedEvent>((resolve) => {
      this.#stoppedResolve = resolve;
    });
    this.#stoppedPromise = stoppedPromise;
    this.#sendFrame({
      version: HOST_PROTOCOL_VERSION_V1,
      type: 'shutdown',
      requestId: rid,
      deadlineMs: deadline,
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<HostStoppedEvent>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ requestId: rid, reason: 'shutdown-timeout' }),
        deadline + 2_000,
      );
    });
    const result = await Promise.race([stoppedPromise, timeoutPromise]);
    clearTimeout(timeoutHandle);
    const child = this.#child;
    if (result.reason === 'shutdown-timeout') {
      console.error('[workbench-supervisor] shutdown deadline exceeded; sending SIGTERM');
      child?.kill('SIGTERM');
    }
    await this.#waitForExit(child, this.#terminationGraceMs);
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      console.error('[workbench-supervisor] child did not exit after shutdown; sending SIGKILL');
      child.kill('SIGKILL');
      await this.#waitForExit(child, this.#terminationGraceMs);
    }

    this.#child = null;
    this.#state = 'stopped';
    this.#cleanup();
    return result;
  }

  /**
   * Graceful shutdown followed by re-spawn. The same data paths are reused
   * so durable state is preserved.
   */
  async restart(requestId?: string, deadlineMs?: number): Promise<HostReadyEvent> {
    await this.shutdown(requestId, deadlineMs);
    this.#state = 'idle';
    return this.start();
  }

  /** Force-kill the child process without protocol negotiation. */
  kill(): void {
    if (this.#child === null) return;
    this.#child.kill('SIGKILL');
    this.#child = null;
    this.#state = 'stopped';
    this.#cleanup();
  }

  async #waitForExit(child: ChildProcess | null, timeoutMs: number): Promise<void> {
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #sendFrame(frame: HostControlFrameV1): void {
    if (this.#control === null || this.#control.destroyed) return;
    try {
      this.#control.write(`${JSON.stringify(frame)}\n`, 'utf8');
    } catch {
      // The child may exit between the state check and write.
    }
  }

  #failWithPreReadyExit(code: number | null, signal: string | null): void {
    this.#state = 'fatal';
    const msg = signal
      ? `Host child exited with signal ${signal} before signaling ready`
      : `Host child exited with code ${code} before signaling ready`;
    console.error(`[workbench-supervisor] ${msg}`);
    this.#readyReject?.(new Error(msg));
    this.#cleanup();
  }

  #cleanup(): void {
    if (this.#control !== null) {
      try { this.#control.destroy(); } catch { /* ignore */ }
      this.#control = null;
    }
    this.#parser = null;
  }
}

/** Convenience: create and start a supervisor in one call. */
export async function createSupervisor(
  options: HostSupervisorOptions,
): Promise<HostSupervisor> {
  const supervisor = new HostSupervisor(options);
  await supervisor.start();
  return supervisor;
}