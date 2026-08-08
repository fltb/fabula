import { cleanup, render, screen, within } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAuthoringApiError } from '../../src/client/authoring-client.js';
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
    await user.click(screen.getByRole('button', { name: '提交工作层' }));
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
    expect(screen.getByRole('heading', { name: '工作候选诊断 — 未被接受' })).toBeInTheDocument();
    expect(screen.getByText('invalid YAML')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '提交工作层' })).not.toBeInTheDocument();
  });
});

describe('Source Studio working-document lifecycle', () => {
  it('creates a working document with the exact CAS request', async () => {
    const onCreateDocument = vi.fn();
    const user = userEvent.setup();
    render(() => (
      <SourceStudio state={source} authoring={authoring} onCreateDocument={onCreateDocument} />
    ));
    await user.click(screen.getByRole('button', { name: '新建工作文稿' }));
    await user.type(screen.getByLabelText('清单相对逻辑路径'), 'scenes/E1.md');
    await user.selectOptions(screen.getByLabelText('文稿类型'), 'prose');
    await user.click(screen.getByRole('button', { name: '创建工作文稿' }));
    expect(onCreateDocument).toHaveBeenCalledWith({
      version: 2,
      projectId: 'proj-a',
      logicalPath: 'scenes/E1.md',
      kind: 'prose',
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
    });
  });

  it('moves a working document to a new logical path', async () => {
    const onMoveDocument = vi.fn();
    const user = userEvent.setup();
    render(() => (
      <SourceStudio state={source} authoring={authoring} onMoveDocument={onMoveDocument} />
    ));
    const item = screen.getByText('nova.yaml').closest('li');
    expect(item).not.toBeNull();
    const row = within(item as HTMLElement);
    await user.click(row.getByRole('button', { name: '重命名/移动' }));
    const pathInput = row.getByLabelText('新的清单相对逻辑路径');
    await user.clear(pathInput);
    await user.type(pathInput, 'scenes/E2.md');
    await user.click(row.getByRole('button', { name: '移动文稿' }));
    expect(onMoveDocument).toHaveBeenCalledWith({
      version: 2,
      projectId: 'proj-a',
      documentId: 'nova.yaml',
      logicalPath: 'scenes/E2.md',
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
    });
  });

  it('deletes a working document only after explicit confirmation', async () => {
    const onDeleteDocument = vi.fn();
    const user = userEvent.setup();
    render(() => (
      <SourceStudio state={source} authoring={authoring} onDeleteDocument={onDeleteDocument} />
    ));
    const item = screen.getByText('nova.yaml').closest('li');
    expect(item).not.toBeNull();
    const row = within(item as HTMLElement);
    await user.click(row.getByRole('button', { name: '删除' }));
    expect(onDeleteDocument).not.toHaveBeenCalled();
    await user.click(row.getByRole('button', { name: '取消' }));
    expect(onDeleteDocument).not.toHaveBeenCalled();
    await user.click(row.getByRole('button', { name: '删除' }));
    await user.click(row.getByRole('button', { name: '确认删除' }));
    expect(onDeleteDocument).toHaveBeenCalledWith({
      version: 2,
      projectId: 'proj-a',
      documentId: 'nova.yaml',
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
    });
  });

  it('surfaces stale lifecycle failures with the typed client error', async () => {
    const onCreateDocument = vi.fn(async () => {
      throw new BrowserAuthoringApiError(
        409,
        'WORKSPACE_STALE',
        'The working layer changed; re-read before mutating.',
      );
    });
    const user = userEvent.setup();
    render(() => (
      <SourceStudio state={source} authoring={authoring} onCreateDocument={onCreateDocument} />
    ));
    await user.click(screen.getByRole('button', { name: '新建工作文稿' }));
    await user.type(screen.getByLabelText('清单相对逻辑路径'), 'scenes/E1.md');
    await user.click(screen.getByRole('button', { name: '创建工作文稿' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The working layer changed; re-read before mutating.');
    expect(alert).toHaveAttribute('data-mutation-error');
  });

  it('offers no lifecycle actions without a Host handler', () => {
    render(() => <SourceStudio state={source} authoring={authoring} />);
    expect(screen.queryByRole('button', { name: '新建工作文稿' })).not.toBeInTheDocument();
    const item = screen.getByText('nova.yaml').closest('li');
    expect(item).not.toBeNull();
    expect(
      within(item as HTMLElement).queryByRole('button', { name: 'Delete' }),
    ).not.toBeInTheDocument();
    expect(
      within(item as HTMLElement).queryByRole('button', { name: '重命名/移动' }),
    ).not.toBeInTheDocument();
  });

  it('disables lifecycle actions when the working digest is unknown', () => {
    render(() => (
      <SourceStudio
        state={source}
        authoring={{ ...authoring, workspaceDigest: null }}
        onCreateDocument={vi.fn()}
        onMoveDocument={vi.fn()}
        onDeleteDocument={vi.fn()}
      />
    ));
    expect(screen.queryByRole('button', { name: '新建工作文稿' })).not.toBeInTheDocument();
    const item = screen.getByText('nova.yaml').closest('li');
    expect(item).not.toBeNull();
    expect(within(item as HTMLElement).getByRole('button', { name: '删除' })).toBeDisabled();
    expect(within(item as HTMLElement).getByRole('button', { name: '重命名/移动' })).toBeDisabled();
  });
});
