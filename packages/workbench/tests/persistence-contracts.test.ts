import { describe, expect, it } from 'vitest';
import { PersistenceClient } from '../src/persistence/client.js';
import { persistenceSchema } from '../src/persistence/schema.js';

type Message = { correlationId: string; operation: string; payload: unknown };
type Response = { correlationId: string; ok: true; operation: string; result: unknown };
type Listener = (event: { data: Response }) => void;
function portPair() {
  let listener: Listener | undefined;
  return {
    client: {
      postMessage(message: Message) {
        queueMicrotask(() =>
          listener?.({
            data: {
              correlationId: message.correlationId,
              ok: true,
              operation: message.operation,
              result: message.payload,
            },
          }),
        );
      },
      addEventListener(_type: 'message', next: Listener) {
        listener = next;
      },
    },
  };
}
describe('persistence contracts', () => {
  it('correlates domain messages', async () => {
    const pair = portPair();
    const client = new PersistenceClient(pair.client);
    await expect(client.request('getProject', { projectId: 'p' })).resolves.toEqual({
      projectId: 'p',
    });
  });
  it('serializes deterministic failures and aborts before task boundary', async () => {
    const pair = portPair();
    const client = new PersistenceClient(pair.client);
    const controller = new AbortController();
    const request = client.request('getProject', { projectId: 'p' }, controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: 'ABORTED', retryable: false });
  });
  it('describes migrations as values and exposes no generic query', () => {
    expect(persistenceSchema[0]?.tables.map((table) => table.name)).toContain('projects');
    expect((PersistenceClient.prototype as Record<string, unknown>).query).toBeUndefined();
  });
  it('declares the project_operations migration with its composite key and indexes', () => {
    const v5 = persistenceSchema.find((migration) => migration.version === 5);
    if (!v5) throw new Error('V5 migration missing from persistence schema');
    const steps = v5.steps ?? [];
    const tableStep = steps.find((step) => step.kind === 'create-table');
    if (tableStep?.kind !== 'create-table') throw new Error('V5 is missing its create-table step');
    expect(tableStep.table.name).toBe('project_operations');
    expect(tableStep.table.primaryKey).toEqual(['project_id', 'operation_id']);
    const indexSteps = steps.filter(
      (step): step is Extract<(typeof steps)[number], { kind: 'create-index' }> =>
        step.kind === 'create-index',
    );
    expect(indexSteps.map((step) => step.name)).toEqual([
      'project_operations_status_updated',
      'project_operations_idempotency',
    ]);
    expect(indexSteps.find((step) => step.name === 'project_operations_idempotency')?.unique).toBe(
      true,
    );
  });
  it('declares the project_publications migration with its composite key and updated index', () => {
    const v6 = persistenceSchema.find((migration) => migration.version === 6);
    expect(v6).toBeDefined();
    const steps = v6?.steps ?? [];
    const tableStep = steps.find((step) => step.kind === 'create-table');
    if (tableStep?.kind !== 'create-table') throw new Error('V6 is missing its create-table step');
    expect(tableStep.table.name).toBe('project_publications');
    expect(tableStep.table.primaryKey).toEqual(['project_id', 'publication_id']);
    expect(
      tableStep.table.columns.some(
        (column) => column.name === 'kind' && column.values?.length === 2,
      ),
    ).toBe(true);
    const indexSteps = steps.filter(
      (step): step is Extract<(typeof steps)[number], { kind: 'create-index' }> =>
        step.kind === 'create-index',
    );
    expect(indexSteps.map((step) => step.name)).toEqual(['project_publications_updated']);
  });
  it('declares the agent migrations (v7) with three tables and the required indexes', () => {
    const latest = persistenceSchema.find((migration) => migration.version === 7);
    expect(latest?.version).toBe(7);
    const steps = latest?.steps ?? [];
    const tableNames = steps
      .filter(
        (step): step is Extract<(typeof steps)[number], { kind: 'create-table' }> =>
          step.kind === 'create-table',
      )
      .map((step) => step.table.name);
    expect(tableNames).toEqual(['agent_conversations', 'agent_runs', 'agent_tool_calls']);
    const conversations = steps.find(
      (step): step is Extract<(typeof steps)[number], { kind: 'create-table' }> =>
        step.kind === 'create-table' && step.table.name === 'agent_conversations',
    );
    expect(
      conversations?.table.columns.some(
        (column) => column.name === 'conversation_id' && column.primaryKey === true,
      ),
    ).toBe(true);
    const runs = steps.find(
      (step): step is Extract<(typeof steps)[number], { kind: 'create-table' }> =>
        step.kind === 'create-table' && step.table.name === 'agent_runs',
    );
    expect(
      runs?.table.columns.some((column) => column.name === 'run_id' && column.primaryKey === true),
    ).toBe(true);
    const toolCalls = steps.find(
      (step): step is Extract<(typeof steps)[number], { kind: 'create-table' }> =>
        step.kind === 'create-table' && step.table.name === 'agent_tool_calls',
    );
    expect(toolCalls?.table.primaryKey).toEqual(['run_id', 'call_index']);
    const indexSteps = steps.filter(
      (step): step is Extract<(typeof steps)[number], { kind: 'create-index' }> =>
        step.kind === 'create-index',
    );
    expect(indexSteps.map((step) => step.name)).toEqual([
      'agent_runs_status_updated',
      'agent_runs_conversation',
    ]);
    expect(indexSteps[0]?.columns).toEqual(['project_id', 'status', 'updated_at']);
    expect(indexSteps[1]?.columns).toEqual(['conversation_id']);
  });
  it('declares the agent message transcript migration (v8) with its table and index', () => {
    const v8 = persistenceSchema.find((migration) => migration.version === 8);
    expect(v8?.version).toBe(8);
    const steps = v8?.steps ?? [];
    const tableStep = steps.find(
      (step): step is Extract<(typeof steps)[number], { kind: 'create-table' }> =>
        step.kind === 'create-table',
    );
    if (tableStep?.kind !== 'create-table') throw new Error('V8 is missing its create-table step');
    expect(tableStep.table.name).toBe('agent_conversation_messages');
    expect(
      tableStep.table.columns.some(
        (column) => column.name === 'message_id' && column.primaryKey === true,
      ),
    ).toBe(true);
    const indexSteps = steps.filter(
      (step): step is Extract<(typeof steps)[number], { kind: 'create-index' }> =>
        step.kind === 'create-index',
    );
    expect(indexSteps.map((step) => step.name)).toEqual([
      'agent_conversation_messages_conversation_created',
    ]);
    expect(indexSteps[0]?.columns).toEqual(['conversation_id', 'created_at']);
  });
});
