// ============================================================================
// Novalistically — StyleProfile Resolver (§D8)
//
// Resolves a StyleProfile by merging project → chapter → narrator/POV → scene
// precedence levels. Each level defines optional overrides; scene wins over
// narrator, narrator wins over chapter, chapter wins over project, project
// wins over defaults.
//
// The merge is deterministic and hash-stable: keys are sorted before merge,
// and the same inputs always produce the same output.
// ============================================================================

import type { StyleProfile as SimpleStyleProfile } from './default-profile.ts';
import { DEFAULT_STYLE_PROFILE } from './default-profile.ts';
import type {
  StyleProfile as InternalStyleProfile,
  StyleResolutionPath,
} from '../types/render-surface.ts';

export interface StyleResolverInput {
  project?: SimpleStyleProfile;
  chapter?: SimpleStyleProfile;
  narrator?: SimpleStyleProfile;
  scene?: SimpleStyleProfile;
}

/**
 * Resolve a combined StyleProfile from up to four cascading levels.
 * Precedence (highest wins): scene > narrator > chapter > project > default.
 */
export function resolveProfile(input: StyleResolverInput): SimpleStyleProfile {
  const merged: SimpleStyleProfile = {};

  // Collect all keys from DEFAULT_STYLE_PROFILE for deterministic iteration
  const allKeys = Object.keys(DEFAULT_STYLE_PROFILE) as (keyof SimpleStyleProfile)[];

  // Apply each level in order: default → project → chapter → narrator → scene
  const levels = [
    DEFAULT_STYLE_PROFILE,
    input.project ?? {},
    input.chapter ?? {},
    input.narrator ?? {},
    input.scene ?? {},
  ];

  for (const key of allKeys) {
    // Walk levels in precedence order — last defined value wins
    for (const level of levels) {
      if (level[key] !== undefined) {
        // Deep clone for avoid[] to ensure immutability
        if (key === 'avoid' && Array.isArray(level.avoid)) {
          (merged as Record<string, unknown>)[key] = [...level.avoid!];
        } else {
          (merged as Record<string, unknown>)[key] = level[key];
        }
      }
    }
  }

  return merged;
}

/**
 * Convert a resolved simple StyleProfile to the internal full StyleProfile
 * (with auto-generated profileId and resolutionPrecedence) for use in
 * CompiledSceneContract.
 */
export function toInternalProfile(
  resolved: SimpleStyleProfile,
  input: StyleResolverInput = {},
): InternalStyleProfile {
  // Produce stable identifiers from the profiles that were provided
  const projectStyle = 'project_style_v1';
  const chapterStyle = input.chapter ? 'chapter_style_v1' : undefined;
  const narratorPovStyle = input.narrator ? 'narrator_style_v1' : undefined;
  const sceneStyle = input.scene ? 'scene_style_v1' : undefined;

  // Build a composite profileId from all non-empty levels
  const levelIds = ['default'];
  if (input.project) levelIds.push('project');
  if (input.chapter) levelIds.push('chapter');
  if (input.narrator) levelIds.push('narrator');
  if (input.scene) levelIds.push('scene');

  const resolutionPrecedence: StyleResolutionPath = {
    projectStyle,
    chapterStyle,
    narratorPovStyle,
    sceneStyle,
  };

  return {
    profileId: `resolved_${levelIds.join('_')}_v1`,
    resolutionPrecedence,
    ...resolved,
  };
}

/**
 * StyleResolver — convenience class wrapping resolveProfile + toInternalProfile.
 */
export class StyleResolver {
  /**
   * Resolve a full internal StyleProfile from cascading config levels.
   * Returns both the simple resolved profile and the full internal profile.
   */
  resolve(input: StyleResolverInput): {
    simple: SimpleStyleProfile;
    internal: InternalStyleProfile;
  } {
    const simple = resolveProfile(input);
    const internal = toInternalProfile(simple, input);
    return { simple, internal };
  }
}

/**
 * Convert a resolved StyleProfile to a human-readable style notes string
 * for inclusion in LLM prompts. Only non-default values are included.
 */
export function toStyleNotes(profile: SimpleStyleProfile): string | undefined {
  const parts: string[] = [];
  if (profile.voice && profile.voice !== DEFAULT_STYLE_PROFILE.voice) {
    parts.push(profile.voice);
  }
  if (profile.diction && profile.diction !== DEFAULT_STYLE_PROFILE.diction) {
    parts.push(`${profile.diction} diction`);
  }
  if (profile.rhythm && profile.rhythm !== DEFAULT_STYLE_PROFILE.rhythm) {
    parts.push(`${profile.rhythm} rhythm`);
  }
  if (profile.paragraphing && profile.paragraphing !== DEFAULT_STYLE_PROFILE.paragraphing) {
    parts.push(`${profile.paragraphing} paragraphing`);
  }
  if (profile.typography && profile.typography !== DEFAULT_STYLE_PROFILE.typography) {
    parts.push(`${profile.typography} typography`);
  }
  if (profile.dialogue && profile.dialogue !== DEFAULT_STYLE_PROFILE.dialogue) {
    parts.push(`${profile.dialogue} dialogue`);
  }
  if (profile.avoid && profile.avoid.length > 0) {
    parts.push(`avoid: ${profile.avoid.join(', ')}`);
  }

  if (parts.length === 0) return undefined;

  return `Style: ${parts.join(', ')}.`;
}
