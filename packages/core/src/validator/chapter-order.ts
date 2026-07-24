// ============================================================================
// ChapterOrderValidator — Validate chapter order contested constraints (S3)
// ============================================================================
// Pre-render: if event.modernNovel?.chapterOrder?.orderContested is true,
// verify that renderingVariants has at least 2 entries. Fewer variants
// means the assembler has no meaningful choices to make.
// ============================================================================

import type {
  Validator,
  ValidationIssue,
  PreRenderInput,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class ChapterOrderValidator implements Validator {
  name = 'chapterOrder';
  category = 'narrative_style' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const config = input.event.modernNovel?.chapterOrder;
    if (!config?.orderContested) return issues;

    const variants = config.renderingVariants ?? [];
    if (variants.length < 2) {
      issues.push(
        makeIssue(
          this.name,
          input.event.id,
          input.event.pov.character,
          'warning',
          `Chapter order is contested but only ${variants.length} rendering variant(s) provided. At least 2 variants are required.`,
          'Add additional rendering variants to give the assembler meaningful ordering choices.',
          'change_value',
          'modernNovel.chapterOrder.renderingVariants',
          undefined,
          { orderContested: true, renderingVariants: variants },
        ),
      );
    }
    return issues;
  }

  validatePost(): ValidationIssue[] {
    return [];
  }

  getAnalysisRequirements() {
    return [];
  }
}
