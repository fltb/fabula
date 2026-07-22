// ============================================================================
// Novalistically — Volume Summary Types (Track 6F, D15)
//
// Multi-level (L0+L1) summary hierarchy:
//   L0: Volume summary — key arcs, character trajectories, active threads
//   L1: Scene summaries — per-scene disclosure-safe summaries from Pass 1
// ============================================================================

import type { StoryTimestamp } from './entity.js';

// ——— Volume Summary (L0) ———

export interface VolumeSummary {
  volumeId: string;
  keyArcs: string[];                 // main narrative arcs in this volume
  characterTrajectory: Map<string, string>;  // entityId → current state
  activeThreads: string[];           // unresolved threads
  sceneCount: number;
}

// ——— Chapter Metadata (input to VolumeSummaryCompiler) ———

export interface ChapterMeta {
  chapter: number;
  title: string;
  summary: string;
}

// ——— Scene Metadata (input to VolumeSummaryCompiler) ———

export interface SceneMeta {
  eventId: string;
  chapter: number;
  narrativeOrder: number;
  storyTime?: StoryTimestamp;
  arcPosition?: 'opening' | 'rising' | 'climax' | 'falling' | 'denouement';
}
