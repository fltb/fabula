// ============================================================================
// Novalistically — Character, Faction & Relationship Definition Types
// ============================================================================

// ——— Character Definition (YAML) ———

export interface CharacterDefinition {
  id: string;
  name: string;
  type: string;
  archetype?: string;
  faction?: string;
  role?: 'minor' | 'supporting' | 'antagonist' | 'background';
  description: string;
  initialState?: Record<string, unknown>;
  traits: string[];
  voiceNotes?: string;
  backstory?: string;
  knownSecrets?: string[];
  appearance?: string;
  aliases?: string[];
  gender?: string;
  age?: number | string;
  profession?: string;
}

// ——— Faction Definition ———

export interface FactionDefinition {
  id: string;
  name: string;
  kind: string;
  description: string;
  initialState?: Record<string, unknown>;
}

// ——— Character-level Relationship Definition (file/YAML format) ———
// Retained for YAML loading backward compatibility; the canonical
// RelationshipDeclaration now lives in ./relationship.ts.

export interface CharacterRelationshipDef {
  participants: [string, string];
  type: string;
  description: string;
  initialState: {
    [key: string]: Record<string, unknown>;
  };
  establishedEvent: string;
}
