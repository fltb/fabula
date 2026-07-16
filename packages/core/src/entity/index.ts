// ============================================================================
// EntityMapper + EntityRegistry
// Reads YAML definitions from project directory and maps them to internal types.
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import type {
  CharacterDefinition,
  ChapterMetadata,
  Entity,
  EntityId,
  EntityKind,
  EntityRegistry,
  EventFile,
  FactionDefinition,
  ItemDefinition,
  LocationDefinition,
  NarrativeEvent,
  ProjectConfig,
  RelationshipDefinition,
  RuleDefinition,
  WorldInitialState,
  Fact,
  BranchSet,
  StoryTimestamp,
  TimeAnchor,
} from '../types/index.js';

// ============================================================================
// Helpers
// ============================================================================

function readYamlFile<T>(filePath: string): T | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return YAML.parse(content) as T;
  } catch {
    return null;
  }
}

function readYamlFilesInDir<T>(dirPath: string): T[] {
  if (!fs.existsSync(dirPath)) return [];
  const results: T[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...readYamlFilesInDir<T>(fullPath));
    } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      const parsed = readYamlFile<T>(fullPath);
      if (parsed !== null) results.push(parsed);
    }
  }
  return results;
}

function parseStoryTimestamp(raw: string | undefined, anchors: Map<string, number>): StoryTimestamp {
  if (raw === undefined || raw === null) return { type: 'absolute', value: 'day_0' };
  // Try "anchor + N unit" pattern
  const relativeMatch = raw.match(/^(\S+)\s*\+\s*(\d+)\s*(minute|hour|day|week|month)s?$/);
  if (relativeMatch) {
    return {
      type: 'relative',
      anchor: relativeMatch[1],
      offset: {
        amount: parseInt(relativeMatch[2], 10),
        unit: relativeMatch[3] as 'minute' | 'hour' | 'day' | 'week' | 'month',
      },
    };
  }

  // Try chapter_N pattern
  const chapterMatch = raw.match(/^chapter[_\s]*(\d+)$/i);
  if (chapterMatch) {
    return { type: 'chapter', chapter: parseInt(chapterMatch[1], 10) };
  }

  // Fallback: absolute timestamp
  return { type: 'absolute', value: raw };
}

function resolveTimestampToDay(ts: StoryTimestamp, anchors: Map<string, number>): number {
  switch (ts.type) {
    case 'absolute': {
      const dayMatch = ts.value.match(/^day[_\s]*(\d+)$/i);
      if (dayMatch) return parseInt(dayMatch[1], 10);
      return 0;
    }
    case 'relative': {
      const anchorDay = anchors.get(ts.anchor) ?? 0;
      const unitDays: Record<string, number> = {
        minute: 1 / 1440,
        hour: 1 / 24,
        day: 1,
        week: 7,
        month: 30,
      };
      return anchorDay + ts.offset.amount * (unitDays[ts.offset.unit] ?? 1);
    }
    case 'chapter':
      return ts.chapter;
  }
}

function compareTimestamp(a: StoryTimestamp, b: StoryTimestamp, anchors: Map<string, number>): number {
  return resolveTimestampToDay(a, anchors) - resolveTimestampToDay(b, anchors);
}

function factIdFrom(entity: string, attribute: string): string {
  return `${entity}.${attribute}`;
}

// ============================================================================
// EntityMapper
// ============================================================================

export interface ProjectData {
  config: ProjectConfig | null;
  characters: CharacterDefinition[];
  relationships: RelationshipDefinition[];
  rules: RuleDefinition[];
  locations: LocationDefinition[];
  items: ItemDefinition[];
  factions: FactionDefinition[];
  worldInitialState: WorldInitialState | null;
  chapters: Map<number, { metadata: ChapterMetadata | null; events: EventFile[] }>;
  timeAnchors: TimeAnchor[];
}

export class EntityMapper {
  private projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /** Load all project data from the filesystem */
  loadProject(): ProjectData {
    const config = readYamlFile<ProjectConfig>(
      path.join(this.projectPath, 'nova.yaml'),
    );

    const defsDir = path.join(this.projectPath, 'definitions');
    const characters = readYamlFilesInDir<CharacterDefinition>(
      path.join(defsDir, 'characters'),
    );
    const relationships = readYamlFilesInDir<RelationshipDefinition>(
      path.join(defsDir, 'relationships'),
    );
    const rules = readYamlFilesInDir<RuleDefinition>(
      path.join(defsDir, 'rules'),
    );
    const locations = readYamlFilesInDir<LocationDefinition>(
      path.join(defsDir, 'locations'),
    );
    const items = readYamlFilesInDir<ItemDefinition>(
      path.join(defsDir, 'items'),
    );
    const factions = readYamlFilesInDir<FactionDefinition>(
      path.join(defsDir, 'factions'),
    );

    const worldInitialState = readYamlFile<WorldInitialState>(
      path.join(defsDir, 'state_initial.yaml'),
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
    if (fs.existsSync(chaptersDir)) {
      const chapterDirs = fs.readdirSync(chaptersDir, { withFileTypes: true });
      for (const dir of chapterDirs) {
        if (!dir.isDirectory()) continue;
        const chapterMatch = dir.name.match(/^chapter[_\s]*(\d+)$/i);
        if (!chapterMatch) continue;
        const chapterNum = parseInt(chapterMatch[1], 10);

        const chapterPath = path.join(chaptersDir, dir.name);
        const metadata = readYamlFile<ChapterMetadata>(
          path.join(chapterPath, '_chapter.yaml'),
        );

        const events: EventFile[] = [];
        const eventFiles = fs.readdirSync(chapterPath).filter(
          (f) => f.startsWith('E') && (f.endsWith('.yaml') || f.endsWith('.yml')),
        );
        for (const ef of eventFiles) {
          const event = readYamlFile<EventFile>(path.join(chapterPath, ef));
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

// ============================================================================
// EntityRegistry Implementation
// ============================================================================

export class InMemoryEntityRegistry implements EntityRegistry {
  private entities: Map<EntityId, Entity> = new Map();

  load(projectPath: string): void {
    const mapper = new EntityMapper(projectPath);
    const data = mapper.loadProject();

    // Load characters
    for (const char of data.characters) {
      this.entities.set(char.id, {
        id: char.id,
        kind: 'character',
        name: char.name,
        definitionFile: `definitions/characters/${char.id}.yaml`,
        state: { ...char.initialState, traits: char.traits },
      });
    }

    // Load locations
    for (const loc of data.locations) {
      this.entities.set(loc.id, {
        id: loc.id,
        kind: 'location',
        name: loc.name,
        definitionFile: `definitions/locations/${loc.id}.yaml`,
        state: { ...loc.initialState },
      });
    }

    // Load items
    for (const item of data.items) {
      this.entities.set(item.id, {
        id: item.id,
        kind: 'item',
        name: item.name,
        definitionFile: `definitions/items/${item.id}.yaml`,
        state: { ...item.initialState },
      });
    }

    // Load factions
    for (const fac of data.factions) {
      this.entities.set(fac.id, {
        id: fac.id,
        kind: 'faction',
        name: fac.name,
        definitionFile: `definitions/factions/${fac.id}.yaml`,
        state: { ...fac.initialState },
      });
    }

    // Load rules as entities
    for (const rule of data.rules) {
      const ruleId = rule.ruleId ?? (rule as any).rule ?? `rule_${Math.random()}`;
      this.entities.set(ruleId, {
        id: ruleId,
        kind: 'rule',
        name: rule.name,
        definitionFile: `definitions/rules/${(ruleId as string).split('.').pop() ?? ruleId}.yaml`,
        state: { category: rule.category, type: rule.type },
      });
    }

    // Load from world initial state facts
    if (data.worldInitialState) {
      for (const wf of data.worldInitialState.worldFacts ?? []) {
        this.entities.set(wf.id, {
          id: wf.id,
          kind: 'concept',
          name: wf.id,
          definitionFile: 'definitions/state_initial.yaml',
          state: { value: wf.value, description: wf.description },
        });
      }
    }
  }

  resolve(id: EntityId): Entity | null {
    return this.entities.get(id) ?? null;
  }

  findByKind(kind: EntityKind): Entity[] {
    return [...this.entities.values()].filter((e) => e.kind === kind);
  }

  findByAttribute(attribute: string, value: unknown): Entity[] {
    return [...this.entities.values()].filter(
      (e) => e.state[attribute] === value,
    );
  }

  resolveRefs(refs: EntityId[]): Map<EntityId, Entity | null> {
    const result = new Map<EntityId, Entity | null>();
    for (const ref of refs) {
      result.set(ref, this.resolve(ref));
    }
    return result;
  }

  register(entity: Entity): void {
    this.entities.set(entity.id, entity);
  }

  updateState(id: EntityId, state: Record<string, unknown>): void {
    const entity = this.entities.get(id);
    if (entity) {
      entity.state = { ...entity.state, ...state };
      this.entities.set(id, entity);
    }
  }

  getAll(): Entity[] {
    return [...this.entities.values()];
  }

  /** Get all entities */
  get entitiesMap(): Map<EntityId, Entity> {
    return this.entities;
  }
}

// Re-export for convenience
export { compareTimestamp, parseStoryTimestamp, resolveTimestampToDay, readYamlFile, readYamlFilesInDir };
