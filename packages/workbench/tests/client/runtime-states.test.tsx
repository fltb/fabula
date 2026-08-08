import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectPicker, RuntimeStatePanel } from '../../src/client/ui/RuntimeStates';
import type { BrowserProjectSummaryV1 } from '../../src/contracts/index';

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
    expect(screen.getByRole('heading', { name: '需要重启' })).toBeInTheDocument();
    expect(screen.getByText(/重启后才会生效/i)).toBeInTheDocument();
    expect(screen.queryByText(/root|token|credential|source bytes/i)).not.toBeInTheDocument();
  });

  it('renders disconnected and unauthorized project picker states with recovery actions', () => {
    const disconnected = render(() => (
      <ProjectPicker
        projects={[]}
        health="disconnected"
        onSelect={() => undefined}
        onRetry={() => undefined}
      />
    ));
    expect(screen.getByRole('heading', { name: 'Host 连接已断开' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    disconnected.unmount();

    render(() => (
      <RuntimeStatePanel
        state="project-picker"
        health="unauthorized"
        actionLabel="登录"
        onAction={() => undefined}
      />
    ));
    expect(screen.getByRole('heading', { name: '需要登录' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
  });

  it('shows only safe project labels when the Host returns an available catalog', () => {
    render(() => <ProjectPicker projects={[project()]} onSelect={() => undefined} />);
    expect(screen.getByRole('button', { name: /A safe project label/ })).toBeInTheDocument();
    expect(screen.queryByText(/2026-08/)).not.toBeInTheDocument();
    expect(screen.queryByText(/project-a/)).not.toBeInTheDocument();
  });
});
