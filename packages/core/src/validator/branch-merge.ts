// ============================================================================
// BranchMergeValidator — Check branch merge precondition consistency
// ============================================================================

import type {
  PreRenderInput,
  PostRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class BranchMergeValidator implements Validator {
  name = 'branch_merge';
  category = 'timeline_plot' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const event = input.event;

    // For branch events: check if this is a merge point
    // A merge point is where multiple incoming branch paths converge
    const incomingBranches = input.events.filter(
      (e) =>
        e.narrativeOrder < event.narrativeOrder &&
        e.branchExistence.type !== 'all',
    );

    if (incomingBranches.length === 0) return issues;

    // Check each precondition against each incoming branch's final state
    for (const pc of event.preconditions) {
      const currentValue = input.queryState(pc.entityId, pc.attribute);

      if (currentValue === undefined || currentValue === null) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Merge precondition "${pc.entityId}.${pc.attribute} = ${pc.value}" is not satisfied (current: ${JSON.stringify(currentValue)}) on branch path`,
          'Ensure the precondition is satisfied on all incoming branch paths before merging.',
          'add_precondition',
          pc.attribute,
        ));
      }
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const event = input.event;
    const prose = input.prose;
    const branchType = event.branchExistence.type;

    if (branchType === 'paths') {
      // Branched event: prose should acknowledge multiple possibilities
      const branchIndicators = [
        /\bif\b/i, /\bor\b/i, /\botherwise\b/i, /\balternatively\b/i,
        /\bdepending\b/i, /\bwhether\b/i, /\bperhaps\b/i, /\bmaybe\b/i,
        /\bcould\b/i, /\bmight\b/i,
      ];
      const hasBranchIndicator = branchIndicators.some((pat) => pat.test(prose));
      if (!hasBranchIndicator) {
        issues.push(makeIssue(
          this.name, event.id, event.pov.character, 'warning',
          `Prose for branched event lacks any reference to alternate possibilities (branch type: paths)`,
          'Consider adding conditional language ("if", "or", "perhaps") to reflect the branching nature of this event.',
          'edit_file',
        ));
      }

      // Flag overly absolute language
      const absolutes = [/definitely\b/i, /certainly\b/i, /always\b/i, /never\b/i,
        /without fail\b/i, /no doubt\b/i, /undeniably\b/i, /inescapably\b/i];
      const foundAbsolute = absolutes.find((pat) => pat.test(prose));
      if (foundAbsolute) {
        issues.push(makeIssue(
          this.name, event.id, event.pov.character, 'info',
          `Phrase may be too absolute for a branched event — consider softening to acknowledge alternate paths`,
          'Replace absolute language with conditional phrasing.',
          'edit_file',
        ));
      }
    }

    if (branchType === 'all') {
      // Canonical event: prose should be definite, not conditional
      const conditionalPhrases = [
        /\bif\b.*\bthen\b/i, /\botherwise\b/i, /\balternatively\b/i,
        /\bdepending on\b/i, /\bwhether\b/i,
      ];
      const foundConditional = conditionalPhrases.find((pat) => pat.test(prose));
      if (foundConditional) {
        issues.push(makeIssue(
          this.name, event.id, event.pov.character, 'warning',
          `Canonical (all-branch) prose should not reference alternate possibilities — "${foundConditional.source.slice(1,-2)}" appears conditional`,
          'Rewrite to describe what happens in the canonical timeline without conditionals.',
          'edit_file',
        ));
      }
    }

    // ── Contradictory statement scan ──
    // Look for negated versions of explicitly stated facts in the same prose block
    const sentences = prose.split(/[.?!]\s*/).filter(Boolean);
    const statedFacts: string[] = [];
    for (const sentence of sentences) {
      const s = sentence.toLowerCase();
      // Track simple positive assertions
      const locationMatch = s.match(/\b(\w+)\s+was\s+(at|in|on|by|near)\s+the\s+(\w+)/);
      if (locationMatch) {
        statedFacts.push(`${locationMatch[1]}_location_${locationMatch[3]}`);
      }
    }
    // Check for contradictions across sentences
    for (const sentence of sentences) {
      const s = sentence.toLowerCase();
      for (const fact of statedFacts) {
        const parts = fact.split('_');
        const entity = parts[0];
        if (s.includes(entity) && /\bwasn't|was not|isn't|is not\b/.test(s)) {
          const negativeLoc = s.match(new RegExp(`${entity}\\s+wasn't\\s+(at|in|on)\\s+the\\s+(\\w+)`));
          if (negativeLoc && statedFacts.includes(`${entity}_location_${negativeLoc[2]}`)) {
            issues.push(makeIssue(
              this.name, event.id, event.pov.character, 'error',
              `Conflicting statements about ${entity}'s location in the same prose block`,
              'Ensure the prose does not contain logical contradictions.',
              'edit_file',
            ));
            break;
          }
        }
      }
    }

    return issues;
  }
}
