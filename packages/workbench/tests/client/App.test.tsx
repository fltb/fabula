import { cleanup, render, screen, waitFor, within } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, type HostStatus } from '../../src/client/App';
import type { AgentChatClient } from '../../src/client/agent-chat-client.js';
import type {
  BrowserPublicationListV1,
  BrowserReviewGateListV1,
  BrowserReviewListV1,
} from '../../src/contracts/browser-api';

const navigationLabels = [
  'Project Home',
  'Scene Canvas',
  'Source Studio',
  'Graph / Route',
] as const;

function stubAgentChatClient(): AgentChatClient {
  const conversation = {
    version: 1 as const,
    conversationId: 'conv-1',
    projectId: 'project-a',
    title: null,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
  };
  return {
    createConversation: async (projectId: string) => ({ ...conversation, projectId }),
    listConversations: async () => [conversation],
    sendMessage: async () => ({
      version: 1 as const,
      runId: 'run-1',
      conversationId: 'conv-1',
      operationId: 'op-1',
      status: 'queued' as const,
      turn: 0,
      maxTurns: 16,
      toolCalls: 0,
      maxToolCalls: 64,
      errorCode: null,
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
    }),
    history: async () => ({
      version: 1 as const,
      projectId: 'project-a',
      conversation,
      runs: [],
      messages: [],
    }),
    cancel: async (_projectId: string, runId: string) => ({
      version: 1 as const,
      runId,
      status: 'cancelled' as const,
    }),
    retry: async (_projectId: string, runId: string) => ({
      version: 1 as const,
      runId,
      status: 'queued' as const,
    }),
    openProgress: () => () => {},
  };
}

afterEach(() => {
  cleanup();
  setViewport(1024);
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

describe('Workbench shell layout controls', () => {
  it('collapses the Navigator without removing its accessible view names', async () => {
    const user = userEvent.setup();
    render(() => <App initialNavigatorCollapsed={false} />);

    const navigator = screen.getByTestId('navigator');
    await user.click(screen.getByRole('button', { name: 'Collapse Navigator' }));

    expect(navigator).toHaveAttribute('data-collapsed', 'true');
    expect(screen.getByRole('button', { name: 'Expand Navigator' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Project Home' })).toBeInTheDocument();
  });

  it('expands the operation center without the removed Inspector column', async () => {
    const user = userEvent.setup();
    render(() => <App initialOperationCenterExpanded={false} />);

    expect(screen.queryByTestId('inspector')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand' }));
    expect(screen.getByText('No operations running')).toBeInTheDocument();
  });
});

describe('Workbench responsive drawers', () => {
  it('uses focus-managed drawers on mobile and retains docked tablet navigation', async () => {
    setViewport(700);
    const user = userEvent.setup();
    render(() => <App />);

    await user.click(await screen.findByRole('button', { name: 'Open navigation' }));
    const navigationDrawer = await screen.findByRole('dialog', { name: 'Navigation' });
    const closeNavigation = within(navigationDrawer).getByRole('button', {
      name: 'Close Navigation',
    });
    await waitFor(() => expect(closeNavigation).toHaveFocus());
    expect(
      within(navigationDrawer).getByRole('navigation', { name: 'Workbench views' }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument(),
    );

    cleanup();
    setViewport(900);
    render(() => <App />);
    expect(screen.queryByRole('button', { name: 'Open navigation' })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Workbench views' })).toBeInTheDocument();
    expect(screen.queryByTestId('inspector')).not.toBeInTheDocument();

    cleanup();
    setViewport(1024);
    render(() => <App />);
    expect(screen.queryByRole('button', { name: 'Open navigation' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('inspector')).not.toBeInTheDocument();
  });
});

describe('Workbench named navigation', () => {
  it('renders every available view and changes the active workspace without project data', async () => {
    const user = userEvent.setup();
    render(() => <App initialView="project-home" />);

    const navigation = screen.getByRole('navigation', { name: 'Workbench views' });
    for (const label of navigationLabels) {
      expect(within(navigation).getByRole('button', { name: label })).toBeInTheDocument();
    }

    await user.click(within(navigation).getByRole('button', { name: 'Graph / Route' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Graph / Route' })).toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: 'Graph / Route' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.queryByText(/example project|demo scene|sample graph/i)).not.toBeInTheDocument();
  });
});

describe('Workbench feature-gated views', () => {
  it('shows only the four always-on views and an empty Agent shelf without Host features', () => {
    render(() => <App />);
    const navigation = screen.getByRole('navigation', { name: 'Workbench views' });
    for (const label of navigationLabels) {
      expect(within(navigation).getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(
      within(navigation).queryByRole('button', { name: 'Review Hub' }),
    ).not.toBeInTheDocument();
    expect(
      within(navigation).queryByRole('button', { name: 'Publication' }),
    ).not.toBeInTheDocument();
    // The global Agent drawer still renders (open by default) with the
    // no-project guidance panel; the chat surface itself is absent.
    expect(screen.getByTestId('agent-shelf')).toBeInTheDocument();
    expect(screen.getByTestId('agent-drawer-guidance')).toHaveTextContent(
      '选择一个项目后,Agent 将在这里就绪',
    );
    expect(screen.queryByTestId('agent-chat-input')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Agent Shelf' })).toBeInTheDocument();
  });

  it('derives the visible views from Host-supplied features', () => {
    render(() => <App features={['project-home', 'review-hub', 'agent-chat']} />);
    const navigation = screen.getByRole('navigation', { name: 'Workbench views' });
    expect(within(navigation).getByRole('button', { name: 'Project Home' })).toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: 'Review Hub' })).toBeInTheDocument();
    expect(
      within(navigation).queryByRole('button', { name: 'Scene Canvas' }),
    ).not.toBeInTheDocument();
    expect(
      within(navigation).queryByRole('button', { name: 'Source Studio' }),
    ).not.toBeInTheDocument();
    expect(
      within(navigation).queryByRole('button', { name: 'Graph / Route' }),
    ).not.toBeInTheDocument();
    expect(
      within(navigation).queryByRole('button', { name: 'Publication' }),
    ).not.toBeInTheDocument();
  });

  it('never offers an Agent Chat navigation view', () => {
    render(() => <App features={['project-home', 'agent-chat']} />);
    const navigation = screen.getByRole('navigation', { name: 'Workbench views' });
    expect(
      within(navigation).queryByRole('button', { name: 'Agent Chat' }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-shelf')).toBeInTheDocument();
  });

  it('renders the Agent Chat drawer whenever the chat surface is supplied', async () => {
    const client = stubAgentChatClient();
    render(() => (
      <App
        hostStatus="ready"
        features={['project-home', 'agent-chat']}
        agentChat={{ projectId: 'project-a', client }}
      />
    ));
    await waitFor(() => {
      expect(screen.getByTestId('agent-chat-input')).toBeInTheDocument();
    });
    expect(screen.getByTestId('agent-shelf')).toBeInTheDocument();

    cleanup();
    render(() => (
      <App
        hostStatus="ready"
        features={['project-home']}
        agentChat={{ projectId: 'project-a', client }}
      />
    ));
    await waitFor(() => {
      expect(screen.getByTestId('agent-chat-input')).toBeInTheDocument();
    });

    cleanup();
    render(() => <App hostStatus="ready" features={['project-home']} agentChat={null} />);
    expect(screen.getByTestId('agent-drawer-guidance')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-chat-input')).not.toBeInTheDocument();
  });

  it('collapses and reopens the Agent drawer from the shell controls', async () => {
    const client = stubAgentChatClient();
    const user = userEvent.setup();
    render(() => (
      <App
        hostStatus="ready"
        features={['project-home', 'agent-chat']}
        agentChat={{ projectId: 'project-a', client }}
      />
    ));
    await waitFor(() => {
      expect(screen.getByTestId('agent-chat-input')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Close Agent Shelf' }));
    expect(screen.queryByTestId('agent-shelf')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Open Agent Shelf' }).length).toBeGreaterThan(0);
    const fab = screen.getAllByRole('button', { name: 'Open Agent Shelf' })[0];
    expect(fab).toBeDefined();
    await user.click(fab as HTMLElement);
    expect(screen.getByTestId('agent-shelf')).toBeInTheDocument();
  });

  it('never offers a hidden view and clicking a visible view activates it', async () => {
    const user = userEvent.setup();
    render(() => <App features={['project-home', 'graph-route']} />);
    const navigation = screen.getByRole('navigation', { name: 'Workbench views' });
    await user.click(within(navigation).getByRole('button', { name: 'Graph / Route' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Graph / Route' })).toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: 'Graph / Route' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('starts on the first available view when the requested view is hidden', () => {
    render(() => <App initialView="review-hub" />);
    const navigation = screen.getByRole('navigation', { name: 'Workbench views' });
    expect(within(navigation).getByRole('button', { name: 'Project Home' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Project Home' })).toBeInTheDocument();
  });

  it('renders the Review Hub only when the review-hub feature is present', async () => {
    const reviewState: BrowserReviewListV1 = {
      version: 1,
      projectId: 'project-a',
      comments: [
        {
          version: 1,
          commentId: 'review-1',
          eventId: 'E1',
          targetType: 'scene',
          severity: 'blocking',
          category: 'plot_logic',
          content: 'Plot hole.',
          status: 'open',
          author: 'human',
          createdAt: '2026-08-06T00:00:00.000Z',
          resolvedAt: null,
          supersedesId: null,
          applications: [],
        },
      ],
      generatedAt: '2026-08-06T00:00:00.000Z',
    };
    const gates: BrowserReviewGateListV1 = {
      version: 1,
      projectId: 'project-a',
      gates: [],
      generatedAt: '2026-08-06T00:00:00.000Z',
    };
    render(() => (
      <App
        hostStatus="ready"
        initialView="review-hub"
        features={['project-home', 'review-hub']}
        reviewState={reviewState}
        reviewGates={gates}
        reviewHistory={{ version: 1, projectId: 'project-a', entries: [], generatedAt: 'now' }}
      />
    ));

    expect(screen.getByRole('heading', { level: 1, name: 'Review Hub' })).toBeInTheDocument();
    expect(screen.getByTestId('review-count')).toHaveTextContent('1');
    expect(screen.getByText('Plot hole.')).toBeInTheDocument();

    cleanup();
    render(() => (
      <App
        hostStatus="ready"
        initialView="review-hub"
        features={['project-home']}
        reviewState={reviewState}
      />
    ));
    expect(screen.getByRole('heading', { level: 1, name: 'Project Home' })).toBeInTheDocument();
    expect(screen.queryByTestId('review-count')).not.toBeInTheDocument();
  });

  it('renders the Publication view only when the publication feature is present', async () => {
    const publications: BrowserPublicationListV1 = {
      version: 1,
      projectId: 'project-a',
      publications: [
        {
          version: 1,
          projectId: 'project-a',
          publicationId: 'canonical',
          kind: 'canonical',
          status: 'current',
          sourceHash: 'source-hash-abcdef',
          scopeHash: 'scope-hash-abcdef',
          revisionIds: ['rev-1'],
          novelHash: 'novel-hash-abcdef012345',
          relativeOutputPath: 'output/novel.md',
          byteLength: 1234,
          sceneCount: 8,
          wordCount: 1200,
          staleReasons: [],
          operationId: 'op-pub-1',
          createdAt: '2026-08-06T00:00:00.000Z',
          updatedAt: '2026-08-06T00:00:00.000Z',
        },
      ],
      generatedAt: '2026-08-06T00:00:00.000Z',
    };
    render(() => (
      <App
        hostStatus="ready"
        initialView="publication"
        features={['project-home', 'publication']}
        publications={publications}
      />
    ));

    expect(screen.getByRole('heading', { level: 1, name: 'Publication' })).toBeInTheDocument();
    expect(screen.getByTestId('publication-count')).toHaveTextContent('1');
    expect(screen.getByText('output/novel.md')).toBeInTheDocument();

    cleanup();
    render(() => (
      <App
        hostStatus="ready"
        initialView="publication"
        features={['project-home']}
        publications={publications}
      />
    ));
    expect(screen.getByRole('heading', { level: 1, name: 'Project Home' })).toBeInTheDocument();
    expect(screen.queryByTestId('publication-count')).not.toBeInTheDocument();
  });
});

describe('Workbench Host availability states', () => {
  it('shows an honest unavailable state by default and supports an empty Host response', () => {
    const unavailable = render(() => <App />);
    const unavailableWorkspace = screen.getByTestId('workspace-state');
    expect(
      within(unavailableWorkspace).getByText(/read API is not configured/i),
    ).toBeInTheDocument();
    expect(unavailableWorkspace.closest('main')?.querySelector('.host-status')).toHaveTextContent(
      'Host unavailable',
    );
    unavailable.unmount();

    render(() => <App hostStatus="empty" />);
    const emptyWorkspace = screen.getByTestId('workspace-state');
    expect(emptyWorkspace.closest('main')?.querySelector('.host-status')).toHaveTextContent(
      'No project open',
    );
    expect(within(emptyWorkspace).getByText(/returned no project projection/i)).toBeInTheDocument();
  });

  it('reacts when the authenticated Host projection status changes', () => {
    const [status, setStatus] = createSignal<HostStatus>('loading');
    render(() => <App hostStatus={status()} />);

    const workspace = screen.getByTestId('workspace-state');
    expect(workspace).toHaveAttribute('aria-busy', 'true');
    expect(workspace.closest('main')?.querySelector('.host-status')).toHaveTextContent('Loading');
    setStatus('ready');
    expect(workspace.closest('main')?.querySelector('.host-status')).toHaveTextContent(
      'Host connected',
    );
  });
});

describe('Workbench Host projections', () => {
  it('renders an accepted Project Home projection without inventing source state', () => {
    render(() => (
      <App
        hostStatus="ready"
        initialView="project-home"
        overview={{
          version: 1,
          projectId: 'project-a',
          metadata: {
            displayName: 'The Accepted Project',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-08-02T00:00:00.000Z',
          },
          projection: {
            version: 1,
            projectId: 'project-a',
            revision: 4,
            sourceHash: 'source-hash',
            documents: 7,
            events: 3,
            rendered: 1,
            pending: 1,
            blocked: 1,
            errorCount: 0,
            warningCount: 2,
            diagnostics: [],
            presence: [],
            generatedAt: '2026-08-02T00:00:00.000Z',
          },
          activity: { busy: false, hasHumanPresence: true },
          generatedAt: '2026-08-02T00:00:00.000Z',
        }}
      />
    ));

    expect(screen.getByRole('heading', { name: 'The Accepted Project' })).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
    expect(
      screen.getByText(/No Host operation is active\.\s*Human collaboration is present\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/example project|demo scene|sample graph/i)).not.toBeInTheDocument();
  });

  it('wires Host-provided Source Studio state into its named workspace', () => {
    render(() => (
      <App
        hostStatus="ready"
        initialView="source-studio"
        sourceStudio={{
          version: 1,
          projectId: 'project-a',
          accepted: null,
          working: {
            documents: [
              {
                projectId: 'project-a',
                documentId: 'definitions/characters/author.yaml',
                kind: 'raw-yaml',
                available: true,
              },
            ],
          },
          generatedAt: '2026-08-02T00:00:00.000Z',
        }}
      />
    ));

    expect(screen.getByRole('heading', { name: 'Authoring source' })).toBeInTheDocument();
    expect(screen.getByText(/online-only, not accepted source/i)).toBeInTheDocument();
    expect(screen.getByText('definitions/characters/author.yaml')).toBeInTheDocument();
  });

  it('wires Source Studio lifecycle and native revision actions through the shell', async () => {
    const onCreateDocument = vi.fn();
    const onMoveDocument = vi.fn();
    const onDeleteDocument = vi.fn();
    const onListAuthoringRevisions = vi.fn();
    const onGetAuthoringRevision = vi.fn();
    const onRestoreAuthoringRevision = vi.fn();
    const user = userEvent.setup();
    render(() => (
      <App
        hostStatus="ready"
        initialView="source-studio"
        sourceStudio={{
          version: 1,
          projectId: 'project-a',
          accepted: null,
          working: {
            documents: [
              {
                projectId: 'project-a',
                documentId: 'nova.yaml',
                kind: 'raw-yaml',
                available: true,
              },
            ],
          },
          generatedAt: '2026-08-02T00:00:00.000Z',
        }}
        authoringState={{
          version: 2,
          projectId: 'project-a',
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
          generatedAt: '2026-08-02T00:00:00.000Z',
        }}
        authoringRevisionHistory={{
          version: 2,
          projectId: 'project-a',
          revisions: [
            {
              version: 2,
              revisionId: 'head-1',
              sourceHash: 'source-1',
              createdAt: '2026-08-02T00:00:00.000Z',
              acceptedAt: '2026-08-02T00:00:00.000Z',
            },
          ],
          generatedAt: '2026-08-02T00:00:00.000Z',
        }}
        onListAuthoringRevisions={onListAuthoringRevisions}
        onGetAuthoringRevision={onGetAuthoringRevision}
        onRestoreAuthoringRevision={onRestoreAuthoringRevision}
        onCreateDocument={onCreateDocument}
        onMoveDocument={onMoveDocument}
        onDeleteDocument={onDeleteDocument}
      />
    ));

    // Native revision history actions are offered through the shell.
    expect(screen.getByRole('button', { name: 'Refresh revision history' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View revision' }));
    expect(onGetAuthoringRevision).toHaveBeenCalledWith('head-1');
    await user.click(screen.getByRole('button', { name: 'Restore revision' }));
    expect(onRestoreAuthoringRevision).toHaveBeenCalledWith({
      version: 2,
      projectId: 'project-a',
      revisionId: 'head-1',
      expectedAcceptedRevisionId: null,
      expectedSourceHash: 'accepted-hash',
    });
    await user.click(screen.getByRole('button', { name: 'Refresh revision history' }));
    expect(onListAuthoringRevisions).toHaveBeenCalledOnce();

    // Working-document lifecycle actions are offered through the shell.
    await user.click(screen.getByRole('button', { name: 'New working document' }));
    await user.type(screen.getByLabelText('Manifest-relative logical path'), 'scenes/E1.md');
    await user.click(screen.getByRole('button', { name: 'Create working document' }));
    expect(onCreateDocument).toHaveBeenCalledWith({
      version: 2,
      projectId: 'project-a',
      logicalPath: 'scenes/E1.md',
      kind: 'raw-yaml',
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
    });

    const item = screen.getByText('nova.yaml').closest('li');
    expect(item).not.toBeNull();
    const row = within(item as HTMLElement);
    await user.click(row.getByRole('button', { name: 'Rename/Move' }));
    const pathInput = row.getByLabelText('New manifest-relative logical path');
    await user.clear(pathInput);
    await user.type(pathInput, 'scenes/E2.md');
    await user.click(row.getByRole('button', { name: 'Move document' }));
    expect(onMoveDocument).toHaveBeenCalledWith({
      version: 2,
      projectId: 'project-a',
      documentId: 'nova.yaml',
      logicalPath: 'scenes/E2.md',
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
    });

    await user.click(row.getByRole('button', { name: 'Delete' }));
    await user.click(row.getByRole('button', { name: 'Confirm delete' }));
    expect(onDeleteDocument).toHaveBeenCalledWith({
      version: 2,
      projectId: 'project-a',
      documentId: 'nova.yaml',
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
    });
  });

  it('forwards only the authoring CAS request and presents streamed operations', async () => {
    const submit = vi.fn();
    const user = userEvent.setup();
    render(() => (
      <App
        hostStatus="ready"
        initialView="source-studio"
        initialOperationCenterExpanded
        sourceStudio={{
          version: 1,
          projectId: 'project-a',
          accepted: null,
          working: {
            documents: [
              {
                projectId: 'project-a',
                documentId: 'nova.yaml',
                kind: 'raw-yaml',
                available: true,
              },
            ],
          },
          generatedAt: '2026-08-02T00:00:00.000Z',
        }}
        authoringState={{
          version: 2,
          projectId: 'project-a',
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
          generatedAt: '2026-08-02T00:00:00.000Z',
        }}
        authoringOperations={[
          {
            version: 2,
            operationId: 'operation-1',
            projectId: 'project-a',
            kind: 'submit',
            status: 'queued',
            acceptedSourceHash: 'accepted-hash',
            acceptedRevisionId: null,
            pendingOperationId: null,
            revisionId: null,
            receiptHash: null,
            errorCode: null,
            createdAt: '2026-08-02T00:00:00.000Z',
            updatedAt: '2026-08-02T00:00:00.000Z',
          },
        ]}
        onSubmitAuthoring={submit}
      />
    ));

    await user.click(screen.getByRole('button', { name: 'Submit working layer' }));
    expect(submit).toHaveBeenCalledWith({
      version: 2,
      projectId: 'project-a',
      expectedAcceptedRevisionId: null,
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
    });
    expect(screen.getAllByText('operation-1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('queued').length).toBeGreaterThan(0);
  });

  it('presents durable operation progress and cancels active operations', async () => {
    const cancel = vi.fn();
    const user = userEvent.setup();
    render(() => (
      <App
        initialOperationCenterExpanded
        authoringOperations={[
          {
            version: 2,
            operationId: 'render-1',
            projectId: 'project-a',
            kind: 'render',
            status: 'running',
            acceptedSourceHash: 'accepted-hash',
            acceptedRevisionId: null,
            pendingOperationId: 'render-1',
            revisionId: null,
            receiptHash: null,
            errorCode: null,
            progress: { completed: 2, total: 5 },
            resultRef: null,
            createdAt: '2026-08-02T00:00:00.000Z',
            updatedAt: '2026-08-02T00:00:00.000Z',
          },
        ]}
        onCancelOperation={cancel}
      />
    ));

    expect(screen.getByText('render')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('2/5')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledWith('render-1');
  });
});
