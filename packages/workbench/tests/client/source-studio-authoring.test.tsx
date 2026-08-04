import { cleanup, render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceStudio } from '../../src/client/source-studio.js';
import type { AuthoringStateV1 } from '../../src/contracts/authoring.js';
import type { SourceStudioStateV1 } from '../../src/contracts/source-studio.js';

afterEach(() => cleanup());

const source: SourceStudioStateV1 = {
  version: 1,
  projectId: 'proj-a',
  accepted: null,
  working: {
    documents: [
      { projectId: 'proj-a', documentId: 'nova.yaml', kind: 'raw-yaml', available: true },
    ],
  },
  generatedAt: '2099-01-01T00:00:00.000Z',
};

const authoring: AuthoringStateV1 = {
  version: 2,
  projectId: 'proj-a',
  phase: 'working-dirty',
  acceptedRevisionId: null,
  acceptedSourceHash: 'accepted-hash',
  pendingOperationId: null,
  workingDirty: true,
  workspaceDigest: 'workspace-hash',
  externalCandidate: null,
  conflicts: [],
  diagnostics: [],
  canSubmit: true,
  submitBlockReason: 'none',
  generatedAt: '2099-01-01T00:00:00.000Z',
};

describe('Source Studio authoring identities', () => {
  it('submits only the safe workspace CAS request', async () => {
    const onSubmitAuthoring = vi.fn();
    const user = userEvent.setup();
    render(() => (
      <SourceStudio state={source} authoring={authoring} onSubmitAuthoring={onSubmitAuthoring} />
    ));
    await user.click(screen.getByRole('button', { name: 'Submit working layer' }));
    expect(onSubmitAuthoring).toHaveBeenCalledWith({
      version: 2,
      projectId: 'proj-a',
      expectedAcceptedRevisionId: null,
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
    });
  });

  it('labels invalid candidate diagnostics as noncanonical and blocks submit', () => {
    render(() => (
      <SourceStudio
        state={source}
        authoring={{
          ...authoring,
          canSubmit: false,
          phase: 'candidate-invalid',
          submitBlockReason: 'candidate-invalid',
          diagnostics: [
            {
              code: 'YAML_INVALID',
              severity: 'error',
              message: 'invalid YAML',
              logicalPath: 'nova.yaml',
            },
          ],
        }}
        operations={[]}
      />
    ));
    expect(
      screen.getByRole('heading', { name: 'Working candidate diagnostics — not accepted' }),
    ).toBeInTheDocument();
    expect(screen.getByText('invalid YAML')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit working layer' })).not.toBeInTheDocument();
  });
});
