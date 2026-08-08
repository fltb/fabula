/**
 * Guarded browser scene mutation surface (plan 9.2.3): the single POST route
 * that triggers one scene render through the same durable operation path the
 * `nova_render` MCP tool uses. Identity is resolved server-side from the
 * request through the injected principal resolver; project reads are gated
 * through the injected authorization port and the server-scoped catalog —
 * the caller never supplies an actor, capability token, source, or hashes.
 *
 * The port is Host-only: the render trigger issues the capability grant,
 * builds the project registry and calls `nova_render` exactly like the MCP
 * transport would, so browser-triggered renders share the queue, the
 * two-phase lane discipline and the idempotency semantics of tool renders.
 */

import type { Context, Handler } from 'hono';
import {
  BROWSER_PROJECT_SCENE_RENDER_PATH,
  type BrowserApiErrorV1,
  type BrowserSessionPrincipalV1,
} from '../contracts/browser-api.js';
import type { SceneRenderTriggerResultV1 } from '../contracts/scene.js';
import {
  type BrowserPrincipalResolver,
  type BrowserProjectAuthorization,
  type BrowserProjectCatalog,
  errorResponse,
} from './browser-read-api.js';
import type { HostListenerEnv } from './listener.js';
import type { ProjectAccessRequiredRole, ProjectAccessService } from './project-access-service.js';
import type { HostServer } from './server.js';

/** One render-trigger outcome: the safe result or a typed browser error. */
export type BrowserSceneRenderOutcome =
  | { readonly ok: true; readonly result: SceneRenderTriggerResultV1 }
  | {
      readonly ok: false;
      readonly code: BrowserApiErrorV1['error']['code'];
      readonly message: string;
    };

/**
 * Project-scoped scene render source. The trigger receives the already
 * resolved browser actor; the Host issues the render capability and enqueues
 * the durable operation server-side.
 */
export interface BrowserSceneRenderSource {
  trigger(input: {
    readonly projectId: string;
    readonly eventId: string;
    readonly userId: string;
  }): Promise<BrowserSceneRenderOutcome>;
}

export interface BrowserSceneApiOptions {
  readonly principal: BrowserPrincipalResolver;
  /** Shared ACL/lifecycle service. When present it is the authoritative gate. */
  readonly access?: Pick<ProjectAccessService, 'authorize' | 'listProjects'>;
  readonly authorization: BrowserProjectAuthorization;
  readonly catalog: BrowserProjectCatalog;
  /** Optional until the Host wires the render trigger for the project. */
  readonly render?: BrowserSceneRenderSource;
}

export interface BrowserSceneApiSurface {
  register(host: HostServer): void;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

class BrowserSceneApiImpl {
  constructor(readonly options: BrowserSceneApiOptions) {}

  /** Identity → project param → ACL → catalog gate; the shared first half of every scene route. */
  async access(
    c: Context<HostListenerEnv>,
    requiredRole: ProjectAccessRequiredRole = 'reader',
  ): Promise<
    | {
        readonly ok: true;
        readonly principal: BrowserSessionPrincipalV1;
        readonly projectId: string;
      }
    | { readonly ok: false; readonly response: Response }
  > {
    const resolution = await this.options.principal.resolve(c.req.raw);
    if (!resolution.ok) {
      return {
        ok: false,
        response: errorResponse(
          resolution.failure === 'SESSION_EXPIRED' ? 'SESSION_EXPIRED' : 'SESSION_NOT_FOUND',
          resolution.failure === 'SESSION_EXPIRED'
            ? 'The session has expired.'
            : 'The session is missing, revoked or unknown.',
        ),
      };
    }
    const projectId = c.req.param('projectId');
    if (!isNonEmptyString(projectId)) {
      return {
        ok: false,
        response: errorResponse(
          'PROJECT_NOT_FOUND',
          "The project is not in this session's catalog.",
        ),
      };
    }
    const authorized =
      this.options.access === undefined
        ? await this.options.authorization.canAccessProject(
            resolution.principal.userId,
            projectId,
            requiredRole,
          )
        : (
            await this.options.access.authorize({
              userId: resolution.principal.userId,
              projectId,
              requiredRole,
            })
          ).ok;
    if (!authorized) {
      return {
        ok: false,
        response: errorResponse(
          'PROJECT_MISMATCH',
          'The session is not authorized for this project.',
        ),
      };
    }
    const projects = await this.options.catalog.listProjects(resolution.principal);
    if (!projects.some((project) => project.projectId === projectId)) {
      return {
        ok: false,
        response: errorResponse(
          'PROJECT_NOT_FOUND',
          "The project is not in this session's catalog.",
        ),
      };
    }
    return { ok: true, principal: resolution.principal, projectId };
  }
}

function sceneRenderHandler(api: BrowserSceneApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'author');
    if (!access.ok) return access.response;
    const eventId = c.req.param('eventId');
    if (!isNonEmptyString(eventId) || eventId.length > 256) {
      return errorResponse(
        'SCENE_RENDER_INVALID',
        'A bounded, non-empty scene event id is required.',
      );
    }
    const render = api.options.render;
    if (render === undefined) {
      return errorResponse(
        'SCENE_RENDER_UNAVAILABLE',
        'The scene render surface is not enabled for this project.',
      );
    }
    try {
      const outcome = await render.trigger({
        projectId: access.projectId,
        eventId,
        userId: access.principal.userId,
      });
      if (!outcome.ok) return errorResponse(outcome.code, outcome.message);
      return c.json(outcome.result);
    } catch {
      return errorResponse(
        'SCENE_RENDER_UNAVAILABLE',
        'The scene render could not be triggered by the host.',
      );
    }
  };
}

/** Create the guarded scene mutation surface; register it before server start. */
export function createBrowserSceneApi(options: BrowserSceneApiOptions): BrowserSceneApiSurface {
  const api = new BrowserSceneApiImpl(options);
  return {
    register(host) {
      host.registerMutationRoute(
        'POST',
        BROWSER_PROJECT_SCENE_RENDER_PATH,
        sceneRenderHandler(api),
      );
    },
  };
}
