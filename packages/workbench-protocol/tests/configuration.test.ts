import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_AGENT_CONFIGURATION_V3,
  DEFAULT_WORKBENCH_OPERATION_LIMITS_V3,
  DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
  normalizeWorkbenchConfiguration,
  type WorkbenchConfigurationV1,
  type WorkbenchConfigurationV2,
  type WorkbenchConfigurationV3,
} from '../src/configuration.js';

const NETWORK_V1 = {
  mode: 'loopback' as const,
  port: 8787,
  allowedHosts: [],
  allowedOrigins: [],
  unixSocket: null,
};

function v1Configuration(
  overrides: Partial<WorkbenchConfigurationV1> = {},
): WorkbenchConfigurationV1 {
  return {
    version: 1,
    projects: [{ projectId: 'demo', displayName: 'Demo', root: '/srv/demo' }],
    defaultProjectId: 'demo',
    provider: null,
    network: NETWORK_V1,
    ...overrides,
  };
}

function v2Configuration(
  overrides: Partial<WorkbenchConfigurationV2> = {},
): WorkbenchConfigurationV2 {
  return {
    version: 2,
    projects: [
      {
        projectId: 'demo',
        displayName: 'Demo',
        root: '/srv/demo',
        revisionMirror: { mode: 'git-best-effort', ref: 'refs/heads/workbench' },
      },
    ],
    defaultProjectId: 'demo',
    provider: null,
    network: NETWORK_V1,
    referenceLimits: DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
    ...overrides,
  };
}

describe('normalizeWorkbenchConfiguration', () => {
  it('always yields a canonical V3 object with version 3', () => {
    const fromV1 = normalizeWorkbenchConfiguration(v1Configuration());
    const fromV2 = normalizeWorkbenchConfiguration(v2Configuration());
    expect(fromV1.version).toBe(3);
    expect(fromV2.version).toBe(3);
    expect(fromV1.operationLimits.maxConcurrentRendersPerProject).toBe(1);
    expect(fromV2.agent.enabled).toBe(false);
  });

  it('migrates a V1 configuration: default profile binding, empty providers, V3 defaults', () => {
    const normalized = normalizeWorkbenchConfiguration(v1Configuration());
    expect(normalized).toEqual({
      version: 3,
      projects: [
        {
          projectId: 'demo',
          displayName: 'Demo',
          root: '/srv/demo',
          revisionMirror: { mode: 'disabled' },
          providerProfile: 'default',
          trustedPlugins: [],
        },
      ],
      defaultProjectId: 'demo',
      providers: {},
      network: NETWORK_V1,
      referenceLimits: DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
      operationLimits: DEFAULT_WORKBENCH_OPERATION_LIMITS_V3,
      agent: DEFAULT_WORKBENCH_AGENT_CONFIGURATION_V3,
    });
  });

  it('migrates the single V1 provider to providers.default', () => {
    const normalized = normalizeWorkbenchConfiguration(
      v1Configuration({
        provider: { kind: 'ai-sdk', baseUrl: 'https://api.example.com', model: 'fast' },
      }),
    );
    expect(normalized.providers).toEqual({
      default: { kind: 'ai-sdk', baseUrl: 'https://api.example.com', model: 'fast' },
    });
    expect('provider' in normalized).toBe(false);
  });

  it('migrates a V2 configuration: preserves mirror and reference limits, adds V3 sections', () => {
    const normalized = normalizeWorkbenchConfiguration(v2Configuration());
    expect(normalized.projects[0]?.revisionMirror).toEqual({
      mode: 'git-best-effort',
      ref: 'refs/heads/workbench',
    });
    expect(normalized.projects[0]?.providerProfile).toBe('default');
    expect(normalized.projects[0]?.trustedPlugins).toEqual([]);
    expect(normalized.referenceLimits).toEqual(DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2);
    expect(normalized.operationLimits).toEqual(DEFAULT_WORKBENCH_OPERATION_LIMITS_V3);
    expect(normalized.agent).toEqual(DEFAULT_WORKBENCH_AGENT_CONFIGURATION_V3);
  });

  it('passes a V3 configuration through with the same identity-bearing fields', () => {
    const v3: WorkbenchConfigurationV3 = {
      version: 3,
      projects: [
        {
          projectId: 'demo',
          displayName: 'Demo',
          root: '/srv/demo',
          revisionMirror: { mode: 'disabled' },
          providerProfile: 'prod-eu',
          trustedPlugins: [{ name: 'fx', version: '1.2.3', moduleHash: 'abc123', required: true }],
        },
      ],
      defaultProjectId: 'demo',
      providers: {
        'prod-eu': { kind: 'ai-sdk', baseUrl: 'https://api.example.com', model: 'fast' },
      },
      network: NETWORK_V1,
      referenceLimits: DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
      operationLimits: { ...DEFAULT_WORKBENCH_OPERATION_LIMITS_V3, maxQueuedPerProject: 8 },
      agent: { enabled: true, maxTurns: 4, maxToolCalls: 12 },
    };
    const normalized = normalizeWorkbenchConfiguration(v3);
    expect(normalized).toEqual(v3);
    expect(normalized.projects[0]?.trustedPlugins).toEqual(v3.projects[0]?.trustedPlugins);
    expect(normalized.providers['prod-eu']).toEqual(v3.providers['prod-eu']);
    expect(normalized.operationLimits.maxQueuedPerProject).toBe(8);
    expect(normalized.agent.enabled).toBe(true);
  });

  it('does not alias input arrays or objects into the result', () => {
    const source = v1Configuration({
      provider: { kind: 'ai-sdk', baseUrl: 'https://api.example.com', model: 'fast' },
    });
    const normalized = normalizeWorkbenchConfiguration(source);
    (normalized.network.allowedHosts as string[]).push('mutated');
    expect(source.network.allowedHosts).toEqual([]);
    expect(normalized.projects[0]?.trustedPlugins).toEqual([]);
    expect(normalized.providers.default).toEqual(source.provider);
    // The migrated project is a fresh object, not the V1 source project.
    expect(normalized.projects[0]).not.toBe(source.projects[0]);
  });
});
