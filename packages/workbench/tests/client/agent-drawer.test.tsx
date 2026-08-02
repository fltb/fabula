import { cleanup, render, screen, waitFor } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import type {
  AgentApplyResponseV1,
  AgentClient,
  AgentProposalResponseV1,
} from '../../src/client/agent-client';
import { AgentDrawer } from '../../src/client/ui/AgentDrawer';

const context = {
  version: 1 as const,
  projectId: 'project-a',
  documentId: 'doc-a',
  selection: { from: 0, to: 12 },
  baseVector: 'vector-a',
};

const proposal = {
  version: 1 as const,
  suggestionId: 'suggestion-a',
  projectId: 'project-a',
  documentId: 'doc-a',
  baseVector: 'vector-a',
  selection: context.selection,
  changes: [{ from: 0, length: 5, before: 'quiet', text: 'clear' }],
};

function clientFor(response: AgentProposalResponseV1): AgentClient & {
  propose: ReturnType<typeof vi.fn>;
  applyProposal: ReturnType<typeof vi.fn>;
} {
  return {
    propose: vi.fn(async () => response),
    applyProposal: vi.fn(async (): Promise<AgentApplyResponseV1> => ({
      status: 'applied',
      suggestionId: 'suggestion-a',
    })),
  };
}

afterEach(() => cleanup());

describe('AgentDrawer proposal workflow', () => {
  it('renders context and does not invoke apply until the human chooses Apply', async () => {
    const client = clientFor({ status: 'proposed', proposal });
    const user = userEvent.setup();
    render(() => <AgentDrawer open context={context} client={client} />);

    await user.type(screen.getByLabelText('What should change?'), 'Make the opening precise.');
    await user.click(screen.getByRole('button', { name: 'Ask for a proposal' }));
    await waitFor(() => expect(screen.getByText('Changes waiting for your review')).toBeInTheDocument());
    expect(client.applyProposal).not.toHaveBeenCalled();
    expect(screen.getByText('clear')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apply changes' }));
    await waitFor(() => expect(client.applyProposal).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Applied to the working layer')).toBeInTheDocument();
    expect(screen.getByText(/Accepted source is unchanged/)).toBeInTheDocument();
  });

  it('keeps paused state actionable and never presents Apply as success', async () => {
    const client = clientFor({ status: 'paused', reason: 'human-typing', replanRequired: true });
    const refresh = vi.fn();
    const user = userEvent.setup();
    render(() => <AgentDrawer open context={context} client={client} onRefreshContext={refresh} />);

    await user.type(screen.getByLabelText('What should change?'), 'Rewrite.');
    await user.click(screen.getByRole('button', { name: 'Ask for a proposal' }));
    await waitFor(() => expect(screen.getByText('Paused — action required')).toBeInTheDocument());
    expect(screen.getByText(/Someone is typing/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh context and replan' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('renders stale vector as a non-success state with a refresh action', async () => {
    const client = clientFor({
      status: 'stale',
      reason: 'stale-vector',
      replanRequired: true,
      currentVector: 'vector-b',
    });
    const user = userEvent.setup();
    render(() => <AgentDrawer open context={context} client={client} />);

    await user.type(screen.getByLabelText('What should change?'), 'Rewrite.');
    await user.click(screen.getByRole('button', { name: 'Ask for a proposal' }));
    await waitFor(() => expect(screen.getByText('Stale — refresh required')).toBeInTheDocument());
    expect(screen.getByText(/working document changed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument();
  });

  it('does not steal focus from the editor when opened', () => {
    const [open, setOpen] = createSignal(false);
    let editor!: HTMLTextAreaElement;
    render(() => (
      <>
        <textarea ref={(node) => (editor = node)} aria-label="Editor" />
        <AgentDrawer
          open={open()}
          context={context}
          client={clientFor({ status: 'streaming', requestId: null })}
        />
      </>
    ));
    editor.focus();
    setOpen(true);
    expect(document.activeElement).toBe(editor);
  });
});
