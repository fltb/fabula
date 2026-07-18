// ============================================================================
// QualityValidator — Self-assessment of prose quality from Pass 2 analysis
// ============================================================================

import type {
  PostRenderInput,
  PreRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class QualityValidator implements Validator {
  name = 'quality';
  category = 'prose_quality' as const;

  validatePre(_input: PreRenderInput): ValidationIssue[] {
    return [];
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const q = input.analysis.analysis.quality;
    if (q.proseScore < 4) {
      issues.push(makeIssue(
        'quality', input.event.id, 'system', 'warning',
        `Low prose quality: score ${q.proseScore}/${q.maxScore}. Weaknesses: ${q.weaknesses.join('; ')}`,
        'Consider rewriting this scene for higher quality.',
        'manual',
      ));
    }
    if (q.estimatedWordCount < 100) {
      issues.push(makeIssue(
        'quality', input.event.id, 'system', 'info',
        `Short scene: ${q.estimatedWordCount} words. Consider expanding.`,
        'Add more descriptive detail or action.',
        'manual',
      ));
    }
    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'quality',
      schemaExample: {
        proseScore: 0,
        maxScore: 10,
        strengths: ['specific strength'],
        weaknesses: ['specific weakness'],
        estimatedWordCount: 0,
      },
      instruction: 'quality: Self-assess the prose quality on a 0-10 scale. List specific strengths and weaknesses of the writing. Estimate the word count. Be honest and critical.',
    }];
  }
}
