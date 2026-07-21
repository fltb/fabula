import type {
  Entity,
  EntityId,
  EntityKind,
  EntityRegistry,
} from '../types/index.js';
import { EntityMapper } from './mapper.js';

// ============================================================================
// InMemoryEntityRegistry — stores and resolves entities in memory
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
        state: {
          // Preserve top-level deterministic character definition fields
          // needed by validators (AliasValidator, PronounValidator, etc.)
          // without overwriting explicit initialState values.
          ...(char.aliases ? { aliases: char.aliases } : {}),
          ...(char.gender ? { gender: char.gender } : {}),
          ...(char.appearance ? { appearance: char.appearance } : {}),
          ...(char.age ? { age: char.age } : {}),
          ...(char.profession ? { profession: char.profession } : {}),
          ...char.initialState,
          traits: char.traits,
        },
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
