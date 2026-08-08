import { cleanup, render, screen, waitFor } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../../src/client/SettingsView';
import type { ProviderPreset } from '../../src/client/provider-presets';

const presets: ProviderPreset[] = [
  { id: 'deepseek', label: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', modelHint: 'deepseek-chat' },
  { id: 'openai', label: 'openai', baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-4o' },
];

const advancedResponse = {
  version: 1,
  providers: [
    {
      profileId: 'default',
      kind: 'pi',
      configured: true,
      endpoint: 'https://api.****/v1',
      model: 'de****t',
      lastValidation: 'valid',
      lastValidatedAt: null,
    },
  ],
  projects: [],
  operationLimits: {
    maxQueuedPerProject: 8,
    maxConcurrentRendersPerProject: 1,
    maxConcurrentRendersPerHost: 2,
  },
  agent: { enabled: false, maxTurns: 8, maxToolCalls: 24 },
  generatedAt: '2026-08-03T00:00:00.000Z',
};

const upsertProviderProfile = vi.fn(async () => ({
  version: 1,
  profile: advancedResponse.providers[0],
  receipt: {
    status: 'applied',
    activeRevision: 'a',
    candidateRevision: 'b',
    changedFields: [],
    diagnostics: [],
  },
}));
const setProviderProfileCredential = vi.fn(async () => ({ version: 1, ok: true }));
const testProviderProfile = vi.fn(async () => ({
  version: 1,
  ok: true,
  diagnostics: [],
}));
const getAdvancedConfig = vi.fn(async () => advancedResponse);

vi.mock('../../src/client/provider-presets', () => ({
  providerPresets: vi.fn(async () => presets),
}));

vi.mock('../../src/client/admin/admin-client', () => ({
  createAdminClient: () => ({
    getAdvancedConfig,
    upsertProviderProfile,
    setProviderProfileCredential,
    testProviderProfile,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SettingsView LLM panel', () => {
  it('renders the preset grid and custom form for the owner', async () => {
    render(() => <SettingsView sessionRole="maintainer" sessionId="session-1" />);
    expect(await screen.findByText('deepseek')).toBeTruthy();
    expect(screen.getByText('openai')).toBeTruthy();
    expect(screen.getByTestId('base-url-input')).toBeTruthy();
    expect(screen.getByTestId('model-input')).toBeTruthy();
    expect(screen.getByTestId('api-key-input')).toBeTruthy();
    expect(screen.getByTestId('test-credential')).toBeTruthy();
  });

  it('pre-fills the form when a preset is clicked without submitting', async () => {
    const user = userEvent.setup();
    render(() => <SettingsView sessionRole="maintainer" sessionId="session-1" />);
    const preset = await screen.findByText('deepseek');
    await user.click(preset);
    const baseUrlInput = screen.getByTestId('base-url-input') as HTMLInputElement;
    const modelInput = screen.getByTestId('model-input') as HTMLInputElement;
    expect(baseUrlInput.value).toBe('https://api.deepseek.com/v1');
    expect(modelInput.value).toBe('deepseek-chat');
    expect(upsertProviderProfile).not.toHaveBeenCalled();
  });

  it('toggles the advanced section', async () => {
    const user = userEvent.setup();
    render(() => <SettingsView sessionRole="maintainer" sessionId="session-1" />);
    await screen.findByText('deepseek');
    const details = screen.getByTestId('advanced-section') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await user.click(screen.getByText('高级参数（可选）'));
    expect(details.open).toBe(true);
    expect(screen.getByTestId('reasoning-input')).toBeTruthy();
    expect(screen.getByTestId('context-window-input')).toBeTruthy();
    expect(screen.getByTestId('max-tokens-input')).toBeTruthy();
  });

  it('calls upsertProviderProfile with the pre-filled values on save', async () => {
    const user = userEvent.setup();
    render(() => <SettingsView sessionRole="maintainer" sessionId="session-1" />);
    const preset = await screen.findByText('deepseek');
    await user.click(preset);
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(upsertProviderProfile).toHaveBeenCalledTimes(1);
    });
    expect(upsertProviderProfile).toHaveBeenCalledWith('default', {
      kind: 'pi',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    });
  });

  it('shows a read-only status without the form when the owner read is denied', async () => {
    getAdvancedConfig.mockRejectedValueOnce(new Error('FORBIDDEN'));
    render(() => <SettingsView sessionRole="reader" sessionId="session-1" />);
    expect(await screen.findByText(/仅所有者可修改/)).toBeTruthy();
    expect(screen.queryByTestId('base-url-input')).toBeNull();
    expect(screen.queryByTestId('preset-grid')).toBeNull();
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });
});
