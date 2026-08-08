// ============================================================================
// Guarded browser project import surface (author-mode plan Step 3)
// ----------------------------------------------------------------------------
// The author-facing "import an existing project" seam: the browser supplies
// an absolute `sourcePath` (from a folder picker on the desktop Host) and the
// Host copies that tree into the managed root (`$WORKBENCH_HOME/projects/
// <projectId>`) and registers the project through the single validated
// configuration writer. The route is owner-only, exactly like the admin
// surface: the browser never supplies a project id, a root, a session, or
// filesystem material beyond the source path.
//
// Copy semantics are `cp -r` with author-internal directories dropped: `.git`,
// `.nova` and `output` never enter the managed root (the original directory is
// left untouched and remains the author's reference). The import fails closed
// on every boundary: missing/undirectory source -> 404, unparseable or
// id-less nova.yaml -> 400, existing managed target -> 409, and a rejected
// configuration registration rolls the copied tree back so the managed root
// never holds an unregistered project.
// ============================================================================

import { cp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Context, Handler } from 'hono';
import YAML from 'yaml';
import {
  BROWSER_API_VERSION,
  BROWSER_PROJECT_IMPORT_PATH,
  type BrowserProjectImportResultV1,
  type BrowserSessionPrincipalV1,
} from '../contracts/browser-api.js';
import {
  DEFAULT_WORKBENCH_AGENT_CONFIGURATION,
  DEFAULT_WORKBENCH_OPERATION_LIMITS,
  DEFAULT_WORKBENCH_REFERENCE_LIMITS,
  DEFAULT_WORKBENCH_RENDER_POLICY,
  type WorkbenchConfigurationV1,
} from '../contracts/configuration.js';
import type { BrowserPrincipalResolver } from './browser-read-api.js';
import { errorResponse } from './browser-read-api.js';
import type { ConfigurationChangeService } from './configuration-service.js';
import type { HostListenerEnv, MutationHttpMethod } from './listener.js';
import type { HostServer } from './server.js';

/** Same shape as the configuration file store's project-id rule. */
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** Author-internal directories that never cross into the managed root. */
const EXCLUDED_TREE_NAMES: readonly string[] = ['.git', '.nova', 'output'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface BrowserImportApiOptions {
  /** Resolves the browser session principal; the import route is owner-only. */
  readonly principal: BrowserPrincipalResolver;
  /** The single validated configuration writer; the import registers through it. */
  readonly configuration: ConfigurationChangeService;
  /** Host-managed base directory; every project root derives from it. */
  readonly hostHome: string;
}

export interface BrowserImportApiSurface {
  register(host: HostServer): void;
}

class BrowserImportApiImpl {
  constructor(readonly options: BrowserImportApiOptions) {}

  /** Owner gate, mirroring the admin surface's `requireOwner` chain. */
  async requireOwner(c: Context<HostListenerEnv>): Promise<Response | BrowserSessionPrincipalV1> {
    const resolution = await this.options.principal.resolve(c.req.raw);
    if (!resolution.ok) {
      return errorResponse(
        resolution.failure,
        resolution.failure === 'SESSION_EXPIRED'
          ? 'The session has expired.'
          : 'The session is missing, revoked, or unknown.',
      );
    }
    if (resolution.principal.role !== 'owner') {
      return errorResponse(
        'PROJECT_MISMATCH',
        'The owner role is required to import projects into the managed root.',
      );
    }
    return resolution.principal;
  }

  /** Minimal full configuration used when the Host is not configured yet. */
  baseConfiguration(projectId: string, displayName: string): WorkbenchConfigurationV1 {
    return {
      version: 1,
      projects: [
        {
          projectId,
          displayName,
          revisionMirror: { mode: 'disabled' },
          providerProfile: 'default',
          trustedPlugins: [],
        },
      ],
      defaultProjectId: projectId,
      providers: {},
      network: { mode: 'loopback', port: 8787, allowedHosts: [], allowedOrigins: [], unixSocket: null },
      referenceLimits: { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS },
      operationLimits: { ...DEFAULT_WORKBENCH_OPERATION_LIMITS },
      agent: { ...DEFAULT_WORKBENCH_AGENT_CONFIGURATION },
      renderPolicy: { ...DEFAULT_WORKBENCH_RENDER_POLICY },
    };
  }
}

function importHandler(api: BrowserImportApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;

    const body: unknown = await c.req.raw.json().catch(() => null);
    if (!isRecord(body) || typeof body.sourcePath !== 'string' || body.sourcePath.length === 0) {
      return errorResponse(
        'PROJECT_IMPORT_INVALID',
        'import accepts exactly one field: a non-empty sourcePath string.',
      );
    }
    const sourcePath = body.sourcePath;

    // 404 — the source must exist and be a directory.
    let sourceStat;
    try {
      sourceStat = await stat(sourcePath);
    } catch {
      return errorResponse(
        'PROJECT_IMPORT_NOT_FOUND',
        `The source path does not exist: ${sourcePath}`,
      );
    }
    if (!sourceStat.isDirectory()) {
      return errorResponse('PROJECT_IMPORT_NOT_FOUND', 'The source path is not a directory.');
    }

    // 400 — the source must be a managed project with a parseable nova.yaml.
    let nova: unknown;
    try {
      nova = YAML.parse(await readFile(join(sourcePath, 'nova.yaml'), 'utf8'));
    } catch {
      return errorResponse(
        'PROJECT_IMPORT_INVALID',
        'The source does not contain a parseable nova.yaml.',
      );
    }
    if (!isRecord(nova) || typeof nova.project !== 'string' || nova.project.length === 0) {
      return errorResponse(
        'PROJECT_IMPORT_INVALID',
        'nova.yaml must declare a string `project` id.',
      );
    }
    const projectId = nova.project;
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      return errorResponse(
        'PROJECT_IMPORT_INVALID',
        `"${projectId}" is not a valid project id.`,
      );
    }
    const displayName =
      typeof nova.title === 'string' && nova.title.length > 0 ? nova.title : projectId;
    const target = join(api.options.hostHome, 'projects', projectId);

    // 409 — the managed target must not exist (on disk or in the registry).
    const active = await api.options.configuration.readActive();
    if (
      active !== null &&
      active.configuration.projects.some((project) => project.projectId === projectId)
    ) {
      return errorResponse(
        'PROJECT_IMPORT_CONFLICT',
        `Project "${projectId}" is already registered in the managed root.`,
      );
    }
    try {
      await stat(target);
      return errorResponse(
        'PROJECT_IMPORT_CONFLICT',
        `Project "${projectId}" already exists in the managed root.`,
      );
    } catch {
      // Target is free; proceed with the copy.
    }

    // Copy the source tree, then drop author-internal directories inside the
    // target so the managed root only ever holds workbench-managed content.
    try {
      await cp(sourcePath, target, { recursive: true });
      await Promise.all(
        EXCLUDED_TREE_NAMES.map((name) =>
          rm(join(target, name), { recursive: true, force: true }),
        ),
      );
    } catch {
      await rm(target, { recursive: true, force: true }).catch(() => {});
      return errorResponse(
        'PROJECT_IMPORT_INVALID',
        'The project tree could not be copied into the managed root.',
      );
    }

    // Register through the validated configuration writer under the revision
    // CAS. A rejected registration rolls the copied tree back.
    const base = active?.configuration ?? null;
    const candidate: WorkbenchConfigurationV1 =
      base === null
        ? api.baseConfiguration(projectId, displayName)
        : {
            ...base,
            projects: [
              ...base.projects,
              {
                projectId,
                displayName,
                revisionMirror: { mode: 'disabled' },
                providerProfile: 'default',
                trustedPlugins: [],
              },
            ],
            defaultProjectId: base.defaultProjectId ?? projectId,
          };
    const receipt = await api.options.configuration.apply({
      candidate,
      expectedRevision: active?.revision ?? null,
      origin: 'dashboard',
    });
    if (receipt.status === 'invalid' || receipt.status === 'stale') {
      await rm(target, { recursive: true, force: true }).catch(() => {});
      const first = receipt.diagnostics[0];
      return errorResponse(
        receipt.status === 'invalid' ? 'PROJECT_IMPORT_INVALID' : 'PROJECT_IMPORT_CONFLICT',
        first?.message ??
          'The Host rejected the project registration; the copied tree was removed.',
      );
    }

    const result: BrowserProjectImportResultV1 = {
      version: BROWSER_API_VERSION,
      projectId,
      displayName,
    };
    return c.json(result);
  };
}

export function createBrowserImportApi(options: BrowserImportApiOptions): BrowserImportApiSurface {
  const api = new BrowserImportApiImpl(options);
  const mutations: readonly {
    readonly method: MutationHttpMethod;
    readonly path: string;
    readonly handler: Handler<HostListenerEnv>;
  }[] = [{ method: 'POST', path: BROWSER_PROJECT_IMPORT_PATH, handler: importHandler(api) }];
  return {
    register(host: HostServer): void {
      for (const route of mutations)
        host.registerMutationRoute(route.method, route.path, route.handler);
    },
  };
}
