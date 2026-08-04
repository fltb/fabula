import { describe, expect, it } from 'vitest';
import { parseAnalysisJSON, parseAnalysisJSONWithErrors } from '../../src/schemas/analysis.js';
import type { ValidationKey } from '../../src/types/discourse.js';
import { makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

const ANALYSIS_PAYLOAD: Record<string, unknown> = {
  postconditions: { covered: ['char.status'], dropped: [] },
  preconditions: { violated: [] },
  pov: { consistent: true, leaks: [] },
  inventedDetails: [],
  quality: {
    proseScore: 8,
    maxScore: 10,
    strengths: ['good'],
    weaknesses: [],
    estimatedWordCount: 350,
  },
  threadProgressAchieved: ['thread-1'],
  foreshadowingDeployed: [],
  narrativeChecks: [],
  appearanceChecks: [],
  characterReferences: [],
  tenseDetected: 'past',
  conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
  ruleChecks: [],
  knowledgeChecks: [],
};

const validJSON = {
  eventId: 'E1',
  protocol: makeProtocol('prose'),
  observations: makeObservations(ANALYSIS_PAYLOAD, 'prose'),
  analysis: ANALYSIS_PAYLOAD,
};

const validJSONStr = JSON.stringify(validJSON);

describe('parseAnalysisJSON', () => {
  it('parses valid JSON string', () => {
    const result = parseAnalysisJSON(validJSONStr);
    expect(result).not.toBeNull();
    expect(result?.eventId).toBe('E1');
    expect(result?.analysis.quality.proseScore).toBe(8);
    expect(result?.analysis.postconditions.covered).toEqual(['char.status']);
  });

  it('strips markdown code fences with json tag', () => {
    const fenced = `\`\`\`json\n${validJSONStr}\n\`\`\``;
    const result = parseAnalysisJSON(fenced);
    expect(result).not.toBeNull();
    expect(result?.eventId).toBe('E1');
  });

  it('strips markdown code fences without tag', () => {
    const fenced = `\`\`\`\n${validJSONStr}\n\`\`\``;
    const result = parseAnalysisJSON(fenced);
    expect(result).not.toBeNull();
    expect(result?.eventId).toBe('E1');
  });

  it('handles code fences with trailing whitespace', () => {
    const fenced = `\`\`\`json\n${validJSONStr}\n\`\`\`  \n`;
    const result = parseAnalysisJSON(fenced);
    expect(result).not.toBeNull();
    expect(result?.eventId).toBe('E1');
  });

  it('returns null for invalid JSON', () => {
    const result = parseAnalysisJSON('not json at all');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = parseAnalysisJSON('');
    expect(result).toBeNull();
  });

  it('returns null for JSON that fails schema validation', () => {
    const result = parseAnalysisJSON('{"eventId": "E1"}'); // missing analysis
    expect(result).toBeNull();
  });

  it('calls warn callback on invalid input', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    parseAnalysisJSON('not json', warn);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('invalid JSON');
  });

  it('calls warn callback on schema validation failure', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    parseAnalysisJSON('{"eventId": "E1"}', warn);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('validation failed');
  });

  it('handles LLM output with extra text before/after code fence', () => {
    const messy = `Here is the analysis:\n\`\`\`json\n${validJSONStr}\n\`\`\`\nHope this helps!`;
    const result = parseAnalysisJSON(messy);
    expect(result).not.toBeNull();
    expect(result?.eventId).toBe('E1');
  });
});

describe('exact-quote evidence validation', () => {
  const PROSE =
    'The old year was ending, and snow fell over the town of Luzhen. ' +
    'I had returned to my hometown for the New Year.';

  function resultWithEvidence(evidence: string[]) {
    const protocol = makeProtocol(PROSE);
    return JSON.stringify({
      eventId: 'E1',
      protocol,
      observations: {
        ...makeObservations(ANALYSIS_PAYLOAD, PROSE),
        pov: { disposition: 'produced', evidence },
      },
      analysis: ANALYSIS_PAYLOAD,
    });
  }

  it('accepts evidence quotes that are exact substrings of the prose', () => {
    const result = parseAnalysisJSON(
      resultWithEvidence(['The old year was ending']),
      undefined,
      null,
      PROSE,
    );
    expect(result).not.toBeNull();
  });

  it('rejects a paraphrased evidence quote when prose is provided', () => {
    const result = parseAnalysisJSON(
      resultWithEvidence(['The year came to a close']),
      undefined,
      null,
      PROSE,
    );
    expect(result).toBeNull();
  });

  it('rejects a quote with an ellipsis abbreviation (not a verbatim substring)', () => {
    const result = parseAnalysisJSON(
      resultWithEvidence(['The old year ... over the town']),
      undefined,
      null,
      PROSE,
    );
    expect(result).toBeNull();
  });

  it('skips the exact-quote check when the parser has no prose', () => {
    const result = parseAnalysisJSON(
      resultWithEvidence(['The year came to a close']),
      undefined,
      null,
      null,
    );
    expect(result).not.toBeNull();
  });

  it('reports the offending quote in the validation errors', () => {
    const parsed = parseAnalysisJSONWithErrors(
      resultWithEvidence(['The year came to a close']),
      undefined,
      null,
      PROSE,
    );
    expect(parsed.result).toBeNull();
    const messages = (parsed.zodErrors?.issues ?? []).map((i) => i.message).join('\n');
    expect(messages).toContain('not an exact substring');
  });
});

describe('expected protocol fail-closed matching', () => {
  const PROSE = 'Snow covered the town of Luzhen.';

  function resultWithProtocol(protocol: ValidationKey) {
    return JSON.stringify({
      eventId: 'E1',
      protocol,
      observations: makeObservations(ANALYSIS_PAYLOAD, PROSE),
      analysis: ANALYSIS_PAYLOAD,
    });
  }

  it('accepts a response echoing the exact expected protocol', () => {
    const expected = makeProtocol(PROSE);
    const result = parseAnalysisJSON(resultWithProtocol(expected), undefined, expected, PROSE);
    expect(result).not.toBeNull();
    expect(result?.protocol).toEqual(expected);
  });

  it.each([
    'proseHash',
    'analysisSchema',
    'model',
    'provider',
    'analysisPromptHash',
    'samplingConfigHash',
    'validatorPolicy',
    'referencePolicy',
  ] as const)('rejects a response echoing a tampered "%s"', (field) => {
    const expected = makeProtocol(PROSE);
    const tampered: ValidationKey = { ...expected, [field]: `tampered-${field}` };
    const result = parseAnalysisJSON(resultWithProtocol(tampered), undefined, expected, PROSE);
    expect(result).toBeNull();
  });

  it('rejects a response echoing an extra protocol field', () => {
    const expected = makeProtocol(PROSE);
    const withExtra: ValidationKey = { ...expected, extraField: 'x' } as unknown as ValidationKey;
    const result = parseAnalysisJSON(resultWithProtocol(withExtra), undefined, expected, PROSE);
    expect(result).toBeNull();
  });

  it('rejects a response echoing a missing protocol field', () => {
    const expected = makeProtocol(PROSE);
    const { model: _dropped, ...withoutModel } = expected;
    const incomplete: ValidationKey = withoutModel as unknown as ValidationKey;
    const result = parseAnalysisJSON(resultWithProtocol(incomplete), undefined, expected, PROSE);
    expect(result).toBeNull();
  });

  it('does not enforce protocol equality when no expected protocol is provided', () => {
    const result = parseAnalysisJSON(
      resultWithProtocol(makeProtocol(PROSE)),
      undefined,
      null,
      PROSE,
    );
    expect(result).not.toBeNull();
  });
});
