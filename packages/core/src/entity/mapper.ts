import * as path from 'node:path';
import type {
  ChapterMetadata,
  EventFile,
  Fact,
  NarrativeEvent,
  ProjectConfig,
  TimeAnchor,
  WorldInitialState,
  CharacterDefinition,
  CharacterRelationshipDef,
  RuleDefinition,
  LocationDefinition,
  ItemDefinition,
  FactionDefinition,
} from '../types/index.js';
import { readYamlFile, readYamlFilesInDir } from './yaml-loader.js';
import { parseStoryTimestamp, factIdFrom } from './timestamp.js';
import type { ProjectData } from './types.js';
import { FsStorage, type Storage } from '../storage/index.ts';

// ============================================================================
// EntityMapper — reads YAML definitions and maps to internal types
// ============================================================================

export class EntityMapper {
  private projectPath: string;
  private storage: Storage;

  constructor(projectPath: string, storage?: Storage) {
    this.projectPath = projectPath;
    this.storage = storage ?? new FsStorage();
  }

  /** Load all project data from the filesystem */
  loadProject(): ProjectData {
    const config = readYamlFile<ProjectConfig>(
      path.join(this.projectPath, 'nova.yaml'),
      this.storage,
    );

    const defsDir = path.join(this.projectPath, 'definitions');
    const characters = readYamlFilesInDir<CharacterDefinition>(
      path.join(defsDir, 'characters'),
      this.storage,
    );
    const relationships = readYamlFilesInDir<CharacterRelationshipDef>(
      path.join(defsDir, 'relationships'),
      this.storage,
    );
    const rules = readYamlFilesInDir<RuleDefinition>(
      path.join(defsDir, 'rules'),
      this.storage,
    );
    const locations = readYamlFilesInDir<LocationDefinition>(
      path.join(defsDir, 'locations'),
      this.storage,
    );
    const items = readYamlFilesInDir<ItemDefinition>(
      path.join(defsDir, 'items'),
      this.storage,
    );
    const factions = readYamlFilesInDir<FactionDefinition>(
      path.join(defsDir, 'factions'),
      this.storage,
    );

    const worldInitialState = readYamlFile<WorldInitialState>(
      path.join(defsDir, 'state_initial.yaml'),
      this.storage,
    );

    const timeAnchors: TimeAnchor[] =
      worldInitialState?.timeAnchors?.map((a) => ({
        id: a.id,
        day: a.day,
        description: a.description,
      })) ?? [];

    // Load chapters
    const chapters = new Map<number, { metadata: ChapterMetadata | null; events: EventFile[] }>();
    const chaptersDir = path.join(this.projectPath, 'chapters');
    if (this.storage.exists(chaptersDir)) {
      const chapterDirs = this.storage.list(chaptersDir);
      for (const dir of chapterDirs) {
        if (!dir.isDirectory()) continue;
        const chapterMatch = dir.name.match(/^chapter[_\s]*(\d+)$/i);
        if (!chapterMatch) continue;
        const chapterNum = parseInt(chapterMatch[1], 10);

        const chapterPath = path.join(chaptersDir, dir.name);
        const metadata = readYamlFile<ChapterMetadata>(
          path.join(chapterPath, '_chapter.yaml'),
          this.storage,
        );

        const events: EventFile[] = [];
        const eventFiles = this.storage.listFiles(chapterPath).filter(
          (f) => f.startsWith('E') && (f.endsWith('.yaml') || f.endsWith('.yml')),
        );
        for (const ef of eventFiles) {
          const event = readYamlFile<EventFile>(path.join(chapterPath, ef), this.storage);
          if (event) events.push(event);
        }

        chapters.set(chapterNum, { metadata, events });
      }
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
    };
  }

  /** Map EventFile to NarrativeEvent (internal type) */
  mapToNarrativeEvent(
    eventFile: EventFile,
    chapterNum: number,
    anchors: Map<string, number>,
  ): NarrativeEvent {
    const timeAnchorsMap = new Map(anchors);

    const preconditions: Fact[] = (eventFile.preconditions ?? []).map((pc, i) => ({
      id: factIdFrom(pc.entity, pc.attribute),
      entityId: pc.entity,
      attribute: pc.attribute,
      value: pc.value,
      confidence: 1.0,
      validity: {
        temporal: {
          start: parseStoryTimestamp(eventFile.storyTime, timeAnchorsMap),
          end: null,
        },
        branches: { type: 'all' as const },
      },
    }));

    const postconditions: Fact[] = (eventFile.expectedPostconditions ?? []).map((pc) => ({
      id: factIdFrom(pc.entity, pc.attribute),
      entityId: pc.entity,
      attribute: pc.attribute,
      value: pc.value,
      confidence: pc.confidence ?? 1.0,
      validity: {
        temporal: {
          start: parseStoryTimestamp(eventFile.storyTime, timeAnchorsMap),
          end: null,
        },
        branches: { type: 'all' as const },
      },
    }));

    const storyTime = parseStoryTimestamp(eventFile.storyTime, timeAnchorsMap);

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
      id: eventFile.event,
      event: eventFile.event,
      narrativeOrder: eventFile.narrativeOrder,
      title: eventFile.title,
      storyTime,
      sceneType: eventFile.sceneType ?? 'linear',
      pov: {
        character: eventFile.pov.character,
        type: eventFile.pov.type,
      },
      sceneBrief: eventFile.sceneBrief,
      preconditions,
      postconditions,
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
      relationshipEffects: (eventFile.relationshipEffects ?? []).map((re) => ({
        participants: re.participants as [string, string],
        effect: re.effect,
        direction: re.direction,
        newState: re.newState,
      })),
      ruleEffects: (eventFile.ruleEffects ?? []).map((re) => ({
        rule: re.rule,
        effect: re.effect,
        evidence: re.evidence,
      })),
      styleGuidance: eventFile.styleGuidance,
      source: 'event_file',
      branchExistence: { type: 'all' },
      participants: {
        entities: [...participantSet],
      },
    };
  }

  /** Load all events as NarrativeEvent objects */
  loadAllEvents(chapters: Map<number, { metadata: ChapterMetadata | null; events: EventFile[] }>): NarrativeEvent[] {
    const anchors = new Map<string, number>();
    const projectData = this.loadProject();
    for (const a of projectData.timeAnchors) {
      anchors.set(a.id, a.day);
    }

    const allEvents: NarrativeEvent[] = [];

    // Add genesis event from world initial state
    if (projectData.worldInitialState) {
      const genesisEvent = this.createGenesisEvent(projectData.worldInitialState);
      allEvents.push(genesisEvent);
    }

    for (const [chapterNum, chapter] of chapters) {
      for (const ef of chapter.events) {
        const ne = this.mapToNarrativeEvent(ef, chapterNum, anchors);
        allEvents.push(ne);
      }
    }

    // Sort by narrative order
    allEvents.sort((a, b) => a.narrativeOrder - b.narrativeOrder);

    return allEvents;
  }

  /** Create the genesis event from world initial state */
  createGenesisEvent(wis: WorldInitialState): NarrativeEvent {
    const postconditions: Fact[] = (wis.worldFacts ?? []).map((wf) => ({
      id: wf.id,
      entityId: 'world',
      attribute: wf.id,
      value: wf.value,
      confidence: 1.0,
      validity: {
        temporal: {
          start: { type: 'absolute' as const, value: 'day_0' },
          end: null,
        },
        branches: { type: 'all' as const },
      },
    }));

    return {
      id: 'system:genesis',
      event: 'system:genesis',
      narrativeOrder: 0,
      title: 'World Genesis',
      storyTime: { type: 'absolute', value: 'day_0' },
      sceneType: 'linear',
      pov: { character: 'system', type: 'omniscient' },
      sceneBrief: 'World initial state. Generated automatically from state_initial.yaml.',
      preconditions: [],
      postconditions,
      threadProgress: [],
      foreshadowing: [],
      relationshipEffects: [],
      ruleEffects: [],
      source: 'genesis',
      branchExistence: { type: 'all' },
      participants: { entities: [] },
    };
  }
}
