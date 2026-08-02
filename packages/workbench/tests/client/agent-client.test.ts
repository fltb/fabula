import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentClientError,
  BROWSER_AGENT_APPLY_PATH,
  BROWSER_AGENT_PROPOSAL_PATH,
  createAgentClient,
} from '../../src/client/agent-client';

const context = {
  version: 1 as const,
  projectId: 'project-a',
  documentId: 'doc-a',
  selection: { from: 4, to: 18 },
  baseVector: 'vector-digest-a',
};

const proposal = {
  version: 1 as const,
  suggestionId: 'suggestion-a',
  projectId: 'project-a',
  documentId: 'doc-a',
  baseVector: 'vector-digest-a',
  selection: context.selection,
  changes: [{ from: 4, length: 3, text: 'new' }],
};

afterEach(() => vi.restoreAllMocks());

describe('Agent browser client', () => {
  it('sends only versioned editor identity and instruction to the guarded Host', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ status: 'proposed', proposal }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createAgentClient({
      fetch,
      getSessionId: () => 'session-only-for-request',
    });

    const result = await client.propose({
      version: 1,
      context,
      instruction: 'Tighten this sentence.',
    });

    expect(result.status).toBe('proposed');
    expect(fetch).toHaveBeenCalledWith(
      BROWSER_AGENT_PROPOSAL_PATH.replace(':projectId', 'project-a'),
      expect.objectContaining({ method: 'POST' }),
    );
    const [, init] = fetch.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      version: 1,
      context,
      instruction: 'Tighten this sentence.',
    });
    expect(body).not.toHaveProperty('documentText');
    expect(body).not.toHaveProperty('capabilityId');
    expect(body).not.toHaveProperty('provider');
  });

  it('uses the explicit apply endpoint and never applies during proposal generation', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'proposed', proposal }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'applied', suggestionId: 'suggestion-a' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const client = createAgentClient({ fetch });

    await client.propose({ version: 1, context, instruction: 'Rewrite.' });
    expect(fetch).toHaveBeenCalledTimes(1);

    await client.applyProposal({ version: 1, context, proposal });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe(
      BROWSER_AGENT_APPLY_PATH.replace(':projectId', 'project-a').replace(
        ':suggestionId',
        'suggestion-a',
      ),
    );
  });

  it('redacts arbitrary Host/provider detail from transport errors', async () => {
    const secret = 'sk-provider-secret-should-not-render';
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({ error: { code: 'PROVIDER_TIMEOUT', message: `${secret} details` } }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createAgentClient({ fetch });

    await expect(client.propose({ version: 1, context, instruction: 'Rewrite.' })).rejects.toEqual(
      expect.objectContaining({ code: 'PROVIDER_TIMEOUT' }),
    );
    try {
      await client.propose({ version: 1, context, instruction: 'Rewrite.' });
    } catch (error) {
      expect(error).toBeInstanceOf(AgentClientError);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('normalizes paused and stale responses as non-success outcomes', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'paused', reason: 'human-editing' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'stale', reason: 'stale-vector' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const client = createAgentClient({ fetch });

    await expect(client.propose({ version: 1, context, instruction: 'Rewrite.' })).resolves.toMatchObject({
      status: 'paused',
      replanRequired: true,
    });
    await expect(client.propose({ version: 1, context, instruction: 'Rewrite.' })).resolves.toMatchObject({
      status: 'stale',
      replanRequired: true,
    });
  });
});
