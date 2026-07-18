// ============================================================================
// Novalistically Bench — ChiNovelKE Dataset Adapter
// ============================================================================
//
// ChiNovelKE is a Chinese novel knowledge graph dataset. Its format includes
// character profiles, relations, location hierarchies, and event skeletons.
//
// Conversion strategy:
//   - Character profiles → CharacterDefinition (direct map)
//   - Locations → LocationDefinition  (direct map, parent_id → parent)
//   - Relations → custom intermediate format (can be further mapped to
//     RelationshipDefinition with LLM inference for bidirectional/initialState)
//   - Event skeletons → prep for EventFile conversion (requires more context)
//
// Fields are tracked per-field via ProvenanceAnnotation for transparency.

import type {
  CharacterDefinition,
  LocationDefinition,
  RuleDefinition,
  NarrativeEvent,
} from '@novalistically/core';
import { annotate, markDirect, markMixed, type ProvenanceAnnotation } from './annotations.js';

// ─── Raw ChiNovelKE types ──────────────────────────────────────────────────

interface ChiNovelKECharacter {
  id: string;
  name: string;
  aliases: string[];
  gender: '男' | '女' | '未知';
  age_range?: string;
  role: 'protagonist' | 'antagonist' | 'supporting' | 'background';
  description: string;
  traits: string[];
  relations: string[];  // IDs of related characters
  locations: string[];  // IDs of associated locations
}

interface ChiNovelKELocation {
  id: string;
  name: string;
  parent_id?: string;
  description: string;
  era?: string;
}

interface ChiNovelKERelationData {
  id: string;
  type: string;
  from_id: string;
  to_id: string;
  direction: string;
  intensity: number;  // 0-100
  description: string;
}

interface ChiNovelKERawData {
  characters: ChiNovelKECharacter[];
  locations: ChiNovelKELocation[];
  relations: ChiNovelKERelationData[];
  events?: Array<Record<string, unknown>>;
}

// ─── Role mapping ───────────────────────────────────────────────────────────
//
// ChiNovelKE uses 'protagonist' | 'antagonist' | 'supporting' | 'background'.
// Core CharacterDefinition.role uses 'minor' | 'supporting' | 'antagonist' | 'background'.
// 'protagonist' maps to 'minor' (closest available — protagonist is not a
// distinct role level in core, it's a story-structural position).

function mapChiNovelKERole(role: ChiNovelKECharacter['role']): 'minor' | 'supporting' | 'antagonist' | 'background' {
  switch (role) {
    case 'antagonist': return 'antagonist';
    case 'supporting': return 'supporting';
    case 'background': return 'background';
    case 'protagonist': return 'minor';
  }
}

// ─── Conversion functions ──────────────────────────────────────────────────

export function convertChiNovelKECharacter(
  raw: ChiNovelKECharacter,
): { data: CharacterDefinition; annotation: ProvenanceAnnotation } {
  const fieldOrigins = markDirect([
    'id', 'name', 'aliases', 'gender', 'age', 'role', 'description', 'traits',
  ]);

  const data: CharacterDefinition = {
    id: raw.id,
    name: raw.name,
    type: 'character',
    aliases: raw.aliases,
    gender: raw.gender,
    age: raw.age_range ?? undefined,
    role: mapChiNovelKERole(raw.role),
    description: raw.description,
    traits: raw.traits,
    initialState: {},
  };

  return { data, annotation: annotate('chinovelke', raw.id, 'character', fieldOrigins) };
}

export function convertChiNovelKELocation(
  raw: ChiNovelKELocation,
): { data: LocationDefinition; annotation: ProvenanceAnnotation } {
  const fieldOrigins = markDirect(['id', 'name', 'description', 'kind', 'parent']);

  const data: LocationDefinition = {
    id: raw.id,
    name: raw.name,
    kind: 'location',
    description: raw.description,
    parent: raw.parent_id ?? undefined,
    initialState: {},
  };

  return { data, annotation: annotate('chinovelke', raw.id, 'location', fieldOrigins) };
}

export interface ChiNovelKERelationOutput {
  id: string;
  participants: [string, string];
  type: string;
  description: string;
  intensity: number;
  direction: string;
}

export function convertChiNovelKERelation(
  raw: ChiNovelKERelationData,
): { data: ChiNovelKERelationOutput; annotation: ProvenanceAnnotation } {
  const fieldOrigins = markDirect(['id', 'participants', 'type', 'direction', 'intensity', 'description']);

  return {
    data: {
      id: raw.id,
      participants: [raw.from_id, raw.to_id],
      type: raw.type,
      description: raw.description,
      intensity: raw.intensity,
      direction: raw.direction,
    },
    annotation: annotate('chinovelke', raw.id, 'relation', fieldOrigins),
  };
}

export interface ChiNovelKEConversionResult {
  characters: Array<{ data: CharacterDefinition; annotation: ProvenanceAnnotation }>;
  locations: Array<{ data: LocationDefinition; annotation: ProvenanceAnnotation }>;
  relations: Array<{ data: ChiNovelKERelationOutput; annotation: ProvenanceAnnotation }>;
  stats: {
    totalCharacters: number;
    totalLocations: number;
    totalRelations: number;
    directFields: number;
    inferredFields: number;
    unavailableFields: number;
  };
}

export function convertChiNovelKE(raw: ChiNovelKERawData): ChiNovelKEConversionResult {
  const characters = raw.characters.map(convertChiNovelKECharacter);
  const locations = raw.locations.map(convertChiNovelKELocation);
  const relations = raw.relations.map(convertChiNovelKERelation);

  // Compute provenance statistics
  let directFields = 0;
  let inferredFields = 0;
  let unavailableFields = 0;

  const countOrigins = (items: Array<{ annotation: ProvenanceAnnotation }>) => {
    for (const item of items) {
      for (const origin of Object.values(item.annotation.fieldOrigins)) {
        if (origin === 'direct_map') directFields++;
        else if (origin === 'llm_inferred') inferredFields++;
        else if (origin === 'unavailable') unavailableFields++;
      }
    }
  };

  countOrigins(characters);
  countOrigins(locations);
  countOrigins(relations);

  return {
    characters,
    locations,
    relations,
    stats: {
      totalCharacters: characters.length,
      totalLocations: locations.length,
      totalRelations: relations.length,
      directFields,
      inferredFields,
      unavailableFields,
    },
  };
}
