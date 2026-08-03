import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ProjectAuthorityTokenError,
  ProjectAuthorityUnavailableError,
  ProjectWriteCoordinator,
  StandaloneMutationBlockedError,
} from '../src/index.js';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'node-host-authority-'));
}

describe('ProjectWriteCoordinator authority lease', () => {
  it('blocks a second authority and standalone writes while the lease is live', async () => {
    const projectRoot = root();
    const first = new ProjectWriteCoordinator(projectRoot, { projectId: 'fixture' });
    const second = new ProjectWriteCoordinator(projectRoot, { projectId: 'fixture' });
    const token = await first.acquireWorkbenchAuthority('host-a');

    await expect(second.acquireWorkbenchAuthority('host-b')).rejects.toBeInstanceOf(
      ProjectAuthorityUnavailableError,
    );
    await expect(second.withStandaloneMutation(() => 'not admitted')).rejects.toBeInstanceOf(
      StandaloneMutationBlockedError,
    );

    await second.release('host-a');
    await expect(first.withWorkbenchMutation(token, () => 'stale token')).rejects.toBeInstanceOf(
      ProjectAuthorityTokenError,
    );
    const replacement = await second.acquireWorkbenchAuthority('host-b');
    expect(replacement.instanceNonce).toBe('host-b');
    await second.releaseWorkbenchAuthority(replacement);
  });

  it('admits standalone writes after heartbeat expiry and rejects expired host tokens', async () => {
    const projectRoot = root();
    let now = new Date('2026-08-03T00:00:00.000Z');
    const coordinator = new ProjectWriteCoordinator(projectRoot, {
      projectId: 'fixture',
      heartbeatTtlMs: 100,
      now: () => now,
    });
    const token = await coordinator.acquireWorkbenchAuthority('host-a');

    now = new Date('2026-08-03T00:00:00.101Z');
    await expect(coordinator.withWorkbenchMutation(token, () => undefined)).rejects.toBeInstanceOf(
      ProjectAuthorityTokenError,
    );
    await expect(coordinator.withStandaloneMutation(() => 'standalone')).resolves.toBe('standalone');
  });

  it('reclaims an expired lease only after an explicit failed health probe', async () => {
    const projectRoot = root();
    let now = new Date('2026-08-03T00:00:00.000Z');
    const first = new ProjectWriteCoordinator(projectRoot, {
      projectId: 'fixture',
      heartbeatTtlMs: 100,
      now: () => now,
    });
    await first.acquireWorkbenchAuthority('host-a');
    now = new Date('2026-08-03T00:00:00.101Z');

    const second = new ProjectWriteCoordinator(projectRoot, {
      projectId: 'fixture',
      heartbeatTtlMs: 100,
      now: () => now,
      healthProbe: () => false,
    });
    const token = await second.acquireWorkbenchAuthority('host-b');
    expect(token.instanceNonce).toBe('host-b');
    await second.releaseWorkbenchAuthority(token);
  });
});
