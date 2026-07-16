import type { BranchPath, ChapterMetadata, SceneMetadata } from '../types/index.js';

// ────────────────────────────────────────────────────────────────────────────
// SceneEntry, SortedScene, AssembleOptions, AssembleResult
// ────────────────────────────────────────────────────────────────────────────

export interface SceneEntry {
  prose: string;
  metadata: SceneMetadata;
  narrativeOrder: number;
  chapter: number;
}

export interface SortedScene {
  eventId: string;
  prose: string;
  narrativeOrder: number;
  chapter: number;
}

export interface AssembleOptions {
  /** Root directory of the novel project (must contain scenes/ and chapters/) */
  projectDir: string;
  /** Custom output path; defaults to <projectDir>/output/novel.md */
  outputPath?: string;
  /** Novel title (overrides the title in nova.yaml) */
  title?: string;
  /** Optional branch path for branch-filtered assembly */
  branchPath?: BranchPath;
}

export interface AssembleResult {
  /** Full novel markdown content */
  markdown: string;
  /** Word count of the assembled novel (excluding headings and separators) */
  wordCount: number;
  /** Number of scenes included */
  sceneCount: number;
}
