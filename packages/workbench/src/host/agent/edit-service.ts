/**
 * Host-only Agent editing command service: capability-gated, presence-aware,
 * scoped Yjs editing for internal Agents (the Agent Composer and future
 * authorized editors).
 *
 * Every effect runs as a ProjectSession operation, so the session re-validates
 * the opaque capability grant (existence, version, revocation, expiry,
 * project, scope) inside its serialized slot immediately before the effect
 * runs, and records typed secret-free audit metadata through the shared audit
 * sink (`buildAuditEffect`; no token, no digest). This service adds the
 * document-level editing safeguards on top of that gate:
 *
 *  - Session-bound project: every document-port mutation is addressed with
 *    the bound ProjectSession's project id, derived here — caller input can
 *    never select or override the project, so a capability/session for one
 *    project cannot mutate or revert another.
 *  - Atomic human-presence generation: the session's human-presence
 *    generation is observed together with the precheck, then re-validated by
 *    the document port inside its own mutation critical section. A human
 *    presence transition between observation and application rejects the
 *    mutation with a typed `paused` outcome and applies nothing.
 *
 *  - Human presence: when a human is actively editing the target
 *    document/scene, the effect returns a typed `paused` outcome. The caller
 *    MUST obtain a fresh state vector and replan before resuming; the paused
 *    outcome carries the live state vector to replan against.
 *  - Vector CAS: an effect is only applied when the live document state
 *    vector still equals the base vector the agent composed against. A moved
 *    document returns a typed `conflict` and is never rewritten.
 *  - Conditional compensating revert: reverting an applied effect re-validates
 *    the capability and pauses on human presence like any other effect, then
 *    applies the recorded compensating (inverse) update ONLY when the document
 *    still matches the post-effect state vector. A moved document returns a
 *    typed `conflict` — the service never rewinds a whole document, so
 *    unrelated human/peer edits are never destroyed.
 *
 * Agents can never write files, Git, or Core through this service: the only
 * mutation surface is the injected Yjs document port, and the accepted
 * Core/Git projection remains canonical and untouched.
 */
import { randomUUID } from 'node:crypto';
import type { JsonValue } from '@novalistically/core';
import type { WorkingDocumentState, YjsDocumentKey } from '../../contracts/persistence.js';
import type { ProjectSession, SessionOperationResult } from '../project-session.js';
import type { AgentCapabilityFailureCode } from './capability-service.js';

/** Maximum applied-effect tickets retained for conditional reverts (FIFO). */
export const MAX_TRACKED_EFFECT_TICKETS = 256;

/** One applied scoped effect; the host derives the compensating update at apply time. */
export interface AgentAppliedTicket {
  /** Live document state vector after the effect applied. */
  readonly stateVector: Uint8Array;
  /** Full persisted working-document update after the effect. */
  readonly update: Uint8Array;
  /** Compensating (inverse) update reverting exactly this effect's changes. */
  readonly compensatingUpdate: Uint8Array;
}

/**
 * Injected Yjs document operations (working layer only). The implementation
 * owns the Yjs mechanics (merge, diff, compensating-update derivation); this
 * service only ever sees opaque byte payloads and state vectors, and never
 * touches files, Git, or the accepted Core projection.
 */
export interface AgentDocumentPort {
  /** Load the persisted working document; null when it has no working state yet. */
  load(key: YjsDocumentKey): Promise<WorkingDocumentState | null>;
  /**
   * Apply a scoped agent update under a compare-and-swap guard: the live
   * document state vector must equal `expectedBaseVector` AND the
   * human-presence generation must still equal
   * `expectedHumanPresenceGeneration` (observed when the caller prechecked
   * presence). Both are validated atomically inside the document's own
   * mutation critical section. The host derives and returns the compensating
   * update for exactly this effect. A moved vector returns a stale verdict; a
   * presence transition returns a paused verdict; nothing is applied and
   * nothing is rewound.
   */
  applyScopedUpdate(input: {
    readonly projectId: string;
    readonly documentId: string;
    readonly expectedBaseVector: Uint8Array;
    readonly update: Uint8Array;
    /** Human-presence generation observed at precheck time; a newer one rejects the mutation. */
    readonly expectedHumanPresenceGeneration: number;
  }): Promise<
    | { readonly ok: true; readonly ticket: AgentAppliedTicket }
    | { readonly ok: false; readonly reason: 'stale-vector'; readonly liveStateVector: Uint8Array }
    | {
        readonly ok: false;
        readonly reason: 'human-presence-changed';
        readonly liveStateVector: Uint8Array;
      }
  >;
  /**
   * Apply the compensating update for one previously applied effect, guarded
   * by the post-effect state vector CAS and the same atomic human-presence
   * generation check. Only the effect's own changes are compensated — never a
   * whole-document rewind.
   */
  applyCompensatingUpdate(input: {
    readonly projectId: string;
    readonly documentId: string;
    readonly expectedVector: Uint8Array;
    readonly compensatingUpdate: Uint8Array;
    /** Human-presence generation observed at precheck time; a newer one rejects the mutation. */
    readonly expectedHumanPresenceGeneration: number;
  }): Promise<
    | { readonly ok: true; readonly stateVector: Uint8Array }
    | { readonly ok: false; readonly reason: 'stale-vector'; readonly liveStateVector: Uint8Array }
    | {
        readonly ok: false;
        readonly reason: 'human-presence-changed';
        readonly liveStateVector: Uint8Array;
      }
  >;
}

/**
 * Document/scene-scoped human-presence resolution. Defaults to the shared
 * ProjectSession projection (any human surface pauses agent edits); wiring may
 * inject a finer tracker that resolves which document/scene a human is
 * editing right now.
 */
export interface AgentPresencePort {
  isHumanEditing(input: {
    readonly projectId: string;
    readonly documentId: string;
    readonly sceneId?: string;
  }): boolean | Promise<boolean>;
}

export interface AgentEditEffectInput {
  readonly documentId: string;
  readonly sceneId?: string;
  /** Opaque server-side grant id; actor and scope truth come from the persisted grant. */
  readonly capabilityId: string;
  /** Capability scope required for this effect; validated against the grant before running. */
  readonly scope: readonly string[];
  /** Version binding; a persisted grant version different from this fails the gate. */
  readonly expectedVersion?: number;
  /** Base document state vector the agent composed the effect against (read-time truth). */
  readonly expectedBaseVector: Uint8Array;
  /** Scoped Yjs update carrying exactly the agent's intended changes. */
  readonly update: Uint8Array;
}

export interface AgentRevertEffectInput {
  readonly documentId: string;
  readonly sceneId?: string;
  /** Opaque server-side grant id; actor and scope truth come from the persisted grant. */
  readonly capabilityId: string;
  /** Capability scope required for this effect; validated against the grant before running. */
  readonly scope: readonly string[];
  /** Version binding; a persisted grant version different from this fails the gate. */
  readonly expectedVersion?: number;
  /** Effect ticket id returned by a previous `applied` outcome. */
  readonly effectId: string;
}

export type AgentEffectDeniedResult = {
  readonly status: 'denied';
  readonly reason: AgentCapabilityFailureCode;
};

export type AgentEffectFailedResult = {
  readonly status: 'failed';
  readonly errorCode: string;
  readonly message: string;
};

/** Successful/checkpoint outcomes of an apply effect; denied/failed are added by the wrapper. */
export type AgentEditEffectOutcome =
  | {
      readonly status: 'applied';
      readonly effectId: string;
      readonly projectId: string;
      readonly documentId: string;
      /** Live document state vector after the effect; the base for the next effect. */
      readonly stateVector: Uint8Array;
      /** Full persisted working-document update after the effect. */
      readonly update: Uint8Array;
    }
  | {
      readonly status: 'paused';
      readonly reason: 'human-presence';
      readonly projectId: string;
      readonly documentId: string;
      readonly sceneId?: string;
      /** Live document state vector to replan against; null when the document has no state yet. */
      readonly liveStateVector: Uint8Array | null;
      /** A fresh state vector must be read and the edit recomposed before retrying. */
      readonly replanRequired: true;
    }
  | {
      readonly status: 'conflict';
      readonly reason: 'stale-vector';
      readonly projectId: string;
      readonly documentId: string;
      readonly liveStateVector: Uint8Array;
    };

export type AgentEditEffectResult =
  | AgentEditEffectOutcome
  | AgentEffectDeniedResult
  | AgentEffectFailedResult;

/** Successful/checkpoint outcomes of a revert effect; denied/failed are added by the wrapper. */
export type AgentRevertEffectOutcome =
  | {
      readonly status: 'reverted';
      readonly effectId: string;
      readonly projectId: string;
      readonly documentId: string;
      /** Live document state vector after the compensating update. */
      readonly stateVector: Uint8Array;
    }
  | {
      readonly status: 'paused';
      readonly reason: 'human-presence';
      readonly projectId: string;
      readonly documentId: string;
      readonly sceneId?: string;
      readonly liveStateVector: Uint8Array | null;
      readonly replanRequired: true;
    }
  | {
      readonly status: 'conflict';
      /** `stale-vector`: the document moved since the effect applied. `unknown-effect`: no matching ticket. */
      readonly reason: 'stale-vector' | 'unknown-effect';
      readonly projectId: string;
      readonly documentId: string;
      readonly liveStateVector?: Uint8Array;
    };

export type AgentRevertEffectResult =
  | AgentRevertEffectOutcome
  | AgentEffectDeniedResult
  | AgentEffectFailedResult;

export interface AgentCommandServiceOptions {
  /**
   * Shared ProjectSession: effects run through its serialized,
   * capability-gated operation queue and its presence projection; the
   * document-port project id and the atomic human-presence generation are
   * both derived from this session, never from caller input. Audit flows
   * through the session's shared sink.
   */
  readonly session: Pick<
    ProjectSession,
    'enqueueOperation' | 'projection' | 'hasHumanPresence' | 'projectId' | 'presenceGeneration'
  >;
  /** Injected Yjs document operations (working layer only). */
  readonly documents: AgentDocumentPort;
  /** Document/scene-scoped human-presence resolution; defaults to the session projection. */
  readonly presence?: AgentPresencePort;
  /** Effect ticket id source; defaults to a fresh random id per effect. */
  readonly newEffectId?: () => string;
  /** Bounded applied-effect tickets retained for conditional reverts; default {@link MAX_TRACKED_EFFECT_TICKETS}. */
  readonly maxTrackedEffectTickets?: number;
}

/** Maximum characters retained from a failed-effect message. */
const MAX_FAILED_MESSAGE_LENGTH = 512;

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'agent.edit.failed';
}

function errorMessageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_FAILED_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_FAILED_MESSAGE_LENGTH)}…`
    : message;
}

/** Host-held applied-effect ticket used by conditional compensating reverts. */
interface AppliedEffectTicket {
  readonly effectId: string;
  readonly projectId: string;
  readonly documentId: string;
  /** Post-effect state vector; the revert CAS compares the live vector against it. */
  readonly stateVector: Uint8Array;
  readonly compensatingUpdate: Uint8Array;
}

/**
 * Editing safeguards for internal Agents over injected Yjs document
 * operations and a shared ProjectSession. Construct once per Host process and
 * share: the applied-effect ticket store is host-held and bounded.
 */
export class AgentCommandService {
  readonly #session: Pick<
    ProjectSession,
    'enqueueOperation' | 'projection' | 'hasHumanPresence' | 'projectId' | 'presenceGeneration'
  >;
  readonly #documents: AgentDocumentPort;
  readonly #presence: AgentPresencePort;
  readonly #newEffectId: () => string;
  readonly #maxTrackedTickets: number;
  /** Applied-effect tickets keyed by effect id, oldest-first (FIFO-bounded). */
  readonly #tickets = new Map<string, AppliedEffectTicket>();

  constructor(options: AgentCommandServiceOptions) {
    const session = options.session;
    if (
      session === null ||
      typeof session !== 'object' ||
      typeof session.enqueueOperation !== 'function' ||
      session.projection === null ||
      typeof session.projection !== 'object' ||
      typeof session.hasHumanPresence !== 'boolean' ||
      typeof session.projectId !== 'string' ||
      session.projectId.length === 0 ||
      typeof session.presenceGeneration !== 'number'
    ) {
      throw new TypeError(
        'AgentCommandService requires a ProjectSession (enqueueOperation, projection, hasHumanPresence, projectId, presenceGeneration)',
      );
    }
    const documents = options.documents;
    if (
      documents === null ||
      typeof documents !== 'object' ||
      typeof documents.load !== 'function' ||
      typeof documents.applyScopedUpdate !== 'function' ||
      typeof documents.applyCompensatingUpdate !== 'function'
    ) {
      throw new TypeError(
        'AgentCommandService requires an injected AgentDocumentPort (load, applyScopedUpdate, applyCompensatingUpdate)',
      );
    }
    const presence = options.presence;
    if (
      presence !== undefined &&
      (presence === null ||
        typeof presence !== 'object' ||
        typeof presence.isHumanEditing !== 'function')
    ) {
      throw new TypeError('AgentCommandService presence port must implement isHumanEditing');
    }
    const maxTracked = options.maxTrackedEffectTickets ?? MAX_TRACKED_EFFECT_TICKETS;
    if (!Number.isInteger(maxTracked) || maxTracked <= 0) {
      throw new TypeError('maxTrackedEffectTickets must be a positive integer');
    }
    this.#session = session;
    this.#documents = documents;
    // Default human-presence resolution: any human surface on the shared
    // session projection pauses agent edits (coarse but safe). Wiring may
    // inject a document/scene-scoped tracker instead.
    this.#presence = presence ?? { isHumanEditing: () => session.hasHumanPresence };
    this.#newEffectId = options.newEffectId ?? randomUUID;
    this.#maxTrackedTickets = maxTracked;
  }

  /**
   * Apply one scoped Yjs edit effect. Runs through the session's serialized
   * operation queue: the capability gate is re-validated immediately before
   * the effect, human presence on the target pauses with a fresh-vector
   * requirement, and a moved document returns a typed `conflict` without
   * applying anything. On success the applied ticket enables a conditional
   * compensating revert.
   */
  async applyEffect(input: AgentEditEffectInput): Promise<AgentEditEffectResult> {
    this.#validateEditInput(input);
    // The document-port project is the bound session's project, never caller
    // input: a capability/session for one project can never address another.
    const { documentId, sceneId, capabilityId, scope, expectedVersion } = input;
    const projectId = this.#session.projectId;
    try {
      const result = await this.#session.enqueueOperation<JsonValue, AgentEditEffectOutcome>({
        kind: 'edit.apply',
        capabilityId,
        scope,
        expectedVersion,
        run: async () => {
          // Observe the human-presence generation together with the precheck:
          // the document port re-validates it atomically inside its own
          // mutation critical section, so a human that starts editing between
          // this precheck and the mutation blocks the effect without applying.
          const presenceGeneration = this.#session.presenceGeneration;
          if (await this.#isHumanEditing({ projectId, documentId, sceneId })) {
            return {
              status: 'paused',
              reason: 'human-presence',
              projectId,
              documentId,
              ...(sceneId === undefined ? {} : { sceneId }),
              liveStateVector: await this.#loadStateVector(projectId, documentId),
              replanRequired: true,
            };
          }
          const applied = await this.#documents.applyScopedUpdate({
            projectId,
            documentId,
            expectedBaseVector: input.expectedBaseVector,
            update: input.update,
            expectedHumanPresenceGeneration: presenceGeneration,
          });
          if (!applied.ok) {
            if (applied.reason === 'human-presence-changed') {
              return {
                status: 'paused',
                reason: 'human-presence',
                projectId,
                documentId,
                ...(sceneId === undefined ? {} : { sceneId }),
                liveStateVector: applied.liveStateVector,
                replanRequired: true,
              };
            }
            return {
              status: 'conflict',
              reason: 'stale-vector',
              projectId,
              documentId,
              liveStateVector: applied.liveStateVector,
            };
          }
          const effectId = this.#newEffectId();
          this.#track(effectId, {
            effectId,
            projectId,
            documentId,
            stateVector: applied.ticket.stateVector,
            compensatingUpdate: applied.ticket.compensatingUpdate,
          });
          return {
            status: 'applied',
            effectId,
            projectId,
            documentId,
            stateVector: applied.ticket.stateVector,
            update: applied.ticket.update,
          };
        },
      });
      return this.#unwrap(result);
    } catch (error) {
      return { status: 'failed', errorCode: errorCodeOf(error), message: errorMessageOf(error) };
    }
  }

  /**
   * Conditionally revert one previously applied effect. The capability is
   * re-validated immediately before the revert; human presence pauses it; and
   * the compensating update is applied ONLY when the live document state
   * vector still matches the recorded post-effect vector. A moved document
   * returns a typed `conflict` and is never rewound; an unknown or foreign
   * effect id is the typed `unknown-effect` conflict.
   */
  async revertEffect(input: AgentRevertEffectInput): Promise<AgentRevertEffectResult> {
    this.#validateRevertInput(input);
    const { documentId, sceneId, capabilityId, scope, expectedVersion, effectId } = input;
    const projectId = this.#session.projectId;
    try {
      const result = await this.#session.enqueueOperation<JsonValue, AgentRevertEffectOutcome>({
        kind: 'edit.revert',
        capabilityId,
        scope,
        expectedVersion,
        run: async () => {
          // Same atomic human-presence generation guard as apply: observed at
          // precheck, re-validated inside the document's mutation critical
          // section so a human transition blocks the compensating update.
          const presenceGeneration = this.#session.presenceGeneration;
          if (await this.#isHumanEditing({ projectId, documentId, sceneId })) {
            return {
              status: 'paused',
              reason: 'human-presence',
              projectId,
              documentId,
              ...(sceneId === undefined ? {} : { sceneId }),
              liveStateVector: await this.#loadStateVector(projectId, documentId),
              replanRequired: true,
            };
          }
          const ticket = this.#tickets.get(effectId);
          if (
            ticket === undefined ||
            ticket.projectId !== projectId ||
            ticket.documentId !== documentId
          ) {
            return { status: 'conflict', reason: 'unknown-effect', projectId, documentId };
          }
          const reverted = await this.#documents.applyCompensatingUpdate({
            projectId,
            documentId,
            expectedVector: ticket.stateVector,
            compensatingUpdate: ticket.compensatingUpdate,
            expectedHumanPresenceGeneration: presenceGeneration,
          });
          if (!reverted.ok) {
            if (reverted.reason === 'human-presence-changed') {
              return {
                status: 'paused',
                reason: 'human-presence',
                projectId,
                documentId,
                ...(sceneId === undefined ? {} : { sceneId }),
                liveStateVector: reverted.liveStateVector,
                replanRequired: true,
              };
            }
            return {
              status: 'conflict',
              reason: 'stale-vector',
              projectId,
              documentId,
              liveStateVector: reverted.liveStateVector,
            };
          }
          this.#tickets.delete(effectId);
          return {
            status: 'reverted',
            effectId,
            projectId,
            documentId,
            stateVector: reverted.stateVector,
          };
        },
      });
      return this.#unwrap(result);
    } catch (error) {
      return { status: 'failed', errorCode: errorCodeOf(error), message: errorMessageOf(error) };
    }
  }

  /** Maps the session's generic result onto this service's typed result surface. */
  #unwrap<TResult extends { readonly status: string }>(
    result: SessionOperationResult<TResult>,
  ): TResult | AgentEffectDeniedResult | AgentEffectFailedResult {
    switch (result.status) {
      case 'completed':
        return result.result;
      case 'denied':
        return { status: 'denied', reason: result.reason };
      case 'failed':
        return { status: 'failed', errorCode: result.errorCode, message: result.message };
    }
  }

  #isHumanEditing(input: {
    readonly projectId: string;
    readonly documentId: string;
    readonly sceneId?: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#presence.isHumanEditing(input));
  }

  async #loadStateVector(projectId: string, documentId: string): Promise<Uint8Array | null> {
    try {
      const state = await this.#documents.load({ projectId, documentId });
      return state?.stateVector ?? null;
    } catch {
      // Best-effort: the paused outcome still requires a replan either way.
      return null;
    }
  }

  /** Records an applied ticket, evicting the oldest once the bound is exceeded. */
  #track(effectId: string, ticket: AppliedEffectTicket): void {
    this.#tickets.set(effectId, ticket);
    if (this.#tickets.size > this.#maxTrackedTickets) {
      const oldest = this.#tickets.keys().next().value;
      if (oldest !== undefined) this.#tickets.delete(oldest);
    }
  }

  #validateEditInput(input: AgentEditEffectInput): void {
    if (typeof input.documentId !== 'string' || input.documentId.length === 0) {
      throw new TypeError('AgentCommandService requires a non-empty documentId');
    }
    if (typeof input.capabilityId !== 'string' || input.capabilityId.length === 0) {
      throw new TypeError('AgentCommandService requires a non-empty capabilityId');
    }
    if (!Array.isArray(input.scope) || input.scope.length === 0) {
      throw new TypeError('AgentCommandService requires at least one scope');
    }
    if (!(input.expectedBaseVector instanceof Uint8Array)) {
      throw new TypeError('AgentCommandService requires expectedBaseVector as a Uint8Array');
    }
    if (!(input.update instanceof Uint8Array)) {
      throw new TypeError('AgentCommandService requires update as a Uint8Array');
    }
  }

  #validateRevertInput(input: AgentRevertEffectInput): void {
    if (typeof input.documentId !== 'string' || input.documentId.length === 0) {
      throw new TypeError('AgentCommandService requires a non-empty documentId');
    }
    if (typeof input.capabilityId !== 'string' || input.capabilityId.length === 0) {
      throw new TypeError('AgentCommandService requires a non-empty capabilityId');
    }
    if (!Array.isArray(input.scope) || input.scope.length === 0) {
      throw new TypeError('AgentCommandService requires at least one scope');
    }
    if (typeof input.effectId !== 'string' || input.effectId.length === 0) {
      throw new TypeError('AgentCommandService requires a non-empty effectId');
    }
  }
}

/**
 * Create one AgentCommandService. Fails closed on missing injected ports: an
 * agent editing surface must never exist without a session, a document port,
 * and working presence semantics.
 */
export function createAgentCommandService(
  options: AgentCommandServiceOptions,
): AgentCommandService {
  return new AgentCommandService(options);
}
