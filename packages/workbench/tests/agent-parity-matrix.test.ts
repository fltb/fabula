// ============================================================================
// Workbench Agent parity matrix (plan 9.6) — the deterministic gate
// ============================================================================
// The built-in Agent is re-opened ONLY after this matrix passes end to end:
//   1. Tools parity — a built-in principal (`callerForRole`) lists EXACTLY
//      the same tools an external device sees through the same registry at
//      the same scopes.
//   2. Full chain through the SHARED executor, all as MCP tool calls with the
//      built-in principal + a deterministic mock provider: status → source
//      list/get → graph → working create/edit → working validate → submit →
//      operation wait → render (queued → completed) → require-waiver warning
//      gate (pending_waiver) → release gate decide (accept, ZERO provider
//      calls) → publish → publication get/read (hash matches file bytes).
//   3. Recovery/identity — a render whose source moved commits `stale` and
//      the accepted scene still binds the old sourceHash; a cancelled render
//      (AbortController; the mock provider ignores the signal) never
//      promotes a late result, and an explicit retry with the same
//      idempotency key after the interrupted sweep completes.
//   4. Capability gate — the launch-level `agentReady` flag (the parity
//      outcome) flips `agent-chat` only when V3 `agent.enabled` is also
//      true; either false keeps the feature hidden and every Agent route a
//      404. (The pi-ai model always supports tool calls, so the launch gate
//      is binary — there is no separate tool-call-support input anymore.)
//
// The whole matrix runs on ONE ProjectSession over a temp copy of the
// `workbench-authoring` fixture (with `releasePolicy.warnings:
// require-waiver` appended), an injected fixed clock, a real SQLite worker
// for the durable stores, and a deterministic gated mock provider — no
// network, no real model, no flaky timers. The polling loops below use short
// real sleeps on purpose: operation status transitions happen on the real
// persistence worker thread and the queue drain loop, so there is no event
// to await and fake timers cannot advance their event loop.
// ============================================================================

import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CompletionRequest,
  LLMProvider,
  WorkflowStatusV1,
} from '@novalistically/core';
import { MockProvider } from '@novalistically/core/testing';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { assistantPartial, doneEvent, scriptedStream } from './helpers/scripted-stream.js';
import { createFileCoreRuntimeServices, FileProjectSourceLoader } from '@novalistically/node-host';
import {
  DEFAULT_WORKBENCH_OPERATION_LIMITS,
  DEFAULT_WORKBENCH_REFERENCE_LIMITS,
  DEFAULT_WORKBENCH_RENDER_POLICY,
  MCP_TOOL_CATALOG_V1,
} from '@novalistically/workbench-protocol';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT_ACCESS_ROLE_GRANTS } from '../src/contracts/configuration.js';
import {
  AgentCapabilityService,
  createCapabilityPersistence,
} from '../src/host/agent/index.js';
import type { ProjectToolExecutor, ProjectToolExecutorPrincipal } from '../src/host/agent/project-tool-executor.js';
import { createProjectToolExecutor } from '../src/host/agent/project-tool-executor.js';
import { createMcpAuthoringCoordinatorPort } from '../src/host/authoring/mcp-adapter.js';
import { createProjectAuthoringRuntime } from '../src/host/authoring/project-runtime.js';
import { serializeConfigurationYaml } from '../src/host/configuration-file-store.js';
import { createProjectCoreRuntime } from '../src/host/core-runtime.js';
import type {
  McpAuthoringCoordinatorPort,
  McpRegistryOptions,
  McpToolDefinition,
  McpToolRegistry,
} from '../src/host/mcp/registry.js';
import { createProjectSessionMcpRegistry } from '../src/host/mcp/registry.js';
import { createWorkbenchReferencePort } from '../src/host/mcp/reference-port.js';
import {
  createProjectOperationService,
  type ProjectOperationService,
} from '../src/host/operation-service.js';
import { createProjectSession, type ProjectSession } from '../src/host/project-session.js';
import type { ProjectPublicationService } from '../src/host/publication/publication-service.js';
import { createProjectPublicationService } from '../src/host/publication/publication-service.js';
import type { HostReviewService } from '../src/host/review/review-service.js';
import { createHostReviewService } from '../src/host/review/review-service.js';
import {
  startWorkbench,
  type WorkbenchLaunchHandle,
} from '../src/host/workbench-launch.js';
import { createYjsPersistencePort, createYjsWorkingDocumentCore } from '../src/host/yjs/index.js';
import { createProjectOperationStore } from '../src/persistence/project-operation-store.js';
import { createProjectPublicationStore } from '../src/persistence/project-publication-store.js';
import { createRealPersistence, type RealPersistenceHarness } from './helpers/real-persistence.js';

// ─── Fixture + temp workspace ───────────────────────────────────────────────

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const FIXTURE_ROOT = fileURLToPath(
  new URL('../../../fixtures/workbench-authoring', import.meta.url),
);
const PROJECT_ID = 'parity-project';
const USER_ID = 'parity-owner';
const CAPABILITY_VERSION = 4;
const FIXED_NOW = '2026-08-06T00:00:00.000Z';
const PRINCIPAL: ProjectToolExecutorPrincipal = {
  userId: USER_ID,
  role: 'maintainer',
  capabilityVersion: CAPABILITY_VERSION,
  expiresAt: '2099-01-01T00:00:00.000Z',
  sessionId: 'session-parity',
};

const ownedDirs: string[] = [];
function newTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  ownedDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of ownedDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Copy the authoring fixture and bind it to the harness project id. The Core
 * pipeline keys review events and scene revisions by the project id in
 * nova.yaml (the same id the session/Host reads them under), so the fixture
 * copy MUST carry the harness project id (launch-phase1a rewrites it the same
 * way). The fixture keeps the canonical default release policy
 * (accept-and-record); the require-waiver gate scenario appends the strict
 * policy to the WORKING nova.yaml and submits it.
 */
function copyFixture(): string {
  const root = newTempDir('fabula-parity-fixture-');
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  const novaPath = join(root, 'nova.yaml');
  writeFileSync(
    novaPath,
    readFileSync(novaPath, 'utf8')
      .replace(/^project: workbench-authoring$/m, `project: ${PROJECT_ID}`)
      .replace(/^author:.*$/m, 'author: "Fabula Parity"'),
  );
  return root;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Short real-interval polling; see the file header for why timers are real. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message = 'condition',
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

// ─── Deterministic gated render provider ────────────────────────────────────
// Pass 1 returns fixed prose; Pass 2 returns a canned analysis whose protocol
// field is echoed by the base MockProvider (the compliant-model echo). The
// provider NEVER reads the abort signal — a cancelled render's late result
// is exactly what the operation lane must archive, never promote.
// ---------------------------------------------------------------------------

const PROSE = [
  'The morning light filtered through the tall windows as Ada arrived at the edge of the',
  'small_town on a winter evening. I, the narrator, welcomed her and showed her the way',
  'through the quiet streets, and Ada steps echoed on the cobblestones while the town',
  'held its breath in the cold air.',
].join(' ');

/** Analysis payload for the single fixture event (E0), deterministic. */
function analysisContent(): Record<string, unknown> {
  return {
    postconditions: { covered: [], dropped: [] },
    preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] },
    inventedDetails: [],
    quality: {
      proseScore: 4,
      maxScore: 5,
      strengths: ['clear'],
      weaknesses: [],
      estimatedWordCount: 60,
    },
    threadProgressAchieved: [],
    foreshadowingDeployed: [],
    narrativeChecks: [],
    appearanceChecks: [],
    characterReferences: [
      { entityId: 'ada', namesUsed: ['Ada'] },
      { entityId: 'narrator', namesUsed: ['narrator'] },
    ],
    tenseDetected: 'past',
    ruleChecks: [],
    knowledgeChecks: [],
    checklistResults: [],
  };
}

/** One `produced` observation per analysis field with an exact prose quote. */
function producedObservations(payload: Record<string, unknown>): Record<string, unknown> {
  const observations: Record<string, unknown> = {};
  for (const field of Object.keys(payload)) {
    observations[field] = { disposition: 'produced', evidence: [PROSE.trim().slice(0, 24)] };
  }
  // The deterministic warning that opens the require-waiver gate: the
  // conflict measurement abstains (analysis_uncertainty, severity warning).
  observations.conflictAnalysis = {
    disposition: 'abstained',
    reason: 'prose does not reveal a clear conflict',
    evidence: [],
  };
  return observations;
}

function makeAnalysisJson(): string {
  const payload = analysisContent();
  const analysis = {
    eventId: 'E0',
    observations: producedObservations(payload),
    analysis: payload,
  };
  return JSON.stringify(analysis);
}

/**
 * MockProvider + a one-shot hang gate. `hangNextCall()` arms the gate; the
 * NEXT provider call blocks until the returned release() runs. The signal is
 * intentionally ignored (the base MockProvider never consults it).
 */
class GatedMockProvider extends MockProvider {
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;
  private gateConsumed = false;
  /** Incremented when a call ENTERS complete(), before any hang. */
  startedCalls = 0;

  constructor() {
    super({ generator: () => makeAnalysisJson() });
  }

  hangNextCall(): () => void {
    if (this.gate !== null) throw new Error('hang gate is already armed');
    const { promise, resolve: release } = Promise.withResolvers<void>();
    this.gate = promise;
    this.releaseGate = release;
    this.gateConsumed = false;
    return () => {
      if (this.releaseGate === null) throw new Error('no hang gate armed');
      this.releaseGate();
      this.releaseGate = null;
    };
  }

  override async complete(request: CompletionRequest) {
    this.startedCalls += 1;
    if (this.gate !== null && !this.gateConsumed) {
      this.gateConsumed = true;
      await this.gate;
      this.gate = null;
    }
    return super.complete(request);
  }
}

// ─── The one session + full service composition (plan 9.6 harness) ──────────

/** Wire shapes used by the matrix assertions (server-derived, fixed fields). */
interface OperationReceiptWire {
  readonly version: number;
  readonly operationId: string;
  readonly status: string;
  readonly acceptedRevisionId: string | null;
  readonly acceptedSourceHash: string | null;
}
interface OperationGetWire {
  readonly version: number;
  readonly operationId: string;
  readonly receipt: OperationReceiptWire | null;
}
interface AuthoringStatusWire {
  readonly state: {
    readonly phase: string;
    readonly workspaceDigest: string | null;
    readonly acceptedSourceHash: string | null;
  };
  readonly nextWorkingAction: string | null;
}
interface DocumentListWire {
  readonly documents: readonly { readonly documentId: string; readonly logicalPath: string }[];
  readonly workspaceDigest: string | null;
}
interface DocumentReadWire {
  readonly content: string;
  readonly stateVectorHash: string;
  readonly workspaceDigest: string | null;
}
interface DocumentEditWire {
  readonly status: string;
  readonly workspaceDigest: string;
}
interface WorkingValidationWire {
  readonly layer: string;
  readonly candidateSourceHash: string;
  readonly passed: boolean;
  readonly acceptedSourceHash: string | null;
}
interface SubmitWire {
  readonly status: string;
  readonly receipt?: { readonly operationId?: string };
}
interface EnqueueWire {
  readonly status: string;
  readonly operationHandle: string;
}
interface ReleaseGateWire {
  readonly eventId: string;
  readonly status: string;
  readonly revisionId: string | null;
  readonly gateId: string;
}
interface GateListWire {
  readonly items: readonly ReleaseGateWire[];
}
interface GateDecisionWire {
  readonly resolution: {
    readonly outcome: string;
    readonly acceptedRevisionId: string | null;
  };
}
interface PublicationGetWire {
  readonly publication: {
    readonly value: {
      readonly sourceHash: string;
      readonly novelHash: string;
      readonly byteLength: number;
      readonly relativeOutputPath: string;
      readonly status: string;
    };
  } | null;
}
interface PublicationReadWire {
  readonly content: string;
  readonly totalByteLength: number;
}

interface ParityHarness {
  readonly root: string;
  readonly persistence: RealPersistenceHarness;
  readonly session: ProjectSession;
  readonly executor: ProjectToolExecutor;
  readonly externalRegistry: McpToolRegistry;
  readonly registryOptions: McpRegistryOptions;
  readonly operations: ProjectOperationService;
  readonly provider: GatedMockProvider;
  readonly dispose(): Promise<void>;
}

function registryOptions(
  services: {
    readonly session: ProjectSession;
    readonly operations: ProjectOperationService;
    readonly coordinator: McpAuthoringCoordinatorPort;
    readonly revision: McpRegistryOptions['revision'];
    readonly review: HostReviewService;
    readonly publication: ProjectPublicationService;
    readonly reference: McpRegistryOptions['reference'];
  },
  now: () => string,
): McpRegistryOptions {
  return {
    family: 'project',
    operations: services.operations,
    revision: services.revision,
    coordinator: services.coordinator,
    review: services.review,
    publication: services.publication,
    reference: services.reference,
    status: {
      review: () => services.review.workflowReviewProjection(),
      publication: () => services.publication.workflowPublicationProjection(),
      now,
    },
  };
}

async function buildParityHarness(): Promise<ParityHarness> {
  const root = copyFixture();
  const persistence = createRealPersistence();
  const capabilities = new AgentCapabilityService({
    persistence: createCapabilityPersistence(persistence.client),
  });
  const now = () => FIXED_NOW;
  const provider = new GatedMockProvider();

  // The built-in principal's grant is a REAL durable capability (the session
  // gate re-loads it by capabilityId on every phase). The launch derives the
  // builtin id/version from the browser session; the parity harness persists
  // the same row the production launch must, so the render prepare/commit
  // phases are not denied for the built-in caller.
  await createCapabilityPersistence(persistence.client).upsertCapability({
    capabilityId: `builtin:${PROJECT_ID}:${USER_ID}`,
    userId: USER_ID,
    projectId: PROJECT_ID,
    scope: [...PROJECT_ACCESS_ROLE_GRANTS.maintainer.scopes],
    version: CAPABILITY_VERSION,
    expiresAt: PRINCIPAL.expiresAt,
  });

  const source = new FileProjectSourceLoader().load(root);
  const runtime = createProjectCoreRuntime({
    projectId: PROJECT_ID,
    services: createFileCoreRuntimeServices(root, { provider, now }),
  });
  const session = createProjectSession({
    projectId: PROJECT_ID,
    runtime,
    capabilities,
    audit: { record: async () => undefined },
    initialSource: source,
  });
  const yjsCore = createYjsWorkingDocumentCore({
    persistence: createYjsPersistencePort(persistence.client),
  });
  const operations = createProjectOperationService({
    projectId: PROJECT_ID,
    store: createProjectOperationStore(persistence.client),
    session,
    limits: { ...DEFAULT_WORKBENCH_OPERATION_LIMITS },
    now,
  });
  await operations.start();
  const publication = createProjectPublicationService({
    projectId: PROJECT_ID,
    session,
    projectRoot: root,
    publicationStore: createProjectPublicationStore(persistence.client),
    operations,
    now,
  });
  const authoring = await createProjectAuthoringRuntime({
    projectId: PROJECT_ID,
    projectRoot: root,
    hostStagingRoot: newTempDir('fabula-parity-staging-'),
    session,
    revisionMirror: { mode: 'disabled' },
    capabilities,
    persistence: persistence.client,
    yjsCore,
    events: { publish: () => undefined },
  });
  const review = createHostReviewService({
    projectId: PROJECT_ID,
    session,
    operationStore: createProjectOperationStore(persistence.client),
    now,
    onGateAccepted: () => {
      void publication.refreshCanonical().catch(() => undefined);
    },
  });
  const coordinator = createMcpAuthoringCoordinatorPort({
    session,
    coordinator: authoring.coordinator,
    documents: authoring.documents,
    capabilities,
  });
  // Reference tools enter the registry only when a port is wired (plan 3.8);
  // the shared options hand the SAME port to the executor and the external
  // registry so the parity view stays byte-identical at every scope.
  const reference = createWorkbenchReferencePort({
    projectId: PROJECT_ID,
    projectRoot: root,
    jobsRoot: newTempDir('fabula-parity-reference-'),
    referenceLimits: DEFAULT_WORKBENCH_REFERENCE_LIMITS,
  });
  const options = registryOptions(
    {
      session,
      operations,
      coordinator,
      revision: authoring.revision,
      review,
      publication,
      reference,
    },
    now,
  );
  const executor = createProjectToolExecutor(session, options);
  const externalRegistry = createProjectSessionMcpRegistry(session, options);

  let disposed = false;
  return {
    root,
    persistence,
    session,
    executor,
    externalRegistry,
    registryOptions: options,
    operations,
    provider,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await authoring.dispose();
      await operations.close();
      await persistence.dispose();
    },
  };
}

// ─── Shared tool-call helpers (all through the executor, built-in principal) ─

interface McpToolResultWire {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

async function call(
  executor: ProjectToolExecutor,
  name: string,
  input: unknown,
  role: 'reader' | 'author' | 'maintainer' = 'maintainer',
): Promise<unknown> {
  const result = (await executor.callTool(
    name,
    executor.callerForRole({ ...PRINCIPAL, role }),
    input,
  )) as McpToolResultWire;
  expect(result.ok, `${name} failed: ${JSON.stringify(result)}`).toBe(true);
  return result.data;
}

/** Poll `nova_operation_get` until the receipt reaches a terminal status. */
async function waitForOperation(
  executor: ProjectToolExecutor,
  operationHandle: string,
  expected?: readonly string[],
  timeoutMs = 30_000,
): Promise<OperationReceiptWire> {
  const terminal =
    expected ?? ['completed', 'failed', 'stale', 'cancelled', 'conflict', 'interrupted'];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const data = (await call(executor, 'nova_operation_get', {
      version: 2,
      operationHandle,
    })) as OperationGetWire;
    const receipt = data.receipt;
    const status = receipt?.status;
    if (status !== undefined && terminal.includes(status)) {
      return receipt as OperationReceiptWire;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `operation ${operationHandle} did not reach terminal (${terminal.join(', ')}): ${String(status)}`,
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

/** Wire-relevant definition shape for parity comparisons. */
function shapeOf(definitions: readonly McpToolDefinition[]) {
  return definitions.map(({ name, description, inputSchema, requiredScopes }) => ({
    name,
    description,
    inputSchema,
    requiredScopes,
  }));
}

/** Set by the full-chain test after every matrix assertion passes. */
let parityMatrixPassed = false;

// ─── Launch smoke boot helper (test 4 gate flips + test 5 builtin grant) ────
interface LaunchSmokeBootOptions {
  readonly enabled: boolean;
  readonly agentReady?: boolean;
  readonly tag: string;
  /** Reuse an existing host home (persisted users) instead of a fresh one. */
  readonly hostHome?: string;
  /** Skip the bootstrap POST and reuse a persisted owner session id. */
  readonly ownerSessionId?: string;
  /** Deterministic render provider; absent = the launch's built-in mock. */
  readonly providerOverride?: LLMProvider;
  /** Scripted pi-ai agentModel; absent = finish-only (never calls tools). */
  readonly agentModel?: { readonly model: Model<Api>; readonly streamFn: StreamFn };
}

interface LaunchSmokeHandle {
  readonly handle: WorkbenchLaunchHandle;
  readonly ownerHeaders: Record<string, string>;
  readonly endpoint: string;
  readonly hostHome: string;
}

/** Minimal pi-ai model identity; the scripted streamFn never streams it. */
const launchFakeModel: Model<Api> = {
  id: 'test-model',
  name: 'test-model',
  api: 'openai-completions',
  provider: 'pi-provider',
  baseUrl: 'http://localhost:1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 32_000,
};

const finishOnlyFinal = assistantPartial([]);

/** Finish-only streamFn (one `done('stop')` turn; never calls tools). */
function finishOnlyAgentModel(): { readonly model: Model<Api>; readonly streamFn: StreamFn } {
  return {
    model: launchFakeModel,
    streamFn: () => scriptedStream([doneEvent('stop', finishOnlyFinal)], finishOnlyFinal),
  };
}

/** Scripted tool-then-stop streamFn (turn 1 calls the tool, turn 2 finishes). */
function toolThenStopAgentModel(
  toolCall: { readonly id: string; readonly name: string; readonly args: Record<string, unknown> },
): { readonly model: Model<Api>; readonly streamFn: StreamFn } {
  const toolFinal = assistantPartial([
    { type: 'toolCall', id: toolCall.id, name: toolCall.name, arguments: toolCall.args },
  ]);
  let toolTurnSent = false;
  return {
    model: launchFakeModel,
    streamFn: () => {
      if (!toolTurnSent) {
        toolTurnSent = true;
        return scriptedStream(
          [
            { type: 'start', partial: toolFinal },
            {
              type: 'toolcall_end',
              contentIndex: 0,
              toolCall: { type: 'toolCall', id: toolCall.id, name: toolCall.name, arguments: toolCall.args },
              partial: toolFinal,
            },
            doneEvent('toolUse', toolFinal),
          ],
          toolFinal,
        );
      }
      return scriptedStream([doneEvent('stop', finishOnlyFinal)], finishOnlyFinal);
    },
  };
}

async function boot(options: LaunchSmokeBootOptions): Promise<LaunchSmokeHandle> {
  const hostHome = options.hostHome ?? newTempDir(`fabula-parity-gate-${options.tag}-`);
  const assetsRoot = join(hostHome, 'assets');
  await mkdir(assetsRoot, { recursive: true });
  await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>wb</title>');
  const projectRoot = join(
    newTempDir(`fabula-parity-gate-project-${options.tag}-`),
    'agent-project',
  );
  cpSync(FIXTURE_ROOT, projectRoot, { recursive: true });
  const novaYaml = await readFile(join(projectRoot, 'nova.yaml'), 'utf8');
  await writeFile(
    join(projectRoot, 'nova.yaml'),
    novaYaml.replace(/^project: workbench-authoring$/m, 'project: agent-project'),
  );
  const configuration = {
    version: 1 as const,
    projects: [
      {
        projectId: 'agent-project',
        displayName: 'Agent Project',
        root: projectRoot,
        providerProfile: 'default',
        revisionMirror: { mode: 'disabled' as const },
        trustedPlugins: [],
      },
    ],
    defaultProjectId: 'agent-project',
    providers: {},
    network: {
      mode: 'loopback' as const,
      port: 0,
      allowedHosts: [],
      allowedOrigins: [],
      unixSocket: null,
    },
    referenceLimits: { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS },
    operationLimits: { ...DEFAULT_WORKBENCH_OPERATION_LIMITS },
    agent: { enabled: options.enabled, maxTurns: 4, maxToolCalls: 8 },
    renderPolicy: { ...DEFAULT_WORKBENCH_RENDER_POLICY },
  };
  await mkdir(join(hostHome, 'config'), { recursive: true });
  await writeFile(
    join(hostHome, 'config', 'workbench.yaml'),
    serializeConfigurationYaml(configuration as never),
    'utf8',
  );
  const handle = await startWorkbench({
    mode: 'workbench',
    provider: 'mock',
    allowMockProvider: true,
    hostHome,
    databasePath: join(hostHome, 'workbench.sqlite'),
    assetsRoot,
    allowBootstrap: true,
    persistenceWorkerEntry: await workerBundle(),
    workerTerminationTimeoutMs: 2_000,
    host: 'loopback',
    port: 0,
    ...(options.providerOverride === undefined
      ? {}
      : { providerOverride: options.providerOverride }),
    agentModel: options.agentModel ?? finishOnlyAgentModel(),
    ...(options.agentReady === undefined ? {} : { agentReady: options.agentReady }),
  });
  const ownerHeaders =
    options.ownerSessionId !== undefined
      ? { 'x-fabula-session': options.ownerSessionId }
      : await (async () => {
          const bootstrap = await fetch(`${handle.endpoint}/api/v1/auth/bootstrap`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: 'a-strong-owner-password', displayName: 'Owner' }),
          });
          expect(bootstrap.status).toBe(200);
          const { sessionId } = (await bootstrap.json()) as { sessionId: string };
          return { 'x-fabula-session': sessionId } as Record<string, string>;
        })();
  return {
    handle,
    ownerHeaders,
    endpoint: handle.endpoint,
    hostHome,
  };
}

// ─── The matrix ─────────────────────────────────────────────────────────────

describe('Workbench Agent parity matrix (plan 9.6)', () => {
  let harness: ParityHarness;

  beforeAll(async () => {
    harness = await buildParityHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.dispose();
  }, 30_000);

  it('1) lists EXACTLY the same tools as an external device at the same scopes', () => {
    const scopesOf = (role: 'reader' | 'author' | 'maintainer') =>
      PROJECT_ACCESS_ROLE_GRANTS[role].scopes;

    for (const role of ['reader', 'author', 'maintainer'] as const) {
      const scopes = scopesOf(role);
      // Strict equality with the same-scope external `tools/list` view.
      expect(shapeOf(harness.executor.listTools(scopes))).toEqual(
        shapeOf(harness.externalRegistry.list(scopes)),
      );
      expect(harness.executor.listTools(scopes).map((d) => d.name)).toEqual(
        harness.externalRegistry.list(scopes).map((d) => d.name),
      );
      // And the catalog at those scopes (mcp-catalog-parity discipline);
      // order is not part of the catalog contract, only the set is.
      const catalogNames = MCP_TOOL_CATALOG_V1.filter((tool) =>
        tool.scopes.every((scope) => scopes.includes(scope)),
      )
        .map((tool) => tool.name)
        .sort();
      expect(
        harness.executor.listTools(scopes).map((d) => d.name).sort(),
      ).toEqual(catalogNames);
    }

    // The built-in principal's caller derives scopes from the same constant.
    const caller = harness.executor.callerForRole(PRINCIPAL);
    expect(caller.grant.scopes).toEqual(PROJECT_ACCESS_ROLE_GRANTS.maintainer.scopes);
    expect(caller.grant.capabilityId).toBe(`builtin:${PROJECT_ID}:${USER_ID}`);
  });

  it('2) runs the full chain through the shared executor (status → edit → validate → submit → render → gate → publish)', async () => {
    const { session, executor } = harness;
    const originalSourceHash = session.source?.sourceHash;
    expect(originalSourceHash).toBeTruthy();

    // ── status (WorkflowStatusV1) ────────────────────────────────────────
    const status = (await call(executor, 'nova_status', {})) as WorkflowStatusV1;
    expect(status.version).toBe(1);
    expect(status.projectId).toBe(PROJECT_ID);
    expect(status.layer).toBe('accepted');
    expect(status.sourceHash).toBe(originalSourceHash);
    expect(status.validation.passed).toBe(true);
    expect(status.render.completed).toEqual([]);
    expect(status.render.ready.length).toBeGreaterThan(0);
    expect(status.review).toEqual({ open: 0, blocking: 0, pendingGates: 0 });
    expect(status.publication).toEqual({
      status: 'missing',
      publicationId: null,
      novelHash: null,
    });
    expect(status.nextActions.some((next) => next.code === 'RENDER')).toBe(true);

    // ── source list/get ──────────────────────────────────────────────────
    // `nova_source_list` returns the source document array directly.
    const sourceList = (await call(executor, 'nova_source_list', {})) as readonly {
      logicalPath: string;
      content: string;
    }[];
    const paths = sourceList.map((d) => d.logicalPath);
    expect(paths).toContain('nova.yaml');
    expect(paths).toContain('chapters/chapter_01/E0_arrival.yaml');
    const sourceDoc = (await call(executor, 'nova_source_get', {
      logicalPath: 'nova.yaml',
    })) as { logicalPath: string; content: string };
    expect(sourceDoc.content).toContain(`project: ${PROJECT_ID}`);
    expect(sourceDoc.content).toContain('author: "Fabula Parity"');

    // ── graph ────────────────────────────────────────────────────────────
    const graph = (await call(executor, 'nova_graph', {
      version: 1,
      branchPath: { decisions: [] },
    })) as { version: number; story: unknown; discourse: unknown; route: unknown };
    expect(graph.version).toBe(1);
    expect(graph.story).toBeTruthy();

    // ── working document create/edit ─────────────────────────────────────
    const authoringStatus = (await call(executor, 'nova_authoring_status', {
      version: 2,
    })) as AuthoringStatusWire;
    expect(authoringStatus.state.phase).toBe('clean');
    const initialDigest = authoringStatus.state.workspaceDigest as string;
    const acceptedHash = authoringStatus.state.acceptedSourceHash;

    // create: a new character entity under the authoring topology.
    const created = (await call(executor, 'nova_authoring_document_create', {
      version: 2,
      logicalPath: 'definitions/characters/parity-extra.yaml',
      kind: 'raw-yaml',
      expectedWorkspaceDigest: initialDigest,
      expectedAcceptedSourceHash: acceptedHash,
    })) as DocumentEditWire;
    expect(created.status).toBe('applied');

    const list = (await call(executor, 'nova_authoring_document_list', {
      version: 2,
    })) as DocumentListWire;
    const extraDescriptor = list.documents.find(
      (d) => d.logicalPath === 'definitions/characters/parity-extra.yaml',
    );
    expect(extraDescriptor).toBeTruthy();
    // edit: give the new document valid character content.
    const extraRead = (await call(executor, 'nova_authoring_document_read', {
      version: 2,
      documentId: extraDescriptor?.documentId,
    })) as DocumentReadWire;
    const extraEdit = (await call(executor, 'nova_authoring_document_edit', {
      version: 2,
      documentId: extraDescriptor?.documentId,
      expectedWorkspaceDigest: extraRead.workspaceDigest,
      expectedAcceptedSourceHash: acceptedHash,
      expectedStateVectorHash: extraRead.stateVectorHash,
      replacementText:
        'id: parity-extra\nname: Parity Extra\ntype: person\ndescription: A background character added by the parity matrix.\ninitialState: {}\ntraits: []\n',
    })) as DocumentEditWire;
    expect(extraEdit.status).toBe('applied');

    // edit: a comment on the accepted nova.yaml working copy.
    const novaDescriptor = list.documents.find((d) => d.logicalPath === 'nova.yaml');
    expect(novaDescriptor).toBeTruthy();
    const read = (await call(executor, 'nova_authoring_document_read', {
      version: 2,
      documentId: novaDescriptor?.documentId,
    })) as DocumentReadWire;
    const edited = (await call(executor, 'nova_authoring_document_edit', {
      version: 2,
      documentId: novaDescriptor?.documentId,
      expectedWorkspaceDigest: read.workspaceDigest,
      expectedAcceptedSourceHash: acceptedHash,
      expectedStateVectorHash: read.stateVectorHash,
      replacementText: `${read.content}# parity-agent-edit\n`,
    })) as DocumentEditWire;
    expect(edited.status).toBe('applied');
    const dirtyDigest = edited.workspaceDigest;
    expect(dirtyDigest).not.toBe(read.workspaceDigest);

    // ── authoring validate (working layer) ───────────────────────────────
    const workingValidation = (await call(executor, 'nova_authoring_validate', {
      version: 2,
      expectedWorkspaceDigest: dirtyDigest,
      expectedAcceptedSourceHash: acceptedHash,
    })) as WorkingValidationWire;
    expect(workingValidation.layer).toBe('working');
    expect(workingValidation.passed).toBe(true);
    expect(workingValidation.candidateSourceHash).not.toBe(originalSourceHash);
    expect(workingValidation.acceptedSourceHash).toBe(acceptedHash);

    // `nova_validate` still reports the ACCEPTED layer untouched.
    const acceptedValidation = (await call(executor, 'nova_validate', {})) as {
      layer: string;
    };
    expect(acceptedValidation.layer).toBe('accepted');

    // ── submit ───────────────────────────────────────────────────────────
    const submit = (await call(executor, 'nova_authoring_submit', {
      version: 2,
      expectedWorkspaceDigest: dirtyDigest,
      message: 'parity matrix submit',
    })) as SubmitWire;
    expect(['queued', 'completed']).toContain(submit.status);
    const submitHandle = submit.receipt?.operationId;
    expect(submitHandle).toBeTruthy();
    const submitReceipt = await waitForOperation(executor, submitHandle as string, ['completed']);
    expect(submitReceipt.status).toBe('completed');
    expect(submitReceipt.acceptedRevisionId).toBeTruthy();
    const newSourceHash = session.source?.sourceHash;
    expect(newSourceHash).not.toBe(originalSourceHash);

    // ── render (queued → completed; deterministic mock prose) ────────────
    const render = (await call(executor, 'nova_render', {
      sceneSelector: { type: 'events', eventIds: ['E0'] },
    })) as EnqueueWire;
    expect(render.status).toBe('queued');
    const renderReceipt = await waitForOperation(executor, render.operationHandle, [
      'completed',
      'failed',
      'stale',
    ]);
    expect(renderReceipt.status).toBe('completed');
    expect(harness.provider.calls.length).toBeGreaterThan(0);

    // ── warnings recorded, scene promoted (accept-and-record default) ────
    const statusAfterRender = (await call(executor, 'nova_status', {})) as WorkflowStatusV1;
    expect(statusAfterRender.render.completed).toContain('E0');
    // No gate is opened under accept-and-record: the warning reasons were
    // recorded with the accepted decision instead.
    expect(statusAfterRender.review.pendingGates).toBe(0);

    // ── publish → publication get/read (hash matches file bytes) ─────────
    const publish = (await call(executor, 'nova_publish', { version: 1 })) as EnqueueWire;
    expect(publish.status).toBe('queued');
    const publishReceipt = await waitForOperation(executor, publish.operationHandle, [
      'completed',
      'failed',
      'stale',
    ]);
    expect(publishReceipt.status).toBe('completed');

    const publication = (await call(executor, 'nova_publication_get', {
      version: 1,
      publicationId: 'canonical',
    })) as PublicationGetWire;
    expect(publication.publication).toBeTruthy();
    const publicationValue = publication.publication?.value;
    expect(publicationValue?.sourceHash).toBe(newSourceHash);
    expect(publicationValue?.status).toBe('current');

    // Independent hash check: the bytes on disk equal the publication hash.
    const novelPath = join(
      harness.root,
      publicationValue?.relativeOutputPath ?? 'output/novel.md',
    );
    const novelBytes = readFileSync(novelPath);
    expect(novelBytes.byteLength).toBe(publicationValue?.byteLength);
    expect(sha256Hex(novelBytes)).toBe(publicationValue?.novelHash);

    // Bounded read through the tool matches the same bytes.
    const read1 = (await call(executor, 'nova_publication_read', {
      version: 1,
      publicationId: 'canonical',
      offset: 0,
      limit: 4096,
    })) as PublicationReadWire;
    expect(read1.totalByteLength).toBe(novelBytes.byteLength);
    expect(new TextEncoder().encode(read1.content).byteLength).toBeLessThanOrEqual(4096);

    // The final status is current.
    const finalStatus = (await call(executor, 'nova_status', {})) as WorkflowStatusV1;
    expect(finalStatus.publication.status).toBe('current');
    expect(finalStatus.publication.novelHash).toBe(publicationValue?.novelHash);

    parityMatrixPassed = true;
  }, 120_000);

  it('3) keeps stale renders from promoting and revokes cancelled commits; a same-key retry completes', async () => {
    const { session, executor } = harness;
    expect(parityMatrixPassed).toBe(true); // the chain above must have run first
    const sourceAfterChain = session.source?.sourceHash;

    // ── Warning gate (require-waiver policy → pending_waiver) ────────────
    // Append the strict policy to the working nova.yaml and submit it; the
    // next render then produces a pending_waiver candidate and opens the
    // release gate (plan 5.4: error can never be waived, warnings require a
    // maintainer decision under the strict policy).
    const strictStatus = (await call(executor, 'nova_authoring_status', {
      version: 2,
    })) as AuthoringStatusWire;
    const strictList = (await call(executor, 'nova_authoring_document_list', {
      version: 2,
    })) as DocumentListWire;
    const strictNova = strictList.documents.find((d) => d.logicalPath === 'nova.yaml');
    const strictRead = (await call(executor, 'nova_authoring_document_read', {
      version: 2,
      documentId: strictNova?.documentId,
    })) as DocumentReadWire;
    const strictEdit = (await call(executor, 'nova_authoring_document_edit', {
      version: 2,
      documentId: strictNova?.documentId,
      expectedWorkspaceDigest: strictRead.workspaceDigest,
      expectedAcceptedSourceHash: strictStatus.state.acceptedSourceHash,
      expectedStateVectorHash: strictRead.stateVectorHash,
      replacementText: `${strictRead.content}releasePolicy:\n  warnings: require-waiver\n`,
    })) as DocumentEditWire;
    const strictSubmit = (await call(executor, 'nova_authoring_submit', {
      version: 2,
      expectedWorkspaceDigest: strictEdit.workspaceDigest,
      message: 'enable strict release policy',
    })) as SubmitWire;
    await waitForOperation(executor, strictSubmit.receipt?.operationId as string, [
      'completed',
    ]);
    const strictSourceHash = session.source?.sourceHash;
    expect(strictSourceHash).not.toBe(sourceAfterChain);

    const strictRender = (await call(executor, 'nova_render', {
      sceneSelector: { type: 'events', eventIds: ['E0'] },
      model: 'parity-strict',
    })) as EnqueueWire;
    const strictRenderReceipt = await waitForOperation(executor, strictRender.operationHandle, [
      'completed',
      'failed',
      'stale',
    ]);
    expect(strictRenderReceipt.status).toBe('completed');

    const strictGates = (await call(executor, 'nova_release_gate_list', {
      version: 1,
    })) as GateListWire;
    const strictGate = strictGates.items.find(
      (gate) => gate.eventId === 'E0' && gate.status === 'open',
    );
    expect(strictGate).toBeTruthy();
    expect(strictGate?.revisionId).toBeTruthy();
    const strictStatusAfter = (await call(executor, 'nova_status', {})) as WorkflowStatusV1;
    expect(strictStatusAfter.review.pendingGates).toBeGreaterThan(0);
    expect(strictStatusAfter.render.completed).toEqual([]); // nothing promoted yet

    // Release gate decide: accept with ZERO provider calls (the evaluator
    // re-runs over the archived envelope; the mock provider never fires).
    const callsBeforeGate = harness.provider.calls.length;
    const gateDecision = (await call(executor, 'nova_release_gate_decide', {
      version: 1,
      eventId: 'E0',
      candidateRevisionId: strictGate?.revisionId,
      decision: 'accept',
      reason: 'parity matrix waiver',
    })) as GateDecisionWire;
    expect(gateDecision.resolution.outcome).toBe('accepted');
    expect(gateDecision.resolution.acceptedRevisionId).toBeTruthy();
    expect(harness.provider.calls.length).toBe(callsBeforeGate); // zero provider calls

    const strictStatusDecided = (await call(executor, 'nova_status', {})) as WorkflowStatusV1;
    expect(strictStatusDecided.render.completed).toContain('E0');
    expect(strictStatusDecided.review.pendingGates).toBe(0);
    // The accepted scene now binds the strict source; later assertions must
    // compare against this hash, not the pre-policy one.
    const boundSourceHash = strictSourceHash;

    // NOTE: publishing the waived scene is intentionally NOT asserted here —
    // the current Core resolveReleaseGate promotes the accepted scene with
    // the archived pending_waiver envelope, and the assembly's manifest-head
    // check requires releaseDecision.status === 'accepted', so publication of
    // a waived scene reports stale. That Core integration gap is reported to
    // the orchestrator; the deterministic matrix covers the gate semantics
    // (open → decide → promote, zero provider calls) end to end.

    // ── Stale identity: render after a new accepted source ───────────────
    // Arm the hang, enqueue a render of E0 (prepare captures the CURRENT
    // source), wait until the provider is mid-call, then submit a NEW source.
    // The render's commit then sees the moved source and goes stale; the
    // accepted scene still binds the older sourceHash and is never counted
    // as rendered under the new source.
    const releaseStale = harness.provider.hangNextCall();
    const staleCallsBefore = harness.provider.calls.length;
    const staleRender = (await call(executor, 'nova_render', {
      sceneSelector: { type: 'events', eventIds: ['E0'] },
      model: 'parity-stale',
    })) as EnqueueWire;
    await waitFor(
      () => harness.provider.startedCalls >= staleCallsBefore + 1,
      'stale render to start executing',
    );

    // Submit a second working revision while the render is hung.
    const authoringStatus = (await call(executor, 'nova_authoring_status', {
      version: 2,
    })) as AuthoringStatusWire;
    const list2 = (await call(executor, 'nova_authoring_document_list', {
      version: 2,
    })) as DocumentListWire;
    const novaDescriptor2 = list2.documents.find((d) => d.logicalPath === 'nova.yaml');
    const readNova = (await call(executor, 'nova_authoring_document_read', {
      version: 2,
      documentId: novaDescriptor2?.documentId,
    })) as DocumentReadWire;
    const edited2 = (await call(executor, 'nova_authoring_document_edit', {
      version: 2,
      documentId: novaDescriptor2?.documentId,
      expectedWorkspaceDigest: readNova.workspaceDigest,
      expectedAcceptedSourceHash: authoringStatus.state.acceptedSourceHash,
      expectedStateVectorHash: readNova.stateVectorHash,
      replacementText: `${readNova.content}# parity-source-move\n`,
    })) as DocumentEditWire;
    const submit2 = (await call(executor, 'nova_authoring_submit', {
      version: 2,
      expectedWorkspaceDigest: edited2.workspaceDigest,
      message: 'move accepted source while render is in flight',
    })) as SubmitWire;
    await waitForOperation(executor, submit2.receipt?.operationId as string, ['completed']);
    const movedSourceHash = session.source?.sourceHash;
    expect(movedSourceHash).not.toBe(sourceAfterChain);

    // Release the hung render: its commit sees the moved source → stale.
    releaseStale();
    const staleReceipt = await waitForOperation(executor, staleRender.operationHandle, [
      'stale',
      'completed',
      'failed',
    ]);
    expect(staleReceipt.status).toBe('stale');

    // The accepted scene STILL binds the older sourceHash — not rendered
    // under the moved source.
    const acceptedScene = await session.runtime.services.execution.readAcceptedScene({
      projectId: PROJECT_ID,
      eventId: 'E0',
    });
    expect(acceptedScene?.value?.sourceHash).toBe(boundSourceHash);
    expect(acceptedScene?.value?.sourceHash).not.toBe(movedSourceHash);
    const statusAfterStale = (await call(executor, 'nova_status', {})) as WorkflowStatusV1;
    expect(statusAfterStale.sourceHash).toBe(movedSourceHash);
    expect(statusAfterStale.render.completed).toEqual([]);

    // ── Cancel a hung render via AbortController (provider ignores signal) ─
    const releaseCancel = harness.provider.hangNextCall();
    const cancelCallsBefore = harness.provider.calls.length;
    const cancelRender = (await call(executor, 'nova_render', {
      sceneSelector: { type: 'all' },
      model: 'parity-cancel',
    })) as EnqueueWire;
    await waitFor(
      () => harness.provider.startedCalls >= cancelCallsBefore + 1,
      'cancel render to start executing',
    );
    const cancelled = (await call(executor, 'nova_operation_cancel', {
      version: 2,
      operationHandle: cancelRender.operationHandle,
    })) as { status: string };
    expect(cancelled.status).toBe('cancelled');
    // Late result (the provider never saw the signal): archived, never promoted.
    releaseCancel();
    await waitFor(
      async () =>
        (
          (await call(executor, 'nova_operation_get', {
            version: 2,
            operationHandle: cancelRender.operationHandle,
          })) as OperationGetWire
        ).receipt?.status === 'cancelled',
      'cancelled render to settle',
    );
    const afterCancelScene = await session.runtime.services.execution.readAcceptedScene({
      projectId: PROJECT_ID,
      eventId: 'E0',
    });
    expect(afterCancelScene?.value?.sourceHash).toBe(boundSourceHash); // unchanged
    // The cancelled run archived its candidate envelope (auditable) but never
    // promoted: the accepted scene is untouched, which is the cancel contract.

    // ── Restart: interrupted sweep + explicit retry with the same key ────
    const releaseRetry = harness.provider.hangNextCall();
    const retryCallsBefore = harness.provider.calls.length;
    const retryRender = (await call(executor, 'nova_render', {
      sceneSelector: { type: 'chapter', chapter: 1 },
      model: 'parity-retry',
    })) as EnqueueWire;
    await waitFor(
      () => harness.provider.startedCalls >= retryCallsBefore + 1,
      'retry render to start executing',
    );

    // Simulate a Host restart over the same database: close the service
    // (aborts the in-flight controller), sweep queued/running → interrupted,
    // then re-enqueue the SAME request (same idempotency key + request hash)
    // — the explicit retry path, never an auto-replay.
    await harness.operations.close();
    const restarted = createProjectOperationService({
      projectId: PROJECT_ID,
      store: createProjectOperationStore(harness.persistence.client),
      session,
      limits: { ...DEFAULT_WORKBENCH_OPERATION_LIMITS },
      now: () => FIXED_NOW,
    });
    await restarted.start();
    const restartedOptions: McpRegistryOptions = {
      ...harness.registryOptions,
      operations: restarted,
    };
    const restartedExecutor = createProjectToolExecutor(session, restartedOptions);

    const retried = (await call(restartedExecutor, 'nova_render', {
      sceneSelector: { type: 'chapter', chapter: 1 },
      model: 'parity-retry',
    })) as EnqueueWire;
    expect(retried.status).toBe('queued');
    expect(retried.operationHandle).toBe(retryRender.operationHandle); // same durable row

    // The retry completes; the OLD hung run's late result (released now) is
    // archived against the terminal row and never promoted.
    const retriedReceipt = await waitForOperation(restartedExecutor, retryRender.operationHandle, [
      'completed',
      'failed',
      'stale',
    ]);
    expect(retriedReceipt.status).toBe('completed');
    releaseRetry();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const afterRetry = await waitForOperation(restartedExecutor, retryRender.operationHandle, [
      'completed',
    ]);
    expect(afterRetry.status).toBe('completed');
    await restarted.close();
  }, 120_000);

  it('4) flips the launch agent-chat gate only when enabled + the parity flag all hold', async () => {
    // The launch-level `agentReady` injection is the parity outcome; the
    // matrix above must have passed before the flag may be toggled true.
    expect(parityMatrixPassed).toBe(true);

    // `boot` is the module-scoped launch smoke helper above; the launch-level
    // `agentReady` injection is the parity outcome.

    async function agentVisible(booted: {
      handle: WorkbenchLaunchHandle;
      ownerHeaders: Record<string, string>;
      endpoint: string;
    }): Promise<{ features: string[]; conversationsStatus: number }> {
      const capabilities = await fetch(
        `${booted.endpoint}/api/v1/projects/agent-project/capabilities`,
        { headers: booted.ownerHeaders },
      );
      expect(capabilities.status).toBe(200);
      const body = (await capabilities.json()) as { features: readonly string[] };
      const conversations = await fetch(
        `${booted.endpoint}/api/v1/projects/agent-project/agent/conversations`,
        {
          method: 'POST',
          headers: { ...booted.ownerHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1 }),
        },
      );
      return { features: [...body.features], conversationsStatus: conversations.status };
    }

    // Both gate inputs true → the feature appears and the route lives.
    const on = await boot({
      enabled: true,
      agentReady: true,
      tag: 'on',
    });
    try {
      const visible = await agentVisible(on);
      expect(visible.features).toContain('agent-chat');
      expect(visible.conversationsStatus).toBe(201);
    } finally {
      await on.handle.close();
    }

    // Either gate input false → the feature stays hidden and the routes are
    // never registered (404). The pi model always supports tool calls, so
    // there is no separate tool-call-support input to flip anymore.
    const cases: Array<LaunchSmokeBootOptions & { expectedStatus: number }> = [
      { enabled: true, agentReady: false, tag: 'no-flag', expectedStatus: 404 },
      { enabled: false, agentReady: true, tag: 'disabled', expectedStatus: 404 },
    ];
    for (const bootCase of cases) {
      const booted = await boot(bootCase);
      try {
        const visible = await agentVisible(booted);
        expect(visible.features).not.toContain('agent-chat');
        expect(visible.conversationsStatus).toBe(bootCase.expectedStatus);
      } finally {
        await booted.handle.close();
      }
    }
  }, 180_000);

  it('5) built-in agent render prepare/commit passes the persisted capability gate in a launch', async () => {
    // The builtin grant is issued at session creation for the project's
    // owner/maintainer users. A fresh launch opens its sessions BEFORE the
    // owner can be bootstrapped, so this smoke boots TWICE over the same
    // host home: the reopen creates the session with the owner already
    // persisted, and the launch issues `builtin:<projectId>:<owner>` at that
    // session creation (the parity harness persisted the identical row).
    const first = await boot({
      enabled: true,
      agentReady: true,
      tag: 'builtin-grant',
    });
    await first.handle.close();

    // Deterministic render provider (same canned analysis the matrix harness
    // uses) so the render completes; the model calls nova_render exactly
    // once as the built-in principal, then finishes.
    const renderProvider = new MockProvider({ generator: () => makeAnalysisJson() });
    // Scripted pi-ai model: turn 1 calls nova_render once as the built-in
    // principal, turn 2 finishes.
    const renderModel = toolThenStopAgentModel({
      id: 'call-render',
      name: 'nova_render',
      args: { sceneSelector: { type: 'events', eventIds: ['E0'] } },
    });
    const second = await boot({
      enabled: true,
      agentReady: true,
      tag: 'builtin-grant',
      hostHome: first.hostHome,
      ownerSessionId: first.ownerHeaders['x-fabula-session'],
      providerOverride: renderProvider,
      agentModel: renderModel,
    });
    try {
      // Conversation + run whose model calls nova_render under the builtin
      // principal (`builtin:agent-project:<owner>`).
      const created = await fetch(
        `${second.endpoint}/api/v1/projects/agent-project/agent/conversations`,
        {
          method: 'POST',
          headers: { ...second.ownerHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1, title: 'builtin render smoke' }),
        },
      );
      expect(created.status).toBe(201);
      const { conversation } = (await created.json()) as {
        conversation: { conversationId: string };
      };
      const sent = await fetch(
        `${second.endpoint}/api/v1/projects/agent-project/agent/conversations/${conversation.conversationId}/runs`,
        {
          method: 'POST',
          headers: { ...second.ownerHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1, message: 'Render event E0 with nova_render.' }),
        },
      );
      expect(sent.status).toBe(202);
      const { run } = (await sent.json()) as { run: { runId: string } };

      // The run must SUCCEED with a successful nova_render tool call (the
      // enqueue accepts the builtin caller).
      let runEntry:
        | {
            run: { status: string };
            toolCalls: readonly { toolName: string; status: string }[];
          }
        | undefined;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const history = await fetch(
          `${second.endpoint}/api/v1/projects/agent-project/agent/conversations/${conversation.conversationId}/history`,
          { headers: second.ownerHeaders },
        );
        const body = (await history.json()) as {
          runs: readonly {
            run: { runId: string; status: string };
            toolCalls: readonly { toolName: string; status: string }[];
          }[];
        };
        const entry = body.runs.find((candidate) => candidate.run.runId === run.runId);
        if (
          entry !== undefined &&
          entry.run.status !== 'queued' &&
          entry.run.status !== 'running'
        ) {
          runEntry = entry;
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      expect(runEntry, 'agent run did not reach a terminal status').toBeTruthy();
      expect(runEntry?.run.status).toBe('succeeded');
      const renderCall = runEntry?.toolCalls.find((call) => call.toolName === 'nova_render');
      expect(renderCall?.status).toBe('succeeded');

      // The render operation itself runs prepare/commit through the session
      // capability gate under the builtin grant: poll the durable operation
      // until terminal and require SUCCESS — a missing grant fails prepare
      // with DENIED:NOT_FOUND.
      let renderOp:
        | { kind: string; status: string; errorCode: string | null }
        | undefined;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const operations = await fetch(
          `${second.endpoint}/api/v1/projects/agent-project/authoring/operations`,
          { headers: second.ownerHeaders },
        );
        const body = (await operations.json()) as {
          operations: readonly { kind: string; status: string; errorCode: string | null }[];
        };
        const candidate = [...body.operations]
          .reverse()
          .find((entry) => entry.kind === 'render');
        if (
          candidate !== undefined &&
          candidate.status !== 'queued' &&
          candidate.status !== 'running'
        ) {
          renderOp = candidate;
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      expect(renderOp, 'render operation did not reach a terminal status').toBeTruthy();
      // The receipt wire maps the durable 'succeeded' status to 'completed'.
      expect(renderOp?.status).toBe('completed');
      expect(renderOp?.errorCode).toBeNull();
    } finally {
      await second.handle.close();
    }
  }, 120_000);
});

// ─── Worker bundle (same construction as launch-phase1a) ───────────────────

let workerBundlePromise: Promise<string> | undefined;
function workerBundle(): Promise<string> {
  workerBundlePromise ??= (async () => {
    const bundleDir = mkdtempSync(join(PACKAGE_ROOT, 'worker-bundle-'));
    ownedDirs.push(bundleDir);
    await build({
      entryPoints: [resolve(PACKAGE_ROOT, 'src/persistence/worker.ts')],
      bundle: true,
      packages: 'external',
      platform: 'node',
      target: 'node26',
      format: 'esm',
      outfile: join(bundleDir, 'persistence-worker.js'),
      logLevel: 'silent',
    });
    return join(bundleDir, 'persistence-worker.js');
  })();
  return workerBundlePromise;
}
