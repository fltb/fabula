// ============================================================================
// Novalistically — Chapter, Scene & Project Config Types
// ============================================================================

import type { StyleGuidance } from './event.js';
import type { IdeaIR } from './idea-ir.js';
import type { RenderSurfaceConfig } from './render-surface.js';

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

// ——— Project Config ———

export interface ProjectConfig {
  project: string;
  title: string;
  author: string;
  defaultModel?: string;
  defaultLanguage?: string;
  genre?: string;
  synopsis?: string;
  ideaIR?: IdeaIR;
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
  concurrency?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  traceLevel?: 'off' | 'basic' | 'detailed';
  cacheEnabled?: boolean;
  defaultSceneTextTarget?: number;
  plugins?: {
    enabled: boolean;
    /** Select a provider registered by a plugin. */
    provider?: string;
  };
  renderSurface?: RenderSurfaceConfig;
}
