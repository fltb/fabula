import { expect, it } from 'vitest';
import { parseAnalysisJSONWithErrors } from '../../src/schemas/analysis.ts';
import type { AnalysisResult } from '../../src/types/analysis.ts';
import { makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

function analysis(): AnalysisResult {
  const payload: Record<string, unknown> = {
    postconditions: { covered: [], dropped: [] },
    preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] },
    inventedDetails: [],
    quality: {
      proseScore: 8,
      maxScore: 10,
      strengths: ['clear'],
      weaknesses: [],
      estimatedWordCount: 80,
    },
    threadProgressAchieved: [],
    foreshadowingDeployed: [],
    narrativeChecks: [],
    appearanceChecks: [],
    characterReferences: [],
    tenseDetected: 'past',
    conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
    ruleChecks: [],
    knowledgeChecks: [],
  };
  return {
    eventId: 'E001',
    protocol: makeProtocol('prose'),
    observations: makeObservations(payload, 'prose'),
    analysis: payload,
  };
}

it('should parse analysis correctly', () => {
  const obj = analysis();
  const raw = JSON.stringify(obj);
  console.log('raw analysis JSON:', raw);

  const parseResult = parseAnalysisJSONWithErrors(raw);

  if (parseResult.result) {
    console.log('Parsed successfully:', JSON.stringify(parseResult.result).substring(0, 200));
  } else if (parseResult.zodErrors) {
    console.log('Zod errors:', JSON.stringify(parseResult.zodErrors.issues, null, 2));
  } else if (parseResult.parseError) {
    console.log('Parse error:', parseResult.parseError);
  }

  expect(parseResult.result).not.toBeNull();
});
