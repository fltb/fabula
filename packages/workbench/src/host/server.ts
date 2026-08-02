import type { Handler } from 'hono';
import { createHostListener } from './listener.js';
import type {
  EffectiveProtocol,
  HostEndpointProjection,
  HostHealthPayload,
  HostHttpMethod,
  HostListener,
  HostListenerApp,
  HostListenerConfig,
  HostListenerEnv,
  HostListenerHandle,
  HostListenerMode,
  HostListenerStatus,
  HostStatusPayload,
  MutationAllowlist,
  MutationHttpMethod,
  RequestProtocol,
} from './listener.js';

export type {
  EffectiveProtocol,
  HostEndpointProjection,
  HostHealthPayload,
  HostHttpMethod,
  HostListener,
  HostListenerApp,
  HostListenerConfig,
  HostListenerEnv,
  HostListenerHandle,
  HostListenerMode,
  HostListenerStatus,
  HostStatusPayload,
  MutationAllowlist,
  MutationHttpMethod,
  RequestProtocol,
} from './listener.js';

export { createHostListener } from './listener.js';
export type { Handler, MiddlewareHandler } from 'hono';

export interface HostServerOptions extends HostListenerConfig {}

export interface HostServer {
  /** The underlying listener; future Host surfaces mount on `listener.app`. */
  readonly listener: HostListener;
  readonly app: HostListenerApp;
  start(): Promise<HostListenerHandle>;
  close(): Promise<void>;
  status(): HostListenerStatus;
  endpoints(): HostEndpointProjection;
  registerMutationRoute(
    method: MutationHttpMethod,
    path: string,
    handler: Handler<HostListenerEnv>,
  ): void;
  isMutationAllowed(host: string | undefined, origin: string | undefined): boolean;
}

/**
 * Create the composed Host server. All configuration flows through the
 * listener's fail-closed transport validation (loopback default, explicit
 * LAN opt-in, Unix proxy-only forwarded headers, no implicit TLS).
 */
export function createHostServer(options: HostServerOptions = {}): HostServer {
  const listener = createHostListener(options);
  return {
    listener,
    app: listener.app,
    start: () => listener.start(),
    close: () => listener.close(),
    status: () => listener.status(),
    endpoints: () => listener.endpoints(),
    registerMutationRoute: (method, path, handler) =>
      listener.registerMutationRoute(method, path, handler),
    isMutationAllowed: (host, origin) => listener.isMutationAllowed(host, origin),
  };
}
