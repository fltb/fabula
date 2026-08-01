// ============================================================================
// Ontology preflight — static declaration/value/reference checks + per-leaf
// replay through the same applicator (plan §6).
//
// validateProjectOntology(ir) is PURE: it only reads the canonical IR and
// replays into scratch state. It never mutates the IR, the registry, or any
// persistence layer, and it never constructs a second event replay — the
// per-leaf replay reuses the existing ReplayEngine + applicator.
// ============================================================================

import { createEmptyBranchPath } from '../branch/index.js';
import { ConfigError } from '../errors.js';
import { ReplayEngine } from '../state/replay.ts';
import type { BranchPath } from '../types/branch.js';
import type { EntityCatalogContext, Fact, NarrativeEvent } from '../types/index.js';
import type { CanonicalProjectIR } from './project-runtime.ts';

/** Phase attached to preflight ConfigErrors; replay uses its own phase. */
const PREFLIGHT_PHASE = 'source';

function contextFor(ir: CanonicalProjectIR): EntityCatalogContext {
  return {
    entityDeclarationCatalog: ir.entityDeclarations,
    entityTypeCatalog: ir.entityTypes,
  };
}

function preflightError(message: string, path: string, eventId?: string): ConfigError {
  return new ConfigError(message, { path, eventId, phase: PREFLIGHT_PHASE });
}

/**
 * Static checks shared by every fact in every event (and every initial fact).
 * Mirrors validateCatalogWrite's source-neutral rule messages so source and
 * replay disagree only in phase; narrative-hint facts keep the same
 * declaration/attribute coverage without value checks.
 */
function checkFact(fact: Fact, catalogs: EntityCatalogContext, eventId: string | undefined): void {
  const { entityDeclarationCatalog, entityTypeCatalog } = catalogs;
  const target = `${fact.entityId}.${fact.attribute}`;

  const declaration = entityDeclarationCatalog.declarations[fact.entityId];
  if (!declaration) {
    throw preflightError(`Unknown entity declaration "${fact.entityId}"`, target, eventId);
  }

  const typeDefinition = entityTypeCatalog.types[declaration.typeRef.typeId];
  if (!typeDefinition) {
    throw preflightError(
      `Unknown entity type "${declaration.typeRef.typeId}" for declaration "${fact.entityId}"`,
      target,
      eventId,
    );
  }

  const attributeDefinition = typeDefinition.attributes[fact.attribute];
  if (!attributeDefinition) {
    throw preflightError(`Write to unknown attribute "${target}"`, target, eventId);
  }

  // Narrative-hint facts carry no state write; the declaration/type/attribute
  // coverage above is all they need.
  if (fact.value === undefined || fact.operation === 'unset') return;

  const parsed = attributeDefinition.valueSchema.safeParse(fact.value);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw preflightError(
      `Value for "${target}" violates value schema${detail ? `: ${detail}` : ''}`,
      target,
      eventId,
    );
  }

  if (attributeDefinition.typedReferenceConstraint) {
    const constraint = attributeDefinition.typedReferenceConstraint;
    if (typeof fact.value !== 'string') {
      throw preflightError(
        `Reference value for "${target}" must be an entity id string`,
        target,
        eventId,
      );
    }
    const refDeclaration = entityDeclarationCatalog.declarations[fact.value];
    if (!refDeclaration) {
      throw preflightError(
        `Reference "${fact.value}" for "${target}" is not a declared entity`,
        target,
        eventId,
      );
    }
    const refType = entityTypeCatalog.types[refDeclaration.typeRef.typeId];
    if (!refType || refType.kind !== constraint.targetKind) {
      throw preflightError(
        `Reference "${fact.value}" for "${target}" must target kind "${constraint.targetKind}" (declared kind: ${refType?.kind ?? 'unknown'})`,
        target,
        eventId,
      );
    }
    if (
      constraint.targetTypeId !== undefined &&
      refDeclaration.typeRef.typeId !== constraint.targetTypeId
    ) {
      throw preflightError(
        `Reference "${fact.value}" for "${target}" must target type "${constraint.targetTypeId}" (declared type: "${refDeclaration.typeRef.typeId}")`,
        target,
        eventId,
      );
    }
  }
}

/** Initial facts may only activate declarations with `introduction.type === 'initial'`. */
function checkInitialFact(fact: Fact, catalogs: EntityCatalogContext): void {
  const declaration = catalogs.entityDeclarationCatalog.declarations[fact.entityId];
  if (!declaration) {
    throw preflightError(
      `Unknown entity declaration "${fact.entityId}"`,
      `${fact.entityId}.${fact.attribute}`,
    );
  }
  if (declaration.introduction.type !== 'initial') {
    throw preflightError(
      `Initial fact cannot activate event-introduced entity "${fact.entityId}" (introduced by event "${declaration.introduction.eventId}")`,
      `${fact.entityId}.${fact.attribute}`,
    );
  }
  checkFact(fact, catalogs, undefined);
}

/**
 * Event `introduces` entries must match a declaration whose activation source
 * is exactly this event; their initialState attributes must be declared.
 */
function checkIntroductions(event: NarrativeEvent, catalogs: EntityCatalogContext): void {
  for (const introduction of event.introduces ?? []) {
    const declaration = catalogs.entityDeclarationCatalog.declarations[introduction.id];
    if (!declaration) {
      throw preflightError(
        `Unknown entity declaration "${introduction.id}"`,
        `${event.id}.introduces.${introduction.id}`,
        event.id,
      );
    }
    if (
      declaration.introduction.type !== 'event' ||
      declaration.introduction.eventId !== event.id
    ) {
      throw preflightError(
        `Introduction of "${introduction.id}" in event "${event.id}" does not match its declaration activation source (${declaration.introduction.type === 'event' ? `event "${declaration.introduction.eventId}"` : 'initial facts'})`,
        `${event.id}.introduces.${introduction.id}`,
        event.id,
      );
    }
    for (const [attribute, value] of Object.entries(introduction.initialState ?? {})) {
      checkFact(
        {
          id: `introduces.${introduction.id}.${attribute}`,
          entityId: introduction.id,
          attribute,
          value,
          validity: {
            temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
            branches: { type: 'all' },
          },
        },
        catalogs,
        event.id,
      );
    }
  }
}

/**
 * Validate a compiled project's ontology without mutating anything:
 *
 * 1. Static declaration / value / reference checks across ALL events and
 *    initial facts (including events no branch reaches).
 * 2. Enumerate the existing game-tree leaves (or the empty path when the
 *    project has no game tree) and replay each into fresh scratch state with
 *    the existing ReplayEngine + applicator, which enforces the timing-based
 *    write policies (requiredAt, immutable / write_once / mutable /
 *    lifecycle_managed, allowed lifecycle states/transitions, unset rules,
 *    activation timing, same-coordinate lifecycle conflicts).
 *
 * Fails closed with ConfigError (phase 'source') on the first violation.
 */
export function validateProjectOntology(ir: CanonicalProjectIR): void {
  const catalogs = contextFor(ir);

  // ── 1. Static checks over every event and initial fact ───────────────
  for (const event of ir.runtimeEvents) {
    checkIntroductions(event, catalogs);
    for (const entityId of event.participants?.entities ?? []) {
      if (!catalogs.entityDeclarationCatalog.declarations[entityId]) {
        throw preflightError(
          `Unknown entity declaration "${entityId}"`,
          `${event.id}.participants`,
          event.id,
        );
      }
    }
    for (const fact of event.preconditions ?? []) {
      checkFact(fact, catalogs, event.id);
    }
    for (const fact of event.postconditions ?? []) {
      checkFact(fact, catalogs, event.id);
    }
  }
  for (const fact of ir.initialFacts) {
    checkInitialFact(fact, catalogs);
  }

  // ── 2. Replay every reachable game-tree leaf into scratch state ───────
  const leaves: readonly BranchPath[] = ir.gameDialogueTree
    ? ir.gameDialogueTree.leafPaths
    : [createEmptyBranchPath()];
  const engine = new ReplayEngine(catalogs);
  const replayOptions = {
    initialFacts: ir.initialFacts,
    initialThreads: ir.initialThreads,
    timeAnchors: ir.data.timeAnchors ?? [],
  };
  // ReplayEngine's signature is mutable-array; hand it a fresh copy so the
  // canonical IR (and its readonly projection) is never aliased or mutated.
  const mutableRuntimeEvents = [...ir.runtimeEvents];
  for (const leaf of leaves) {
    try {
      engine.replay(mutableRuntimeEvents, { ...replayOptions, branchPath: leaf });
    } catch (err) {
      // The applicator throws source-neutral rule messages; the preflight
      // surfaces them as source-phase diagnostics (path/eventId preserved).
      if (err instanceof ConfigError) {
        throw new ConfigError(err.message, {
          ...err.context,
          phase: PREFLIGHT_PHASE,
        });
      }
      throw err;
    }
  }
}
