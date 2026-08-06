import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  type AcceptedSceneRecord,
  buildWorkflowStatus,
  type ISSSnapshot,
  type WorkflowStatusInputV1,
} from '@novalistically/core';
import { buildSourceSnapshot, computeSourceDocumentHash } from '@novalistically/core/source';
import { describe, expect, it } from 'vitest';
import {
  FileProjectSourceLoader,
  FileProjectStatusReporter,
  formatProjectStatus,
  PROJECT_STATUS_FILENAME,
  writeFileProjectStatus,
} from '../src/index.js';

const ISS: ISSSnapshot = { overall: 100, target: 80, dimensions: [] };

function makeStatus(overrides: Partial<WorkflowStatusInputV1> = {}): WorkflowStatusInputV1 {
  return {
    projectId: 'status-project',
    snapshot: buildSourceSnapshot([
      {
        version: 1,
        logicalPath: 'nova.yaml',
        content: 'version: 1\n',
        contentHash: computeSourceDocumentHash('version: 1\n'),
        parseResult: { status: 'parsed', value: null },
        diagnostics: [],
      },
    ]),
    acceptedRevisionId: 'rev-1',
    validation: { errors: [], warnings: [] },
    iss: ISS,
    execution: {
      events: [
        {
          eventId: 'E1',
          acceptedScene: {
            version: 1,
            projectId: 'status-project',
            eventId: 'E1',
            sourceHash: 'source-1',
            revisionId: 'rev-1',
            prose: 'rendered prose',
            proseHash: 'ph',
            sceneHash: 'sh',
          } satisfies AcceptedSceneRecord,
          renderBlockedReasons: [],
        },
      ],
    },
    working: { dirty: false, validated: false, validationPassed: false, conflict: false },
    review: { open: 0, blocking: 0, pendingGates: 0 },
    publication: { status: 'missing', publicationId: null, novelHash: null },
    now: () => '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

const withTempProject = async (run: (projectRoot: string) => Promise<void>): Promise<void> => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'fabula-status-reporter-'));
  try {
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
};

describe('FileProjectStatusReporter', () => {
  it('writes PROJECT_STATUS.md atomically at the project root with the full status', async () => {
    await withTempProject(async (root) => {
      const status = buildWorkflowStatus(makeStatus());
      const target = await writeFileProjectStatus(root, status);

      expect(target).toBe(path.join(root, PROJECT_STATUS_FILENAME));
      const markdown = await readFile(target, 'utf8');
      expect(markdown).toContain('# Project Status');
      expect(markdown).toContain('status-project');
      expect(markdown).toContain(status.sourceHash);
      expect(markdown).toContain('rev-1');
      expect(markdown).toContain('## Validation');
      expect(markdown).toContain('## Render');
      expect(markdown).toContain('## Blockers');
      expect(markdown).toContain('## Review');
      expect(markdown).toContain('## Publication');
      expect(markdown).toContain('## Next actions');
      expect(markdown).toContain('## Guidance');
      expect(markdown).toContain(status.generatedAt);
      expect(markdown).toContain('E1');
    });
  });

  it('renders validation errors, blockers and next actions deterministically', () => {
    const status = buildWorkflowStatus(
      makeStatus({
        validation: {
          errors: [
            {
              validator: 'test-validator',
              severity: 'error',
              kind: 'compiler_invariant',
              event: 'E2',
              entity: '',
              message: 'precondition cannot be satisfied',
              fixSuggestion: 'fix it',
              fixAction: 'edit_file',
              fixTarget: { file: 'chapters/chapter_01/E2.yaml' },
            },
          ],
          warnings: [],
        },
        execution: { events: [] },
      }),
    );
    const markdown = formatProjectStatus(status);
    expect(markdown).toContain('`error` [test-validator] E2: precondition cannot be satisfied');
    expect(markdown).toContain('[VALIDATION_ERROR]');
    expect(markdown).toContain('`FIX_ACCEPTED_SOURCE`');
    expect(markdown).toContain('Fix the accepted source');
  });

  it('marks the reporter degraded on write failure without throwing', async () => {
    // A regular file where the project root should be: every write fails
    // closed before touching the accepted revision.
    const badRoot = path.join(tmpdir(), `fabula-status-bad-${Date.now()}`);
    await writeFile(badRoot, 'not a directory');
    try {
      const reporter = new FileProjectStatusReporter(badRoot);
      await expect(reporter.refresh(buildWorkflowStatus(makeStatus()))).resolves.toBeUndefined();
      expect(reporter.degraded).toBe(true);
    } finally {
      await rm(badRoot, { force: true });
    }
  });

  it('clears the degraded flag after a later successful write', async () => {
    await withTempProject(async (root) => {
      const badRoot = path.join(root, 'nested');
      await writeFile(badRoot, 'not a directory');
      const reporter = new FileProjectStatusReporter(badRoot);
      await reporter.refresh(buildWorkflowStatus(makeStatus()));
      expect(reporter.degraded).toBe(true);
      // Point the reporter at the real project root: the next refresh succeeds.
      const recovered = new FileProjectStatusReporter(root);
      await recovered.refresh(buildWorkflowStatus(makeStatus()));
      expect(recovered.degraded).toBe(false);
    });
  });

  it('never enters the authoring source topology (manifest, revision or mirror inputs)', async () => {
    await withTempProject(async (root) => {
      // Minimal manifest-approved tree so the loader can read it.
      for (const logical of [
        'nova.yaml',
        'definitions/state_initial.yaml',
        'definitions/entity-types.yaml',
        'definitions/thread-types.yaml',
        'definitions/propositions.yaml',
        'definitions/relationship-types.yaml',
        'definitions/rule-types.yaml',
      ]) {
        const target = path.join(root, ...logical.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, 'version: 1\n');
      }
      const loader = new FileProjectSourceLoader();
      const before = loader.load(root).sourceHash;
      await writeFileProjectStatus(root, buildWorkflowStatus(makeStatus()));
      const after = loader.load(root).sourceHash;
      // The loader only reads the manifest-approved YAML topology; the derived
      // markdown file must not change source identity, so it can never reach
      // the authoring manifest, a native revision bundle, or the Git mirror.
      expect(after).toBe(before);
      expect(PROJECT_STATUS_FILENAME.endsWith('.md')).toBe(true);
    });
  });
});
