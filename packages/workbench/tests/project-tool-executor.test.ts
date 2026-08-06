// ============================================================================
// ProjectToolExecutor tests
// ============================================================================
// Verifies that the shared executor (plan 9.1) exposes exactly the same tool
// surface an external device sees through the registry at the same scopes,
// delegates errors byte-for-byte to the shared registry, and derives built-in
// caller scopes from the single PROJECT_ACCESS_ROLE_GRANTS constant.
// ============================================================================

import type { CoreRuntimeServices, ProjectCoreRuntime } from '@novalistically/core';
import { MCP_ADMIN_SCOPE, MCP_SCOPES_V1 } from '@novalistically/workbench-protocol';
import { describe, expect, it } from 'vitest';
import { PROJECT_ACCESS_ROLE_GRANTS } from '../src/contracts/configuration.js';
import type { ProjectToolExecutorPrincipal } from '../src/host/agent/project-tool-executor.js';
import { createProjectToolExecutor } from '../src/host/agent/project-tool-executor.js';
import type { McpToolRegistry } from '../src/host/mcp/registry.js';
import { createProjectSessionMcpRegistry } from '../src/host/mcp/registry.js';
import type { ProjectSession, ProjectSessionProjectionV1 } from '../src/host/project-session.js';

/** Every non-admin capability scope a project-scope caller can be granted. */
const PROJECT_SCOPES = MCP_SCOPES_V1.filter((scope) => scope !== MCP_ADMIN_SCOPE);

// ─── Session double ──────────────────────────────────────────────────────────
// Tool listing and scope checks never touch session state; the double only
// needs to typecheck as a ProjectSession (mirrors mcp-catalog-parity.test.ts).

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
        throw new Error('compile is not exercised by the executor gate');
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
      throw new Error('refreshSource is not exercised by the executor gate');
    },
    updatePresence: () => {
      throw new Error('updatePresence is not exercised by the executor gate');
    },
    enqueueOperation: async () => {
      throw new Error('enqueueOperation is not exercised by the executor gate');
    },
  };
}

/** Same construction the Streamable HTTP transport uses per project request. */
function buildExternalRegistry(): McpToolRegistry {
  return createProjectSessionMcpRegistry(fakeSession(), { family: 'project' });
}

const PRINCIPAL: ProjectToolExecutorPrincipal = {
  userId: 'u1',
  role: 'maintainer',
  capabilityVersion: 4,
  expiresAt: '2099-01-01T00:00:00.000Z',
  sessionId: 'session-live',
};

/** Wire-relevant definition shape: names, schemas, and required scopes. */
function shapeOf(
  definitions: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
    readonly requiredScopes: readonly string[];
  }[],
) {
  return definitions.map(({ name, description, inputSchema, requiredScopes }) => ({
    name,
    description,
    inputSchema,
    requiredScopes,
  }));
}

describe('ProjectToolExecutor', () => {
  it('lists exactly the tools an external device sees at the same scopes', () => {
    const executor = createProjectToolExecutor(fakeSession(), { family: 'project' });
    const registry = buildExternalRegistry();

    for (const role of ['reader', 'author', 'maintainer'] as const) {
      const scopes = PROJECT_ACCESS_ROLE_GRANTS[role].scopes;
      // Strict equality with the same-scope external tools/list view: same
      // names, descriptions, input schemas, and required scopes.
      expect(shapeOf(executor.listTools(scopes))).toEqual(shapeOf(registry.list(scopes)));
      expect(executor.listTools(scopes).map((definition) => definition.name)).toEqual(
        registry.list(scopes).map((definition) => definition.name),
      );
    }
  });

  it('keeps the executor tool set inside the registry tool set for any grant', () => {
    const executor = createProjectToolExecutor(fakeSession(), { family: 'project' });
    const registry = buildExternalRegistry();
    const all = new Set(registry.definitions().map((definition) => definition.name));

    for (const scopes of PROJECT_SCOPES.map((scope) => [scope])) {
      for (const definition of executor.listTools(scopes)) {
        expect(all.has(definition.name), `${definition.name} outside the registry`).toBe(true);
      }
    }
  });

  it('exposes submit/gate/publish tools only for the maintainer role', () => {
    const executor = createProjectToolExecutor(fakeSession(), { family: 'project' });
    const names = (role: 'reader' | 'author' | 'maintainer'): string[] =>
      executor.listTools(PROJECT_ACCESS_ROLE_GRANTS[role].scopes).map((d) => d.name);

    for (const submitTool of [
      'nova_publish',
      'nova_authoring_submit',
      'nova_release_gate_decide',
    ]) {
      expect(names('reader')).not.toContain(submitTool);
      expect(names('author')).not.toContain(submitTool);
      expect(names('maintainer')).toContain(submitTool);
    }
  });

  it('propagates SCOPE_MISMATCH exactly like the transport registry', async () => {
    const executor = createProjectToolExecutor(fakeSession(), { family: 'project' });
    const readerCaller = executor.callerForRole({ ...PRINCIPAL, role: 'reader' });

    const viaExecutor = await executor.callTool('nova_publish', readerCaller, {});
    const registry = buildExternalRegistry();
    const viaRegistry = await registry.run('nova_publish', readerCaller, {});

    expect(viaExecutor).toEqual(viaRegistry);
    expect(viaExecutor.ok).toBe(false);
    if (!viaExecutor.ok) expect(viaExecutor.error.code).toBe('SCOPE_MISMATCH');
  });

  it('propagates TOOL_NOT_FOUND for unknown tool names', async () => {
    const executor = createProjectToolExecutor(fakeSession(), { family: 'project' });
    const caller = executor.callerForRole(PRINCIPAL);

    const result = await executor.callTool('nova_no_such_tool', caller, {});
    expect(result).toEqual({
      ok: false,
      error: { code: 'TOOL_NOT_FOUND', message: 'Unknown tool: nova_no_such_tool' },
    });
  });

  it('derives caller scopes from PROJECT_ACCESS_ROLE_GRANTS for every role', () => {
    const executor = createProjectToolExecutor(fakeSession(), { family: 'project' });

    for (const role of ['reader', 'author', 'maintainer'] as const) {
      const caller = executor.callerForRole({ ...PRINCIPAL, role });
      expect(caller.userId).toBe('u1');
      expect(caller.role).toBe(role);
      expect(caller.sessionId).toBe('session-live');
      expect(caller.projectGrant).toEqual({ projectId: 'p1', role });
      expect(caller.grant).toMatchObject({
        capabilityId: 'builtin:p1:u1',
        userId: 'u1',
        projectId: 'p1',
        version: 4,
        expiresAt: PRINCIPAL.expiresAt,
      });
      expect(caller.grant.scopes).toEqual(PROJECT_ACCESS_ROLE_GRANTS[role].scopes);
    }
  });

  it('omits sessionId for device-style principals', () => {
    const executor = createProjectToolExecutor(fakeSession(), { family: 'project' });
    const caller = executor.callerForRole({ ...PRINCIPAL, sessionId: undefined });
    expect(caller.sessionId).toBeNull();
  });

  it('accepts an authorized caller for a submit-scoped tool', async () => {
    const executor = createProjectToolExecutor(fakeSession(), { family: 'project' });
    const caller = executor.callerForRole(PRINCIPAL);

    // The grant covers mcp:submit, so the scope gate passes and the handler
    // runs; the absent coordinator port fails closed with a business error,
    // never SCOPE_MISMATCH or TOOL_NOT_FOUND.
    const result = await executor.callTool('nova_authoring_submit', caller, {});
    // The scope gate must have passed: the failure (if any) is a business
    // error from the absent coordinator port, never a scope/not-found denial.
    if (!result.ok) {
      expect(result.error.code).not.toBe('SCOPE_MISMATCH');
      expect(result.error.code).not.toBe('TOOL_NOT_FOUND');
    }
  });
});
