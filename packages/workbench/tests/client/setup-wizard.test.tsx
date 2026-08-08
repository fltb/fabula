import { cleanup, render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupApiError, type SetupClient } from '../../src/client/setup-client';
import { SetupWizard, validateNetworkFields } from '../../src/client/ui/SetupWizard';
import type { WorkbenchSetupStatusV1 } from '../../src/contracts/index';

vi.mock('../../src/client/provider-presets', () => ({
  providerPresets: vi.fn(async () => [
    {
      id: 'deepseek',
      label: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      modelHint: 'deepseek-chat',
    },
  ]),
}));

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
  it('skips the project step: an owner-created status lands directly on provider', async () => {
    expect(validateNetworkFields('unix', '8787').unixSocketName).toBeDefined();

    const client = createClient();
    render(() => <SetupWizard client={client} initialStatus={status} />);

    // The wizard has no project step: owner-created setups go straight to
    // the provider step, where the project is created later from the UI.
    expect(screen.queryByLabelText('Project identifier')).not.toBeInTheDocument();
    expect(await screen.findByText('Connect the provider')).toBeInTheDocument();
    const presetButton = await screen.findByRole('button', { name: 'deepseek' });
    await userEvent.setup().click(presetButton);
    expect(screen.getByLabelText('Provider endpoint')).toHaveValue('https://api.deepseek.com/v1');
    expect(screen.getByLabelText('Model')).toHaveValue('deepseek-chat');
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
    // Owner creation advances straight to the provider step (no project step).
    expect(await screen.findByText('Connect the provider')).toBeInTheDocument();
  });
});
