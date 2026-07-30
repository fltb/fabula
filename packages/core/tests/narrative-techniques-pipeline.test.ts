import { describe, expect, it } from 'vitest';
import { EntityMapper } from '../src/entity/mapper.ts';
import { eventFileSchema } from '../src/schemas/event.ts';
import { MemoryStorage } from '../src/storage/memory-storage.ts';
import type { EventFile } from '../src/types/event.ts';

function makeTechniqueEvent(): Record<string, unknown> {
  return {
    event: 'E0',
    narrativeOrder: 1,
    title: 'Technique contract',
    storyTime: 'day_1',
    pov: { character: 'narrator', type: 'omniscient' },
    sceneBrief: 'A scene with every direct narrative technique contract.',
    preconditions: [],
    expectedPostconditions: [],
    causalDiscontinuity: {
      predecessor: 'E0',
      dependent: 'E1',
      instruction: 'Keep the missing causal link visible.',
      requiredEvidence: 'The consequence remains unexplained.',
    },
    surfaceMode: {
      instruction: '  Describe only observable action.  ',
      requiredEvidence: 'The door closes without commentary.',
    },
    causalMultiplicity: {
      minimumOutgoingEdges: 2,
      instruction: 'Preserve both causal consequences.',
      requiredEvidence: 'Two consequences diverge.',
    },
    irresolvableIndeterminacy: {
      assertionIds: ['assertion:unknown'],
      instruction: 'Keep the claim unresolved.',
      requiredEvidence: 'No account settles the claim.',
    },
    absentApparatus: {
      readId: 'read:missing_witness',
      instruction: 'Treat absence as active.',
      requiredEvidence: 'The witness never appears.',
    },
    voiceDissonance: {
      assertionId: 'assertion:catastrophe',
      storyOutputId: 'output:catastrophe',
      instruction: 'Make the narrator dissonant.',
      requiredEvidence: 'The narrator calls the disaster delightful.',
    },
    multiplicity: {
      assertionIds: ['assertion:account-a', 'assertion:account-b'],
      instruction: 'Preserve both accounts.',
      requiredEvidence: 'Both accounts remain possible.',
    },
    metanarrativeLevel: {
      instruction: 'Expose the act of narration.',
      requiredEvidence: 'The narrator revises this sentence.',
    },
  };
}

describe('narrative technique event contracts', () => {
  it('parses strict direct contracts and maps all eight contracts through EntityMapper', () => {
    const parsed = eventFileSchema.parse(makeTechniqueEvent()) as EventFile;
    const mapper = new EntityMapper('/unused', new MemoryStorage());
    const event = mapper.mapToNarrativeEvent(parsed);

    expect(parsed.surfaceMode?.instruction).toBe('Describe only observable action.');
    expect(event.causalDiscontinuity).toEqual(parsed.causalDiscontinuity);
    expect(event.surfaceMode).toEqual(parsed.surfaceMode);
    expect(event.causalMultiplicity).toEqual(parsed.causalMultiplicity);
    expect(event.irresolvableIndeterminacy).toEqual(parsed.irresolvableIndeterminacy);
    expect(event.absentApparatus).toEqual(parsed.absentApparatus);
    expect(event.voiceDissonance).toEqual(parsed.voiceDissonance);
    expect(event.multiplicity).toEqual(parsed.multiplicity);
    expect(event.metanarrativeLevel).toEqual(parsed.metanarrativeLevel);
  });

  it.each([
    ['modernNovel', { surfaceMode: { enabled: true } }],
    ['antiCausalEdge', { enabled: true }],
    ['causalOverload', { enabled: true }],
    ['chapterOrder', { orderContested: true }],
  ])('rejects legacy key %s', (key, value) => {
    expect(eventFileSchema.safeParse({ ...makeTechniqueEvent(), [key]: value }).success).toBe(false);
  });

  it.each([
    ['enabled', { ...makeTechniqueEvent(), surfaceMode: { enabled: true } }],
    ['orderContested', { ...makeTechniqueEvent(), surfaceMode: { orderContested: true } }],
    [
      'blank instruction',
      {
        ...makeTechniqueEvent(),
        surfaceMode: { instruction: '   ', requiredEvidence: 'Visible proof.' },
      },
    ],
    [
      'blank evidence',
      {
        ...makeTechniqueEvent(),
        metanarrativeLevel: { instruction: 'Expose narration.', requiredEvidence: ' ' },
      },
    ],
    [
      'duplicate assertion ids',
      {
        ...makeTechniqueEvent(),
        multiplicity: {
          assertionIds: ['assertion:same', 'assertion:same'],
          instruction: 'Preserve both accounts.',
          requiredEvidence: 'Both accounts remain possible.',
        },
      },
    ],
  ])('rejects %s', (_description, invalidEvent) => {
    expect(eventFileSchema.safeParse(invalidEvent).success).toBe(false);
  });
});
