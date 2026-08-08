import { cleanup, render, screen, within } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceStudio, type SourceStudioYjsStatus } from '../../src/client/source-studio';
import type { SourceStudioStateV1 } from '../../src/contracts/index.js';

afterEach(() => cleanup());

const projection = {
  version: 1 as const,
  projectId: 'proj-a',
  revision: 4,
  sourceHash: 'hash-4',
  documents: 2,
  events: 5,
  rendered: 5,
  pending: 0,
  blocked: 0,
  errorCount: 1,
  warningCount: 2,
  diagnostics: [
    {
      code: 'E1',
      severity: 'error' as const,
      message: 'unclosed quote',
      logicalPath: 'chapters/chapter_01/_chapter.yaml',
    },
    {
      code: 'W1',
      severity: 'warning' as const,
      message: 'missing prose hint',
      logicalPath: null,
    },
  ],
  presence: [],
  generatedAt: '2026-08-02T00:00:00.000Z',
};

const state: SourceStudioStateV1 = {
  version: 1,
  projectId: 'proj-a',
  accepted: projection,
  working: {
    documents: [
      {
        projectId: 'proj-a',
        documentId: 'chapters/chapter_01/_chapter.yaml',
        kind: 'raw-yaml',
        available: true,
      },
      {
        projectId: 'proj-a',
        documentId: 'scenes/E1.md',
        kind: 'prose',
        available: false,
      },
    ],
  },
  generatedAt: '2026-08-02T00:00:00.000Z',
};

describe('SourceStudio accepted projection', () => {
  it('renders only Host-provided accepted identity and diagnostics', () => {
    render(() => <SourceStudio state={state} />);

    expect(screen.getByRole('heading', { name: '写作源文稿' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '已接受的源 — 最后校验通过的投影' }),
    ).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('hash-4')).toBeInTheDocument();
    expect(screen.getByText('unclosed quote')).toBeInTheDocument();
    expect(screen.getByText('missing prose hint')).toBeInTheDocument();
  });

  it('shows an honest empty state when the Host has no accepted projection', () => {
    render(() => <SourceStudio state={{ ...state, accepted: null }} />);
    expect(screen.getByText('Host 还没有该项目已接受的源投影。')).toBeInTheDocument();
  });

  it('shows an honest empty state when no Host state was provided', () => {
    render(() => <SourceStudio state={null} />);
    expect(screen.getByText('暂无源状态')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('SourceStudio working layer disclosure', () => {
  it('labels Yjs as a noncanonical online-only layer, never accepted source', () => {
    render(() => <SourceStudio state={state} />);

    expect(
      screen.getByRole('heading', {
        name: '工作层（Yjs）— 仅在线，非已接受源',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/工作层编辑是非权威的.*不会被采纳为已接受源/i)).toBeInTheDocument();
    expect(screen.getByText('chapters/chapter_01/_chapter.yaml')).toBeInTheDocument();
    expect(screen.getByText('scenes/E1.md')).toBeInTheDocument();
  });

  it('never offers a submit or connect action without a Host-provided handler', () => {
    render(() => <SourceStudio state={state} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
  });

  it('passes the exact descriptor to Host-provided connect and submit handlers', async () => {
    const connect = vi.fn();
    const submit = vi.fn();
    const user = userEvent.setup();
    render(() => <SourceStudio state={state} onConnectYjs={connect} onSubmit={submit} />);

    const first = screen.getByText('chapters/chapter_01/_chapter.yaml').closest('li');
    expect(first).not.toBeNull();
    const available = within(first as HTMLElement);
    await user.click(available.getByRole('button', { name: '连接工作文稿' }));
    await user.click(available.getByRole('button', { name: '提交工作文稿到 Host' }));

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(state.working.documents[0]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(state.working.documents[0]);
  });

  it('disables actions for working documents the Host reports as unavailable', () => {
    render(() => <SourceStudio state={state} onConnectYjs={vi.fn()} onSubmit={vi.fn()} />);
    const second = screen.getByText('scenes/E1.md').closest('li');
    expect(second).not.toBeNull();
    const unavailable = within(second as HTMLElement);
    expect(unavailable.getByRole('button', { name: '连接工作文稿' })).toBeDisabled();
    expect(unavailable.getByRole('button', { name: '提交工作文稿到 Host' })).toBeDisabled();
  });

  it('reports browser-local connection status without binding a socket itself', () => {
    const yjsStatus: Record<string, SourceStudioYjsStatus> = {
      'chapters/chapter_01/_chapter.yaml': 'connected',
    };
    render(() => <SourceStudio state={state} yjsStatus={yjsStatus} />);
    expect(screen.getByText('connected')).toBeInTheDocument();
    expect(screen.getByText('idle')).toBeInTheDocument();
  });
});
describe('SourceStudio native history controls', () => {
  it('reads revision details/diffs and restores with server-owned CAS identities', async () => {
    const getRevision = vi.fn();
    const diffRevisions = vi.fn();
    const restoreRevision = vi.fn();
    const user = userEvent.setup();
    render(() => (
      <SourceStudio
        state={state}
        authoring={{
          version: 2,
          projectId: 'proj-a',
          phase: 'clean',
          acceptedRevisionId: 'head-2',
          acceptedSourceHash: 'source-2',
          pendingOperationId: null,
          workingDirty: false,
          workspaceDigest: 'workspace-2',
          externalCandidate: null,
          conflicts: [],
          diagnostics: [],
          canSubmit: false,
          submitBlockReason: 'not-dirty',
          generatedAt: state.generatedAt,
        }}
        revisionHistory={{
          version: 2,
          projectId: 'proj-a',
          revisions: [
            {
              version: 2,
              revisionId: 'head-1',
              sourceHash: 'source-1',
              createdAt: state.generatedAt,
              acceptedAt: state.generatedAt,
            },
            {
              version: 2,
              revisionId: 'head-2',
              sourceHash: 'source-2',
              createdAt: state.generatedAt,
              acceptedAt: state.generatedAt,
            },
          ],
          generatedAt: state.generatedAt,
        }}
        onGetRevision={getRevision}
        onDiffRevisions={diffRevisions}
        onRestoreRevision={restoreRevision}
      />
    ));
    await user.click(screen.getAllByRole('button', { name: '查看修订' })[0] as HTMLElement);
    await user.click(screen.getByRole('button', { name: '与上一修订对比' }));
    await user.click(screen.getAllByRole('button', { name: '恢复修订' })[1] as HTMLElement);
    expect(getRevision).toHaveBeenCalledWith('head-1');
    expect(diffRevisions).toHaveBeenCalledWith('head-1', 'head-2');
    expect(restoreRevision).toHaveBeenCalledWith({
      version: 2,
      projectId: 'proj-a',
      revisionId: 'head-2',
      expectedAcceptedRevisionId: 'head-2',
      expectedSourceHash: 'source-2',
    });
  });
});
