import { cleanup, render, screen, within } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewHub } from '../../src/client/ReviewHub.js';
import type {
  BrowserReviewGateListV1,
  BrowserReviewHistoryV1,
  BrowserReviewListV1,
} from '../../src/contracts/browser-api.js';

afterEach(() => cleanup());

const review: BrowserReviewListV1 = {
  version: 1,
  projectId: 'proj-a',
  comments: [
    {
      version: 1,
      commentId: 'review-1',
      eventId: 'E1',
      targetType: 'scene',
      severity: 'suggestion',
      category: 'style',
      content: 'The prose is rushed.',
      status: 'open',
      author: 'human',
      createdAt: '2026-08-06T00:00:00.000Z',
      resolvedAt: null,
      supersedesId: null,
      applications: [
        {
          eventId: 'E1',
          revisionId: 'rev-2',
          operationId: 'op-2',
          appliedAt: '2026-08-06T01:00:00.000Z',
        },
      ],
    },
    {
      version: 1,
      commentId: 'review-2',
      eventId: 'E2',
      targetType: 'scene',
      severity: 'blocking',
      category: 'plot_logic',
      content: 'Plot hole.',
      status: 'addressed',
      author: 'human',
      createdAt: '2026-08-06T02:00:00.000Z',
      resolvedAt: null,
      supersedesId: null,
      applications: [],
    },
  ],
  generatedAt: '2026-08-06T03:00:00.000Z',
};

const gates: BrowserReviewGateListV1 = {
  version: 1,
  projectId: 'proj-a',
  gates: [
    {
      version: 1,
      gateId: 'gate-1',
      eventId: 'E1',
      sourceHash: 'source-hash',
      proseHash: 'prose-hash',
      scopeHash: 'scope-hash',
      validationIdentity: 'validation-id',
      warningFingerprints: ['w1', 'w2'],
      revisionId: 'rev-1',
      status: 'open',
      decision: null,
      openedAt: '2026-08-06T02:30:00.000Z',
      supersededAt: null,
    },
  ],
  generatedAt: '2026-08-06T03:00:00.000Z',
};

const history: BrowserReviewHistoryV1 = {
  version: 1,
  projectId: 'proj-a',
  entries: [
    {
      version: 1,
      sequence: 1,
      kind: 'comment_added',
      commentId: 'review-1',
      gateId: null,
      revisionId: null,
      at: '2026-08-06T00:00:00.000Z',
      summary: 'Comment review-1 added.',
    },
    {
      version: 1,
      sequence: 2,
      kind: 'comment_applied',
      commentId: 'review-1',
      gateId: null,
      revisionId: 'rev-2',
      at: '2026-08-06T01:00:00.000Z',
      summary: 'Comment review-1 addressed by rev-2.',
    },
  ],
  generatedAt: '2026-08-06T03:00:00.000Z',
};

describe('Review Hub projections', () => {
  it('renders comments with status, severity and revision linkage', () => {
    render(() => <ReviewHub projectId="proj-a" review={review} gates={gates} history={history} />);

    expect(screen.getByRole('heading', { name: /Comments/ })).toBeInTheDocument();
    expect(screen.getByTestId('review-count')).toHaveTextContent('2');
    expect(screen.getByText('The prose is rushed.')).toBeInTheDocument();
    expect(screen.getByText('Plot hole.')).toBeInTheDocument();
    expect(screen.getAllByText('open').length).toBeGreaterThan(0);
    expect(screen.getByText('addressed')).toBeInTheDocument();
    expect(screen.getByText('Addressed by revisions')).toBeInTheDocument();
    expect(screen.getAllByText(/rev-2/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('gate-count')).toHaveTextContent('1');
    expect(screen.getByText('gate-1')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('comment_applied')).toBeInTheDocument();
  });

  it('shows an honest empty state when no review projection is loaded', () => {
    render(() => <ReviewHub projectId="proj-a" review={null} gates={null} history={null} />);

    expect(screen.getByText('No review projection')).toBeInTheDocument();
    expect(screen.getByText(/Open an authenticated project in the Host/)).toBeInTheDocument();
    expect(screen.getByText('No release-gate projection is loaded.')).toBeInTheDocument();
    expect(screen.queryByTestId('review-add-open')).not.toBeInTheDocument();
  });

  it('renders no mock data and no mutation affordances without wired callbacks', () => {
    render(() => <ReviewHub projectId="proj-a" review={review} gates={gates} history={history} />);

    expect(screen.queryByTestId('review-add-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('resolve-review-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gate-decide-gate-1')).not.toBeInTheDocument();
    expect(screen.queryByText(/example comment|demo review/i)).not.toBeInTheDocument();
  });
});

describe('Review Hub mutation affordances', () => {
  it('offers comment actions and gate decisions when callbacks are wired', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const onUpdate = vi.fn();
    const onDecide = vi.fn();
    render(() => (
      <ReviewHub
        projectId="proj-a"
        review={review}
        gates={gates}
        history={history}
        onAddComment={onAdd}
        onUpdateComment={onUpdate}
        onDecideGate={onDecide}
      />
    ));

    await user.click(screen.getByTestId('review-add-open'));
    await user.type(screen.getByTestId('review-add-event'), 'E3');
    await user.type(screen.getByTestId('review-add-text'), 'Tighten the pacing.');
    await user.click(screen.getByTestId('review-add-save'));
    expect(onAdd).toHaveBeenCalledWith({
      version: 1,
      projectId: 'proj-a',
      eventId: 'E3',
      severity: 'suggestion',
      category: 'reader_experience',
      content: 'Tighten the pacing.',
    });

    await user.click(screen.getByTestId('resolve-review-1'));
    expect(onUpdate).toHaveBeenCalledWith({
      version: 1,
      projectId: 'proj-a',
      commentId: 'review-1',
      action: 'resolve',
    });

    await user.type(screen.getByPlaceholderText('Reason (required)'), 'Warnings acceptable.');
    await user.click(screen.getByTestId('gate-decide-gate-1'));
    expect(onDecide).toHaveBeenCalledWith({
      version: 1,
      projectId: 'proj-a',
      gateId: 'gate-1',
      decision: 'accept',
      reason: 'Warnings acceptable.',
    });
  });

  it('replaces comment text through the replace affordance', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(() => (
      <ReviewHub
        projectId="proj-a"
        review={review}
        gates={gates}
        history={history}
        onUpdateComment={onUpdate}
      />
    ));

    await user.click(screen.getByTestId('replace-open-review-1'));
    await user.type(screen.getByTestId('replace-text-review-1'), 'New wording.');
    await user.click(screen.getByTestId('replace-save-review-1'));
    expect(onUpdate).toHaveBeenCalledWith({
      version: 1,
      projectId: 'proj-a',
      commentId: 'review-1',
      action: 'replace',
      content: 'New wording.',
    });
  });

  it('hides comment mutations for a reader session even with wired callbacks', () => {
    render(() => (
      <ReviewHub
        projectId="proj-a"
        review={review}
        gates={gates}
        history={history}
        sessionRole="reader"
        onAddComment={vi.fn()}
        onUpdateComment={vi.fn()}
        onDecideGate={vi.fn()}
      />
    ));

    expect(screen.queryByTestId('review-add-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('resolve-review-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gate-decide-gate-1')).not.toBeInTheDocument();
  });

  it('allows comment mutations but hides gate decisions for an author session', () => {
    render(() => (
      <ReviewHub
        projectId="proj-a"
        review={review}
        gates={gates}
        history={history}
        sessionRole="author"
        onAddComment={vi.fn()}
        onUpdateComment={vi.fn()}
        onDecideGate={vi.fn()}
      />
    ));

    expect(screen.getByTestId('review-add-open')).toBeInTheDocument();
    expect(screen.getByTestId('resolve-review-1')).toBeInTheDocument();
    expect(screen.queryByTestId('gate-decide-gate-1')).not.toBeInTheDocument();
  });

  it('allows gate decisions for a maintainer session', () => {
    render(() => (
      <ReviewHub
        projectId="proj-a"
        review={review}
        gates={gates}
        history={history}
        sessionRole="maintainer"
        onDecideGate={vi.fn()}
      />
    ));

    expect(screen.getByTestId('gate-decide-gate-1')).toBeInTheDocument();
  });

  it('surfaces a typed mutation failure honestly', async () => {
    const user = userEvent.setup();
    render(() => (
      <ReviewHub
        projectId="proj-a"
        review={review}
        gates={gates}
        history={history}
        onUpdateComment={() => {
          throw new Error('GATE_NOT_OPEN: already decided');
        }}
      />
    ));

    await user.click(screen.getByTestId('resolve-review-1'));
    expect(await screen.findByRole('alert')).toHaveTextContent('GATE_NOT_OPEN: already decided');
  });
});
