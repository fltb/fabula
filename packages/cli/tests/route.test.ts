import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../src/route.ts';

describe('resolveRoute', () => {
  it('omits absent route fields', () => {
    expect(resolveRoute({})).toEqual({});
  });

  it('preserves branch and discourse routing without CLI entry imports', () => {
    const branchPath = { decisions: [{ atEventId: 'E1', choiceId: 'left', narrativeOrder: 1 }] };
    expect(resolveRoute({ branchPath, discourseBranch: 'alternate' })).toEqual({
      branchPath,
      discourseBranch: 'alternate',
    });
  });
});
