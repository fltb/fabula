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
  relationshipDefinitionSchema,
  ruleDefinitionSchema,
  worldInitialStateSchema,
} from '../schemas/index.js';
import { compilePlannedDiscourseLedger } from '../state/discourse-ledger.ts';
import type { NarrativeEllipsis } from '../types/corpus.js';
import type {
  ChapterMetadata,
  CharacterDefinition,
  EntityTypeCatalogSource,
  EventFile,
  Fact,
  FactionDefinition,
  ItemDefinition,
  LocationDefinition,
  NarrativeEllipsisFile,
  NarrativeEvent,
  NarratorAssertion,
  NarratorProfile,
  PlannedDiscourseLedgerSource,
  RelationshipDefinition,
  RuleDefinition,
  TimeAnchor,
  WorldInitialState,
} from '../types/index.js';
import { convertRelationshipChange } from '../types/relationship.js';
import { factIdFrom, parseStoryTimestamp, resolveTemporalContext } from './timestamp.js';
import type { ProjectData } from './types.js';
import { loadProjectConfig, readYamlFile, readYamlFilesInDir } from './yaml-loader.js';

// ============================================================================
// EntityMapper — reads YAML definitions and maps to internal types
// ============================================================================

export class EntityMapper {
  private snapshot: ProjectSourceSnapshotV1;
  private narratorProfiles: Record<string, NarratorProfile> = {};

  constructor(snapshot: ProjectSourceSnapshotV1) {
    this.snapshot = snapshot;
  }

  loadProject(): ProjectData {
    const snapshot = this.snapshot;
    const config = loadProjectConfig(snapshot);
    const defsDir = 'definitions';
    const characters = readYamlFilesInDir(
      `${defsDir}/characters`,
      characterDefinitionSchema,
      snapshot,
    ) as CharacterDefinition[];
    const relationships = readYamlFilesInDir(
      `${defsDir}/relationships`,
      relationshipDefinitionSchema,
      snapshot,
    ) as RelationshipDefinition[];
    const rules = readYamlFilesInDir(
      `${defsDir}/rules`,
      ruleDefinitionSchema,
      snapshot,
    ) as RuleDefinition[];
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
    const worldInitialState = readYamlFile({
      logicalPath: 'definitions/state_initial.yaml',
      schema: worldInitialStateSchema,
      snapshot,
    }) as WorldInitialState | null;
    const timeAnchors: TimeAnchor[] =
      worldInitialState?.timeAnchors?.map((anchor) => {
        const at = parseStoryTimestamp(anchor.at);
        if (at.type === 'indeterminate')
          throw new ConfigError(`Time anchor '${anchor.id}' must have a locatable timestamp`, {
            path: `anchor:${anchor.id}.at`,
            phase: 'timestamp',
          });
        return { id: anchor.id, at, description: anchor.description };
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
    return {
      config,
      characters,
      relationships,
      rules,
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
    };
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
      participantSet.add(re.participants[0]);
      participantSet.add(re.participants[1]);
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
      threadProgress: (eventFile.threadProgress ?? []).map((tp) => ({
        thread: tp.thread,
        advancement: tp.advancement,
        progressAfter: tp.progressAfter,
        progressTotal: tp.progressTotal,
      })),
      foreshadowing: (eventFile.foreshadowing ?? []).map((f) => ({
        id: f.id,
        hint: f.hint,
        targetRevealChapter: f.targetRevealChapter,
        thread: f.thread,
      })),
      relationshipEffects: (eventFile.relationshipEffects ?? []).map((re, idx) =>
        convertRelationshipChange(re, eventFile.event, idx),
      ),
      ruleEffects: (eventFile.ruleEffects ?? []).map((re) => ({
        rule: re.rule,
        effect: re.effect,
        evidence: re.evidence,
      })),
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
