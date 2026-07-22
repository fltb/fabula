// ============================================================================
// Agent System — Registry
// ============================================================================

import type { Agent, AgentRole } from './types.ts';

/**
 * Central registry that maps AgentRole → Agent instance.
 *
 * The pipeline queries the registry by role to obtain the correct agent
 * for each phase (pass1, pass2, summary, review). Registration is
 * append-only — a subsequent register() for the same role silently
 * replaces the prior entry to allow plugin overrides.
 */
export class AgentRegistry {
  private readonly _agents = new Map<AgentRole, Agent<unknown, unknown>>();

  /**
   * Register (or replace) an agent for its declared role.
   */
  register(agent: Agent<unknown, unknown>): void {
    this._agents.set(agent.role, agent);
  }

  /**
   * Retrieve the agent for a given role, or `undefined` if none registered.
   */
  get(role: AgentRole): Agent<unknown, unknown> | undefined {
    return this._agents.get(role);
  }

  /**
   * Return a snapshot of all registered agents.
   */
  getAll(): Agent<unknown, unknown>[] {
    return Array.from(this._agents.values());
  }

  /**
   * Remove the agent for the given role, if present.
   */
  unregister(role: AgentRole): void {
    this._agents.delete(role);
  }

  /**
   * Remove all registered agents.
   */
  clear(): void {
    this._agents.clear();
  }
}
