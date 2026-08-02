// ============================================================================
// Novalistically — RENDER-SURFACE-1: CompiledSceneContract compilation
//
// Every scene has one CompiledSceneContract BEFORE prose (§2).
// Contains branch/discourse position, boundary hashes, resolved versioned
// StyleProfile, deterministic authored continuity packet, prompt contract hash.
//
// StyleProfile resolution follows deterministic precedence:
//   project → chapter → narrator/POV → scene
// ============================================================================

import { sha256 } from '../cache/pure-sha256.ts';
import type { BranchPath } from '../types/branch.js';
import type { DiscoursePosition } from '../types/discourse.js';
import type {
  CompiledSceneContract,
  ContinuityPacket,
  SceneTransition,
  StyleProfile,
  StyleResolutionPath,
} from '../types/render-surface.js';

// ─── Default Style Profiles ──────────────────────────────────────────────────

/**
 * Default project-level style profile.
 * Used as fallback when no more specific style is resolved.
 */
const DEFAULT_PROJECT_STYLE: StyleProfile = {
  profileId: 'default_project_style_v1',
  resolutionPrecedence: {
    projectStyle: 'default_project_style_v1',
  },
  voice: 'clear narrative prose',
  diction: 'standard literary',
  rhythm: 'varied',
  paragraphing: 'conventional',
  typography: 'standard',
  dialogue: 'attributed',
};

// ─── StyleProfile Registry ───────────────────────────────────────────────────

/**
 * In-memory registry of style profiles keyed by their profile ID.
 * In production this would be loaded from YAML/project config.
 */
const styleProfileRegistry = new Map<string, StyleProfile>([
  [DEFAULT_PROJECT_STYLE.profileId, DEFAULT_PROJECT_STYLE],
]);

// ─── Scene Contract Compilation ──────────────────────────────────────────────

export interface SceneContractInput {
  /** Unique scene identifier. */
  sceneId: string;

  /** Branch path this scene belongs to. */
  branch: BranchPath;

  /** Discourse position. */
  discoursePosition: DiscoursePosition;

  /** Hash of WorldState at scene boundary. */
  worldStateHash: string;

  /** Hash of Knowledge state at scene boundary. */
  knowledgeStateHash: string;

  /** Hash of narrator profile/configuration. */
  narratorProfileHash: string;

  /** Hash of planned discourse boundary. */
  plannedDiscourseHash: string;

  /** Hash of assertion catalog (definitions/assertions). */
  catalogHash?: string;

  /** Style resolution hints (chapter/narrator/POV/scene style IDs). */
  styleHints?: {
    chapterStyle?: string;
    narratorPovStyle?: string;
    sceneStyle?: string;
  };

  /** Authored continuity directives. */
  continuityDirectives?: {
    transition: SceneTransition;
    motifs?: string[];
    callbacks?: string[];
    openCloseMode?: 'open' | 'closed' | 'open_close' | 'none';
  };

  /** Prompt provider identifier. */
  promptProviderId?: string;

  /** Version of the prompt provider used. */
  promptProviderVersion?: string;
}
/**
 * Compile a scene contract from input data.
 * Resolves the deterministic style profile and builds the continuity packet.
 * This is a pure function (no side effects beyond registry lookup).
 */
export function compileSceneContract(input: SceneContractInput): CompiledSceneContract {
  const styleProfile = resolveStyleProfile(input.styleHints);

  const continuityPacket: ContinuityPacket = {
    transition: input.continuityDirectives?.transition ?? 'continuous',
    motifs: input.continuityDirectives?.motifs,
    callbacks: input.continuityDirectives?.callbacks,
    openCloseMode: input.continuityDirectives?.openCloseMode,
  };

  const promptContractHash = computePromptContractHash(input, styleProfile, continuityPacket);

  return {
    sceneId: input.sceneId,
    branch: input.branch,
    discoursePosition: input.discoursePosition,
    worldStateHash: input.worldStateHash,
    knowledgeStateHash: input.knowledgeStateHash,
    narratorProfileHash: input.narratorProfileHash,
    plannedDiscourseHash: input.plannedDiscourseHash,
    catalogHash: input.catalogHash,
    styleProfile,
    continuityPacket,
    promptContractHash,
    promptProviderId: input.promptProviderId,
    promptProviderVersion: input.promptProviderVersion,
  };
}

/**
 * Resolve StyleProfile by project → chapter → narrator/POV → scene precedence.
 * Falls back to parent level if a more specific profile is not found.
 */
export function resolveStyleProfile(styleHints?: SceneContractInput['styleHints']): StyleProfile {
  // Start with project default
  const projectStyle = getProfile(DEFAULT_PROJECT_STYLE.profileId) ?? DEFAULT_PROJECT_STYLE;

  // Try to resolve chapter style
  let chapterStyle: StyleProfile | undefined;
  if (styleHints?.chapterStyle) {
    chapterStyle = getProfile(styleHints.chapterStyle);
  }

  // Try to resolve narrator/POV style
  let narratorPovStyle: StyleProfile | undefined;
  if (styleHints?.narratorPovStyle) {
    narratorPovStyle = getProfile(styleHints.narratorPovStyle);
  }

  // Try to resolve scene-specific style
  let sceneStyle: StyleProfile | undefined;
  if (styleHints?.sceneStyle) {
    sceneStyle = getProfile(styleHints.sceneStyle);
  }

  // Resolve final profile: scene wins over narrator/POV, narrator/POV wins over
  // chapter, chapter wins over project. Each level provides overrides.
  const finalProfile =
    sceneStyle ?? narratorPovStyle ?? chapterStyle ?? projectStyle ?? DEFAULT_PROJECT_STYLE;

  const resolutionPrecedence: StyleResolutionPath = {
    projectStyle: projectStyle?.profileId,
    chapterStyle: chapterStyle?.profileId,
    narratorPovStyle: narratorPovStyle?.profileId,
    sceneStyle: sceneStyle?.profileId,
  };

  return {
    ...finalProfile,
    profileId: finalProfile.profileId,
    resolutionPrecedence,
  };
}

/**
 * Register a style profile for resolution lookup.
 * Throws if a profile with the same ID already exists.
 */
export function registerStyleProfile(profile: StyleProfile): void {
  if (styleProfileRegistry.has(profile.profileId)) {
    throw new Error(`StyleProfile '${profile.profileId}' already registered`);
  }
  styleProfileRegistry.set(profile.profileId, profile);
}

/**
 * Get a registered style profile by ID.
 * Returns undefined if not found.
 */
export function getProfile(profileId: string): StyleProfile | undefined {
  return styleProfileRegistry.get(profileId);
}

/**
 * Clear all registered style profiles (useful for testing).
 */
export function clearStyleProfileRegistry(): void {
  styleProfileRegistry.clear();
  // Re-register default
  styleProfileRegistry.set(DEFAULT_PROJECT_STYLE.profileId, DEFAULT_PROJECT_STYLE);
}

/**
 * Compute the prompt contract hash from the input and resolved values.
 * Uses canonical-key-sorted JSON SHA-256 for deterministic cryptographic identity.
 */
function computePromptContractHash(
  input: SceneContractInput,
  styleProfile: StyleProfile,
  continuityPacket: ContinuityPacket,
): string {
  // Build comprehensive payload covering ALL contract identity inputs:
  // world-state boundary, knowledge boundary, narrator/profile,
  // planned discourse/catalog, style, branch, prompt-provider/version.
  const payload: Record<string, unknown> = {
    sceneId: input.sceneId,
    branch: input.branch,
    discoursePosition: input.discoursePosition,
    worldStateHash: input.worldStateHash,
    knowledgeStateHash: input.knowledgeStateHash,
    narratorProfileHash: input.narratorProfileHash,
    plannedDiscourseHash: input.plannedDiscourseHash,
    catalogHash: input.catalogHash ?? null,
    styleProfile,
    continuity: continuityPacket,
    promptProviderId: input.promptProviderId ?? null,
    promptProviderVersion: input.promptProviderVersion ?? null,
  };

  const raw = canonicalJson(payload);
  return sha256(raw);
}

/**
 * Deterministic recursive sorted-key canonical JSON serialization.
 * Arrays preserve original order; object keys are sorted lexicographically;
 * undefined members are omitted; primitives serialize normally.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/**
 * Compute SHA-256 hex digest of the input string.
 * Cryptographic — suitable for contract identity.
 */
export function computeSha256Hex(input: string): string {
  return sha256(input);
}
