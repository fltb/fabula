// ============================================================================
// StyleProfile — Unit Tests (§D8)
// Tests: default fallback, precedence resolution, hash stability, config merge
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { StyleResolverInput } from '../src/style/index.js';
import {
  DEFAULT_STYLE_PROFILE,
  resolveProfile,
  StyleResolver,
  toInternalProfile,
  toStyleNotes,
} from '../src/style/index.js';

// ============================================================================
// DEFAULT_STYLE_PROFILE
// ============================================================================

describe('DEFAULT_STYLE_PROFILE', () => {
  it('provides sensible defaults', () => {
    expect(DEFAULT_STYLE_PROFILE.voice).toBe('neutral');
    expect(DEFAULT_STYLE_PROFILE.diction).toBe('standard');
    expect(DEFAULT_STYLE_PROFILE.rhythm).toBe('varied');
    expect(DEFAULT_STYLE_PROFILE.paragraphing).toBe('standard');
    expect(DEFAULT_STYLE_PROFILE.typography).toBe('standard');
    expect(DEFAULT_STYLE_PROFILE.dialogue).toBe('standard');
    expect(DEFAULT_STYLE_PROFILE.avoid).toEqual([]);
  });
});

// ============================================================================
// resolveProfile — cascading merge
// ============================================================================

describe('resolveProfile', () => {
  it('returns default when no input provided', () => {
    const result = resolveProfile({});
    expect(result.voice).toBe('neutral');
    expect(result.diction).toBe('standard');
    expect(result.rhythm).toBe('varied');
  });

  it('uses project profile over default', () => {
    const result = resolveProfile({
      project: { voice: 'formal', diction: 'elevated' },
    });
    expect(result.voice).toBe('formal');
    expect(result.diction).toBe('elevated');
    // non-overridden fields fall through to default
    expect(result.rhythm).toBe('varied');
  });

  it('overrides project with chapter profile', () => {
    const result = resolveProfile({
      project: { voice: 'formal', diction: 'elevated', rhythm: 'flowing' },
      chapter: { voice: 'conversational' },
    });
    expect(result.voice).toBe('conversational'); // chapter wins
    expect(result.diction).toBe('elevated'); // from project
    expect(result.rhythm).toBe('flowing'); // from project
  });

  it('overrides chapter with narrator profile', () => {
    const result = resolveProfile({
      project: { voice: 'formal' },
      chapter: { voice: 'conversational', diction: 'colloquial' },
      narrator: { voice: 'lyrical' },
    });
    expect(result.voice).toBe('lyrical'); // narrator wins
    expect(result.diction).toBe('colloquial'); // from chapter
  });

  it('overrides narrator with scene profile', () => {
    const result = resolveProfile({
      project: { voice: 'formal' },
      narrator: { voice: 'lyrical', diction: 'elevated' },
      scene: { voice: 'conversational' },
    });
    expect(result.voice).toBe('conversational'); // scene wins
    expect(result.diction).toBe('elevated'); // from narrator
  });

  it('handles avoid array merge', () => {
    const result = resolveProfile({
      project: { avoid: ['cliche', 'purple_prose'] },
      scene: { avoid: ['cliche', 'adverbs'] },
    });
    // scene value wins for the whole array (not merge)
    expect(result.avoid).toEqual(['cliche', 'adverbs']);
  });

  it('is deterministic: same inputs = same output', () => {
    const input: StyleResolverInput = {
      project: { voice: 'formal', diction: 'elevated', avoid: ['cliche'] },
      chapter: { rhythm: 'staccato' },
      scene: { voice: 'conversational' },
    };

    const result1 = resolveProfile(input);
    const result2 = resolveProfile(input);

    expect(result1).toEqual(result2);
  });

  it('returns a new object each call (immutability)', () => {
    const input = { project: { voice: 'formal' } };
    const result1 = resolveProfile(input);
    const result2 = resolveProfile(input);
    expect(result1).not.toBe(result2);
  });

  it('preserves undefined fields as undefined in merged result', () => {
    const result = resolveProfile({
      project: { voice: 'formal' },
    });
    // avoid is not explicitly set, but defaults are applied
    expect(result.avoid).toBeDefined();
    expect(result.avoid).toEqual([]);
  });
});

// ============================================================================
// toInternalProfile — conversion to render-surface StyleProfile
// ============================================================================

describe('toInternalProfile', () => {
  it('generates profileId from resolved levels', () => {
    const internal = toInternalProfile(
      { voice: 'formal' },
      { project: { voice: 'formal' }, scene: { voice: 'lyrical' } },
    );
    expect(internal.profileId).toContain('default');
    expect(internal.profileId).toContain('project');
    expect(internal.profileId).toContain('scene');
  });

  it('includes resolutionPrecedence in correct order', () => {
    const internal = toInternalProfile(
      { voice: 'formal' },
      {
        project: { voice: 'formal' },
        chapter: { voice: 'conversational' },
        narrator: { voice: 'lyrical' },
        scene: { voice: 'dramatic' },
      },
    );
    expect(internal.resolutionPrecedence.projectStyle).toBe('project_style_v1');
    expect(internal.resolutionPrecedence.chapterStyle).toBe('chapter_style_v1');
    expect(internal.resolutionPrecedence.narratorPovStyle).toBe('narrator_style_v1');
    expect(internal.resolutionPrecedence.sceneStyle).toBe('scene_style_v1');
  });

  it('carries resolved style fields to internal profile', () => {
    const resolved = { voice: 'formal', diction: 'elevated', avoid: ['cliche'] };
    const internal = toInternalProfile(resolved);
    expect(internal.voice).toBe('formal');
    expect(internal.diction).toBe('elevated');
    expect(internal.avoid).toEqual(['cliche']);
  });

  it('omits optional precedence levels when not provided', () => {
    const internal = toInternalProfile({ voice: 'formal' }, { project: { voice: 'formal' } });
    expect(internal.resolutionPrecedence.chapterStyle).toBeUndefined();
    expect(internal.resolutionPrecedence.narratorPovStyle).toBeUndefined();
    expect(internal.resolutionPrecedence.sceneStyle).toBeUndefined();
  });
});

// ============================================================================
// StyleResolver class
// ============================================================================

describe('StyleResolver', () => {
  const resolver = new StyleResolver();

  it('resolves simple and internal profiles', () => {
    const { simple, internal } = resolver.resolve({
      project: { voice: 'formal' },
      scene: { voice: 'lyrical' },
    });
    expect(simple.voice).toBe('lyrical');
    expect(internal.voice).toBe('lyrical');
    expect(internal.profileId).toBeDefined();
    expect(internal.resolutionPrecedence).toBeDefined();
  });

  it('defaults to DEFAULT_STYLE_PROFILE with no input', () => {
    const { simple, internal } = resolver.resolve({});
    expect(simple.voice).toBe('neutral');
    expect(internal.profileId).toBe('resolved_default_v1');
  });

  it('is hash-stable: same inputs yield identical output', () => {
    const input: StyleResolverInput = {
      project: { voice: 'formal' },
      narrator: { diction: 'colloquial' },
    };
    const a = resolver.resolve(input);
    const b = resolver.resolve(input);
    expect(a.simple).toEqual(b.simple);
    expect(a.internal).toEqual(b.internal);
  });
});

// ============================================================================
// toStyleNotes — prose instruction generation
// ============================================================================

describe('toStyleNotes', () => {
  it('returns undefined for default profile', () => {
    expect(toStyleNotes(DEFAULT_STYLE_PROFILE)).toBeUndefined();
  });

  it('generates notes for non-default values', () => {
    const notes = toStyleNotes({ voice: 'formal', diction: 'elevated' });
    expect(notes).toContain('formal');
    expect(notes).toContain('elevated diction');
    expect(notes).toContain('Style:');
  });

  it('includes avoid patterns', () => {
    const notes = toStyleNotes({ voice: 'formal', avoid: ['cliche', 'adverbs'] });
    expect(notes).toContain('avoid: cliche, adverbs');
  });

  it('returns undefined when only default values are set', () => {
    const notes = toStyleNotes({ voice: 'neutral', diction: 'standard' });
    expect(notes).toBeUndefined();
  });
});

// ============================================================================
// Full precedence chain integration
// ============================================================================

describe('Full precedence chain', () => {
  it('scene > narrator > chapter > project > default', () => {
    const result = resolveProfile({
      project: { voice: 'neutral', diction: 'standard' },
      chapter: { voice: 'conversational', rhythm: 'staccato' },
      narrator: { voice: 'lyrical', diction: 'elevated', dialogue: 'minimal' },
      scene: { voice: 'dramatic', paragraphing: 'short_paragraphs' },
    });

    // scene overrides
    expect(result.voice).toBe('dramatic');
    expect(result.paragraphing).toBe('short_paragraphs');

    // narrator fills gaps not overridden by scene
    expect(result.diction).toBe('elevated');
    expect(result.dialogue).toBe('minimal');

    // chapter fills remaining gaps
    expect(result.rhythm).toBe('staccato');

    // project is baseline for unset fields
    // (all fields are now covered, but typography/dialogue/avoid fall to default)
    expect(result.typography).toBe('standard');
    expect(result.avoid).toEqual([]);
  });

  it('partial overrides at each level work correctly', () => {
    const result = resolveProfile({
      project: { typography: 'minimal_punctuation' },
      narrator: { voice: 'lyrical', diction: 'elevated' },
    });
    // narrator overrides voice and diction
    expect(result.voice).toBe('lyrical');
    expect(result.diction).toBe('elevated');
    // project typography preserved
    expect(result.typography).toBe('minimal_punctuation');
    // defaults for everything else
    expect(result.rhythm).toBe('varied');
  });

  it('same inputs produce same toStyleNotes output', () => {
    const input: StyleResolverInput = {
      project: { voice: 'formal', avoid: ['cliche'] },
      scene: { voice: 'dramatic' },
    };

    const resolved1 = resolveProfile(input);
    const resolved2 = resolveProfile(input);

    const notes1 = toStyleNotes(resolved1);
    const notes2 = toStyleNotes(resolved2);
    expect(notes1).toBe(notes2);
  });
});
