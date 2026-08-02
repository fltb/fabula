import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AnalysisResult } from '../../src/types/analysis.ts';
import { ResultAggregator } from '../../src/validator/index.ts';
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
    checklistResults: [],
  };
  return {
    eventId: 'E001',
    protocol: makeProtocol('prose'),
    observations: makeObservations(payload, 'prose'),
    analysis: payload,
  };
}

it('should pass combined schema', () => {
  const aggregator = new ResultAggregator();
  const combinedSchema = aggregator.getCombinedValidationSchema();

  console.log('Combined schema keys:', Object.keys(combinedSchema.shape));

  const ac = aggregator.getAnalysisContract({});
  console.log(
    'Analysis contract field requirements:',
    ac.requirements.map((r) => r.field).join(', '),
  );

  const obj = analysis();
  const raw = JSON.stringify(obj);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    expect.fail('JSON parse failed');
    return;
  }

  // parseAnalysisJSONWithErrors wraps as z.object({ eventId: z.string(), analysis: combinedSchema })
  const outer = z.object({ eventId: z.string(), analysis: combinedSchema });
  const outerResult = outer.safeParse(parsed);

  if (!outerResult.success) {
    console.log('Zod errors:', JSON.stringify(outerResult.error.issues, null, 2));
  } else {
    console.log('Success!');
  }

  expect(outerResult.success).toBe(true);
});
