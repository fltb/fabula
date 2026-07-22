import { describe, it, expect } from 'vitest';
import { parseAnalysisJSON } from '../../src/schemas/analysis.js';

const validJSON = {
  eventId: 'E1',
  analysis: {
    postconditions: { covered: ['char.status'], dropped: [] },
    preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] },
    inventedDetails: [],
    quality: { proseScore: 8, maxScore: 10, strengths: ['good'], weaknesses: [], estimatedWordCount: 350 },
    threadProgressAchieved: ['thread-1'],
    foreshadowingDeployed: [],
    narrativeChecks: [],
    appearanceChecks: [],
    characterReferences: [],
    tenseDetected: 'past',
    conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
    ruleChecks: [],
    knowledgeChecks: [],
  },
};

const validJSONStr = JSON.stringify(validJSON);

describe('parseAnalysisJSON', () => {
  it('parses valid JSON string', () => {
    const result = parseAnalysisJSON(validJSONStr);
    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('E1');
    expect(result!.analysis.quality.proseScore).toBe(8);
    expect(result!.analysis.postconditions.covered).toEqual(['char.status']);
  });

  it('strips markdown code fences with json tag', () => {
    const fenced = '```json\n' + validJSONStr + '\n```';
    const result = parseAnalysisJSON(fenced);
    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('E1');
  });

  it('strips markdown code fences without tag', () => {
    const fenced = '```\n' + validJSONStr + '\n```';
    const result = parseAnalysisJSON(fenced);
    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('E1');
  });

  it('handles code fences with trailing whitespace', () => {
    const fenced = '```json\n' + validJSONStr + '\n```  \n';
    const result = parseAnalysisJSON(fenced);
    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('E1');
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
    const messy = 'Here is the analysis:\n```json\n' + validJSONStr + '\n```\nHope this helps!';
    const result = parseAnalysisJSON(messy);
    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('E1');
  });
});
