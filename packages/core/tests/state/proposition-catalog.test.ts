// ============================================================================
// PropositionCatalog — Tests for PropositionCatalog construction and validation
// ============================================================================

import { describe, expect, it } from 'vitest';
import { propositionCatalogSchema } from '../../src/schemas/knowledge.js';
import { validatePropositionCatalog } from '../../src/state/knowledge-replay.js';
import type { PropositionCatalog } from '../../src/types/index.js';

describe('PropositionCatalog', () => {
  it('accepts empty catalog', () => {
    const catalog: PropositionCatalog = {
      version: 1,
      propositions: {},
      dependencyGraph: {},
    };
    expect(() => validatePropositionCatalog(catalog)).not.toThrow();
  });

  it('accepts single grounded proposition', () => {
    const catalog: PropositionCatalog = {
      version: 1,
      propositions: {
        p1: {
          kind: 'grounded',
          id: 'p1',
          entityId: 'hero',
          attribute: 'alive',
          value: true,
        },
      },
      dependencyGraph: {
        p1: [],
      },
    };
    expect(() => validatePropositionCatalog(catalog)).not.toThrow();
  });

  it('accepts valid epistemic dependency chain', () => {
    const catalog: PropositionCatalog = {
      version: 1,
      propositions: {
        p1: {
          kind: 'grounded',
          id: 'p1',
          entityId: 'ring',
          attribute: 'location',
          value: 'mordor',
        },
        p2: {
          kind: 'epistemic',
          id: 'p2',
          subject: 'frodo',
          propositionId: 'p1',
          attitude: 'knows',
        },
        p3: {
          kind: 'epistemic',
          id: 'p3',
          subject: 'gollum',
          propositionId: 'p2',
          attitude: 'believes',
        },
      },
      dependencyGraph: {
        p1: [],
        p2: ['p1'],
        p3: ['p2'],
      },
    };
    expect(() => validatePropositionCatalog(catalog)).not.toThrow();
  });

  it('rejects self-referencing proposition', () => {
    const catalog: PropositionCatalog = {
      version: 1,
      propositions: {
        p1: { kind: 'grounded', id: 'p1', entityId: 'x', attribute: 'y', value: 'z' },
      },
      dependencyGraph: {
        p1: ['p1'],
      },
    };
    expect(() => validatePropositionCatalog(catalog)).toThrow(/references itself/);
  });

  it('rejects missing dependency', () => {
    const catalog: PropositionCatalog = {
      version: 1,
      propositions: {
        p1: { kind: 'grounded', id: 'p1', entityId: 'x', attribute: 'y', value: 'z' },
      },
      dependencyGraph: {
        p1: ['nonexistent'],
      },
    };
    expect(() => validatePropositionCatalog(catalog)).toThrow(/not in the catalog/);
  });

  it('rejects cycles in dependency graph', () => {
    const catalog: PropositionCatalog = {
      version: 1,
      propositions: {
        p1: { kind: 'grounded', id: 'p1', entityId: 'x', attribute: 'y', value: 'a' },
        p2: { kind: 'grounded', id: 'p2', entityId: 'x', attribute: 'y', value: 'b' },
      },
      dependencyGraph: {
        p1: ['p2'],
        p2: ['p1'],
      },
    };
    expect(() => validatePropositionCatalog(catalog)).toThrow(/Cycle detected/);
  });

  it('accepts intensional proposition (opaque, no deps)', () => {
    const catalog: PropositionCatalog = {
      version: 1,
      propositions: {
        p1: {
          kind: 'intensional',
          id: 'p1',
          content: 'The hero will return when most needed',
          domain: 'prophecy',
        },
      },
      dependencyGraph: {
        p1: [],
      },
    };
    expect(() => validatePropositionCatalog(catalog)).not.toThrow();
  });

  it('accepts act proposition', () => {
    const catalog: PropositionCatalog = {
      version: 1,
      propositions: {
        p_ring: {
          kind: 'grounded',
          id: 'p_ring',
          entityId: 'ring',
          attribute: 'location',
          value: 'mordor',
        },
        p1: {
          kind: 'act',
          id: 'p1',
          actType: 'testimony',
          actor: 'gandalf',
          recipients: ['frodo'],
          contentPropositions: ['p_ring'],
        },
      },
      dependencyGraph: { p1: ['p_ring'], p_ring: [] },
    };
    expect(() => validatePropositionCatalog(catalog)).not.toThrow();
  });

  it('catalog version is a literal 1 (source contract)', () => {
    const v1: PropositionCatalog = { version: 1, propositions: {}, dependencyGraph: {} };
    expect(v1.version).toBe(1);
    expect(
      propositionCatalogSchema.safeParse({ version: 2, propositions: {}, dependencyGraph: {} })
        .success,
    ).toBe(false);
  });
});
