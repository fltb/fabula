export const HOST_PROTOCOL_VERSION_V1 = 1 as const;
export const HOST_CONTROL_MAX_FRAME_BYTES = 64 * 1024;

export interface HostBuildIdentityV1 {
  readonly version: 1;
  readonly packageId: string;
  readonly buildId: string;
  readonly protocolVersion: typeof HOST_PROTOCOL_VERSION_V1;
}

export interface HostReadyMessageV1 {
  readonly version: 1;
  readonly type: 'ready';
  readonly endpoint: string;
  readonly build: HostBuildIdentityV1;
  readonly pid: number;
  readonly listenerMode: 'listener' | 'workbench';
  readonly bootstrapRequired: boolean;
}
export interface HostStoppedMessageV1 {
  readonly version: 1;
  readonly type: 'stopped';
  readonly requestId: string;
  readonly reason: string;
}
export interface HostFatalMessageV1 {
  readonly version: 1;
  readonly type: 'fatal';
  readonly code: string;
  readonly message: string;
}
export interface HostShutdownMessageV1 {
  readonly version: 1;
  readonly type: 'shutdown';
  readonly requestId: string;
  readonly deadlineMs: number;
}
export type HostControlFrameV1 = HostReadyMessageV1 | HostStoppedMessageV1 | HostFatalMessageV1 | HostShutdownMessageV1;
export type HostControlDirectionV1 = 'child-to-supervisor' | 'supervisor-to-child';

export interface HostHealthPayloadV1 {
  readonly version: 1;
  readonly instanceId: string;
  readonly build: HostBuildIdentityV1;
  readonly status: 'starting' | 'ready' | 'unavailable' | 'stopping';
}
export interface HostStatusPayloadV1 extends HostHealthPayloadV1 {
  readonly openProjectIds: readonly string[];
}
export interface HostLaunchMarkerV1 {
  readonly version: 1;
  readonly instanceId: string;
  readonly endpoint: string;
  readonly build: HostBuildIdentityV1;
  readonly projectIds: readonly string[];
}
export interface ProjectAuthorityLeaseV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly rootFingerprint: string;
  readonly instanceId: string;
  readonly state: 'starting' | 'ready';
  readonly endpoint?: string;
  readonly build?: HostBuildIdentityV1;
  readonly heartbeatAt: string;
}
export interface WorkbenchErrorEnvelopeV1 {
  readonly version: 1;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly projectId?: string;
  readonly operationId?: string;
}
export const CLI_EXIT_CODES_V1 = {
  success: 0,
  validationOrReleaseFailure: 1,
  usageOrLocalInput: 2,
  hostUnavailable: 3,
  authenticationOrAuthorization: 4,
  authorityCasOrConflict: 5,
} as const;
export type CliExitCodeV1 = (typeof CLI_EXIT_CODES_V1)[keyof typeof CLI_EXIT_CODES_V1];
