/**
 * Host-only authenticated Yjs working-layer gateway: session-authenticated
 * connect/disconnect/update APIs over typed persistence worker operations.
 * Never imported by the browser client; a ws upgrade integration (a later
 * Host slice) consumes these APIs instead of running a y-websocket server.
 */

export type {
  SessionAuthPortOptions,
  YjsApplyFailureReason,
  YjsApplyResult,
  YjsAuthPort,
  YjsConnectFailureReason,
  YjsConnectionRequest,
  YjsConnectionScope,
  YjsDenialReason,
  YjsGateway,
  YjsGatewayConnection,
  YjsGatewayConnectResult,
  YjsGatewayOptions,
  YjsPersistencePort,
  YjsScopeResolution,
  YjsServiceFailureReason,
} from './gateway.js';
export {
  createSessionAuthPort,
  createYjsGateway,
  createYjsPersistencePort,
} from './gateway.js';
