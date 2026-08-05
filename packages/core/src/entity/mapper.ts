import type { ZodType } from 'zod';
import { compileGameDialogueTree } from '../branch/game-dialogue-tree.ts';
import type { ProjectSourceSnapshotV1 } from '../contracts/source.js';
import { ConfigError } from '../errors.ts';
import {
  chapterMetadataSchema,
  characterDefinitionSchema,
  entityTypeCatalogSourceSchema,
  eventFileSchema,
  factionDefinitionSchema,
  itemDefinitionSchema,
  locationDefinitionSchema,
  narratorAssertionSchema,
  narratorProfileSchema,
  plannedDiscourseLedgerSourceSchema,
  propositionCatalogSchema,
  relationshipDeclarationSchema,
  relationshipTypeCatalogSchema,
  ruleDeclarationSchema,
  ruleTypeCatalogSchema,
  threadTypeCatalogSchema,
  worldInitialStateSchema,
} from '../schemas/index.js';
import { compilePlannedDiscourseLedger } from '../state/discourse-ledger.ts';
import { validatePropositionCatalog } from '../state/knowledge-replay.ts';
import type { NarrativeEllipsis } from '../types/corpus.js';
import type {
  ChapterMetadata,
  CharacterDefinition,
  ClaimEvidenceRecord,
  EntityTypeCatalogSource,
  EventFile,
  Fact,
  FactionDefinition,
  ItemDefinition,
  KnowledgeTransaction,
  LocationDefinition,
  Membership,
  NarrativeEllipsisFile,
  NarrativeEvent,
  NarratorAssertion,
  NarratorProfile,
  PlannedDiscourseLedgerSource,
  PropositionCatalog,
  RelationshipDeclaration,
  RelationshipEffect,
  RelationshipTypeCatalog,
  RuleDeclaration,
  RuleTypeCatalog,
  RuntimeKnowledgeTransaction,
  SourceClaimEvidence,
  ThreadProgressEntry,
  ThreadRunId,
  ThreadTransaction,
  ThreadTypeCatalog,
  TimeAnchor,
  WorldInitialState,
} from '../types/index.js';
import { compileThreadCatalog } from './thread-catalog-compiler.js';
import { factIdFrom, parseStoryTimestamp, resolveTemporalContext } from './timestamp.js';
import type { ProjectData } from './types.js';
import { loadProjectConfig, readYamlFile, readYamlFilesInDir } from './yaml-loader.js';

// ============================================================================
// EntityMapper — reads YAML definitions and maps to internal types
// ============================================================================

/**
 * Read canonical declaration documents from a directory and require the
 * file basename to equal the declaration id (map-key/file-ID validation).
 */
function readDeclarationsFromDir<T extends { [key in IdKey]: string }, IdKey extends string>(
  dirPath: string,
  schema: ZodType<T>,
  snapshot: ProjectSourceSnapshotV1,
  idKey: IdKey,
): T[] {
  return readYamlFilesInDir(dirPath, schema, snapshot)
    .map((declaration) => {
      const id = declaration[idKey];
      const expected = `${dirPath}/${id}.yaml`;
      if (!snapshot.documents.some((document) => document.logicalPath === expected)) {
        throw new ConfigError(
          `Declaration file name does not match ${idKey} "${id}": expected ${expected}`,
          { path: `${dirPath}/${id}.yaml` },
        );
      }
      return declaration;
    })
    .sort((a, b) => a[idKey].localeCompare(b[idKey]));
}

function collectEntityKinds(
  characters: readonly CharacterDefinition[],
  locations: readonly LocationDefinition[],
  items: readonly ItemDefinition[],
  factions: readonly FactionDefinition[],
  worldInitialState: WorldInitialState,
): ReadonlyMap<string, string> {
  const kinds = new Map<string, string>();
  const add = (id: string, kind: string): void => {
    if (kinds.has(id)) {
      throw new ConfigError(`Duplicate declared entity "${id}"`, {
        path: `entity:${id}`,
        phase: 'catalog',
      });
    }
    kinds.set(id, kind);
  };
  for (const character of characters) add(character.id, 'character');
  for (const location of locations) add(location.id, 'location');
  for (const item of items) add(item.id, 'item');
  for (const faction of factions) add(faction.id, 'faction');
  for (const fact of worldInitialState.worldFacts) add(fact.id, 'concept');
  return kinds;
}

function requireKnownEntity(
  entityId: string,
  entityKinds: ReadonlyMap<string, string>,
  path: string,
): void {
  if (!entityKinds.has(entityId)) {
    throw new ConfigError(`Unknown entity "${entityId}"`, { path, phase: 'catalog' });
  }
}

function validatePropositions(
  catalog: PropositionCatalog,
  entityKinds: ReadonlyMap<string, string>,
): void {
  try {
    validatePropositionCatalog(catalog);
  } catch (error) {
    throw new ConfigError(
      `Invalid proposition catalog: ${error instanceof Error ? error.message : 'invalid dependency graph'}`,
      { path: 'definitions/propositions.yaml', phase: 'catalog' },
    );
  }
  for (const [propositionId, proposition] of Object.entries(catalog.propositions)) {
    switch (proposition.kind) {
      case 'grounded':
        requireKnownEntity(
          proposition.entityId,
          entityKinds,
          `definitions/propositions.yaml:propositions.${propositionId}.entityId`,
        );
        break;
      case 'epistemic':
        requireKnownEntity(
          proposition.subject,
          entityKinds,
          `definitions/propositions.yaml:propositions.${propositionId}.subject`,
        );
        if (!catalog.propositions[proposition.propositionId]) {
          throw new ConfigError(`Unknown proposition "${proposition.propositionId}"`, {
            path: `definitions/propositions.yaml:propositions.${propositionId}.propositionId`,
            phase: 'catalog',
          });
        }
        break;
      case 'act':
        requireKnownEntity(
          proposition.actor,
          entityKinds,
          `definitions/propositions.yaml:propositions.${propositionId}.actor`,
        );
        for (const recipient of proposition.recipients) {
          requireKnownEntity(
            recipient,
            entityKinds,
            `definitions/propositions.yaml:propositions.${propositionId}.recipients`,
          );
        }
        for (const contentId of proposition.contentPropositions) {
          if (!catalog.propositions[contentId]) {
            throw new ConfigError(`Unknown proposition "${contentId}"`, {
              path: `definitions/propositions.yaml:propositions.${propositionId}.contentPropositions`,
              phase: 'catalog',
            });
          }
        }
        break;
      case 'intensional':
        break;
    }
  }
}

function validateInitialKnowledge(
  worldInitialState: WorldInitialState,
  propositionCatalog: PropositionCatalog,
  entityKinds: ReadonlyMap<string, string>,
): void {
  for (const claim of worldInitialState.knowledge.claims) {
    requireKnownEntity(
      claim.subject,
      entityKinds,
      'definitions/state_initial.yaml:knowledge.claims',
    );
    if (!propositionCatalog.propositions[claim.propositionId]) {
      throw new ConfigError(`Unknown proposition "${claim.propositionId}"`, {
        path: 'definitions/state_initial.yaml:knowledge.claims',
        phase: 'catalog',
      });
    }
  }
  for (const record of worldInitialState.knowledge.commonGround) {
    if (!propositionCatalog.propositions[record.propositionId]) {
      throw new ConfigError(`Unknown proposition "${record.propositionId}"`, {
        path: 'definitions/state_initial.yaml:knowledge.commonGround',
        phase: 'catalog',
      });
    }
    for (const participant of record.participants) {
      requireKnownEntity(
        participant,
        entityKinds,
        'definitions/state_initial.yaml:knowledge.commonGround',
      );
    }
  }
}

function validateRelationshipDeclarations(
  declarations: readonly RelationshipDeclaration[],
  typeCatalog: RelationshipTypeCatalog,
  entityKinds: ReadonlyMap<string, string>,
): void {
  const seen = new Set<string>();
  for (const declaration of declarations) {
    if (seen.has(declaration.relationshipId)) {
      throw new ConfigError(`Duplicate relationship "${declaration.relationshipId}"`, {
        path: `definitions/relationships/${declaration.relationshipId}.yaml`,
        phase: 'catalog',
      });
    }
    seen.add(declaration.relationshipId);
    const type = typeCatalog.types[declaration.typeId];
    if (!type) {
      throw new ConfigError(`Unknown relationship type "${declaration.typeId}"`, {
        path: `definitions/relationships/${declaration.relationshipId}.yaml:typeId`,
        phase: 'catalog',
      });
    }
    const roles = new Map(type.roles.map((role) => [role.roleId, role]));
    const memberships = new Set<string>();
    const cardinality = new Map<string, number>();
    for (const membership of declaration.initialEpoch.memberships) {
      if (memberships.has(membership.membershipId)) {
        throw new ConfigError(`Duplicate membership "${membership.membershipId}"`, {
          path: `definitions/relationships/${declaration.relationshipId}.yaml:initialEpoch.memberships`,
          phase: 'catalog',
        });
      }
      memberships.add(membership.membershipId);
      requireKnownEntity(
        membership.entityId,
        entityKinds,
        `definitions/relationships/${declaration.relationshipId}.yaml:initialEpoch.memberships`,
      );
      if (!membership.role || !roles.has(membership.role)) {
        throw new ConfigError(`Unknown relationship role "${membership.role ?? '<missing>'}"`, {
          path: `definitions/relationships/${declaration.relationshipId}.yaml:initialEpoch.memberships`,
          phase: 'catalog',
        });
      }
      const role = roles.get(membership.role);
      if (!role) continue;
      if (!role.allowedEntityKinds.includes(entityKinds.get(membership.entityId) ?? '')) {
        throw new ConfigError(
          `Entity "${membership.entityId}" is not permitted in role "${role.roleId}"`,
          {
            path: `definitions/relationships/${declaration.relationshipId}.yaml:initialEpoch.memberships`,
            phase: 'catalog',
          },
        );
      }
      cardinality.set(role.roleId, (cardinality.get(role.roleId) ?? 0) + 1);
    }
    const occupiedRolesByGroup = new Map<string, Set<string>>();
    for (const role of type.roles) {
      const count = cardinality.get(role.roleId) ?? 0;
      if (count < role.minCardinality || count > role.maxCardinality) {
        throw new ConfigError(`Invalid cardinality for relationship role "${role.roleId}"`, {
          path: `definitions/relationships/${declaration.relationshipId}.yaml:initialEpoch.memberships`,
          phase: 'catalog',
        });
      }
      if (role.exclusiveGroup && count > 0) {
        const occupied = occupiedRolesByGroup.get(role.exclusiveGroup) ?? new Set<string>();
        occupied.add(role.roleId);
        occupiedRolesByGroup.set(role.exclusiveGroup, occupied);
      }
    }
    for (const [group, occupiedRoles] of occupiedRolesByGroup) {
      if (occupiedRoles.size > 1) {
        throw new ConfigError(`Exclusive relationship role group "${group}" has multiple roles`, {
          path: `definitions/relationships/${declaration.relationshipId}.yaml:initialEpoch.memberships`,
          phase: 'catalog',
        });
      }
    }
    for (const dimension of declaration.initialEpoch.dimensions) {
      if (dimension.scope === 'role' && (!dimension.roleId || !roles.has(dimension.roleId))) {
        throw new ConfigError(`Invalid role-scoped dimension "${dimension.dimensionId}"`, {
          path: `definitions/relationships/${declaration.relationshipId}.yaml:initialEpoch.dimensions`,
          phase: 'catalog',
        });
      }
      if (
        dimension.scope === 'member' &&
        (!dimension.memberId || !memberships.has(dimension.memberId))
      ) {
        throw new ConfigError(`Invalid member-scoped dimension "${dimension.dimensionId}"`, {
          path: `definitions/relationships/${declaration.relationshipId}.yaml:initialEpoch.dimensions`,
          phase: 'catalog',
        });
      }
      if (dimension.scope === 'positional' && !dimension.position) {
        throw new ConfigError(`Invalid positional dimension "${dimension.dimensionId}"`, {
          path: `definitions/relationships/${declaration.relationshipId}.yaml:initialEpoch.dimensions`,
          phase: 'catalog',
        });
      }
    }
  }
}

function validateRuleBindings(
  bindings: Record<string, unknown>,
  entityKinds: ReadonlyMap<string, string>,
  path: string,
): void {
  for (const [binding, value] of Object.entries(bindings)) {
    if (typeof value === 'string') requireKnownEntity(value, entityKinds, `${path}.${binding}`);
  }
}

function validateRuleDeclarations(
  declarations: readonly RuleDeclaration[],
  typeCatalog: RuleTypeCatalog,
  entityKinds: ReadonlyMap<string, string>,
): void {
  const seen = new Set<string>();
  for (const declaration of declarations) {
    if (seen.has(declaration.ruleId)) {
      throw new ConfigError(`Duplicate rule "${declaration.ruleId}"`, {
        path: `definitions/rules/${declaration.ruleId}.yaml`,
        phase: 'catalog',
      });
    }
    seen.add(declaration.ruleId);
    if (!typeCatalog.types[declaration.typeId]) {
      throw new ConfigError(`Unknown rule type "${declaration.typeId}"`, {
        path: `definitions/rules/${declaration.ruleId}.yaml:typeId`,
        phase: 'catalog',
      });
    }
    if (!declaration.specifications[declaration.initialSpecificationId]) {
      throw new ConfigError(
        `Unknown initial specification "${declaration.initialSpecificationId}"`,
        {
          path: `definitions/rules/${declaration.ruleId}.yaml:initialSpecificationId`,
          phase: 'catalog',
        },
      );
    }
    validateRuleBindings(
      declaration.scopeBindings,
      entityKinds,
      `definitions/rules/${declaration.ruleId}.yaml:scopeBindings`,
    );
    const constraintIds = new Set(
      Object.values(declaration.specifications).flatMap((specification) =>
        specification.constraints.map((constraint) => constraint.constraintId),
      ),
    );
    for (const exception of declaration.exceptions) {
      validateRuleBindings(
        exception.scopeBindings,
        entityKinds,
        `definitions/rules/${declaration.ruleId}.yaml:exceptions.${exception.exceptionId}.scopeBindings`,
      );
      for (const constraintId of exception.constraintIds) {
        if (!constraintIds.has(constraintId)) {
          throw new ConfigError(`Unknown rule constraint "${constraintId}"`, {
            path: `definitions/rules/${declaration.ruleId}.yaml:exceptions.${exception.exceptionId}`,
            phase: 'catalog',
          });
        }
      }
    }
  }
}

/**
 * Memberships of a canonical relationship effect for participant extraction.
 */
function relationshipMemberships(effect: RelationshipEffect): Membership[] {
  return effect.type === 'relationship_transaction'
    ? effect.membershipAfter
    : effect.newTransactions.flatMap((transaction) => transaction.membershipAfter);
}

/**
 * Normalize authored knowledge transactions into runtime form: parse authored
 * timestamps once (shared with Fact validity), stamp the event id, and keep
 * only explicit writes/acts/common ground.
 */
function normalizeKnowledgeTransactions(eventFile: EventFile): RuntimeKnowledgeTransaction[] {
  return (eventFile.knowledgeTransactions ?? []).map((transaction: KnowledgeTransaction) => {
    switch (transaction.type) {
      case 'claim_write':
        return {
          ...transaction,
          evidence: transaction.evidence.map(
            (entry: SourceClaimEvidence): ClaimEvidenceRecord => ({
              ...entry,
              acquiredAt: parseStoryTimestamp(entry.acquiredAt),
            }),
          ),
        };
      case 'information_act':
        return {
          ...transaction,
          timestamp: parseStoryTimestamp(transaction.timestamp),
          eventId: eventFile.event,
        };
      case 'common_ground':
        return {
          ...transaction,
          establishedAt: parseStoryTimestamp(transaction.establishedAt),
          provenance: eventFile.event,
        };
      default:
        throw new ConfigError('Unsupported knowledge transaction', { phase: 'knowledge' });
    }
  });
}

export class EntityMapper {
  private readonly snapshot: ProjectSourceSnapshotV1;
  private narratorProfiles: Record<string, NarratorProfile> = {};
  private projectData: ProjectData | null = null;

  constructor(snapshot: ProjectSourceSnapshotV1) {
    this.snapshot = snapshot;
  }

  loadProject(): ProjectData {
    if (this.projectData) return this.projectData;
    const snapshot = this.snapshot;
    const config = loadProjectConfig(snapshot);
    const defsDir = 'definitions';
    const characters = readYamlFilesInDir(
      `${defsDir}/characters`,
      characterDefinitionSchema,
      snapshot,
    ) as CharacterDefinition[];
    const locations = readYamlFilesInDir(
      `${defsDir}/locations`,
      locationDefinitionSchema,
      snapshot,
    ) as LocationDefinition[];
    const items = readYamlFilesInDir(
      `${defsDir}/items`,
      itemDefinitionSchema,
      snapshot,
    ) as ItemDefinition[];
    const factions = readYamlFilesInDir(
      `${defsDir}/factions`,
      factionDefinitionSchema,
      snapshot,
    ) as FactionDefinition[];
    this.narratorProfiles = {};
    for (const np of readYamlFilesInDir(
      'definitions/narrators',
      narratorProfileSchema,
      snapshot,
    ) as NarratorProfile[]) {
      this.narratorProfiles[np.id] = np;
    }
    const discourseLedgerSource = readYamlFile({
      logicalPath: 'definitions/discourse-ledger.yaml',
      schema: plannedDiscourseLedgerSourceSchema,
      snapshot,
      optional: true,
    }) as PlannedDiscourseLedgerSource | null;
    const discourseLedger = compilePlannedDiscourseLedger(
      discourseLedgerSource ?? {
        id: 'empty',
        chapters: [{ branch: 'main', chapter: 1, sceneIds: ['__empty__'] }],
        entries: [],
      },
    );
    const narratorAssertions: Record<string, NarratorAssertion> = {};
    for (const na of readYamlFilesInDir(
      'definitions/assertions',
      narratorAssertionSchema,
      snapshot,
    ) as NarratorAssertion[]) {
      if (narratorAssertions[na.id] !== undefined)
        throw new ConfigError(
          `Duplicate assertion id "${na.id}" in definitions/assertions/ — assertion IDs must be unique`,
        );
      narratorAssertions[na.id] = na;
    }
    const entityTypeCatalogSource = readYamlFile({
      logicalPath: 'definitions/entity-types.yaml',
      schema: entityTypeCatalogSourceSchema,
      snapshot,
    }) as EntityTypeCatalogSource;
    const threadTypeCatalog = readYamlFile({
      logicalPath: 'definitions/thread-types.yaml',
      schema: threadTypeCatalogSchema,
      snapshot,
    }) as ThreadTypeCatalog;
    const propositionCatalog = readYamlFile({
      logicalPath: 'definitions/propositions.yaml',
      schema: propositionCatalogSchema,
      snapshot,
    }) as PropositionCatalog;
    const relationshipTypeCatalog = readYamlFile({
      logicalPath: 'definitions/relationship-types.yaml',
      schema: relationshipTypeCatalogSchema,
      snapshot,
    }) as RelationshipTypeCatalog;
    const ruleTypeCatalog = readYamlFile({
      logicalPath: 'definitions/rule-types.yaml',
      schema: ruleTypeCatalogSchema,
      snapshot,
    }) as RuleTypeCatalog;
    const worldInitialState = readYamlFile({
      logicalPath: 'definitions/state_initial.yaml',
      schema: worldInitialStateSchema,
      snapshot,
    }) as WorldInitialState;
    const { declarations: threadDeclarations } = compileThreadCatalog(
      threadTypeCatalog,
      worldInitialState.threads ?? [],
    );
    void threadDeclarations;
    const relationshipDeclarations = readDeclarationsFromDir(
      `${defsDir}/relationships`,
      relationshipDeclarationSchema,
      snapshot,
      'relationshipId',
    ) as RelationshipDeclaration[];
    const ruleDeclarations = readDeclarationsFromDir(
      `${defsDir}/rules`,
      ruleDeclarationSchema,
      snapshot,
      'ruleId',
    ) as RuleDeclaration[];
    const entityKinds = collectEntityKinds(
      characters,
      locations,
      items,
      factions,
      worldInitialState,
    );
    validatePropositions(propositionCatalog, entityKinds);
    validateInitialKnowledge(worldInitialState, propositionCatalog, entityKinds);
    validateRelationshipDeclarations(
      relationshipDeclarations,
      relationshipTypeCatalog,
      entityKinds,
    );
    validateRuleDeclarations(ruleDeclarations, ruleTypeCatalog, entityKinds);
    const timeAnchors: TimeAnchor[] =
      worldInitialState.timeAnchors?.map((anchor) => {
        const at = parseStoryTimestamp(anchor.at);
        if (at.type === 'indeterminate')
          throw new ConfigError(`Time anchor '${anchor.id}' must have a locatable timestamp`, {
            path: `anchor:${anchor.id}.at`,
            phase: 'timestamp',
          });
        return {
          id: anchor.id,
          at,
          description: anchor.description,
          significance: anchor.significance,
        };
      }) ?? [];
    const chapters = new Map<number, { metadata: ChapterMetadata | null; events: EventFile[] }>();
    const chapterPaths = [
      ...new Set(
        snapshot.documents
          .map((document) => document.logicalPath.match(/^chapters\/(chapter[_\s]*\d+)\//i)?.[1])
          .filter((value): value is string => value !== undefined),
      ),
    ];
    for (const chapterName of chapterPaths) {
      const chapterMatch = chapterName.match(/^chapter[_\s]*(\d+)$/i);
      if (!chapterMatch) continue;
      const chapterNum = Number.parseInt(chapterMatch[1], 10);
      const chapterPath = `chapters/${chapterName}`;
      const metadata = readYamlFile({
        logicalPath: `${chapterPath}/_chapter.yaml`,
        schema: chapterMetadataSchema,
        snapshot,
        optional: true,
      });
      const events: EventFile[] = [];
      for (const document of snapshot.documents
        .filter(
          (entry) =>
            entry.logicalPath.startsWith(`${chapterPath}/`) &&
            /^E.*\.ya?ml$/i.test(entry.logicalPath.split('/').pop() ?? ''),
        )
        .sort((a, b) => a.logicalPath.localeCompare(b.logicalPath))) {
        const event = readYamlFile({
          logicalPath: document.logicalPath,
          schema: eventFileSchema,
          snapshot,
        });
        if (event) events.push({ ...event, logicalPath: document.logicalPath } as EventFile);
      }
      chapters.set(chapterNum, { metadata, events });
    }
    this.projectData = {
      config,
      characters,
      locations,
      items,
      factions,
      worldInitialState,
      chapters,
      timeAnchors,
      narratorProfiles: this.narratorProfiles,
      discourseLedger,
      narratorAssertions,
      entityTypeCatalogSource,
      threadTypeCatalog,
      propositionCatalog,
      relationshipTypeCatalog,
      ruleTypeCatalog,
      relationshipDeclarations,
      ruleDeclarations,
    };
    return this.projectData;
  }

  /**
   * Map scalar EventFile threadProgress once into catalog-checked
   * ThreadTransaction(s). Rejects unknown declarations/types and duplicate
   * thread writes per event; never a second state source at replay time.
   */
  private normalizeThreadProgress(eventFile: EventFile): ThreadTransaction[] {
    const entries = eventFile.threadProgress ?? [];
    if (entries.length === 0) return [];
    const data = this.requireProjectData();
    const declarationByThread = new Map(
      (data.worldInitialState.threads ?? []).map((thread) => [thread.threadId, thread]),
    );
    const seen = new Set<string>();
    return entries.map((tp: ThreadProgressEntry) => {
      if (seen.has(tp.thread)) {
        throw new ConfigError(
          `Duplicate thread write for "${tp.thread}" in event "${eventFile.event}"`,
          {
            eventId: eventFile.event,
            path: `event:${eventFile.event}.threadProgress.${tp.thread}`,
            phase: 'thread_progress',
          },
        );
      }
      seen.add(tp.thread);
      const declaration = declarationByThread.get(tp.thread);
      if (!declaration) {
        throw new ConfigError(
          `Unknown thread "${tp.thread}" in event "${eventFile.event}" — not declared in state_initial.yaml`,
          {
            eventId: eventFile.event,
            path: `event:${eventFile.event}.threadProgress.${tp.thread}`,
            phase: 'thread_progress',
          },
        );
      }
      const typeDef = data.threadTypeCatalog.types[declaration.typeId];
      if (!typeDef) {
        throw new ConfigError(
          `Thread "${tp.thread}" references unknown thread type "${declaration.typeId}"`,
          {
            eventId: eventFile.event,
            path: `event:${eventFile.event}.threadProgress.${tp.thread}`,
            phase: 'thread_progress',
          },
        );
      }
      const completed = tp.progressAfter >= tp.progressTotal;
      return {
        thread: tp.thread,
        runId: `run-${tp.thread}` as ThreadRunId,
        status: completed ? ('completed' as const) : ('active' as const),
        phase: typeDef.allowedPhases[0] ?? '',
        goalSet: typeDef.stableGoals.map((goal) => ({
          goalId: goal.goalId,
          status: completed ? ('achieved' as const) : ('active' as const),
        })),
        milestoneSet: [],
        provenance: eventFile.event,
        advancement: tp.advancement,
      };
    });
  }

  private requireProjectData(): ProjectData {
    if (!this.projectData) {
      throw new ConfigError('Project must be loaded before mapping events', {
        phase: 'mapper',
      });
    }
    return this.projectData;
  }

  /** Map EventFile to NarrativeEvent (internal type) */
  mapToNarrativeEvent(eventFile: EventFile): NarrativeEvent {
    const storyTime = parseStoryTimestamp(eventFile.storyTime);
    const narrationTime =
      eventFile.narrationTime === undefined
        ? undefined
        : parseStoryTimestamp(eventFile.narrationTime);
    const preconditions: Fact[] = (eventFile.preconditions ?? []).map((pc) => ({
      id: factIdFrom(pc.entity, pc.attribute),
      entityId: pc.entity,
      attribute: pc.attribute,
      value: pc.value,
      operator: pc.operator,
      confidence: 1.0,
      narrativeHint: pc.narrativeHint,
      validity: {
        temporal: { start: storyTime, end: null },
        branches: { type: 'all' as const },
      },
    }));
    const postconditions: Fact[] = (eventFile.expectedPostconditions ?? []).map((pc) => ({
      id: factIdFrom(pc.entity, pc.attribute),
      entityId: pc.entity,
      attribute: pc.attribute,
      value: pc.value,
      operation: pc.operation,
      confidence: pc.confidence ?? 1.0,
      narrativeHint: pc.narrativeHint,
      validity: {
        temporal: { start: storyTime, end: null },
        branches: { type: 'all' as const },
      },
    }));

    // Extract participant entities from preconditions and relationship effects
    const participantSet = new Set<string>();
    for (const pc of preconditions) participantSet.add(pc.entityId);
    for (const pc of postconditions) participantSet.add(pc.entityId);
    for (const re of eventFile.relationshipEffects ?? []) {
      for (const membership of relationshipMemberships(re)) participantSet.add(membership.entityId);
    }
    if (eventFile.pov?.character) participantSet.add(eventFile.pov.character);

    return {
      kind: 'event',
      id: eventFile.event,
      event: eventFile.event,
      narrativeOrder: eventFile.narrativeOrder,
      title: eventFile.title,
      storyTime,
      narrationTime,
      sceneType: eventFile.sceneType ?? 'linear',
      discourseMode: eventFile.discourseMode,
      arcPosition: eventFile.arcPosition,
      emotionalValence: eventFile.emotionalValence,
      conflictType: eventFile.conflictType,
      resolutionType: eventFile.resolutionType,
      tense: eventFile.tense,
      pov: {
        character: eventFile.pov.character,
        type: eventFile.pov.type,
      },
      sceneBrief: eventFile.sceneBrief,
      beats: eventFile.beats,
      preconditions,
      postconditions,
      choices: eventFile.choices,
      threadProgress: this.normalizeThreadProgress(eventFile),
      greyLines: eventFile.greyLines,
      foreshadowing: (eventFile.foreshadowing ?? []).map((f) => ({
        id: f.id,
        hint: f.hint,
        targetRevealChapter: f.targetRevealChapter,
        thread: f.thread,
      })),
      relationshipEffects: eventFile.relationshipEffects ?? [],
      ...(eventFile.knowledgeTransactions && eventFile.knowledgeTransactions.length > 0
        ? { knowledgeTransactions: normalizeKnowledgeTransactions(eventFile) }
        : {}),
      ruleEffects: eventFile.ruleEffects ?? [],
      styleGuidance: eventFile.styleGuidance,
      source: 'event_file',
      causalPredecessors: eventFile.causalPredecessors,
      branchExistence: { type: 'all' },
      participants: {
        entities: [...participantSet],
      },
      targetAudience: eventFile.targetAudience ?? undefined,
      status: 'draft',
      cast: eventFile.cast ?? undefined,
      // S1/S4: Pass 1 prompt inputs
      narrativeChecklist: eventFile.narrativeChecklist,
      sourceContext: eventFile.sourceContext,
      // S6: Genette dimensions + narrator reference
      duration: eventFile.duration,
      frequency: eventFile.frequency,
      voice: eventFile.voice,
      anachrony: eventFile.anachrony,
      focalization: eventFile.focalization,
      narratorProfileRef: eventFile.narratorProfileRef,
      // Graph-resolved narrative technique contracts
      causalDiscontinuity: eventFile.causalDiscontinuity,
      surfaceMode: eventFile.surfaceMode,
      causalMultiplicity: eventFile.causalMultiplicity,
      irresolvableIndeterminacy: eventFile.irresolvableIndeterminacy,
      absentApparatus: eventFile.absentApparatus,
      voiceDissonance: eventFile.voiceDissonance,
      multiplicity: eventFile.multiplicity,
      metanarrativeLevel: eventFile.metanarrativeLevel,
      // Entity introduction + free-form author pass-through
      introduces: eventFile.introduces,
      authorNotes: eventFile.authorNotes,
    };
  }

  /**
   * Load all authored events as NarrativeEvent objects from already-loaded
   * ProjectData. Never loads the project itself (the canonical kernel owns
   * the single loadProject call). Applies game-dialogue scopes to authored
   * events and injects choice-transition predecessor ids, but returns ONLY
   * renderable event-file events — synthetic transitions (introduction,
   * branch choice) are composed into runtimeEvents by the canonical kernel.
   */
  loadAllEvents(data: ProjectData): NarrativeEvent[] {
    const eventFiles = [...data.chapters.values()].flatMap((chapter) => chapter.events);

    // Step 1: Map all EventFile to NarrativeEvent (parses storyTime once,
    // shared with Fact validity via mapToNarrativeEvent).
    const authoredEvents = eventFiles.map((eventFile) => this.mapToNarrativeEvent(eventFile));

    // Step 2: Resolve TemporalContext from mapped events + project time anchors.
    const temporalContext = resolveTemporalContext(authoredEvents, data.timeAnchors);

    // Step 3: Compile game dialogue tree using NarrativeEvent[] + TemporalContext.
    const gameDialogueTree = compileGameDialogueTree(authoredEvents, temporalContext);

    if (gameDialogueTree) {
      const authoredEventById = new Map(authoredEvents.map((event) => [event.id, event]));
      for (const event of authoredEvents) {
        const scope = gameDialogueTree.eventScopes.get(event.id);
        if (!scope) {
          throw new ConfigError(`Missing game dialogue scope for event '${event.id}'`, {
            eventId: event.id,
            phase: 'game_dialogue_tree',
          });
        }
        event.branchExistence = scope;
        for (const fact of [...event.preconditions, ...event.postconditions]) {
          fact.validity.branches = scope;
        }
      }

      // Inject causal predecessors with deduplication
      for (const [eventId, choices] of gameDialogueTree.choicesByEventId) {
        for (const choice of choices) {
          const target = authoredEventById.get(choice.targetEvent);
          if (!target) {
            throw new ConfigError(`Missing game dialogue target event '${choice.targetEvent}'`, {
              eventId,
              phase: 'game_dialogue_tree',
            });
          }
          const transitionId = `system:branch-choice:${eventId}:${choice.id}`;
          const predecessors = target.causalPredecessors ?? [];
          if (!predecessors.includes(transitionId)) {
            predecessors.push(transitionId);
            target.causalPredecessors = predecessors;
          }
        }
      }
    }

    // Authored renderable events only; sort by narrative order.
    return [...authoredEvents].sort((a, b) => a.narrativeOrder - b.narrativeOrder);
  }
}

// ============================================================================
// Corpus mapping — NarrativeEllipsisFile → NarrativeEllipsis
// No casting of wire objects to runtime types; proper structural mapping with
// shared fact parsing (same AST as EventFile preconditions/postconditions).
// Omitted storyTime → { type: 'indeterminate', mode: 'unspecified' }.
// ============================================================================

/**
 * Map a NarrativeEllipsisFile (wire/YAML format) to a runtime NarrativeEllipsis.
 *
 * Shares fact-parsing AST with mapToNarrativeEvent: wire-format preconditions
 * and postconditions (entity/attribute/value) are parsed into runtime Fact
 * objects using the same factIdFrom pattern. Omitted storyTime defaults to
 * unspecified indeterminate. Transaction arrays pass through as-is (they
 * already use the runtime-compatible types).
 *
 * @param file - Wire-format NarrativeEllipsisFile from YAML
 * @returns Runtime NarrativeEllipsis ready for replay / causal graph
 */
export function mapToNarrativeEllipsis(file: NarrativeEllipsisFile): NarrativeEllipsis {
  const storyTime = file.storyTime
    ? parseStoryTimestamp(file.storyTime)
    : { type: 'indeterminate' as const, mode: 'unspecified' as const };

  const preconditions: Fact[] = (file.preconditions ?? []).map((pc) => ({
    id: factIdFrom(pc.entity, pc.attribute),
    entityId: pc.entity,
    attribute: pc.attribute,
    value: pc.value,
    operator: pc.operator,
    confidence: 1.0,
    narrativeHint: pc.narrativeHint,
    validity: {
      temporal: { start: storyTime, end: null },
      branches: { type: 'all' as const },
    },
  }));

  const postconditions: Fact[] = (file.postconditions ?? []).map((pc) => ({
    id: factIdFrom(pc.entity, pc.attribute),
    entityId: pc.entity,
    attribute: pc.attribute,
    value: pc.value,
    operation: pc.operation,
    confidence: 1.0,
    narrativeHint: pc.narrativeHint,
    validity: {
      temporal: { start: storyTime, end: null },
      branches: { type: 'all' as const },
    },
  }));

  return {
    kind: 'ellipsis',
    id: file.id,
    branchScope: file.branchScope ?? { decisions: [] },
    storyTime,
    summary: file.summary,
    preconditions,
    postconditions,
    relationshipEffects: file.relationshipEffects ?? [],
    knowledgeTransactions: file.knowledgeTransactions ?? [],
    threadProgress: file.threadProgress ?? [],
    ruleEffects: file.ruleEffects ?? [],
    provenance: file.provenance,
  };
}
