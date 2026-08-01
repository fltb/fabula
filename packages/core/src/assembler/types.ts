import type { Storage } from '../storage/index.ts';
import type { SceneMetadataV1 } from '../types/editorial.ts';
import type { BranchPath, BranchSet } from '../types/index.js';

// ────────────────────────────────────────────────────────────────────────────
// AssemblyError — typed error for assembly failures
// ────────────────────────────────────────────────────────────────────────────

export const AssemblyErrorCode = {
  NO_SCENES: 'NO_SCENES',
  MISSING_METADATA: 'MISSING_METADATA',
  MISSING_NARRATIVE_ORDER: 'MISSING_NARRATIVE_ORDER',
  MISSING_BRANCH_EXISTENCE: 'MISSING_BRANCH_EXISTENCE',
  INVALID_BRANCH_EXISTENCE: 'INVALID_BRANCH_EXISTENCE',
  MISSING_PROSE: 'MISSING_PROSE',
  EMPTY_PROSE: 'EMPTY_PROSE',
  UNKNOWN_COUNT_VERSION: 'UNKNOWN_COUNT_VERSION',
} as const;

export type AssemblyErrorCodeType = (typeof AssemblyErrorCode)[keyof typeof AssemblyErrorCode];

export class AssemblyError extends Error {
  readonly code: AssemblyErrorCodeType;

  constructor(code: AssemblyErrorCodeType, message: string) {
    super(message);
    this.name = 'AssemblyError';
    this.code = code;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SceneEntry, SortedScene, AssembleOptions, AssembleResult
// ────────────────────────────────────────────────────────────────────────────

export interface SceneEntry {
  prose: string;
  metadata: SceneMetadataV1;
  narrativeOrder: number;
  chapter: number;
  branchExistence: BranchSet;
}

export interface SortedScene {
  eventId: string;
  prose: string;
  narrativeOrder: number;
  chapter: number;
  branchExistence: BranchSet;
}

interface SceneInfo {
  eventId: string;
  chapter: number;
  narrativeOrder: number;
  branchExistence: BranchSet;
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
  /** Discourse branch for scene sequencing; defaults to "main" */
  discourseBranch?: string;
  language?: string;
  /** Optional storage backend (defaults to FsStorage) */
  storage?: Storage;
}

export interface AssembleResult {
  /** Full novel markdown content */
  markdown: string;
  /** Word count of the assembled novel (excluding headings and separators) */
  wordCount: number;
  /** Number of scenes included */
  sceneCount: number;
  /** Per-scene metadata for the assembled scenes */
  scenes: SceneInfo[];
}
