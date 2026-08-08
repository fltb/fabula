import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('shows the safe project id and display label when the Host returns an available catalog', () => {
    render(() => <ProjectPicker projects={[project()]} onSelect={() => undefined} />);
    expect(screen.getByRole('button', { name: /A safe project label/ })).toBeInTheDocument();
    expect(screen.getByText('project-a')).toBeInTheDocument();
    expect(screen.queryByText(/2026-08/)).not.toBeInTheDocument();
  });

  it('keeps the loading panel while the catalog is pending', () => {
    render(() => <ProjectPicker projects={[]} pending onSelect={() => undefined} />);
    expect(screen.getByRole('heading', { name: '正在检查 Host 状态' })).toBeInTheDocument();
    expect(screen.queryByText('还没有项目')).not.toBeInTheDocument();
  });

  it('renders an actionable guidance card with create/import actions when the catalog is empty', () => {
    const onCreateProject = vi.fn();
    const onImportProject = vi.fn();
    render(() => (
      <ProjectPicker
        projects={[]}
        onSelect={() => undefined}
        onCreateProject={onCreateProject}
        onImportProject={onImportProject}
      />
    ));
    expect(screen.getByRole('heading', { name: '还没有项目' })).toBeInTheDocument();
    const createButton = screen.getByRole('button', { name: '创建第一个项目' });
    const importButton = screen.getByRole('button', { name: '导入现有项目' });
    createButton.click();
    importButton.click();
    expect(onCreateProject).toHaveBeenCalledTimes(1);
    expect(onImportProject).toHaveBeenCalledTimes(1);
  });

  it('offers create/import actions above a non-empty catalog', () => {
    const onCreateProject = vi.fn();
    const onImportProject = vi.fn();
    render(() => (
      <ProjectPicker
        projects={[project()]}
        onSelect={() => undefined}
        onCreateProject={onCreateProject}
        onImportProject={onImportProject}
      />
    ));
    expect(screen.queryByText('还没有项目')).not.toBeInTheDocument();
    const createButton = screen.getByRole('button', { name: '新建项目' });
    const importButton = screen.getByRole('button', { name: '导入现有项目' });
    createButton.click();
    importButton.click();
    expect(onCreateProject).toHaveBeenCalledTimes(1);
    expect(onImportProject).toHaveBeenCalledTimes(1);
  });

  it('hides the toolbar while the catalog is pending or empty', () => {
    render(() => (
      <ProjectPicker
        projects={[project()]}
        pending
        onSelect={() => undefined}
        onCreateProject={() => undefined}
        onImportProject={() => undefined}
      />
    ));
    expect(screen.queryByRole('button', { name: '新建项目' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '导入现有项目' })).not.toBeInTheDocument();
  });

  it('hides the create/import affordances when no handlers are provided', () => {
    render(() => <ProjectPicker projects={[]} onSelect={() => undefined} />);
    expect(screen.getByRole('heading', { name: '还没有项目' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '创建第一个项目' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '导入现有项目' })).not.toBeInTheDocument();
  });
});
