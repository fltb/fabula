import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentRegistry } from '../src/agent/registry.ts';
import type { Agent, AgentConfig, AgentPacket, AgentRole } from '../src/agent/types.ts';

// ============================================================================
// Helpers — reusable mock agents
// ============================================================================

function createMockAgent(
  name: string,
  role: AgentRole,
  configOverride?: Partial<AgentConfig>,
): Agent<string, string> {
  const baseConfig: AgentConfig = {
    model: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 2000,
    ...configOverride,
  };
  return {
    name,
    role,
    compilePacket(input: string): AgentPacket {
      return {
        systemPrompt: `You are ${name}.`,
        userPrompt: input,
      };
    },
    getOutputSchema(): z.ZodType<string> {
      return z.string();
    },
    getConfig(): AgentConfig {
      return { ...baseConfig };
    },
  };
}

// ============================================================================
// AgentRegistry
// ============================================================================

describe('AgentRegistry', () => {
  describe('register / get', () => {
    it('returns the agent registered for a role', () => {
      const reg = new AgentRegistry();
      const agent = createMockAgent('Pass1Agent', 'pass1');
      reg.register(agent);
      expect(reg.get('pass1')).toBe(agent);
    });

    it('returns undefined for an unregistered role', () => {
      const reg = new AgentRegistry();
      expect(reg.get('pass2')).toBeUndefined();
    });

    it('replaces a previously registered agent for the same role', () => {
      const reg = new AgentRegistry();
      const a1 = createMockAgent('OldAgent', 'pass1');
      const a2 = createMockAgent('NewAgent', 'pass1');
      reg.register(a1);
      reg.register(a2);
      expect(reg.get('pass1')).toBe(a2);
    });

    it('supports all four roles simultaneously', () => {
      const reg = new AgentRegistry();
      const roles: AgentRole[] = ['pass1', 'pass2', 'summary', 'review'];
      const agents = roles.map((r) => createMockAgent(`${r}Agent`, r));
      for (const agent of agents) reg.register(agent);
      for (const r of roles) {
        expect(reg.get(r)?.role).toBe(r);
      }
    });
  });

  describe('getAll', () => {
    it('returns a snapshot of all registered agents', () => {
      const reg = new AgentRegistry();
      const a1 = createMockAgent('Pass1', 'pass1');
      const a2 = createMockAgent('Pass2', 'pass2');
      reg.register(a1);
      reg.register(a2);
      expect(reg.getAll()).toEqual([a1, a2]);
    });

    it('returns an empty array when no agents are registered', () => {
      const reg = new AgentRegistry();
      expect(reg.getAll()).toEqual([]);
    });
  });

  describe('unregister', () => {
    it('removes the agent for the given role', () => {
      const reg = new AgentRegistry();
      reg.register(createMockAgent('Pass1', 'pass1'));
      reg.unregister('pass1');
      expect(reg.get('pass1')).toBeUndefined();
    });

    it('is a no-op when the role is not registered', () => {
      const reg = new AgentRegistry();
      expect(() => reg.unregister('review')).not.toThrow();
    });
  });

  describe('clear', () => {
    it('removes all registered agents', () => {
      const reg = new AgentRegistry();
      reg.register(createMockAgent('Pass1', 'pass1'));
      reg.register(createMockAgent('Pass2', 'pass2'));
      reg.clear();
      expect(reg.getAll()).toEqual([]);
      expect(reg.get('pass1')).toBeUndefined();
      expect(reg.get('pass2')).toBeUndefined();
    });
  });
});

// ============================================================================
// Agent contract — compilePacket, getOutputSchema, getConfig
// ============================================================================

describe('Agent contract', () => {
  it('compilePacket returns structured prompt packet', () => {
    const agent = createMockAgent('TestAgent', 'review');
    const packet = agent.compilePacket('Render this scene.');
    expect(packet).toHaveProperty('systemPrompt');
    expect(packet).toHaveProperty('userPrompt');
    expect(packet.systemPrompt).toBe('You are TestAgent.');
    expect(packet.userPrompt).toBe('Render this scene.');
  });

  it('getOutputSchema returns a Zod schema', () => {
    const agent = createMockAgent('SchemaAgent', 'summary');
    const schema = agent.getOutputSchema();
    expect(schema).toBeInstanceOf(z.ZodType);
    expect(schema.safeParse('any string').success).toBe(true);
  });

  it('getConfig returns config including model, temperature, maxTokens', () => {
    const agent = createMockAgent('ConfigAgent', 'pass1', {
      model: 'claude-3-opus',
      temperature: 0.3,
      maxTokens: 4000,
      seed: 42,
    });
    const config = agent.getConfig();
    expect(config.model).toBe('claude-3-opus');
    expect(config.temperature).toBe(0.3);
    expect(config.maxTokens).toBe(4000);
    expect(config.seed).toBe(42);
  });

  it('getConfig returns defaults when no overrides provided', () => {
    const agent = createMockAgent('DefaultAgent', 'pass2');
    const config = agent.getConfig();
    expect(config.model).toBe('gpt-4o');
    expect(config.temperature).toBe(0.7);
    expect(config.maxTokens).toBe(2000);
    expect(config.seed).toBeUndefined();
  });
});

// ============================================================================
// Routing by role — pipeline integration simulation
// ============================================================================

describe('Agent routing', () => {
  it('routes through registry by role and produces correct packet', () => {
    const reg = new AgentRegistry();
    reg.register(createMockAgent('Pass1Renderer', 'pass1'));
    reg.register(createMockAgent('Pass2Analyzer', 'pass2'));
    reg.register(createMockAgent('SummaryBuilder', 'summary'));
    reg.register(createMockAgent('ReviewChecker', 'review'));

    const pass1Agent = reg.get('pass1')!;
    const pass2Agent = reg.get('pass2')!;

    expect(pass1Agent.name).toBe('Pass1Renderer');
    expect(pass2Agent.name).toBe('Pass2Analyzer');

    const p1Packet = pass1Agent.compilePacket('Write the scene.');
    expect(p1Packet.systemPrompt).toContain('Pass1Renderer');
    const p2Packet = pass2Agent.compilePacket('Analyze this.');
    expect(p2Packet.systemPrompt).toContain('Pass2Analyzer');
  });

  it('falls back gracefully when role is not registered', () => {
    const reg = new AgentRegistry();
    // Only register pass1
    reg.register(createMockAgent('Pass1', 'pass1'));
    expect(reg.get('summary')).toBeUndefined();
    expect(reg.get('review')).toBeUndefined();
    expect(reg.get('pass2')).toBeUndefined();
  });
});

// ============================================================================
// Mock injection — replace a real agent with a test double
// ============================================================================

describe('Mock injection', () => {
  it('replaces a registered agent with a mock', () => {
    const reg = new AgentRegistry();
    const realAgent = createMockAgent('RealPass2', 'pass2', {
      model: 'expensive-model',
      temperature: 0.3,
      maxTokens: 12000,
    });
    reg.register(realAgent);

    const mockAgent = createMockAgent('MockPass2', 'pass2', {
      model: 'mock-model',
      temperature: 0.0,
      maxTokens: 500,
    });
    reg.register(mockAgent); // replace

    const retrieved = reg.get('pass2')!;
    expect(retrieved.name).toBe('MockPass2');
    expect(retrieved.getConfig().model).toBe('mock-model');
    expect(retrieved.getConfig().temperature).toBe(0.0);
  });
});

// ============================================================================
// Config override — per-agent config differs from pipeline defaults
// ============================================================================

describe('Config override', () => {
  it('each agent can carry its own model and parameters', () => {
    const agents: Agent<unknown, unknown>[] = [
      createMockAgent('CheapPass1', 'pass1', {
        model: 'gpt-4o-mini',
        temperature: 0.8,
        maxTokens: 2000,
      }),
      createMockAgent('ExpensivePass2', 'pass2', {
        model: 'gpt-4o',
        temperature: 0.3,
        maxTokens: 12000,
        seed: 42,
      }),
      createMockAgent('SummaryAgent', 'summary', {
        model: 'gpt-4o-mini',
        temperature: 0.5,
        maxTokens: 1500,
      }),
    ];

    const configs = agents.map((a) => ({ name: a.name, config: a.getConfig() }));

    const pass1Cfg = configs.find((c) => c.name === 'CheapPass1')!.config;
    expect(pass1Cfg.model).toBe('gpt-4o-mini');
    expect(pass1Cfg.temperature).toBe(0.8);

    const pass2Cfg = configs.find((c) => c.name === 'ExpensivePass2')!.config;
    expect(pass2Cfg.model).toBe('gpt-4o');
    expect(pass2Cfg.seed).toBe(42);
  });
});
