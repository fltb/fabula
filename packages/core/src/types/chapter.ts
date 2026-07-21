// ============================================================================
// Novalistically — Chapter, Scene & Project Config Types
// ============================================================================

import type { StyleGuidance } from './event.js';

// ——— Chapter Metadata ———

export interface ChapterMetadata {
  chapter: number;
  title: string;
  summary: string;
  intent: string;
  plannedScenes: number;
  styleGuidance?: StyleGuidance;
}

// ——— Scene Metadata ———

export interface SceneMetadata {
  event: string;
  proseSource: 'llm' | 'human_edited' | 'human_locked';
  modelUsed?: string;
  renderedAt?: string;
  wordCount?: number;
  editHistory: Array<{
    timestamp: string;
    notes: string;
  }>;
  quality?: {
    proseQuality?: number;
    voiceAdherence?: number;
    pacingScore?: number;
    continuityScore?: number;
  };
}

// ——— Project Config ———

export interface ProjectConfig {
  project: string;
  title: string;
  author: string;
  defaultModel?: string;
  defaultLanguage?: string;
  genre?: string;
  synopsis?: string;
  tense?: 'past' | 'present';
  validatorOverrides?: Record<string, 'off' | 'warning' | 'error'>;
  circuitBreaker?: {
    maxRetries: number;
  };
  reviewExpiry?: {
    enabled: boolean;
    autoResolveDays: number;
  };
  snapshotInterval?: number;
  defaultSceneTextTarget?: number;
}
