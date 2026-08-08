// ============================================================================
// Agent System — Type Definitions
// ============================================================================
import type { z } from 'zod/v3';

/**
 * The role an agent plays in the pipeline.
 * Mirrors TaskType from ai/types.ts but adds 'review' and is the canonical
 * routing key for the AgentRegistry.
 */
export type AgentRole = 'pass1' | 'pass2' | 'summary' | 'review';

/**
 * Structured prompt packet produced by an Agent's compilePacket().
 */
export interface AgentPacket {
  /** System-level instruction that establishes model behaviour. */
  systemPrompt: string;
  /** Per-call user prompt containing the input data. */
  userPrompt: string;
  /** Optional Zod schema that the output must conform to. */
  schema?: z.ZodType;
}

/**
 * Per-agent configuration overrides.
 * When absent, the pipeline's global config is used.
 */
export interface AgentConfig {
  /** The model identifier to route this agent to. */
  model: string;
  /** Sampling temperature (0.0 – 2.0). 0 = deterministic. */
  temperature: number;
  /** Maximum completion tokens for this agent. */
  maxTokens: number;
  /** Optional seed for reproducible outputs (Pass 2, review). */
  seed?: number;
}

/**
 * Core Agent interface.
 *
 * Each Agent is responsible for one role in the pipeline. It knows how to
 * compile its input into a structured prompt packet and exposes its output
 * schema for validation downstream.
 */
export interface Agent<I, O> {
  /** Human-readable identifier (e.g. "SceneRenderer", "AnalysisReviewer"). */
  readonly name: string;
  /** The pipeline role this agent fulfills. */
  readonly role: AgentRole;

  /**
   * Transform typed input into an AgentPacket (system + user prompt pair,
   * optionally with an output schema).
   */
  compilePacket(input: I): AgentPacket;

  /** Return the Zod schema that the agent's output is expected to match. */
  getOutputSchema(): z.ZodType<O>;

  /** Return the config override for this agent (or defaults). */
  getConfig(): AgentConfig;
}
