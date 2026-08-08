import { cleanup, render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupApiError, type SetupClient } from '../../src/client/setup-client';
import {
  SetupWizard,
  validateNetworkFields,
  validateProjectFields,
} from '../../src/client/ui/SetupWizard';
import type { WorkbenchSetupStatusV1 } from '../../src/contracts/index';

const status: WorkbenchSetupStatusV1 = {
  version: 1,
  phase: 'project-pending',
  configurationPresent: false,
  configurationRevision: null,
  ownerCreated: true,
  projects: [],
  defaultProjectId: null,
  provider: null,
  network: {
    mode: 'loopback',
    port: 8787,
    allowedHosts: [],
    allowedOrigins: [],
    unixSocket: false,
    listenerActive: true,
    restartRequired: false,
  },
  generatedAt: '2026-08-03T00:00:00.000Z',
  hostHome: '/state/fabula/workbench',
};

function createClient(overrides: Partial<SetupClient> = {}): SetupClient {
  return {
    getStatus: vi.fn(async () => status),
    createOwner: vi.fn(async () => ({
      version: 1 as const,
      sessionId: 'session',
      userId: 'owner',
      displayName: 'Owner',
    })),
    validateProject: vi.fn(async () => ({
      version: 1 as const,
      validation: 'valid' as const,
      projectId: 'project-a',
    })),
    saveProject: vi.fn(async () => ({
      version: 1 as const,
      validation: 'valid' as const,
      projectId: 'project-a',
    })),
    validateProvider: vi.fn(async () => ({
      version: 1 as const,
      validation: 'valid' as const,
      kind: 'pi' as const,
    })),
    saveCredential: vi.fn(async () => ({
      version: 1 as const,
      providerId: 'ai-sdk',
      configured: true as const,
    })),
    applyNetwork: vi.fn(async () => ({
      version: 1 as const,
      mode: 'loopback' as const,
      port: 8787,
      restartRequired: true as const,
    })),
    finish: vi.fn(async () => ({
      version: 1 as const,
      receipt: {
        status: 'applied' as const,
        activeRevision: 'active',
        candidateRevision: 'candidate',
        changedFields: [],
        diagnostics: [],
      },
    })),
    ...overrides,
  };
}

afterEach(cleanup);

describe('setup wizard state and validation', () => {
  it('keeps local errors on the project step and never collects a project root', async () => {
    expect(validateProjectFields('bad id', 'Project').projectId).toBeDefined();
    expect(validateNetworkFields('unix', '8787').unixSocketName).toBeDefined();

    const client = createClient({
      validateProject: vi.fn(async () => {
        throw new SetupApiError(
          400,
          'PROJECT_INVALID_ROOT',
          'project',
          'safe project validation error',
        );
      }),
    });
    const user = userEvent.setup();
    render(() => <SetupWizard client={client} initialStatus={status} />);

    await user.type(screen.getByLabelText('Project identifier'), 'project-a');
    await user.type(screen.getByLabelText('Display name'), 'A Project');
    // The wizard collects no project path: the Host derives the managed root.
    expect(screen.queryByLabelText('Project path on Host')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Workspace location')).toHaveAttribute('readonly');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByTestId('setup-server-error')).toHaveTextContent(
      'The Host could not validate this project.',
    );
  });

  it('clears the owner password after the one-way owner request', async () => {
    const onOwnerCreated = vi.fn();
    const client = createClient({
      getStatus: vi.fn(async () => ({
        ...status,
        ownerCreated: false,
        phase: 'unconfigured' as const,
      })),
    });
    const user = userEvent.setup();
    render(() => (
      <SetupWizard
        client={client}
        initialStatus={{ ...status, ownerCreated: false, phase: 'unconfigured' }}
        onOwnerCreated={onOwnerCreated}
      />
    ));

    await user.type(screen.getByLabelText(/^Password/), 'a-safe-password-123');
    await user.click(screen.getByRole('button', { name: 'Create owner' }));

    expect(onOwnerCreated).toHaveBeenCalledWith('session');
    expect(screen.queryByDisplayValue('a-safe-password-123')).not.toBeInTheDocument();
  });
});
