// ============================================================================
// Novalistically MCP Server
// Model Context Protocol server for AI agent integration
// All tools are thin wrappers over core root facade calls only.
// ============================================================================
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { BranchPath, CommentFilter, LLMProvider, StatusReport } from '@novalistically/core';
import {
  addReviewComment,
  adoptSceneProse,
  applySourceChange,
  assembleCanonicalNovel,
  assembleCustomNovel,
  type Blocker,
  type EditorialAssembleResult,
  getEditorialOperation,
  getEditorialWorkspace,
  getProjectStatus,
  getSourceDocument,
  type ISSDimension,
  inspectScenes,
  listEntities,
  listReviewComments,
  listSceneRevisions,
  listSourceDocuments,
  type NewReviewComment,
  type NextAction,
  type PipelineRunResult,
  previewEditorialRun,
  previewSourceChange,
  ReportWriter,
  type ReviewComment,
  renderGameDialogueTree,
  renderNovel,
  replaceReviewComment,
  rollbackSceneRevision,
  type SceneSelector,
  type SourceChangePreviewV1,
  setSceneLock,
  showEntity,
  type ThreadSnapshot,
  updateReviewComment,
  type ValidationIssue,
  validateNovel,
} from '@novalistically/core';
// ============================================================================
// Object-input types for MCP tools
// Each carries operationId/actorId where applicable; inputs thread through
// to the corresponding core facade function unchanged.
// ============================================================================

export interface MCPWorkspaceInput {
  operationId: string;
  actorId: string;
}

export interface MCPSourceListInput {
  operationId: string;
  actorId: string;
}

export interface MCPSourceGetInput {
  operationId: string;
  actorId: string;
  path: string;
}

export interface MCPSourcePreviewInput {
  operationId: string;
  actorId: string;
  changeSet: SourceChangePreviewV1['changeSet'];
}

export interface MCPSourceApplyInput {
  operationId: string;
  actorId: string;
  preview: SourceChangePreviewV1;
}

export interface MCPReviewListInput {
  operationId: string;
  actorId: string;
  status?: ReviewComment['status'];
  severity?: ReviewComment['severity'];
  eventId?: string;
}

export interface MCPReviewAddInput {
  operationId: string;
  actorId: string;
  eventId: string;
  content: string;
  severity?: 'nit' | 'suggestion' | 'blocking';
  category?: ReviewComment['category'];
}

export interface MCPReviewReplaceInput {
  operationId: string;
  actorId: string;
  commentId: string;
  eventId: string;
  content: string;
  severity?: 'nit' | 'suggestion' | 'blocking';
  category?: ReviewComment['category'];
}
export interface MCPReviewStatusInput {
  operationId: string;
  actorId: string;
  commentId: string;
  action: 'resolve' | 'wontfix' | 'reopen' | 'escalate';
}

export interface MCPBatchRenderInput {
  operationId: string;
  actorId: string;
  eventIds: readonly string[];
  model?: string;
  profile?: string;
  branchPath?: BranchPath;
  batchSize?: number;
  windowSize?: number;
}

export interface MCPBatchReviseInput {
  operationId: string;
  actorId: string;
  eventIds: readonly string[];
  model?: string;
  profile?: string;
  branchPath?: BranchPath;
  instruction?: string;
}

export interface MCPSceneListInput {
  operationId: string;
  actorId: string;
  selector?: SceneSelector;
  branchPath?: BranchPath;
}

export interface MCPSceneShowInput {
  operationId: string;
  actorId: string;
  eventId: string;
}

export interface MCPSceneAdoptInput {
  operationId: string;
  actorId: string;
  eventId: string;
  input:
    | {
        type: 'replacement';
        expectedRevisionId: string | null;
        expectedSceneHash: string | null;
        prose: string;
      }
    | { type: 'working_copy'; expectedSceneHash: string };
  note?: string;
  lockAfter?: boolean;
  model?: string;
  profile?: string;
  branchPath?: BranchPath;
}

export interface MCPSceneSetLockInput {
  operationId: string;
  actorId: string;
  eventId: string;
  locked: boolean;
  expectedSceneHash: string;
  note?: string;
}

export interface MCPSceneHistoryInput {
  operationId: string;
  actorId: string;
  eventId: string;
}

export interface MCPSceneRollbackInput {
  operationId: string;
  actorId: string;
  eventId: string;
  revisionId: string;
  note?: string;
  model?: string;
  profile?: string;
  branchPath?: BranchPath;
}

export interface MCPOperationGetInput {
  operationId: string;
  actorId: string;
}
// Existing names nova_render, nova_render_scene, nova_render_tree are preserved.
// ============================================================================

// ─── Status ─────────────────────────────────────────────────────────────────
// mcp_nova_status — Full status report via core root facade calls
export async function mcpNovaStatus(projectPath: string): Promise<StatusReport> {
  const status = getProjectStatus(projectPath);
  const { iss, results: validationResults } = await validateNovel(projectPath);
  const l1Issues: ValidationIssue[] = [];
  for (const [, vr] of validationResults) {
    l1Issues.push(...vr.errors, ...vr.warnings, ...vr.infos);
  }
  const threadSnapshots: ThreadSnapshot[] = status.threads.map((t) => ({
    id: t.id,
    name: t.id,
    progress: `${t.progress}/${t.total}`,
    lastAdvancedIn: '',
    targetChapter: 1,
    currentChapter: 1,
    onTrack: true,
    risk: 'on_track' as const,
  }));
  const renderCompleted = status.events.filter((e) => e.status === 'rendered').map((e) => e.id);
  const renderBlocked = status.events.filter((e) => e.status === 'blocked').map((e) => e.id);
  const renderReady = status.events.filter((e) => e.status === 'pending').map((e) => e.id);
  const blockers: Blocker[] = status.events
    .filter((e) => e.status === 'blocked')
    .map((e) => ({
      event: e.id,
      reason: 'Blocked by validation errors',
      missingPreconditions: [],
    }));
  const allErrors = l1Issues.filter((i) => i.severity === 'error');
  const nextActions = generateNextActions(iss, allErrors, threadSnapshots, renderBlocked);
  const guidance = generateGuidance(
    iss,
    allErrors,
    threadSnapshots,
    renderReady,
    renderBlocked,
    nextActions,
  );
  const result: PipelineRunResult = {
    projectName: path.basename(projectPath),
    projectDir: projectPath,
    generatedAt: new Date().toISOString(),
    passed: l1Issues.filter((i) => i.severity === 'error').length === 0,
    l1Issues,
    l2Issues: [],
    iss,
    results: [],
    renderStatus: {
      ready: renderReady,
      blocked: renderBlocked,
      waiting: [],
      completed: renderCompleted,
    },
    threads: threadSnapshots,
    blockers,
    nextActions,
    guidance,
    errors: [],
  };
  return new ReportWriter(result).toStatusReport();
}

// ─── Validate ───────────────────────────────────────────────────────────────
export async function mcpNovaValidate(
  projectPath: string,
  eventId?: string,
): Promise<{ errors: ValidationIssue[]; warnings: ValidationIssue[] }> {
  const result = await validateNovel(projectPath);
  if (eventId) {
    const eventResult = result.results.get(eventId);
    if (!eventResult) throw new Error(`Event "${eventId}" not found`);
    return { errors: eventResult.errors, warnings: eventResult.warnings };
  }
  const allErrors: ValidationIssue[] = [];
  const allWarnings: ValidationIssue[] = [];
  for (const [, vr] of result.results) {
    allErrors.push(...vr.errors);
    allWarnings.push(...vr.warnings);
  }
  return { errors: allErrors, warnings: allWarnings };
}

// ─── ISS Score ──────────────────────────────────────────────────────────────
export async function mcpNovaIss(projectPath: string) {
  const result = await validateNovel(projectPath);
  return { iss: result.iss };
}

// ─── Read State ─────────────────────────────────────────────────────────────
export function mcpNovaReadState(projectPath: string, entityId?: string) {
  if (entityId) {
    const entity = showEntity(projectPath, entityId);
    if (!entity) return null;
    return { entity, state: entity.state, knowledge: { knownFacts: [] } };
  }
  const status = getProjectStatus(projectPath);
  const entities = listEntities(projectPath);
  return {
    entities: Object.fromEntries(entities.map((e) => [e.id, { kind: e.kind, name: e.name }])),
    threads: Object.fromEntries(
      status.threads.map((t) => [t.id, { progress: t.progress, total: t.total }]),
    ),
    events: status.events.map((e) => ({ id: e.id, status: e.status, chapter: e.chapter })),
  };
}

// ─── Thread Status ──────────────────────────────────────────────────────────
export function mcpNovaThreadStatus(projectPath: string, threadId?: string) {
  const status = getProjectStatus(projectPath);
  if (threadId) {
    const thread = status.threads.find((t) => t.id === threadId);
    return thread ?? null;
  }
  return Object.fromEntries(
    status.threads.map((t) => [t.id, { progress: t.progress, total: t.total }]),
  );
}

// ─── Render (dry-run) — PRESERVED name ──────────────────────────────────────
export async function mcpNovaRender(projectPath: string, eventId: string, branchPath?: BranchPath) {
  const result = await previewEditorialRun(
    {
      version: 1,
      projectDir: projectPath,
      selector: { type: 'events', eventIds: [eventId] },
      branchPath,
    },
    {},
  );
  const prompt = result.prompts.find((p) => p.eventId === eventId);
  if (!prompt) throw new Error(`Event "${eventId}" not found`);
  return {
    contextPackage: null,
    markdown: prompt.userPrompt,
    characterCount: 0,
    worldFactCount: 0,
    threadCount: 0,
  };
}

// ─── Render Scene — PRESERVED name ──────────────────────────────────────────
export async function mcpNovaRenderScene(
  projectPath: string,
  eventId: string,
  options?: { model?: string; branchPath?: BranchPath },
  provider?: LLMProvider,
) {
  const result = await renderNovel(
    {
      version: 1,
      projectDir: projectPath,
      selector: { type: 'events', eventIds: [eventId] },
      mutation: { operationId: crypto.randomUUID(), actorId: 'mcp' },
      model: options?.model,
      branchPath: options?.branchPath,
    },
    { provider },
  );
  if (result.results.length === 0) {
    throw new Error(`Event "${eventId}" not found or render failed: ${result.errors.join(', ')}`);
  }
  const r = result.results[0];
  return {
    eventId: r.eventId,
    prose: r.prose,
    wordCount: r.wordCount,
    cacheHit: r.cacheHit,
    errors: r.errors,
    analysis: r.analysis,
  };
}

// ─── Render Tree — PRESERVED name ───────────────────────────────────────────
// No direct fs reads: dialogue tree content comes from the core render result.
export async function mcpNovaRenderTree(
  projectPath: string,
  options?: { model?: string },
  provider?: LLMProvider,
) {
  const result = await renderGameDialogueTree(
    {
      version: 1,
      projectDir: projectPath,
      mutation: { operationId: crypto.randomUUID(), actorId: 'mcp' },
      model: options?.model,
    },
    { provider },
  );
  return {
    tree: result.tree,
    results: result.results,
    errors: result.errors,
    editorialErrors: result.editorialErrors,
    dialogueTree: result.dialogueTree,
    outputPath: result.outputPath,
    publication: result.publication,
  };
}

// ─── Assemble ───────────────────────────────────────────────────────────────
// Thin wrapper; no direct EntityMapper or compileGameDialogueTree calls.
export function mcpNovaAssemble(
  projectPath: string,
  options?: { outputPath?: string; branchPath?: BranchPath },
): EditorialAssembleResult {
  const request = {
    version: 1 as const,
    projectDir: projectPath,
    mutation: {
      operationId: crypto.randomUUID(),
      actorId: 'local-mcp',
    },
    ...(options?.outputPath ? { outputPath: options.outputPath } : {}),
    ...(options?.branchPath ? { branchPath: options.branchPath } : {}),
  };
  return options?.outputPath ? assembleCustomNovel(request) : assembleCanonicalNovel(request);
}

// ─── Review (backward-compatible object-input and positional overloads) ────

export function mcpNovaReviewList(
  projectPath: string,
  input?: MCPReviewListInput | (Pick<CommentFilter, 'status' | 'severity'> & { eventId?: string }),
) {
  const getFilter = (src: typeof input): CommentFilter | undefined => {
    if (!src) return undefined;
    const f: CommentFilter = {};
    if ('operationId' in src) {
      if (src.status) f.status = src.status;
      if (src.severity) f.severity = src.severity;
      if (src.eventId) f.targetId = src.eventId;
    } else {
      if (src.status) f.status = src.status;
      if (src.severity) f.severity = src.severity;
      if (src.eventId) f.targetId = src.eventId;
    }
    return Object.keys(f).length > 0 ? f : undefined;
  };
  return listReviewComments({ projectDir: projectPath, filter: getFilter(input) });
}

export function mcpNovaReviewAdd(
  projectPath: string,
  eventIdOrInput: string | MCPReviewAddInput,
  content?: string,
  severity?: 'nit' | 'suggestion' | 'blocking',
) {
  if (typeof eventIdOrInput === 'object') {
    const input: NewReviewComment = {
      target: { type: 'scene', id: eventIdOrInput.eventId },
      severity: eventIdOrInput.severity ?? 'suggestion',
      category: eventIdOrInput.category ?? 'style',
      content: eventIdOrInput.content,
    };
    return addReviewComment({
      projectDir: projectPath,
      input,
      mutation: {
        operationId: eventIdOrInput.operationId,
        actorId: eventIdOrInput.actorId,
      },
    });
  }
  const input: NewReviewComment = {
    target: { type: 'scene', id: eventIdOrInput },
    severity: severity ?? 'suggestion',
    category: 'style',
    content: content ?? '',
  };
  const comment = addReviewComment({
    projectDir: projectPath,
    input,
    mutation: { operationId: crypto.randomUUID(), actorId: 'mcp' },
  });
  return { id: comment.id, message: 'Review comment added' };
}

export function mcpNovaReviewResolve(
  projectPath: string,
  commentIdOrInput: string | { operationId: string; actorId: string; commentId: string },
) {
  if (typeof commentIdOrInput === 'object') {
    updateReviewComment({
      projectDir: projectPath,
      commentId: commentIdOrInput.commentId,
      action: 'resolve',
      mutation: { operationId: commentIdOrInput.operationId, actorId: commentIdOrInput.actorId },
    });
    return { id: commentIdOrInput.commentId, message: 'Comment resolved' };
  }
  updateReviewComment({
    projectDir: projectPath,
    commentId: commentIdOrInput,
    action: 'resolve',
    mutation: { operationId: crypto.randomUUID(), actorId: 'mcp' },
  });
  return { id: commentIdOrInput, message: 'Comment resolved' };
}

export function mcpNovaReviewReopen(
  projectPath: string,
  commentIdOrInput: string | { operationId: string; actorId: string; commentId: string },
) {
  if (typeof commentIdOrInput === 'object') {
    updateReviewComment({
      projectDir: projectPath,
      commentId: commentIdOrInput.commentId,
      action: 'reopen',
      mutation: { operationId: commentIdOrInput.operationId, actorId: commentIdOrInput.actorId },
    });
    return { id: commentIdOrInput.commentId, message: 'Comment reopened' };
  }
  updateReviewComment({
    projectDir: projectPath,
    commentId: commentIdOrInput,
    action: 'reopen',
    mutation: { operationId: crypto.randomUUID(), actorId: 'mcp' },
  });
  return { id: commentIdOrInput, message: 'Comment reopened' };
}

export function mcpNovaReviewEscalate(
  projectPath: string,
  commentIdOrInput: string | { operationId: string; actorId: string; commentId: string },
) {
  if (typeof commentIdOrInput === 'object') {
    updateReviewComment({
      projectDir: projectPath,
      commentId: commentIdOrInput.commentId,
      action: 'escalate',
      mutation: { operationId: commentIdOrInput.operationId, actorId: commentIdOrInput.actorId },
    });
    return { id: commentIdOrInput.commentId, message: 'Comment escalated to blocking' };
  }
  updateReviewComment({
    projectDir: projectPath,
    commentId: commentIdOrInput,
    action: 'escalate',
    mutation: { operationId: crypto.randomUUID(), actorId: 'mcp' },
  });
  return { id: commentIdOrInput, message: 'Comment escalated to blocking' };
}

// ============================================================================
// Generate next actions
// ============================================================================

function generateNextActions(
  iss: { dimensions: ISSDimension[] },
  errors: ValidationIssue[],
  threads: ThreadSnapshot[],
  blockedRenders: string[],
): NextAction[] {
  const actions: NextAction[] = [];
  for (const dim of iss.dimensions) {
    for (const gap of dim.gaps) {
      actions.push({
        priority: dim.status === 'red' ? 'critical' : 'high',
        category: 'iss',
        action: gap.suggestion,
        targetFile: gap.fixTarget,
        fixAction: gap.fixAction,
        template: gap.template,
      });
    }
  }
  for (const err of errors) {
    actions.push({
      priority: 'critical',
      category: 'validation',
      action: err.fixSuggestion,
      targetFile: err.fixTarget.file,
      fixAction: err.fixAction,
    });
  }
  for (const t of threads.filter((t) => t.risk !== 'on_track')) {
    actions.push({
      priority: t.risk === 'critical' ? 'high' : 'medium',
      category: 'thread',
      action: `Thread "${t.name}" (${t.id}) is ${t.risk}: ${t.progress} progress`,
    });
  }
  for (const eventId of blockedRenders) {
    actions.push({
      priority: 'high',
      category: 'rendering',
      action: `Event "${eventId}" is blocked by validation errors`,
    });
  }
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  return actions;
}

// ============================================================================
// Generate guidance
// ============================================================================

function generateGuidance(
  iss: { overall: number; target: number; dimensions: ISSDimension[] },
  errors: ValidationIssue[],
  _threads: ThreadSnapshot[],
  readyRenders: string[],
  blockedRenders: string[],
  nextActions: NextAction[],
): string {
  let guidance = '## 当前项目状态指导\n\n';
  if (iss.overall < iss.target) {
    guidance += `ISS: ${iss.overall}% (目标 ${iss.target}%)\n\n`;
    guidance += '### 你应该优先修复 ISS\n\n';
    for (const action of nextActions.filter((a) => a.category === 'iss')) {
      guidance += `${action.priority === 'critical' ? '🔴' : '🟡'} ${action.action}\n`;
      if (action.targetFile) guidance += `   → 编辑 ${action.targetFile}\n`;
      guidance += '\n';
    }
  }
  if (readyRenders.length > 0) {
    guidance += '### 当前可渲染的场景\n';
    for (const e of readyRenders) guidance += `- ${e} — ✅ preconditions 满足\n`;
    guidance += '\n';
  }
  if (blockedRenders.length > 0) {
    guidance += '### 被阻断的场景\n';
    for (const b of blockedRenders) guidance += `- ${b}: 验证错误阻断\n`;
    guidance += '\n';
  }
  if (iss.overall < iss.target) guidance += '- 不要创建新的 chapters/ 文件（ISS 未达标）\n';
  if (errors.length > 0) guidance += '- 不要渲染被 ERROR 阻断的场景\n';
  if (readyRenders.length === 0 && errors.length > 0)
    guidance += '- 不要创建新的 events（先修复现有 ERROR）\n';
  return guidance;
}

// ============================================================================
// MCP Server entry point
// ============================================================================
type MCPTool = (...args: never[]) => Promise<unknown> | unknown;

export function createMCPServer(projectPath: string): {
  tools: Record<string, MCPTool>;
} {
  return {
    tools: {
      // Preserved positional tools
      nova_status: () => mcpNovaStatus(projectPath),
      nova_validate: (eventId?: string) => mcpNovaValidate(projectPath, eventId),
      nova_iss: () => mcpNovaIss(projectPath),
      nova_read_state: (entityId?: string) => mcpNovaReadState(projectPath, entityId),
      nova_thread_status: (threadId?: string) => mcpNovaThreadStatus(projectPath, threadId),
      nova_render: (eventId: string, branchPath?: BranchPath) =>
        mcpNovaRender(projectPath, eventId, branchPath),
      nova_render_scene: (eventId: string, options?: { model?: string; branchPath?: BranchPath }) =>
        mcpNovaRenderScene(projectPath, eventId, options),
      nova_render_tree: (options?: { model?: string }) => mcpNovaRenderTree(projectPath, options),
      nova_render_batch: (input: MCPBatchRenderInput) =>
        renderNovel({
          version: 1,
          projectDir: projectPath,
          selector: { type: 'events', eventIds: input.eventIds },
          mutation: { operationId: input.operationId, actorId: input.actorId },
          model: input.model,
          providerProfile: input.profile,
          branchPath: input.branchPath,
          batch: { batchSize: input.batchSize, windowSize: input.windowSize, failFast: true },
        }),
      nova_assemble: (options?: { outputPath?: string; branchPath?: BranchPath }) =>
        mcpNovaAssemble(projectPath, options),

      // Review tools (backward-compatible)
      nova_review_list: (
        filter?:
          | MCPReviewListInput
          | (Pick<CommentFilter, 'status' | 'severity'> & { eventId?: string }),
      ) => mcpNovaReviewList(projectPath, filter),
      nova_review_add: (
        eventId: string,
        contentOrOptions?: string | MCPReviewAddInput,
        options?: MCPReviewAddInput,
      ) => {
        if (typeof eventId === 'object') {
          return mcpNovaReviewAdd(projectPath, eventId);
        }
        const content =
          typeof contentOrOptions === 'string'
            ? contentOrOptions
            : (contentOrOptions?.content ?? '');
        const severity =
          typeof contentOrOptions === 'string' ? options?.severity : contentOrOptions?.severity;
        return mcpNovaReviewAdd(projectPath, eventId, content, severity);
      },
      nova_review_resolve: (commentId: string) => mcpNovaReviewResolve(projectPath, commentId),
      nova_review_reopen: (commentId: string) => mcpNovaReviewReopen(projectPath, commentId),
      nova_review_escalate: (commentId: string) => mcpNovaReviewEscalate(projectPath, commentId),

      // ── Object-input tools ──
      nova_workspace_get: (_input?: MCPWorkspaceInput) =>
        getEditorialWorkspace({ version: 1, projectDir: projectPath }),
      nova_source_list: (_input?: MCPSourceListInput) =>
        listSourceDocuments({ projectDir: projectPath }),
      nova_source_get: (input: MCPSourceGetInput) =>
        getSourceDocument({ projectDir: projectPath, path: input.path }),
      nova_source_preview: (input: MCPSourcePreviewInput) =>
        previewSourceChange({ projectDir: projectPath, changeSet: input.changeSet }),
      nova_source_apply: (input: MCPSourceApplyInput) =>
        applySourceChange({
          projectDir: projectPath,
          preview: input.preview,
          mutation: {
            operationId: input.operationId,
            actorId: input.actorId,
          },
        }),
      nova_review_replace: (input: MCPReviewReplaceInput) =>
        replaceReviewComment({
          projectDir: projectPath,
          commentId: input.commentId,
          input: {
            target: { type: 'scene', id: input.eventId },
            severity: input.severity ?? 'suggestion',
            category: input.category ?? 'style',
            content: input.content,
          },
          mutation: { operationId: input.operationId, actorId: input.actorId },
        }),
      nova_review_status: (input: MCPReviewStatusInput) =>
        updateReviewComment({
          projectDir: projectPath,
          commentId: input.commentId,
          action: input.action,
          mutation: {
            operationId: input.operationId,
            actorId: input.actorId,
          },
        }),
      nova_batch_render: (input: MCPBatchRenderInput) =>
        renderNovel({
          version: 1,
          projectDir: projectPath,
          selector: { type: 'events', eventIds: input.eventIds },
          mutation: { operationId: input.operationId, actorId: input.actorId },
          model: input.model,
          providerProfile: input.profile,
          branchPath: input.branchPath,
          batch: { batchSize: input.batchSize, windowSize: input.windowSize, failFast: true },
        }),
      nova_revise: (input: MCPBatchReviseInput) =>
        renderNovel({
          version: 1,
          projectDir: projectPath,
          selector: { type: 'events', eventIds: input.eventIds },
          mutation: {
            operationId: input.operationId,
            actorId: input.actorId,
          },
          model: input.model,
          providerProfile: input.profile,
          branchPath: input.branchPath,
          revision: input.instruction ? { instruction: input.instruction } : undefined,
        }),
      nova_batch_revise: (input: MCPBatchReviseInput) =>
        renderNovel({
          version: 1,
          projectDir: projectPath,
          selector: { type: 'events', eventIds: input.eventIds },
          mutation: { operationId: input.operationId, actorId: input.actorId },
          model: input.model,
          providerProfile: input.profile,
          branchPath: input.branchPath,
          revision: input.instruction ? { instruction: input.instruction } : undefined,
        }),
      nova_scene_list: (input: MCPSceneListInput) =>
        inspectScenes({
          version: 1,
          projectDir: projectPath,
          selector: input.selector,
          branchPath: input.branchPath,
        }),
      nova_scene_show: (input: MCPSceneShowInput) =>
        inspectScenes({
          version: 1,
          projectDir: projectPath,
          selector: { type: 'events', eventIds: [input.eventId] },
        }).then((scenes) => scenes[0] ?? null),
      nova_scene_adopt: (input: MCPSceneAdoptInput) =>
        adoptSceneProse({
          version: 1,
          projectDir: projectPath,
          mutation: { operationId: input.operationId, actorId: input.actorId },
          eventId: input.eventId,
          input: input.input,
          note: input.note,
          lockAfter: input.lockAfter,
          model: input.model,
          providerProfile: input.profile,
          branchPath: input.branchPath,
        }),
      nova_scene_set_lock: (input: MCPSceneSetLockInput) =>
        setSceneLock({
          version: 1,
          projectDir: projectPath,
          mutation: { operationId: input.operationId, actorId: input.actorId },
          eventId: input.eventId,
          locked: input.locked,
          expectedSceneHash: input.expectedSceneHash,
          note: input.note,
        }),
      nova_scene_history: (input: MCPSceneHistoryInput) =>
        listSceneRevisions({ projectDir: projectPath, eventId: input.eventId }),
      nova_scene_rollback: (input: MCPSceneRollbackInput) =>
        rollbackSceneRevision({
          version: 1,
          projectDir: projectPath,
          mutation: { operationId: input.operationId, actorId: input.actorId },
          eventId: input.eventId,
          revisionId: input.revisionId,
          note: input.note,
          model: input.model,
          providerProfile: input.profile,
          branchPath: input.branchPath,
        }),
      nova_operation_get: (input: MCPOperationGetInput) =>
        getEditorialOperation({ projectDir: projectPath, operationId: input.operationId }),
    },
  };
}
