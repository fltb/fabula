// ============================================================================
// Novalistically MCP Server
// Model Context Protocol server for AI agent integration
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AnalysisResult, CommentFilter, StatusReport } from '@novalistically/core';
import {
  type AssembleResult,
  assembleNovel,
  type Blocker,
  clearEventCache,
  FsStorage,
  getProjectStatus,
  type ISSDimension,
  listEntities,
  type NextAction,
  type PipelineRunResult,
  ReportWriter,
  type ReviewComment,
  ReviewManager,
  renderNovel,
  showEntity,
  type ThreadSnapshot,
  type ValidationIssue,
  validateNovel,
} from '@novalistically/core';

// ============================================================================
// MCP Tool Implementations
// ============================================================================

// ============================================================================
// mcp_nova_status — Full status report
// ============================================================================

export async function mcpNovaStatus(projectPath: string): Promise<StatusReport> {
  const status = getProjectStatus(projectPath);
  const { iss, results: validationResults } = await validateNovel(projectPath);

  // Collect all L1 issues from validateNovel
  const l1Issues: ValidationIssue[] = [];
  for (const [, vr] of validationResults) {
    l1Issues.push(...vr.errors, ...vr.warnings, ...vr.infos);
  }

  // Thread snapshots (simplified — getProjectStatus provides basic progress)
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

  // Render lists
  const renderCompleted = status.events.filter((e) => e.status === 'rendered').map((e) => e.id);
  const renderBlocked = status.events.filter((e) => e.status === 'blocked').map((e) => e.id);
  const renderReady = status.events.filter((e) => e.status === 'pending').map((e) => e.id);

  // Blockers
  const blockers: Blocker[] = status.events
    .filter((e) => e.status === 'blocked')
    .map((e) => ({
      event: e.id,
      reason: 'Blocked by validation errors',
      missingPreconditions: [],
    }));

  // Next actions (helper functions defined below in this file)
  const allErrors = l1Issues.filter((i) => i.severity === 'error');
  const nextActions = generateNextActions(iss, allErrors, threadSnapshots, renderBlocked);

  // Guidance
  const guidance = generateGuidance(
    iss,
    allErrors,
    threadSnapshots,
    renderReady,
    renderBlocked,
    nextActions,
  );

  // Build PipelineRunResult and delegate to ReportWriter
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

// ============================================================================
// mcp_nova_validate — Validate project or specific event
// ============================================================================

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

// ============================================================================
// mcp_nova_iss — Get ISS score
// ============================================================================

export async function mcpNovaIss(projectPath: string) {
  const result = await validateNovel(projectPath);
  return { iss: result.iss };
}

// ============================================================================
// mcp_nova_read_state — Get current world state for an entity
// ============================================================================

export function mcpNovaReadState(projectPath: string, entityId?: string) {
  if (entityId) {
    const entity = showEntity(projectPath, entityId);
    if (!entity) return null;
    return {
      entity,
      state: entity.state,
      knowledge: { knownFacts: [] },
    };
  }

  // Full project overview from orchestration functions
  const status = getProjectStatus(projectPath);
  const entities = listEntities(projectPath);
  return {
    entities: Object.fromEntries(entities.map((e) => [e.id, { kind: e.kind, name: e.name }])),
    threads: Object.fromEntries(
      status.threads.map((t) => [t.id, { progress: t.progress, total: t.total }]),
    ),
    events: status.events.map((e) => ({
      id: e.id,
      status: e.status,
      chapter: e.chapter,
    })),
  };
}

// ============================================================================
// mcp_nova_thread_status — Get thread progress
// ============================================================================

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

// ============================================================================
// mcp_nova_render — Compile context for rendering (dry-run)
// ============================================================================

export async function mcpNovaRender(projectPath: string, eventId: string) {
  const result = await renderNovel({
    projectDir: projectPath,
    eventId,
    dryRun: true,
  });

  if (result.results.length === 0) {
    throw new Error(`Event "${eventId}" not found`);
  }

  // Read the saved prompt from disk
  const dryRunPath = path.join(projectPath, '.nova', 'dry-runs', `${eventId}_prompt.md`);
  const markdown = fs.existsSync(dryRunPath) ? fs.readFileSync(dryRunPath, 'utf-8') : '';

  return {
    contextPackage: null,
    markdown,
    characterCount: 0,
    worldFactCount: 0,
    threadCount: 0,
  };
}

// ============================================================================
// mcp_nova_render_scene — Full LLM rendering + output writing
// ============================================================================

export async function mcpNovaRenderScene(
  projectPath: string,
  eventId: string,
  options?: { model?: string },
): Promise<{
  eventId: string;
  prose: string;
  wordCount: number;
  cacheHit: boolean;
  errors: string[];
  analysis: AnalysisResult | null;
}> {
  const result = await renderNovel({
    projectDir: projectPath,
    model: options?.model,
    eventId,
  });

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

// ============================================================================
// mcp_nova_review_list — List review comments
// ============================================================================

export function mcpNovaReviewList(
  projectPath: string,
  filter?: Pick<CommentFilter, 'status' | 'severity'> & { eventId?: string },
) {
  const manager = new ReviewManager();
  manager.load(projectPath);

  const commentFilter: CommentFilter = {};
  if (filter?.status) commentFilter.status = filter.status;
  if (filter?.severity) commentFilter.severity = filter.severity;
  if (filter?.eventId) commentFilter.targetId = filter.eventId;

  return manager.getComments(Object.keys(commentFilter).length > 0 ? commentFilter : undefined);
}

// ============================================================================
// mcp_nova_review_add — Add a review comment
// ============================================================================

export function mcpNovaReviewAdd(
  projectPath: string,
  eventId: string,
  content: string,
  severity?: 'nit' | 'suggestion' | 'blocking',
) {
  const manager = new ReviewManager();
  manager.load(projectPath);

  const comment: ReviewComment = {
    id: `rev_${Date.now()}`,
    author: 'human',
    target: { type: 'scene', id: eventId },
    severity: severity ?? 'suggestion',
    status: 'open',
    content,
    category: 'style',
    createdAt: new Date().toISOString(),
  };

  manager.addComment(comment);
  manager.save(projectPath);

  return { id: comment.id, message: 'Review comment added' };
}

// ============================================================================
// mcp_nova_review_resolve — Resolve a review comment
// ============================================================================

export function mcpNovaReviewResolve(projectPath: string, commentId: string) {
  const manager = new ReviewManager();
  manager.load(projectPath);
  manager.resolve(commentId);
  manager.save(projectPath);
  return { id: commentId, message: 'Comment resolved' };
}

// ============================================================================
// mcp_nova_review_reopen — Reopen + invalidate cache for a comment
// ============================================================================

export function mcpNovaReviewReopen(projectPath: string, commentId: string) {
  const manager = new ReviewManager();
  manager.load(projectPath);
  manager.reopen(commentId);
  manager.save(projectPath);

  // Invalidate cache for the associated event
  const comment = manager.getComments().find((c: ReviewComment) => c.id === commentId);
  if (comment) {
    const cacheDir = path.join(projectPath, '.nova', 'render-cache');
    clearEventCache(cacheDir, comment.target.id, new FsStorage());
  }

  return { id: commentId, message: 'Comment reopened, cache invalidated' };
}

// ============================================================================
// mcp_nova_review_escalate — Escalate severity
// ============================================================================

export function mcpNovaReviewEscalate(projectPath: string, commentId: string) {
  const manager = new ReviewManager();
  manager.load(projectPath);
  manager.escalate(commentId);
  manager.save(projectPath);
  return { id: commentId, message: 'Comment escalated to blocking' };
}

// ============================================================================
// mcp_nova_assemble — Assemble novel
// ============================================================================

export function mcpNovaAssemble(projectPath: string, outputPath?: string): AssembleResult {
  return assembleNovel({
    projectDir: projectPath,
    outputPath,
  });
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

  // ISS gaps → actions
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

  // Validation errors → actions
  for (const err of errors) {
    actions.push({
      priority: 'critical',
      category: 'validation',
      action: err.fixSuggestion,
      targetFile: err.fixTarget.file,
      fixAction: err.fixAction,
    });
  }

  // Thread warnings → actions
  for (const t of threads.filter((t) => t.risk !== 'on_track')) {
    actions.push({
      priority: t.risk === 'critical' ? 'high' : 'medium',
      category: 'thread',
      action: `Thread "${t.name}" (${t.id}) is ${t.risk}: ${t.progress} progress`,
    });
  }

  // Blocked renders → actions
  for (const eventId of blockedRenders) {
    actions.push({
      priority: 'high',
      category: 'rendering',
      action: `Event "${eventId}" is blocked by validation errors`,
    });
  }

  // Sort: critical → high → medium → low
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
  threads: ThreadSnapshot[],
  readyRenders: string[],
  blockedRenders: string[],
  nextActions: NextAction[],
): string {
  let guidance = '## 当前项目状态指导\n\n';

  // ISS
  if (iss.overall < iss.target) {
    guidance += `ISS: ${iss.overall}% (目标 ${iss.target}%)\n\n`;
    guidance += '### 你应该优先修复 ISS\n\n';
    for (const action of nextActions.filter((a) => a.category === 'iss')) {
      guidance += `${action.priority === 'critical' ? '🔴' : '🟡'} ${action.action}\n`;
      if (action.targetFile) guidance += `   → 编辑 ${action.targetFile}\n`;
      guidance += '\n';
    }
  }

  // Render
  if (readyRenders.length > 0) {
    guidance += '### 当前可渲染的场景\n';
    for (const e of readyRenders) {
      guidance += `- ${e} — ✅ preconditions 满足\n`;
    }
    guidance += '\n';
  }

  // Blocked
  if (blockedRenders.length > 0) {
    guidance += '### 被阻断的场景\n';
    for (const b of blockedRenders) {
      guidance += `- ${b}: 验证错误阻断\n`;
    }
    guidance += '\n';
  }

  // Threads
  for (const t of threads.filter((t) => t.risk !== 'on_track')) {
    guidance += `- ⚠ ${t.name} (${t.id}): ${t.progress}，${t.risk}\n`;
  }

  // Don'ts
  guidance += '\n### 不要做的事\n';
  if (iss.overall < iss.target) {
    guidance += '- 不要创建新的 chapters/ 文件（ISS 未达标）\n';
  }
  if (errors.length > 0) {
    guidance += '- 不要渲染被 ERROR 阻断的场景\n';
  }
  if (readyRenders.length === 0 && errors.length > 0) {
    guidance += '- 不要创建新的 events（先修复现有 ERROR）\n';
  }

  return guidance;
}

// ============================================================================
// MCP Server entry point (for standalone process)
// ============================================================================

type MCPTool = (...args: never[]) => Promise<unknown> | unknown;
type MCPReviewAddInput = {
  content?: string;
  severity?: ReviewComment['severity'];
};

export function createMCPServer(projectPath: string): {
  tools: Record<string, MCPTool>;
} {
  return {
    tools: {
      nova_status: () => mcpNovaStatus(projectPath),
      nova_validate: (eventId?: string) => mcpNovaValidate(projectPath, eventId),
      nova_iss: () => mcpNovaIss(projectPath),
      nova_read_state: (entityId?: string) => mcpNovaReadState(projectPath, entityId),
      nova_thread_status: (threadId?: string) => mcpNovaThreadStatus(projectPath, threadId),
      nova_render: (eventId: string) => mcpNovaRender(projectPath, eventId),
      nova_render_scene: (eventId: string, options?: { model?: string }) =>
        mcpNovaRenderScene(projectPath, eventId, options),
      nova_assemble: (outputPath?: string) => mcpNovaAssemble(projectPath, outputPath),
      nova_review_list: (
        filter?: Pick<CommentFilter, 'status' | 'severity'> & { eventId?: string },
      ) => mcpNovaReviewList(projectPath, filter),
      nova_review_add: (
        eventId: string,
        contentOrOptions?: string | MCPReviewAddInput,
        options?: MCPReviewAddInput,
      ) => {
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
    },
  };
}
