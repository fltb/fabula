import { cleanup, render, screen, waitFor, within } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, type HostStatus } from '../../src/client/App';

const navigationLabels = [
  'Project Home',
  'Scene Canvas',
  'Source Studio',
  'Graph / Route',
  'Review Hub',
  'Publication',
] as const;

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

  it('pins the Inspector, expands operations, and opens the Agent Shelf', async () => {
    const user = userEvent.setup();
    render(() => (
      <App
        initialInspectorPinned={true}
        initialOperationCenterExpanded={false}
        initialAgentShelfOpen={false}
      />
    ));

    const inspectorPin = screen.getByRole('button', { name: 'Unpin Inspector' });
    expect(inspectorPin).toHaveAttribute('aria-pressed', 'true');
    await user.click(inspectorPin);
    expect(screen.getByRole('button', { name: 'Pin Inspector' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await user.click(screen.getByRole('button', { name: 'Expand' }));
    expect(screen.getByText('No operations running')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open Agent Shelf' }));
    expect(screen.getByRole('complementary', { name: 'Agent Shelf' })).toBeInTheDocument();
    expect(screen.getByText('No agent activity')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close Agent Shelf' }));
    expect(screen.queryByRole('complementary', { name: 'Agent Shelf' })).not.toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: 'Open Inspector' }));
    const inspectorDrawer = await screen.findByRole('dialog', { name: 'Inspector' });
    expect(within(inspectorDrawer).getByTestId('inspector')).toBeInTheDocument();
    await user.click(within(inspectorDrawer).getByRole('button', { name: 'Close Inspector' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Inspector' })).not.toBeInTheDocument(),
    );

    cleanup();
    setViewport(900);
    render(() => <App />);
    expect(screen.queryByRole('button', { name: 'Open navigation' })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Workbench views' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Inspector' })).toBeInTheDocument();

    cleanup();
    setViewport(1024);
    render(() => <App />);
    expect(screen.queryByRole('button', { name: 'Open navigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Inspector' })).not.toBeInTheDocument();
    expect(screen.getByTestId('inspector')).toBeInTheDocument();
  });
});

describe('Workbench named navigation', () => {
  it('renders every named view and changes the active workspace without project data', async () => {
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

describe('Workbench Host availability states', () => {
  it('shows an honest unavailable state by default and supports an empty Host response', () => {
    const unavailable = render(() => <App />);
    const unavailableWorkspace = screen.getByTestId('workspace-state');
    expect(within(unavailableWorkspace).getByText(/read API is not configured/i)).toBeInTheDocument();
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
});
