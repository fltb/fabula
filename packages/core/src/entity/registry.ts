import type { CharacterDefinition, FactionDefinition } from '../types/character.js';
import type {
  Entity,
  EntityId,
  EntityKind,
  EntityRegistry,
  EntityTypeRef,
} from '../types/index.js';
import type { ItemDefinition, LocationDefinition } from '../types/location.js';
import type { RuleDefinition } from '../types/rule.js';
import type { Storage } from '../storage/types.ts';
import { defaultEntityTypeCatalog } from './default-catalog.js';
import { canonicalizeFactValue } from './fact-value.js';
import { EntityMapper } from './mapper.js';

// ============================================================================
// InMemoryEntityRegistry — stores and resolves entities in memory
// ============================================================================

function makeTypeRef(kind: string, schemaVersion = 1): EntityTypeRef {
  return { typeId: kind, schemaVersion };
}

/**
 * Build the entity state for a character by promoting definition-level
 * fields (aliases, gender, appearance, age, profession, traits) into
 * state, then overlaying initialState.
 */
function buildCharacterState(char: CharacterDefinition): Record<string, unknown> {
  const state: Record<string, unknown> = {};

  // Promote top-level definition fields needed by validators
  if (char.aliases) state.aliases = canonicalizeFactValue(char.aliases);
  if (char.gender) state.gender = canonicalizeFactValue(char.gender);
  if (char.appearance) state.appearance = canonicalizeFactValue(char.appearance);
  if (char.age) state.age = canonicalizeFactValue(char.age);
  if (char.profession) state.profession = canonicalizeFactValue(char.profession);
  // traits is always set (even if undefined — preserve existing behavior)
  state.traits = canonicalizeFactValue(char.traits);

  // Overlay initialState (may overwrite promoted fields)
  if (char.initialState) {
    for (const [key, value] of Object.entries(char.initialState)) {
      state[key] = canonicalizeFactValue(value);
    }
  }

  return state;
}

/**
 * Build the entity state for a rule by promoting definition-level
 * fields (category, type) into state.
 */
function buildRuleState(rule: RuleDefinition): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  state.category = canonicalizeFactValue(rule.category);
  state.type = canonicalizeFactValue(rule.type);
  return state;
}

/**
 * Build state for location, item, or faction from initialState.
 */
function buildGenericState(
  initialState: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  if (initialState) {
    for (const [key, value] of Object.entries(initialState)) {
      state[key] = canonicalizeFactValue(value);
    }
  }
  return state;
}

export class InMemoryEntityRegistry implements EntityRegistry {
  private entities: Map<EntityId, Entity> = new Map();

  load(projectPath: string, storage?: Storage): void {
    const mapper = new EntityMapper(projectPath, storage);
    const data = mapper.loadProject();

    // Load characters
    for (const char of data.characters) {
      this.entities.set(char.id, {
        id: char.id,
        kind: 'character',
        name: char.name,
        definitionFile: `definitions/characters/${char.id}.yaml`,
        lifecycle: 'active',
        typeRef: makeTypeRef('character'),
        state: buildCharacterState(char),
      });
    }

    // Load locations
    for (const loc of data.locations) {
      this.entities.set(loc.id, {
        id: loc.id,
        kind: 'location',
        name: loc.name,
        definitionFile: `definitions/locations/${loc.id}.yaml`,
        lifecycle: 'active',
        typeRef: makeTypeRef('location'),
        state: buildGenericState(loc.initialState),
      });
    }

    // Load items
    for (const item of data.items) {
      this.entities.set(item.id, {
        id: item.id,
        kind: 'item',
        name: item.name,
        definitionFile: `definitions/items/${item.id}.yaml`,
        lifecycle: 'active',
        typeRef: makeTypeRef('item'),
        state: buildGenericState(item.initialState),
      });
    }

    // Load factions
    for (const fac of data.factions) {
      this.entities.set(fac.id, {
        id: fac.id,
        kind: 'faction',
        name: fac.name,
        definitionFile: `definitions/factions/${fac.id}.yaml`,
        lifecycle: 'active',
        typeRef: makeTypeRef('faction'),
        state: buildGenericState(fac.initialState),
      });
    }

    // Load rules as entities
    for (const rule of data.rules) {
      // Some fixture YAML files use a snake_case 'rule' field as fallback ruleId
      const ruleId = rule.ruleId ?? `rule_${Math.random()}`;
      this.entities.set(ruleId, {
        id: ruleId,
        kind: 'rule',
        name: rule.name,
        definitionFile: `definitions/rules/${ruleId.split('.').pop() ?? ruleId}.yaml`,
        lifecycle: 'active',
        typeRef: makeTypeRef('rule'),
        state: buildRuleState(rule),
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
          lifecycle: 'active',
          typeRef: makeTypeRef('concept'),
          state: {
            value: canonicalizeFactValue(wf.value),
            description: canonicalizeFactValue(wf.description),
          },
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
    return [...this.entities.values()].filter((e) => e.state[attribute] === value);
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
