import type { JsonObject } from '../contracts/json.ts';
import type { ProjectSourceSnapshotV1 } from '../contracts/source.ts';
import type { BranchPath, BranchSet } from '../types/index.js';
import type { ChapterMetadata } from '../types/chapter.ts';
import type { DiscourseSceneSequenceEntry } from '../types/graph.ts';

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
  constructor(code: AssemblyErrorCodeType, message: string) { super(message); this.name = 'AssemblyError'; this.code = code; }
}

export interface SceneEntry {
  prose: string;
  /** JSON-safe scene metadata materialized by the host loader. */
  metadata: JsonObject;
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
interface SceneInfo { eventId: string; chapter: number; narrativeOrder: number; branchExistence: BranchSet; }

/** Materialized semantic inputs for assembly. Host loaders create this value. */
export interface AssemblySource {
  readonly snapshot: ProjectSourceSnapshotV1;
  readonly scenes: ReadonlyMap<string, SceneEntry>;
  readonly chapterTitles?: ReadonlyMap<number, ChapterMetadata>;
  readonly projectTitle?: string;
  readonly discourseSequence: readonly DiscourseSceneSequenceEntry[];
}
export interface AssembleOptions {
  readonly source: AssemblySource;
  readonly outputPath?: never;
  readonly title?: string;
  readonly branchPath?: BranchPath;
  readonly discourseBranch?: string;
  readonly language?: string;
}
export interface AssembleResult {
  readonly markdown: string;
  readonly wordCount: number;
  readonly sceneCount: number;
  readonly scenes: SceneInfo[];
  readonly sourceHash: string;
}
