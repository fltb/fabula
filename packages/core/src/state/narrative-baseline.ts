import { parseStoryTimestamp } from '../entity/timestamp.ts';
import { ConfigError } from '../errors.ts';
import type {
  CommonGroundRecord,
  DimensionState,
  EpistemicLedger,
  NarrativeCatalogContext,
  RelationshipId,
  RuleRuntimeState,
  WorldInitialState,
  WorldState,
} from '../types/index.js';
import { dimensionKey } from './relationship-replay.ts';
import { initializeThreadRuntimeState } from './thread-replay.ts';

function claimKey(subject: string, propositionId: string): string {
  return `${subject}:${propositionId}`;
}

function materializeLedger(initial: WorldInitialState): EpistemicLedger {
  const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
  for (const declaration of initial.knowledge.claims) {
    const key = claimKey(declaration.subject, declaration.propositionId);
    if (ledger.claims[key]) {
      throw new ConfigError(`Duplicate initial knowledge claim "${key}"`, {
        path: 'definitions/state_initial.yaml:knowledge.claims',
        phase: 'baseline',
      });
    }
    ledger.claims[key] = {
      subject: declaration.subject,
      propositionId: declaration.propositionId,
      assessment: structuredClone(declaration.assessment),
      evidence: declaration.evidence.map((evidence) => ({
        ...evidence,
        acquiredAt: parseStoryTimestamp(evidence.acquiredAt),
      })),
    };
    let subjectClaims = ledger.bySubject[declaration.subject];
    if (!subjectClaims) {
      subjectClaims = [];
      ledger.bySubject[declaration.subject] = subjectClaims;
    }
    subjectClaims.push(declaration.propositionId);

    let propositionClaims = ledger.byProposition[declaration.propositionId];
    if (!propositionClaims) {
      propositionClaims = [];
      ledger.byProposition[declaration.propositionId] = propositionClaims;
    }
    propositionClaims.push(declaration.subject);
  }
  return ledger;
}

function materializeCommonGround(initial: WorldInitialState): CommonGroundRecord[] {
  return initial.knowledge.commonGround.map((declaration) => ({
    propositionId: declaration.propositionId,
    participants: [...declaration.participants],
    establishedAt: parseStoryTimestamp(declaration.establishedAt),
    establishedBy: declaration.establishedBy ?? 'system:initial',
  }));
}

/**
 * Materialize the declaration-owned state that exists before the first event.
 * This is the only baseline constructor for the narrative domains; replay must
 * never synthesize a thread, rule, relationship, proposition catalog, or
 * knowledge ledger from an event transaction.
 */
export function materializeNarrativeBaseline(
  catalogs: NarrativeCatalogContext,
  initial: WorldInitialState,
): WorldState {
  const state: WorldState = {
    entities: {},
    relationships: {},
    epistemicLedger: materializeLedger(initial),
    propositionCatalog: structuredClone(catalogs.propositionCatalog),
    commonGround: materializeCommonGround(initial),
    threads: {},
    rules: {},
    facts: [],
  };

  for (const declaration of catalogs.threadDeclarations) {
    const type = catalogs.threadTypeCatalog.types[declaration.typeId];
    if (!type) {
      throw new ConfigError(`Unknown thread type "${declaration.typeId}"`, {
        path: `thread:${declaration.threadId}`,
        phase: 'baseline',
      });
    }
    state.threads[declaration.threadId] = initializeThreadRuntimeState(
      declaration.threadId,
      declaration,
      type,
    );
  }

  for (const declaration of catalogs.relationshipDeclarations) {
    const memberships: Record<string, (typeof declaration.initialEpoch.memberships)[number]> = {};
    for (const membership of declaration.initialEpoch.memberships) {
      memberships[membership.membershipId] = structuredClone(membership);
    }
    const dimensions: Record<string, DimensionState> = {};
    for (const dimension of declaration.initialEpoch.dimensions) {
      const key = dimensionKey(
        dimension.dimensionId,
        dimension.scope,
        dimension.roleId,
        dimension.memberId,
        dimension.position,
      );
      if (dimensions[key]) {
        throw new ConfigError(`Duplicate initial relationship dimension "${key}"`, {
          path: `relationship:${declaration.relationshipId}`,
          phase: 'baseline',
        });
      }
      const scopeKey =
        dimension.scope === 'role'
          ? dimension.roleId
          : dimension.scope === 'member'
            ? dimension.memberId
            : dimension.scope === 'positional'
              ? dimension.position
              : undefined;
      dimensions[key] = {
        value: structuredClone(dimension.value),
        scope: dimension.scope,
        lastUpdatedEffectId: `system:initial:${declaration.relationshipId}`,
        ...(scopeKey === undefined ? {} : { scopeKey }),
      };
    }
    state.relationships[declaration.relationshipId as RelationshipId] = {
      relationshipId: declaration.relationshipId as RelationshipId,
      typeId: declaration.typeId,
      epochs: {
        [declaration.initialEpoch.epochId]: {
          epochId: declaration.initialEpoch.epochId,
          lifecycle: declaration.initialEpoch.lifecycle,
          memberships,
          dimensions,
        },
      },
      ...(declaration.initialEpoch.lifecycle === 'active'
        ? { activeEpochId: declaration.initialEpoch.epochId }
        : {}),
    };
  }

  for (const declaration of catalogs.ruleDeclarations) {
    const runtime: RuleRuntimeState = {
      ruleId: declaration.ruleId,
      currentEpoch: declaration.initialEpochId,
      specificationId: declaration.initialSpecificationId,
      activation: declaration.initialActivation,
      effectiveness: declaration.initialEffectiveness,
      scopeBindings: structuredClone(declaration.scopeBindings),
      exceptions: structuredClone(declaration.exceptions),
    };
    state.rules[declaration.ruleId] = runtime;
  }

  return state;
}
