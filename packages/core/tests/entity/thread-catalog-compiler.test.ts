import { describe, expect, it } from 'vitest';
import { compileThreadCatalog } from '../../src/entity/thread-catalog-compiler.js';
import { ConfigError } from '../../src/errors.js';
import type { ThreadDeclaration, ThreadTypeCatalog } from '../../src/types/thread.js';

const typeCatalog: ThreadTypeCatalog = {
  types: {
    arc: {
      typeId: 'arc',
      description: 'Character arc',
      allowedPhases: ['setup', 'resolution'],
      lifecyclePolicy: { reopenPolicy: 'allowed' },
      timeDomain: 'story',
      stableGoals: [{ goalId: 'resolve', status: 'pending' }],
      stableMilestones: [{ milestoneId: 'turn', status: 'pending' }],
    },
  },
};

const declaration = (overrides: Partial<ThreadDeclaration> = {}): ThreadDeclaration => ({
  threadId: 'T1',
  name: 'Arc',
  description: 'A thread',
  typeId: 'arc',
  ...overrides,
});

describe('compileThreadCatalog', () => {
  it('accepts canonical declarations and preserves retained metadata', () => {
    const result = compileThreadCatalog(typeCatalog, [
      declaration({
        initialPhase: 'setup',
        initialGoalStates: [{ goalId: 'resolve', status: 'active' }],
        initialMilestoneStates: [{ milestoneId: 'turn', status: 'pending' }],
        targetRevealChapter: 2,
        initialProgress: '0.25',
        structuralFunction: 'mediation',
      }),
    ]);

    expect(result.declarations[0]).toMatchObject({
      threadId: 'T1',
      targetRevealChapter: 2,
      initialProgress: '0.25',
      structuralFunction: 'mediation',
    });
  });

  it('rejects type map key and internal typeId mismatches', () => {
    expect(() =>
      compileThreadCatalog(
        {
          types: { arc: { ...typeCatalog.types.arc, typeId: 'other' } },
        },
        [],
      ),
    ).toThrow(ConfigError);
  });

  it('rejects duplicate declaration, phase, goal, and milestone IDs', () => {
    expect(() => compileThreadCatalog(typeCatalog, [declaration(), declaration()])).toThrow(
      /Duplicate thread declaration id/,
    );
    expect(() =>
      compileThreadCatalog(
        {
          types: { arc: { ...typeCatalog.types.arc, allowedPhases: ['setup', 'setup'] } },
        },
        [],
      ),
    ).toThrow(/Duplicate phase id/);
    expect(() =>
      compileThreadCatalog(
        {
          types: {
            arc: {
              ...typeCatalog.types.arc,
              stableGoals: [
                { goalId: 'resolve', status: 'pending' },
                { goalId: 'resolve', status: 'active' },
              ],
            },
          },
        },
        [],
      ),
    ).toThrow(/Duplicate goal id/);
    expect(() =>
      compileThreadCatalog(
        {
          types: {
            arc: {
              ...typeCatalog.types.arc,
              stableMilestones: [
                { milestoneId: 'turn', status: 'pending' },
                { milestoneId: 'turn', status: 'achieved' },
              ],
            },
          },
        },
        [],
      ),
    ).toThrow(/Duplicate milestone id/);
  });

  it('rejects unknown type, phase, goal, and milestone references', () => {
    expect(() => compileThreadCatalog(typeCatalog, [declaration({ typeId: 'missing' })])).toThrow(
      /unknown thread type/,
    );
    expect(() =>
      compileThreadCatalog(typeCatalog, [declaration({ initialPhase: 'missing' })]),
    ).toThrow(/unknown initial phase/);
    expect(() =>
      compileThreadCatalog(typeCatalog, [
        declaration({ initialGoalStates: [{ goalId: 'missing', status: 'active' }] }),
      ]),
    ).toThrow(/unknown goal/);
    expect(() =>
      compileThreadCatalog(typeCatalog, [
        declaration({ initialMilestoneStates: [{ milestoneId: 'missing', status: 'achieved' }] }),
      ]),
    ).toThrow(/unknown milestone/);
  });
});
