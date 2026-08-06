// ============================================================================
// FileProjectStatusReporter — derived PROJECT_STATUS.md at the project root
// ============================================================================
//
// The workflow status is a DERIVED artifact: the same `WorkflowStatusV1` the
// `nova_status` MCP tool returns, persisted as readable markdown so a human or
// script can see the project state without a client. It is NOT part of the
// authoring manifest, the native revision bundle, or the Git mirror — all of
// those only ever carry the manifest-approved YAML source topology, so writing
// this file can never change source identity or the watcher's tree hash.
//
// Write failures only mark the reporter `degraded`; they never roll back the
// accepted revision, because the status file is never a source of authority.
// ============================================================================

import * as path from 'node:path';
import type { WorkflowStatusV1 } from '@novalistically/core';
import {
  atomicWrite,
  prepareDirectory,
  recoverJournal,
  withDirectoryLock,
} from '../execution/types.js';

/** Fixed derived status filename at the project root. */
export const PROJECT_STATUS_FILENAME = 'PROJECT_STATUS.md' as const;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function eventList(ids: readonly string[]): string {
  return ids.length === 0 ? '_(none)_' : ids.map((id) => `\`${id}\``).join(', ');
}

/**
 * Deterministic markdown rendering of one accepted-layer workflow status.
 * Renders the same fields `nova_status` returns so the file and the tool can
 * never disagree: project identity, source/revision, validation, render
 * buckets, blockers, review, publication, next actions, guidance, generatedAt.
 */
export function formatProjectStatus(status: WorkflowStatusV1): string {
  const lines: string[] = [
    '# Project Status',
    '',
    `- **projectId**: \`${status.projectId}\``,
    `- **layer**: \`${status.layer}\``,
    `- **sourceHash**: \`${status.sourceHash}\``,
    `- **acceptedRevisionId**: ${
      status.acceptedRevisionId === null ? '_(none)_' : `\`${status.acceptedRevisionId}\``
    }`,
    `- **generatedAt**: \`${status.generatedAt}\``,
    '',
    '## Validation',
    '',
    `- **passed**: \`${status.validation.passed}\``,
    `- **errors**: ${status.validation.errors.length}`,
    `- **warnings**: ${status.validation.warnings.length}`,
  ];
  for (const issue of status.validation.errors) {
    lines.push(`  - \`error\` [${issue.validator}] ${issue.event}: ${oneLine(issue.message)}`);
  }
  for (const issue of status.validation.warnings) {
    lines.push(`  - \`warning\` [${issue.validator}] ${issue.event}: ${oneLine(issue.message)}`);
  }
  lines.push(
    '',
    '## Render',
    '',
    `- **completed** (${status.render.completed.length}): ${eventList(status.render.completed)}`,
    `- **ready** (${status.render.ready.length}): ${eventList(status.render.ready)}`,
    `- **blocked** (${status.render.blocked.length}): ${eventList(status.render.blocked)}`,
    `- **waiting** (${status.render.waiting.length}): ${eventList(status.render.waiting)}`,
    '',
    '## Blockers',
    '',
  );
  if (status.blockers.length === 0) {
    lines.push('_(none)_');
  }
  for (const blocker of status.blockers) {
    const event = blocker.eventId === undefined ? '' : ` ${blocker.eventId}`;
    lines.push(`- \`${blocker.severity}\` [${blocker.code}]${event}: ${oneLine(blocker.message)}`);
  }
  lines.push(
    '',
    '## Review',
    '',
    `- **open**: ${status.review.open}`,
    `- **blocking**: ${status.review.blocking}`,
    `- **pendingGates**: ${status.review.pendingGates}`,
    '',
    '## Publication',
    '',
    `- **status**: \`${status.publication.status}\``,
    `- **publicationId**: ${
      status.publication.publicationId === null
        ? '_(none)_'
        : `\`${status.publication.publicationId}\``
    }`,
    `- **novelHash**: ${
      status.publication.novelHash === null ? '_(none)_' : `\`${status.publication.novelHash}\``
    }`,
    '',
    '## Next actions',
    '',
  );
  if (status.nextActions.length === 0) {
    lines.push('_(none)_');
  }
  for (const next of status.nextActions) {
    const reasons = next.reasonCodes.length === 0 ? '' : ` (${next.reasonCodes.join(', ')})`;
    lines.push(`- \`${next.code}\` — \`${next.tool}\` [${next.priority}]${reasons}`);
  }
  lines.push('', '## Guidance', '');
  lines.push(status.guidance.trim() === '' ? '_(none)_' : status.guidance);
  return `${lines.join('\n')}\n`;
}

/**
 * Atomically persist a workflow status as `PROJECT_STATUS.md` at the project
 * root. The file is a derived artifact (see module header); the write reuses
 * the same journal + lock + atomic-rename path the execution repositories and
 * the validation reporter use, so a crash mid-write cannot leave a torn file.
 */
export async function writeFileProjectStatus(
  projectRoot: string,
  status: WorkflowStatusV1,
): Promise<string> {
  const root = path.resolve(projectRoot);
  const target = path.join(root, PROJECT_STATUS_FILENAME);
  await prepareDirectory(root, root);
  return withDirectoryLock(root, root, async () => {
    await recoverJournal(root, root);
    await atomicWrite(root, root, target, formatProjectStatus(status));
    return target;
  });
}

/**
 * Best-effort per-project status writer. `refresh` never throws: a write
 * failure marks the reporter `degraded` and leaves the accepted revision
 * untouched; a later successful refresh clears the flag.
 */
export class FileProjectStatusReporter {
  private degradedFlag = false;

  constructor(private readonly projectRoot: string) {}

  /** True when the last status write failed; the accepted revision is unaffected. */
  get degraded(): boolean {
    return this.degradedFlag;
  }

  /** Best-effort refresh of the derived status file. Never throws. */
  async refresh(status: WorkflowStatusV1): Promise<void> {
    try {
      await writeFileProjectStatus(this.projectRoot, status);
      this.degradedFlag = false;
    } catch {
      this.degradedFlag = true;
    }
  }
}
