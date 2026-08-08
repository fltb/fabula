import type {
  AdminNetworkUpdateRequestV1,
  ConfigOperationReceiptV1,
  WorkbenchProjectSafeViewV1,
  WorkbenchSetupErrorCode,
  WorkbenchSetupStatusV1,
} from '../contracts/index.js';
import type { BrowserFetch } from './browser-read-client.js';

/** Version carried by every setup mutation. */
export const SETUP_CONTRACT_VERSION = 1 as const;

/**
 * Setup is intentionally a closed, same-origin surface. These paths are
 * duplicated as browser literals rather than importing Host route modules;
 * no filesystem, provider, or durable-state implementation crosses the client
 * boundary.
 */
export const SETUP_ENDPOINTS = Object.freeze({
  status: '/api/v1/setup/status',
  owner: '/api/v1/setup/owner',
  validateProject: '/api/v1/setup/projects/validate',
  saveProject: '/api/v1/setup/projects',
  validateProvider: '/api/v1/setup/providers/validate',
  saveCredential: '/api/v1/setup/providers/credential',
  network: '/api/v1/setup/network',
  finish: '/api/v1/setup/finish',
} as const);

export type SetupField =
  | 'owner'
  | 'project'
  | 'source'
  | 'provider'
  | 'network'
  | 'review'
  | 'host';

export interface SetupOwnerInput {
  readonly password: string;
  readonly displayName: string;
}

/** One-way input: the Host derives the project root; it is never sent here. */
export interface SetupProjectInput {
  readonly projectId: string;
  readonly displayName: string;
}

export interface SetupProviderInput {
  readonly kind: 'pi';
  readonly baseUrl: string | null;
  readonly model: string | null;
}

/** One-way input: the key is sent once and is never represented in a result. */
export interface SetupCredentialInput {
  readonly providerId: string;
  readonly apiKey: string;
}

export type SetupNetworkInput = Omit<AdminNetworkUpdateRequestV1, 'version'>;

export interface SetupOwnerResult {
  readonly version: typeof SETUP_CONTRACT_VERSION;
  readonly sessionId: string;
  readonly userId: string;
  readonly displayName: string;
}

export interface SetupValidationResult {
  readonly version: typeof SETUP_CONTRACT_VERSION;
  readonly validation: 'valid';
  readonly projectId?: string;
  readonly defaultProject?: boolean;
  readonly kind?: 'pi';
}

export interface SetupCredentialResult {
  readonly version: typeof SETUP_CONTRACT_VERSION;
  readonly providerId: string;
  readonly configured: true;
}

export interface SetupNetworkResult {
  readonly version: typeof SETUP_CONTRACT_VERSION;
  readonly mode: SetupNetworkInput['mode'];
  readonly port: number;
  readonly restartRequired: true;
}

export interface SetupFinishResult {
  readonly version: typeof SETUP_CONTRACT_VERSION;
  readonly receipt: ConfigOperationReceiptV1;
}

/**
 * Typed setup failures deliberately expose only a known code and a safe,
 * field-scoped message. The response body is not retained, so a Host cannot
 * accidentally echo an API key or absolute project root into the UI.
 */
export class SetupApiError extends Error {
  readonly status: number;
  readonly code: WorkbenchSetupErrorCode | null;
  readonly field: SetupField;

  constructor(
    status: number,
    code: WorkbenchSetupErrorCode | null,
    field: SetupField,
    message: string,
  ) {
    super(message);
    this.name = 'SetupApiError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export interface SetupClientOptions {
  /** Injectable Fetch keeps the client deterministic in browser tests. */
  readonly fetch?: BrowserFetch;
  /** Optional same-origin prefix for an embedded/test Host. */
  readonly baseUrl?: string;
}

export interface SetupClient {
  getStatus(): Promise<WorkbenchSetupStatusV1>;
  createOwner(input: SetupOwnerInput): Promise<SetupOwnerResult>;
  validateProject(input: SetupProjectInput): Promise<SetupValidationResult>;
  saveProject(input: SetupProjectInput): Promise<SetupValidationResult>;
  validateProvider(input: SetupProviderInput): Promise<SetupValidationResult>;
  saveCredential(input: SetupCredentialInput): Promise<SetupCredentialResult>;
  applyNetwork(input: SetupNetworkInput): Promise<SetupNetworkResult>;
  finish(expectedRevision: string | null): Promise<SetupFinishResult>;
}

const SAFE_MESSAGES: Readonly<Record<WorkbenchSetupErrorCode, string>> = {
  SETUP_DISABLED: 'Setup is not available on this listener.',
  SETUP_ALREADY_CONFIGURED: 'This Host is already configured. Continue to sign in.',
  SETUP_INVALID_INPUT: 'Review the highlighted setup fields.',
  OWNER_EXISTS: 'An owner account already exists. Continue to sign in.',
  PROJECT_INVALID_ROOT: 'The Host could not validate this project.',
  PROJECT_DUPLICATE_ID: 'Choose a different project identifier.',
  PROJECT_NOT_ACCESSIBLE: 'The Host cannot access this project.',
  PROVIDER_VALIDATION_FAILED: 'The provider could not be validated.',
  CREDENTIAL_INVALID: 'The provider credential could not be stored.',
  NETWORK_INVALID: 'Review the listener settings.',
  CONFIG_INVALID: 'The setup configuration is invalid.',
  CONFIG_STALE: 'Setup changed elsewhere. Refresh and review it again.',
  UNKNOWN_FIELD: 'The Host rejected an unsupported setup field.',
};

const CODE_SET = new Set<WorkbenchSetupErrorCode>(
  Object.keys(SAFE_MESSAGES) as WorkbenchSetupErrorCode[],
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCode(value: unknown): WorkbenchSetupErrorCode | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== 'string')
    return null;
  return CODE_SET.has(value.error.code as WorkbenchSetupErrorCode)
    ? (value.error.code as WorkbenchSetupErrorCode)
    : null;
}

function safeMessage(code: WorkbenchSetupErrorCode | null, field: SetupField): string {
  if (code !== null) return SAFE_MESSAGES[code];
  if (field === 'host') return 'The Workbench Host could not be reached.';
  return 'The Host rejected this setup step.';
}

function setupError(
  status: number,
  code: WorkbenchSetupErrorCode | null,
  field: SetupField,
): SetupApiError {
  return new SetupApiError(status, code, field, safeMessage(code, field));
}

async function decode<T>(response: Response, field: SetupField): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw setupError(response.status, safeCode(body), field);
  return body as T;
}

function oneWayBody(input: SetupProjectInput): Record<string, unknown> {
  return {
    version: SETUP_CONTRACT_VERSION,
    projectId: input.projectId,
    displayName: input.displayName,
  };
}

/** Create the typed, same-origin setup adapter. */
export function createSetupClient(options: SetupClientOptions = {}): SetupClient {
  const execute = options.fetch ?? globalThis.fetch;
  if (typeof execute !== 'function') throw new Error('Browser Fetch API is unavailable.');
  const prefix = options.baseUrl ?? '';

  const request = async <T>(
    path: string,
    field: SetupField,
    init: RequestInit = {},
  ): Promise<T> => {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    let response: Response;
    try {
      response = await execute(`${prefix}${path}`, {
        ...init,
        headers,
        credentials: 'same-origin',
      });
    } catch {
      throw setupError(0, null, 'host');
    }
    return decode<T>(response, field);
  };

  return {
    getStatus: () => request<WorkbenchSetupStatusV1>(SETUP_ENDPOINTS.status, 'host'),
    createOwner: (input) =>
      request<SetupOwnerResult>(SETUP_ENDPOINTS.owner, 'owner', {
        method: 'POST',
        body: JSON.stringify({
          version: SETUP_CONTRACT_VERSION,
          password: input.password,
          displayName: input.displayName,
        }),
      }),
    validateProject: (input) =>
      request<SetupValidationResult>(SETUP_ENDPOINTS.validateProject, 'project', {
        method: 'POST',
        body: JSON.stringify(oneWayBody(input)),
      }),
    saveProject: (input) =>
      request<SetupValidationResult>(SETUP_ENDPOINTS.saveProject, 'source', {
        method: 'POST',
        body: JSON.stringify(oneWayBody(input)),
      }),
    validateProvider: (input) =>
      request<SetupValidationResult>(SETUP_ENDPOINTS.validateProvider, 'provider', {
        method: 'POST',
        body: JSON.stringify({ version: SETUP_CONTRACT_VERSION, ...input }),
      }),
    saveCredential: (input) =>
      request<SetupCredentialResult>(SETUP_ENDPOINTS.saveCredential, 'provider', {
        method: 'POST',
        body: JSON.stringify({ version: SETUP_CONTRACT_VERSION, ...input }),
      }),
    applyNetwork: (input) =>
      request<SetupNetworkResult>(SETUP_ENDPOINTS.network, 'network', {
        method: 'POST',
        body: JSON.stringify({ version: SETUP_CONTRACT_VERSION, ...input }),
      }),
    finish: (expectedRevision) =>
      request<SetupFinishResult>(SETUP_ENDPOINTS.finish, 'review', {
        method: 'POST',
        body: JSON.stringify({ version: SETUP_CONTRACT_VERSION, expectedRevision }),
      }),
  };
}

export function isSetupApiError(error: unknown): error is SetupApiError {
  return error instanceof SetupApiError;
}

/** Public safe project shape used by setup-to-runtime handoff tests. */
export type SetupProjectSafeView = WorkbenchProjectSafeViewV1;
