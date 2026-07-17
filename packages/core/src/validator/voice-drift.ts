// ============================================================================
// VoiceDriftDetector — Prose-level voice consistency checks
// ============================================================================

import type {
  PreRenderInput,
  Validator,
  ValidationIssue,
  PostRenderInput,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class VoiceDriftDetector implements Validator {
  name = 'voice_drift';
  category = 'narrative_style' as const;

  validatePre(_input: PreRenderInput): ValidationIssue[] {
    return [];
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { prose, event, worldState } = input;
    const characterId = event.pov.character;
    const charState = worldState.entities[characterId];
    if (!charState) return issues;

    const proseLower = prose.toLowerCase();
    const archetype = (charState.archetype as string) ?? '';
    const traits: string[] = (charState.traits as string[]) ?? [];
    const voiceNotes = (charState.voiceNotes as string) ?? '';

    // ── Cultured / aristocratic voice ──
    const isAristocratic =
      /aristocrat|cultured|refined|noble|count|general/i.test(archetype) ||
      traits.some((t) => /aristocrat|cultured|refined|noble|formal/i.test(t)) ||
      /formal|elaborate|ornate/i.test(voiceNotes);

    if (isAristocratic) {
      // Flag informal / slang terms
      const informalTerms = ['gonna', 'wanna', 'gotta', 'yo', 'dude', 'bro', 'lol', 'sucks', 'ain\'t', 'y\'all', 'nah', 'yeah'];
      const foundInformal = informalTerms.find((t) => {
        const re = new RegExp(`\\b${t.replace(/'/g, "\\'")}\\b`, 'i');
        return re.test(prose);
      });
      if (foundInformal) {
        issues.push(makeIssue(
          this.name, event.id, characterId, 'warning',
          `Voice drift: "${foundInformal}" is too informal for the aristocratic/cultured voice of "${characterId}"`,
          `Replace "${foundInformal}" with more refined vocabulary consistent with the character's voice.`,
          'edit_file',
          'voiceNotes',
        ));
      }

      // Check for formal vocabulary markers in longer prose
      const formalMarkers = ['thus', 'hence', 'shall', 'whom', 'indeed', 'nevertheless', 'heretofore', 'therefore'];
      const hasFormal = formalMarkers.some((w) => {
        const re = new RegExp(`\\b${w}\\b`, 'i');
        return re.test(prose);
      });
      if (!hasFormal && prose.split(/\s+/).length > 30) {
        issues.push(makeIssue(
          this.name, event.id, characterId, 'info',
          `Prose for aristocratic character "${characterId}" lacks formal vocabulary markers`,
          'Consider using more formal language (e.g. "thus", "shall", "indeed") to match the character\'s voice.',
          'edit_file',
          'voiceNotes',
        ));
      }
    }

    // ── Practical / direct voice ──
    const isPractical =
      /practical|direct|no.nonsense|action|hunter|soldier|pragmatic|stoic/i.test(archetype) ||
      traits.some((t) => /practical|direct|no.nonsense|action|hunter|soldier|blunt/i.test(t));

    if (isPractical) {
      // Flag flowery / abstract language
      const floweryWords = ['ethereal', 'sublime', 'transcendent', 'mellifluous', 'effulgent', 'resplendent', 'pulchritude'];
      const foundFlowery = floweryWords.find((w) => {
        const re = new RegExp(`\\b${w}\\b`, 'i');
        return re.test(prose);
      });
      if (foundFlowery) {
        issues.push(makeIssue(
          this.name, event.id, characterId, 'warning',
          `Voice drift: "${foundFlowery}" is overly flowery for the practical/direct voice of "${characterId}"`,
          'Replace abstract or poetic language with concrete, action-oriented wording.',
          'edit_file',
          'voiceNotes',
        ));
      }

      // Check for concrete action verbs in longer prose
      const actionVerbs = ['ran', 'fired', 'grabbed', 'pushed', 'climbed', 'jumped', 'swung',
        'struck', 'aimed', 'lunged', 'crawled', 'dove', 'sprinted', 'seized'];
      const hasActionVerb = actionVerbs.some((v) => {
        const re = new RegExp(`\\b${v}\\b`, 'i');
        return re.test(prose);
      });
      if (!hasActionVerb && prose.split(/\s+/).length > 30) {
        issues.push(makeIssue(
          this.name, event.id, characterId, 'info',
          `Prose for practical character "${characterId}" lacks concrete action verbs`,
          'Consider adding more direct, physical action words to match the character\'s straightforward voice.',
          'edit_file',
          'voiceNotes',
        ));
      }
    }

    // ── Period-appropriate language check ──
    // Flag modern slang unless the story is explicitly set in a modern period
    const storyTimeVal = event.storyTime.type === 'absolute' ? event.storyTime.value : '';
    const isModernSetting = /modern|contemporary|present|202/i.test(storyTimeVal);

    if (!isModernSetting) {
      const anachronisticTerms = ['ain\'t', 'y\'all', 'gonna', 'wanna', 'gotta',
        'btw', 'selfie', 'ghosted', 'salty', 'cringe', 'fomo', 'lit', 'vibe'];
      const foundAnachronism = anachronisticTerms.find((t) => {
        const re = new RegExp(`\\b${t.replace(/'/g, "\\'")}\\b`, 'i');
        return re.test(prose);
      });
      if (foundAnachronism) {
        issues.push(makeIssue(
          this.name, event.id, characterId, 'warning',
          `Anachronistic voice drift: "${foundAnachronism}" is modern slang inappropriate for the story's time period`,
          `Replace "${foundAnachronism}" with period-appropriate language.`,
          'edit_file',
          'voiceNotes',
        ));
      }
    }

    return issues;
  }
}
