import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_AGENT_CONFIGURATION,
  DEFAULT_WORKBENCH_NETWORK,
  DEFAULT_WORKBENCH_OPERATION_LIMITS,
  DEFAULT_WORKBENCH_REFERENCE_LIMITS,
  DEFAULT_WORKBENCH_RENDER_POLICY,
  WORKBENCH_CONFIGURATION_VERSION,
  type WorkbenchConfigurationV1,
} from '../src/configuration.js';

/**
 * Canonical block-YAML emitter + parser for the exact subset the canonical
 * configuration serializes to. The protocol package is dependency-free, so
 * the round-trip helpers are local; key order follows the canonical JSON
 * order (property declaration order) and must be retained by owners.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function yamlScalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  throw new Error(`unsupported YAML scalar: ${typeof value}`);
}

function yamlStringify(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    const lines: string[] = [];
    for (const entry of value) {
      if (isRecord(entry)) {
        const entryLines = yamlStringify(entry, indent + 2).split('\n');
        lines.push(`${pad}- ${entryLines[0]?.trimStart() ?? ''}`);
        lines.push(...entryLines.slice(1));
      } else {
        lines.push(`${pad}- ${yamlScalar(entry)}`);
      }
    }
    return lines.join('\n');
  }
  if (isRecord(value)) {
    const lines: string[] = [];
    for (const [key, child] of Object.entries(value)) {
      if (Array.isArray(child) && child.length === 0) {
        lines.push(`${pad}${key}: []`);
      } else if (isRecord(child) && Object.keys(child).length === 0) {
        lines.push(`${pad}${key}: {}`);
      } else if (isRecord(child) || (Array.isArray(child) && child.length > 0)) {
        lines.push(`${pad}${key}:`);
        lines.push(...yamlStringify(child, indent + 2).split('\n'));
      } else {
        lines.push(`${pad}${key}: ${yamlScalar(child)}`);
      }
    }
    return lines.join('\n');
  }
  return `${pad}${yamlScalar(value)}`;
}

function yamlParse(text: string): unknown {
  const lines = text
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith('#'));
  const indents = lines.map((line) => line.length - line.trimStart().length);
  const texts = lines.map((line) => line.trim());
  let pos = 0;

  const parseScalar = (raw: string): unknown => {
    if (raw === 'null') return null;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === '[]') return [];
    if (raw === '{}') return {};
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (raw.startsWith('"')) return JSON.parse(raw) as unknown;
    return raw;
  };

  const parseMapping = (indent: number): Record<string, unknown> => {
    const map: Record<string, unknown> = {};
    while (pos < lines.length && indents[pos] === indent && !texts[pos].startsWith('- ')) {
      const text = texts[pos] as string;
      const colon = text.indexOf(':');
      const key = text.slice(0, colon);
      const rest = text.slice(colon + 1).trim();
      pos += 1;
      map[key] = rest.length > 0 ? parseScalar(rest) : parseBlock(indent + 2);
    }
    return map;
  };

  const parseSequence = (indent: number): unknown[] => {
    const items: unknown[] = [];
    while (pos < lines.length && indents[pos] === indent && texts[pos].startsWith('- ')) {
      const rest = (texts[pos] as string).slice(2);
      pos += 1;
      // Quoted scalars (emitter uses JSON.stringify) may contain ':' — parse
      // them as scalars, never as an inline mapping key.
      if (rest.startsWith('"')) {
        items.push(parseScalar(rest));
        continue;
      }
      const colon = rest.indexOf(':');
      if (colon === -1) {
        items.push(parseScalar(rest));
        continue;
      }
      const key = rest.slice(0, colon);
      const value = rest.slice(colon + 1).trim();
      const item: Record<string, unknown> = {};
      item[key] = value.length > 0 ? parseScalar(value) : parseBlock(indent + 2);
      Object.assign(item, parseMapping(indent + 2));
      items.push(item);
    }
    return items;
  };

  const parseBlock = (indent: number): unknown => {
    if (pos >= lines.length || indents[pos] !== indent) return {};
    return texts[pos]?.startsWith('- ') ? parseSequence(indent) : parseMapping(indent);
  };

  return parseBlock(0);
}

/** Plain deep projection (JSON-safe) of a canonical configuration. */
function plain(value: WorkbenchConfigurationV1): unknown {
  return JSON.parse(JSON.stringify(value));
}

const CANONICAL_KEYS = [
  'version',
  'projects',
  'defaultProjectId',
  'providers',
  'network',
  'referenceLimits',
  'operationLimits',
  'agent',
  'renderPolicy',
] as const;

/** Full canonical V1 shape: two projects, both provider kinds, non-default sections. */
function fullConfiguration(): WorkbenchConfigurationV1 {
  return {
    version: 1,
    projects: [
      {
        projectId: 'demo',
        displayName: 'Demo',
        root: '/srv/demo',
        revisionMirror: { mode: 'disabled' },
        providerProfile: 'default',
        trustedPlugins: [
          { name: 'arc', version: '1.2.3', moduleHash: 'abc123', required: true },
          { name: 'fx', version: '0.9.0', moduleHash: 'def456', required: false },
        ],
      },
      {
        projectId: 'editorial',
        displayName: 'Editorial',
        root: '/srv/editorial',
        revisionMirror: { mode: 'git-best-effort', ref: 'refs/heads/workbench' },
        providerProfile: 'prod-eu',
        trustedPlugins: [],
      },
    ],
    defaultProjectId: 'demo',
    providers: {
      default: { kind: 'pi', baseUrl: 'https://api.example.com', model: 'fast' },
      'prod-eu': { kind: 'ai-sdk', baseUrl: 'https://eu.example.com/v1', model: 'slow' },
    },
    network: {
      mode: 'lan',
      port: 8787,
      allowedHosts: ['127.0.0.1', '10.0.0.0/8'],
      allowedOrigins: ['https://editor.example.com'],
      unixSocket: null,
    },
    referenceLimits: { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS, maxItemsPerProject: 500 },
    operationLimits: { ...DEFAULT_WORKBENCH_OPERATION_LIMITS, maxQueuedPerProject: 8 },
    agent: { enabled: true, maxTurns: 4, maxToolCalls: 12 },
    renderPolicy: {
      pass1: { temperature: 0.7, maxTokens: 8_000 },
      pass2: { temperature: 0.2, maxTokens: 16_000, seed: 7 },
    },
  };
}

/** EMPTY_DRAFT-like shape: no projects, no providers, every section on defaults. */
function emptyConfiguration(): WorkbenchConfigurationV1 {
  return {
    version: 1,
    projects: [],
    defaultProjectId: null,
    providers: {},
    network: { ...DEFAULT_WORKBENCH_NETWORK },
    referenceLimits: { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS },
    operationLimits: { ...DEFAULT_WORKBENCH_OPERATION_LIMITS },
    agent: { ...DEFAULT_WORKBENCH_AGENT_CONFIGURATION },
    renderPolicy: { ...DEFAULT_WORKBENCH_RENDER_POLICY },
  };
}

describe('canonical V1 configuration round-trip', () => {
  it('serializes the canonical shape and re-parses to identical bytes', () => {
    const configuration = fullConfiguration();
    const yamlA = yamlStringify(configuration);

    // The document opens in canonical key order (property declaration order).
    expect(yamlA.startsWith('version: 1\nprojects:')).toBe(true);

    const parsed = yamlParse(yamlA);
    expect(parsed).toEqual(plain(configuration));
    expect(Object.keys(parsed as Record<string, unknown>)).toEqual([...CANONICAL_KEYS]);

    // serialize → parse → serialize is byte-identical (canonical round-trip).
    expect(yamlStringify(parsed)).toBe(yamlA);
  });

  it('round-trips an empty-shape configuration (no projects or providers)', () => {
    const configuration = emptyConfiguration();
    const yamlA = yamlStringify(configuration);
    const parsed = yamlParse(yamlA);

    expect(parsed).toEqual(plain(configuration));
    expect((parsed as Record<string, unknown>).projects).toEqual([]);
    expect((parsed as Record<string, unknown>).providers).toEqual({});
    expect(yamlStringify(parsed)).toBe(yamlA);
  });

  it('preserves both provider kinds ("ai-sdk" and "pi") through the round-trip', () => {
    const configuration = fullConfiguration();
    const parsed = yamlParse(yamlStringify(configuration)) as WorkbenchConfigurationV1;
    expect(parsed.providers.default.kind).toBe('pi');
    expect(parsed.providers['prod-eu']?.kind).toBe('ai-sdk');

    // A configuration using only the legacy-compatible 'ai-sdk' kind also
    // round-trips byte-identically.
    const legacyKinds = fullConfiguration();
    legacyKinds.providers.default.kind = 'ai-sdk';
    const yamlA = yamlStringify(legacyKinds);
    expect(yamlParse(yamlA)).toEqual(plain(legacyKinds));
    expect(yamlStringify(yamlParse(yamlA))).toBe(yamlA);
  });
});

describe('canonical defaults', () => {
  it('fills every section from the DEFAULT_WORKBENCH_* constants in the empty shape', () => {
    const parsed = yamlParse(yamlStringify(emptyConfiguration())) as WorkbenchConfigurationV1;
    expect(parsed.version).toBe(1);
    expect(parsed.projects).toEqual([]);
    expect(parsed.defaultProjectId).toBeNull();
    expect(parsed.providers).toEqual({});
    expect(parsed.network).toEqual(DEFAULT_WORKBENCH_NETWORK);
    expect(parsed.referenceLimits).toEqual(DEFAULT_WORKBENCH_REFERENCE_LIMITS);
    expect(parsed.operationLimits.maxConcurrentRendersPerProject).toBe(1);
    expect(parsed.agent.enabled).toBe(false);
    expect(parsed.renderPolicy).toEqual(DEFAULT_WORKBENCH_RENDER_POLICY);
  });

  it('pins WORKBENCH_CONFIGURATION_VERSION to 1', () => {
    expect(WORKBENCH_CONFIGURATION_VERSION).toBe(1);
  });

  it('pins DEFAULT_WORKBENCH_RENDER_POLICY to the agreed sampling values', () => {
    expect(DEFAULT_WORKBENCH_RENDER_POLICY.pass1.temperature).toBe(0.8);
    expect(DEFAULT_WORKBENCH_RENDER_POLICY.pass1.maxTokens).toBe(10_000);
    expect(DEFAULT_WORKBENCH_RENDER_POLICY.pass2.temperature).toBe(0.3);
    expect(DEFAULT_WORKBENCH_RENDER_POLICY.pass2.maxTokens).toBe(12_000);
    expect(DEFAULT_WORKBENCH_RENDER_POLICY.pass2.seed).toBe(42);
  });
});
