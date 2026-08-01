import { ConfigError } from '../errors.ts';
import type { CharacterDefinition } from '../types/character.js';
import type {
  Entity,
  EntityId,
  EntityKind,
  EntityRegistry,
  EntityTypeRef,
} from '../types/index.js';
import type { RuleDefinition } from '../types/rule.js';
import { canonicalizeFactValue } from './fact-value.js';
import type { ProjectData } from './types.js';

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

  /**
   * Load entities from already-loaded ProjectData (never loads the project
   * itself — the canonical kernel owns the single loadProject call).
   *
   * `deferredIntroductionIds` are entities whose activation is authored as an
   * event `introduces` boundary. Definition-backed ids are registered from
   * their definitions; definition-less ids are NOT registered here — the
   * canonical kernel registers them from their authored introduction data.
   * No placeholder entity and no fabricated definition path is ever created.
   */
  load(data: ProjectData, deferredIntroductionIds: readonly string[] = []): void {
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

    // Load rules as entities with deterministic ids (ruleId is required by
    // the current contract — never a random fallback).
    for (const rule of data.rules) {
      if (!rule.ruleId) {
        throw new ConfigError(`Rule definition "${rule.name}" is missing the required ruleId`, {
          path: `definitions/rules/${rule.name}.yaml`,
          phase: 'registry',
        });
      }
      this.entities.set(rule.ruleId, {
        id: rule.ruleId,
        kind: 'rule',
        name: rule.name,
        definitionFile: `definitions/rules/${rule.ruleId.split('.').pop() ?? rule.ruleId}.yaml`,
        lifecycle: 'active',
        typeRef: makeTypeRef('rule'),
        state: buildRuleState(rule),
      });
    }

    // Load from world initial state facts (state_initial concepts)
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

    // Deferred introduction ids are intentionally not registered here.
    // Definition-less entities get their authored kind/state from the
    // canonical kernel, which owns the introduction data. A registry alone
    // must never fabricate entities or definition paths for them.
    void deferredIntroductionIds;
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
