import type { CoreRuntimeServices, ProjectCoreRuntime } from '@novalistically/core';
import {
  MCP_SCOPES_V1,
  MCP_TOOL_CATALOG_V1,
  type McpReferencePort,
} from '@novalistically/workbench-protocol';
import { describe, expect, it } from 'vitest';
import type { AgentCapabilityGrant } from '../src/host/agent/index.js';
import {
  createAdminMcpRegistry,
  createProjectSessionMcpRegistry,
  MCP_ADMIN_SCOPE,
} from '../src/host/mcp/registry.js';
import type { ProjectSession, ProjectSessionProjectionV1 } from '../src/host/project-session.js';

/**
 * Catalog-declared project tools the session registry does not implement yet.
 *
 * This list MUST stay empty: `nova_graph`, `nova_revise`, `nova_render_tree`,
 * `nova_authoring_validate` and `nova_event_state_diff` now have real handlers
 * in `createProjectSessionMcpRegistry`, so the parity gate below is exact in
 * both directions with zero orphan allowance. It must never be papered over by
 * deleting catalog entries.
 */
const KNOWN_ORPHAN_TOOLS = [] as const;

/** Every non-admin capability scope a project-scope caller can be granted. */
const PROJECT_SCOPES = MCP_SCOPES_V1.filter((scope) => scope !== MCP_ADMIN_SCOPE);

const sorted = (names: Iterable<string>): string[] => [...names].sort();

// ─── Session double ──────────────────────────────────────────────────────────
// Tool listing never touches session state; the double only needs to typecheck
// as a ProjectSession, mirroring mcp-auth-registry.test.ts's construction.

function makeProjection(): ProjectSessionProjectionV1 {
  return {
    version: 1,
    projectId: 'p1',
    revision: 1,
    sourceHash: null,
    documents: 0,
    events: 0,
    rendered: 0,
    pending: 0,
    blocked: 0,
    errorCount: 0,
    warningCount: 0,
    diagnostics: [],
    presence: [],
    generatedAt: '2026-08-02T00:00:00.000Z',
  };
}

function fakeSession(): ProjectSession {
  return {
    projectId: 'p1',
    runtime: {
      projectId: 'p1',
      services: {} as CoreRuntimeServices,
      compile: () => {
        throw new Error('compile is not exercised by the catalog parity gate');
      },
      has: () => false,
      memoizedHashes: [],
      memoSize: 0,
    } as ProjectCoreRuntime,
    source: null,
    projection: makeProjection(),
    busy: false,
    hasHumanPresence: false,
    presenceGeneration: 0,
    refreshSource: () => {
      throw new Error('refreshSource is not exercised by the catalog parity gate');
    },
    updatePresence: () => {
      throw new Error('updatePresence is not exercised by the catalog parity gate');
    },
    enqueueOperation: async () => {
      throw new Error('enqueueOperation is not exercised by the catalog parity gate');
    },
  };
}

/** Truthy reference port for tool listing only; its methods are never invoked. */
function unusedReferenceMethod(name: string): never {
  throw new Error(`reference port method ${name} is not exercised by the catalog parity gate`);
}

const STUB_REFERENCE_PORT: McpReferencePort = {
  list: () => unusedReferenceMethod('list'),
  get: () => unusedReferenceMethod('get'),
  search: () => unusedReferenceMethod('search'),
  getChunk: () => unusedReferenceMethod('getChunk'),
  readContent: () => unusedReferenceMethod('readContent'),
  importBegin: () => unusedReferenceMethod('importBegin'),
  importChunk: () => unusedReferenceMethod('importChunk'),
  importCommit: () => unusedReferenceMethod('importCommit'),
  jobGet: () => unusedReferenceMethod('jobGet'),
  retry: () => unusedReferenceMethod('retry'),
  delete: () => unusedReferenceMethod('delete'),
};

interface RegistryNames {
  readonly project: readonly string[];
  readonly admin: readonly string[];
}

function buildRegistryNames(): RegistryNames {
  const session = fakeSession();
  const project = createProjectSessionMcpRegistry(session, {
    family: 'project',
    reference: STUB_REFERENCE_PORT,
  });
  const admin = createAdminMcpRegistry(session, {});
  return {
    project: project.list(PROJECT_SCOPES).map((definition) => definition.name),
    admin: admin.list([MCP_ADMIN_SCOPE]).map((definition) => definition.name),
  };
}

/** All catalog project/authoring/reference tools: every name not `nova_admin_*`. */
function catalogProjectNames(): Set<string> {
  return new Set(
    MCP_TOOL_CATALOG_V1.filter((tool) => !tool.name.startsWith('nova_admin_')).map(
      (tool) => tool.name,
    ),
  );
}

/** All catalog `nova_admin_*` tools. */
function catalogAdminNames(): Set<string> {
  return new Set(
    MCP_TOOL_CATALOG_V1.filter((tool) => tool.name.startsWith('nova_admin_')).map(
      (tool) => tool.name,
    ),
  );
}

describe('MCP catalog ↔ registry parity', () => {
  it('declares zero catalog orphans', () => {
    // The allowlist must stay empty; any entry here is a real gap in the
    // session registry that the release gate rejects.
    expect(KNOWN_ORPHAN_TOOLS).toEqual([]);
  });

  it('matches the registry tool set to the catalog exactly in both directions', () => {
    const { project, admin } = buildRegistryNames();
    const catalogProject = catalogProjectNames();
    const catalogAdmin = catalogAdminNames();
    const projectRegistrySet = new Set(project);
    const adminRegistrySet = new Set(admin);

    // The project registry implements exactly the catalog project tools, and
    // nothing else — no orphan allowance.
    expect(projectRegistrySet).toEqual(catalogProject);
    // Reverse direction: no registry tool may exist outside the catalog.
    for (const name of project) {
      expect(catalogProject.has(name), `registry tool ${name} is missing from the catalog`).toBe(
        true,
      );
    }

    // Admin family is exact in both directions, with no orphan allowance.
    expect(adminRegistrySet).toEqual(catalogAdmin);
    for (const name of admin) {
      expect(
        catalogAdmin.has(name),
        `admin registry tool ${name} is missing from the catalog`,
      ).toBe(true);
    }

    // Sorted listing comparison: readable failure diff for any drift.
    expect(sorted(project)).toEqual(sorted(catalogProject));
    expect(sorted(admin)).toEqual(sorted(catalogAdmin));
  });

  it('registers a real handler for every catalog project tool', async () => {
    const session = fakeSession();
    const registry = createProjectSessionMcpRegistry(session, {
      family: 'project',
      reference: STUB_REFERENCE_PORT,
    });
    const grant: AgentCapabilityGrant = {
      capabilityId: 'cap-parity',
      version: 1,
      userId: 'u1',
      projectId: 'p1',
      scopes: [...PROJECT_SCOPES],
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const caller = { sessionId: 'session-live', userId: grant.userId, grant };

    for (const name of catalogProjectNames()) {
      const definition = registry.get(name);
      expect(definition, `${name} must have a registered handler`).not.toBeNull();
      if (definition === null) continue;
      // The handler must be reachable through the normal run path; the fake
      // session fails closed on queue access, so a missing handler surfaces
      // as TOOL_NOT_FOUND before any session state is touched.
      const result = await registry.run(name, caller, {});
      expect(result.ok ? true : result.error.code !== 'TOOL_NOT_FOUND').toBe(true);
    }
  });
});
