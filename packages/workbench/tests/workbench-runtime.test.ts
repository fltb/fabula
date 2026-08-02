import { describe, expect, it, vi } from 'vitest';
import type { ProjectSession } from '../src/host/project-session.js';
import { createProjectSessionRegistry } from '../src/host/project-session.js';
import { createWorkbenchRuntime } from '../src/host/workbench-runtime.js';

const project = {
  projectId: 'project-a',
  displayName: 'Project A',
  root: '/tmp/project-a',
} as const;

function session(projectId: string): ProjectSession {
  return { projectId, busy: false } as unknown as ProjectSession;
}

describe('WorkbenchRuntime', () => {
  it('serializes concurrent opens into one complete project bundle', async () => {
    let resolveCreation: ((value: ProjectSession) => void) | undefined;
    const createSession = vi.fn(
      () =>
        new Promise<ProjectSession>((resolve) => {
          resolveCreation = resolve;
        }),
    );
    const runtime = createWorkbenchRuntime({ createSession });

    const first = runtime.open(project);
    const second = runtime.open(project);
    expect(createSession).toHaveBeenCalledTimes(1);

    const created = session(project.projectId);
    resolveCreation?.(created);
    await expect(first).resolves.toBe(created);
    await expect(second).resolves.toBe(created);
    expect(runtime.listOpen()).toEqual([created]);
  });

  it('clears a rejected opening so a later explicit retry can create the bundle', async () => {
    const created = session(project.projectId);
    const createSession = vi
      .fn<() => Promise<ProjectSession>>()
      .mockRejectedValueOnce(new Error('source invalid'))
      .mockResolvedValueOnce(created);
    const runtime = createWorkbenchRuntime({ createSession });

    await expect(runtime.open(project)).rejects.toThrow('source invalid');
    await expect(runtime.open(project)).resolves.toBe(created);
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('disposes the full bundle before removing the shared session', async () => {
    const created = session(project.projectId);
    const closeSession = vi.fn(async () => undefined);
    const runtime = createWorkbenchRuntime({
      createSession: async () => created,
      closeSession,
    });

    await runtime.open(project);
    await expect(runtime.close(project.projectId)).resolves.toBe(true);
    expect(closeSession).toHaveBeenCalledWith(created);
    expect(runtime.isOpen(project.projectId)).toBe(false);
  });

  it('disposes a losing bundle when an external registry registration wins the race', async () => {
    const registry = createProjectSessionRegistry();
    let resolveCreation: ((value: ProjectSession) => void) | undefined;
    const losing = session(project.projectId);
    const winner = session(project.projectId);
    const closeSession = vi.fn(async () => undefined);
    const runtime = createWorkbenchRuntime({
      registry,
      createSession: () =>
        new Promise<ProjectSession>((resolve) => {
          resolveCreation = resolve;
        }),
      closeSession,
    });

    const opening = runtime.open(project);
    registry.register(winner);
    resolveCreation?.(losing);

    await expect(opening).rejects.toThrow();
    expect(closeSession).toHaveBeenCalledWith(losing);
    expect(runtime.get(project.projectId)).toBe(winner);
  });
});
