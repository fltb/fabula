import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserProjectSummaryV1 } from '../../src/contracts/index';
import { ProjectPicker, RuntimeStatePanel } from '../../src/client/ui/RuntimeStates';

const project = (overrides: Partial<BrowserProjectSummaryV1> = {}): BrowserProjectSummaryV1 => ({
  version: 1,
  projectId: 'project-a',
  displayName: 'A safe project label',
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
  open: true,
  ...overrides,
});

afterEach(cleanup);

describe('runtime state views', () => {
  it('renders restart-required without exposing any host internals', () => {
    render(() => <RuntimeStatePanel state="configuration-restart-required" />);
    expect(screen.getByRole('heading', { name: 'Restart required' })).toBeInTheDocument();
    expect(screen.getByText(/listener must restart/i)).toBeInTheDocument();
    expect(screen.queryByText(/root|token|credential|source bytes/i)).not.toBeInTheDocument();
  });

  it('renders disconnected and unauthorized project picker states with recovery actions', () => {
    const disconnected = render(() => (
      <ProjectPicker projects={[]} health="disconnected" onSelect={() => undefined} onRetry={() => undefined} />
    ));
    expect(screen.getByRole('heading', { name: 'Host connection lost' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    disconnected.unmount();

    render(() => (
      <RuntimeStatePanel state="project-picker" health="unauthorized" actionLabel="Sign in" onAction={() => undefined} />
    ));
    expect(screen.getByRole('heading', { name: 'Sign-in required' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows only safe project labels when the Host returns an available catalog', () => {
    render(() => <ProjectPicker projects={[project()]} onSelect={() => undefined} />);
    expect(screen.getByRole('button', { name: /A safe project label/ })).toBeInTheDocument();
    expect(screen.queryByText(/2026-08/)).not.toBeInTheDocument();
    expect(screen.queryByText(/project-a/)).not.toBeInTheDocument();
  });
});
