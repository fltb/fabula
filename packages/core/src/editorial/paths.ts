import * as path from 'node:path';
import { DEFAULT_CONFIG } from '../config/index.ts';

export interface ProjectPaths {
  projectDir: string;
  workDir: string;
  responsesDir: string;
  sceneRevisionsDir: string;
  sourceRevisionsDir: string;
  operationsDir: string;
  transactionsDir: string;
  conflictsDir: string;
  derivedDir: string;
  dryRunsDir: string;
  renderCacheDir: string;
  tracesDir: string;
  renderPlansDir: string;
  snapshotsDir: string;
  publicationPath: string;
  sourceHeadPath: string;
  transactionLockPath: string;
  scenesDir: string;
  outputDir: string;
  novelPath: string;
  reviewsDir: string;
  reviewLedgerPath: string;
}

/** The sole project/work-artifact path resolver used by editorial callers. */
export function resolveProjectPaths(projectDir: string, outputDir?: string): ProjectPaths {
  const workDir = path.join(projectDir, outputDir ?? DEFAULT_CONFIG.outputDir);
  const transactionsDir = path.join(workDir, 'transactions');
  const transparentOutputDir = path.join(projectDir, 'output');
  const reviewsDir = path.join(projectDir, 'reviews');
  return {
    projectDir,
    workDir,
    responsesDir: path.join(workDir, 'responses'),
    sceneRevisionsDir: path.join(workDir, 'revisions', 'scenes'),
    sourceRevisionsDir: path.join(workDir, 'revisions', 'sources'),
    operationsDir: path.join(workDir, 'operations'),
    transactionsDir,
    conflictsDir: path.join(workDir, 'conflicts'),
    derivedDir: path.join(workDir, 'derived'),
    dryRunsDir: path.join(workDir, 'dry-runs'),
    renderCacheDir: path.join(workDir, 'render-cache'),
    tracesDir: path.join(workDir, 'traces'),
    renderPlansDir: path.join(workDir, 'render-plans'),
    snapshotsDir: path.join(workDir, 'snapshots'),
    publicationPath: path.join(workDir, 'publication.json'),
    sourceHeadPath: path.join(workDir, 'source-head.json'),
    transactionLockPath: path.join(transactionsDir, 'workspace.lock'),
    scenesDir: path.join(projectDir, 'scenes'),
    outputDir: transparentOutputDir,
    novelPath: path.join(transparentOutputDir, 'novel.md'),
    reviewsDir,
    reviewLedgerPath: path.join(reviewsDir, 'pending.json'),
  };
}
