import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompletionRequest } from '@novalistically/core';
import { analysisResultSchema, buildAnalysisResultSchema } from '@novalistically/core/schema';
import { describe, expect, it } from 'vitest';
import {
  createDeterministicMockProvider,
  DeterministicMockProvider,
} from '../src/providers/deterministic-mock.ts';
import { withTempProject } from './cache-fixtures.js';

/** Schema-valid measurement protocol block the pipeline embeds in Pass 2. */
const PROTOCOL = {
  proseHash: 'prose-hash',
  analysisSchema: 'builtin',
  model: 'deterministic-mock',
  provider: 'deterministic-mock',
  analysisPromptHash: 'prompt-hash',
  samplingConfigHash: 'sampling-hash',
  validatorPolicy: 'validator-policy',
  referencePolicy: 'reference-policy',
};

/** Pass 1-shaped request (no seed / no json_object hint). */
function pass1Request(eventId: string, prose?: string): CompletionRequest {
  return {
    messages: [
      { role: 'system', content: 'You are a narrative prose writer.' },
      {
        role: 'user',
        content: [
          '## Narrative Context Package',
          '```json',
          JSON.stringify({ eventId, sceneSpec: { id: eventId, sceneBrief: 'b' } }, null, 2),
          '```',
          '## Output',
          'Begin with the scene.',
          ...(prose === undefined ? [] : ['', '## Rendered Prose', '```', prose, '```']),
        ].join('\n'),
      },
    ],
    taskType: 'pass1',
  };
}

/** Pass 2-shaped request mirroring buildAnalysisPrompt's message layout. */
function pass2Request(eventId: string, prose: string): CompletionRequest {
  return {
    messages: [
      { role: 'system', content: 'You are a literary editor.' },
      {
        role: 'user',
        content: [
          '## Scene Specification',
          '```json',
          JSON.stringify({ id: eventId, title: 't', sceneType: 's', sceneBrief: 'b' }, null, 2),
          '```',
          '## Rendered Prose',
          '```',
          prose,
          '```',
          '## Instructions',
          '```json',
          JSON.stringify(
            {
              eventId,
              protocol: { ...PROTOCOL },
              observations: { quality: { disposition: 'produced', evidence: ['quote'] } },
              analysis: { quality: { proseScore: 4, maxScore: 5, strengths: [], weaknesses: [] } },
            },
            null,
            2,
          ),
          '```',
          '## Measurement Protocol',
          '```json',
          JSON.stringify(PROTOCOL),
          '```',
        ].join('\n'),
      },
    ],
    taskType: 'pass2',
    seed: 42,
    responseFormat: { type: 'json_object' },
  };
}

describe('DeterministicMockProvider', () => {
  it('resolves a Pass 2 entry from a reference dir and echoes the request protocol', async () => {
    await withTempProject(async (root) => {
      const references = join(root, 'references');
      await mkdir(references);
      const fixture = { prose: 'fixture prose E1', analysis: { eventId: 'E1' } };
      await writeFile(join(references, 'E1.json'), JSON.stringify(fixture));

      const provider = createDeterministicMockProvider({ referenceDirs: [references] });
      const response = await provider.complete(pass2Request('E1', fixture.prose));
      expect(JSON.parse(response.content)).toEqual({ ...fixture.analysis, protocol: PROTOCOL });
    });
  });

  it('looks up reference dirs in order and prefers explicit entries', async () => {
    await withTempProject(async (root) => {
      const dirA = join(root, 'a');
      const dirB = join(root, 'b');
      await mkdir(dirA);
      await mkdir(dirB);
      // E1 only in the second dir; E2 in both — the first dir must win.
      await writeFile(
        join(dirB, 'E1.json'),
        JSON.stringify({ prose: 'b-prose', analysis: { eventId: 'E1', from: 'b' } }),
      );
      await writeFile(
        join(dirA, 'E2.json'),
        JSON.stringify({ prose: 'a-prose', analysis: { eventId: 'E2', from: 'a' } }),
      );
      await writeFile(
        join(dirB, 'E2.json'),
        JSON.stringify({ prose: 'b-prose', analysis: { eventId: 'E2', from: 'b' } }),
      );

      const provider = createDeterministicMockProvider({ referenceDirs: [dirA, dirB] });
      const e1 = await provider.complete(pass2Request('E1', 'b-prose'));
      expect((JSON.parse(e1.content) as { from: string }).from).toBe('b');
      const e2 = await provider.complete(pass2Request('E2', 'a-prose'));
      expect((JSON.parse(e2.content) as { from: string }).from).toBe('a');

      // Explicit entries override reference-dir entries.
      const overridden = createDeterministicMockProvider({
        referenceDirs: [dirA],
        entries: { E2: { prose: 'override-prose', analysis: { eventId: 'E2', from: 'override' } } },
      });
      const e2b = await overridden.complete(pass2Request('E2', 'override-prose'));
      expect((JSON.parse(e2b.content) as { from: string }).from).toBe('override');
    });
  });

  it('generates a schema-valid Pass 2 analysis for ANY eventId without a reference entry', async () => {
    await withTempProject(async (root) => {
      // A missing reference dir must not crash: generated fallback only.
      const provider = createDeterministicMockProvider({
        referenceDirs: [join(root, 'does-not-exist')],
      });
      const eventId = 'Z9';
      const proseResponse = await provider.complete(pass1Request(eventId));
      expect(proseResponse.content.trim().length).toBeGreaterThan(0);
      const prose = proseResponse.content;

      const analysisResponse = await provider.complete(pass2Request(eventId, prose));
      const parsed: unknown = JSON.parse(analysisResponse.content);

      // The exact parser/validator the pipeline uses, with the request's
      // expected protocol (fail-closed) and the actual rendered prose
      // (exact-quote evidence checks).
      const schema = buildAnalysisResultSchema({
        expectedProtocol: PROTOCOL,
        prose,
      });
      const result = schema.safeParse(parsed);
      expect(result.success, result.success ? undefined : result.error.message).toBe(true);
      expect((result.data as { eventId: string }).eventId).toBe(eventId);

      // Static contract shape (no protocol comparison / prose checks).
      expect(analysisResultSchema.safeParse(parsed).success).toBe(true);

      // The generated envelope pairs every produced payload field with one
      // observation, plus the abstained conflict measurement (which carries
      // no canonical payload — the pairing refinement requires that).
      const envelope = parsed as {
        observations: Record<string, { disposition: string }>;
        analysis: Record<string, unknown>;
      };
      expect(Object.keys(envelope.observations)).toEqual([
        ...Object.keys(envelope.analysis),
        'conflictAnalysis',
      ]);
      expect(envelope.observations.conflictAnalysis?.disposition).toBe('abstained');
      expect('conflictAnalysis' in envelope.analysis).toBe(false);
    });
  });

  it('returns deterministic non-empty prose for Pass 1 requests', async () => {
    const provider = new DeterministicMockProvider();
    const first = await provider.complete(pass1Request('E5'));
    const second = await provider.complete(pass1Request('E5'));
    expect(first.content).toBe(second.content);
    expect(first.content.trim().length).toBeGreaterThan(0);
    expect(first.content).toContain('E5');
    expect(first.finishReason).toBe('stop');
  });
});
