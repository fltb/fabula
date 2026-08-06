/**
 * Shared project tool orchestration for external MCP devices and the built-in
 * Agent (plan 9.1).
 *
 * The executor owns exactly ONE `createProjectSessionMcpRegistry` instance —
 * the same construction the Streamable HTTP transport uses via
 * `resolveRegistry`. It never re-implements handler, CAS, or scope logic:
 * `listTools` is the registry's own scope-filtered listing (the exact set an
 * external device with the same grant sees through `tools/list`), `callTool`
 * delegates to the registry `run()` (same `TOOL_NOT_FOUND` / `SCOPE_MISMATCH`
 * / `INTERNAL_ERROR` semantics), and `callerForRole` derives scopes from the
 * single `PROJECT_ACCESS_ROLE_GRANTS` constant.
 */
import type { ProjectAccessRole } from '../../contracts/configuration.js';
import { PROJECT_ACCESS_ROLE_GRANTS } from '../../contracts/configuration.js';
import type { McpAuthorizedCaller } from '../mcp/auth.js';
import {
  createProjectSessionMcpRegistry,
  type McpRegistryOptions,
  type McpToolDefinition,
  type McpToolRegistry,
  type McpToolResult,
} from '../mcp/registry.js';
import type { ProjectSession } from '../project-session.js';
import type { AgentCapabilityGrant } from './capability-service.js';

/**
 * Built-in Agent principal, derived from the browser session/project role.
 * `role` is the project ACL role (never `owner`): the executor's scope
 * derivation is keyed by `PROJECT_ACCESS_ROLE_GRANTS`, so submit/gate/publish
 * tools enter the model tool set only when the role is `maintainer`.
 */
export interface ProjectToolExecutorPrincipal {
  /** Server-assigned actor; callers can never supply this. */
  readonly userId: string;
  /** Project ACL role; scopes derive from {@link PROJECT_ACCESS_ROLE_GRANTS}. */
  readonly role: ProjectAccessRole;
  /** Monotonic capability version the role grant was issued under. */
  readonly capabilityVersion: number;
  /** Grant expiry; the browser-session expiry for session principals. */
  readonly expiresAt: string;
  /** Optional live session id; null/absent for device-style principals. */
  readonly sessionId?: string | null;
}

/** Host-side shared tool surface for one open project session. */
export interface ProjectToolExecutor {
  readonly projectId: string;
  /** The one ProjectSession this executor is bound to. */
  readonly session: ProjectSession;
  /**
   * The exact tools an external device granted exactly `scopes` sees through
   * `tools/list`: the registry's own scope-filtered listing, unchanged.
   */
  listTools(scopes: readonly string[]): readonly McpToolDefinition[];
  /**
   * Run one tool under a fully authorized caller. Delegates to the shared
   * registry `run()` so `TOOL_NOT_FOUND`, `SCOPE_MISMATCH`, and normalized
   * `INTERNAL_ERROR` results are byte-for-byte the transport's.
   */
  callTool(name: string, caller: McpAuthorizedCaller, input: unknown): Promise<McpToolResult>;
  /**
   * Build the authorized caller for a built-in principal: scopes come from
   * {@link PROJECT_ACCESS_ROLE_GRANTS} (single source of truth), never from a
   * duplicated role table.
   */
  callerForRole(principal: ProjectToolExecutorPrincipal): McpAuthorizedCaller;
}

/** Construct the shared executor over one project session. */
export function createProjectToolExecutor(
  session: ProjectSession,
  options: McpRegistryOptions = {},
): ProjectToolExecutor {
  const registry: McpToolRegistry = createProjectSessionMcpRegistry(session, options);
  return {
    projectId: session.projectId,
    session,
    listTools(scopes) {
      return registry.list(scopes);
    },
    callTool(name, caller, input) {
      return registry.run(name, caller, input);
    },
    callerForRole(principal) {
      const grant: AgentCapabilityGrant = {
        capabilityId: `builtin:${session.projectId}:${principal.userId}`,
        userId: principal.userId,
        projectId: session.projectId,
        scopes: PROJECT_ACCESS_ROLE_GRANTS[principal.role].scopes,
        version: principal.capabilityVersion,
        expiresAt: principal.expiresAt,
      };
      return {
        sessionId: principal.sessionId ?? null,
        userId: principal.userId,
        role: principal.role,
        projectGrant: { projectId: session.projectId, role: principal.role },
        grant,
      };
    },
  };
}
