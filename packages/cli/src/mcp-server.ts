// ============================================================================
// Novalistically MCP Server
// Model Context Protocol server for AI agent integration
// ============================================================================

import {
  EntityMapper,
  InMemoryEntityRegistry,
  StateManager,
  ResultAggregator,
  ContextCompiler,
  assembleNovel,
  calculateISS,
  detectAntiPatterns,
} from '@novalistically/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StatusReport, NextAction, ISSGap, ValidationIssue, ThreadSnapshot, Blocker } from '@novalistically/core';

// ============================================================================
// MCP Tool Implementations
// ============================================================================

export interface MCPContext {
  projectDir: string;
  mapper: EntityMapper;
  registry: InMemoryEntityRegistry;
  stateManager: StateManager;
  data: ReturnType<EntityMapper['loadProject']>;
  events: ReturnType<EntityMapper['loadAllEvents']>;
}

function initializeContext(projectPath: string): MCPContext {
  const mapper = new EntityMapper(projectPath);
  const data = mapper.loadProject();
  const events = mapper.loadAllEvents(data.chapters);

  const registry = new InMemoryEntityRegistry();
  registry.load(projectPath);

  const snapshotsDir = path.join(projectPath, '.nova', 'snapshots');
  const stateManager = new StateManager(snapshotsDir);
  for (const event of events) {
    stateManager.commit(event);
  }

  return { projectDir: projectPath, mapper, registry, stateManager, data, events };
}

// ============================================================================
// mcp_nova_status — Full status report
// ============================================================================

export function mcpNovaStatus(projectPath: string): StatusReport {
  const ctx = initializeContext(projectPath);
  const state = ctx.stateManager.getCurrentState();

  // ISS
  const threads = ctx.data.worldInitialState?.threads ?? [];
  const issResult = calculateISS({
    projectDir: projectPath,
    entityRegistry: ctx.registry,
    events: ctx.events,
    threads: threads.map((t) => ({ id: t.id, name: t.name })),
    rules: ctx.data.rules,
  });

  // Validation
  const aggregator = new ResultAggregator();
  const overrides = ctx.data.config?.validatorOverrides;
  const validationResults = aggregator.validateAll(ctx.events, state, ctx.registry, overrides);

  const allErrors: ValidationIssue[] = [];
  const allWarnings: ValidationIssue[] = [];
  for (const [, result] of validationResults) {
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  // Threads
  const threadSnapshots: ThreadSnapshot[] = [];
  for (const t of threads) {
    const progress = state.threads[t.id];
    const progressStr = progress
      ? `${progress.progress}/${progress.total}`
      : t.initialProgress;
    const [cur, total] = progressStr.split('/').map(Number);
    const currentChapter = Math.max(
      1,
      ...ctx.events.map((e) => Math.ceil(e.narrativeOrder / 3)),
    );

    let risk: ThreadSnapshot['risk'] = 'on_track';
    if (!progress || progress.progress === 0) {
      risk = currentChapter > 3 ? 'stalled' : 'behind';
    } else if (progress.progress < progress.total * (currentChapter / t.targetRevealChapter)) {
      risk = 'behind';
    } else if (currentChapter >= t.targetRevealChapter && progress.progress < progress.total) {
      risk = 'critical';
    }

    threadSnapshots.push({
      id: t.id,
      name: t.name,
      progress: progressStr,
      lastAdvancedIn: '',
      targetChapter: t.targetRevealChapter,
      currentChapter,
      onTrack: risk === 'on_track',
      risk,
    });
  }

  // Render status
  const renderReady: string[] = [];
  const renderBlocked: string[] = [];
  const renderWaiting: string[] = [];
  const renderCompleted: string[] = [];

  // Check scenes/ directory for completed renders
  const scenesDir = path.join(projectPath, 'scenes');
  if (fs.existsSync(scenesDir)) {
    const sceneDirs = fs.readdirSync(scenesDir, { withFileTypes: true });
    for (const dir of sceneDirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(scenesDir, dir.name);
      const mdFiles = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
      for (const mf of mdFiles) {
        const eventId = mf.replace('.md', '');
        renderCompleted.push(eventId);
      }
    }
  }

  // Determine ready/blocked/waiting
  for (const event of ctx.events) {
    if (event.id === 'system:genesis') continue;
    if (renderCompleted.includes(event.id)) continue;

    const eventResult = validationResults.get(event.id);
    if (!eventResult) {
      renderReady.push(event.id);
    } else if (!eventResult.passed) {
      renderBlocked.push(event.id);
    } else {
      // Check precondition satisfaction
      let allPreconditionsMet = true;
      for (const pc of event.preconditions) {
        const currentVal = state.entities[pc.entityId]?.[pc.attribute];
        if (currentVal === undefined || currentVal === null) {
          allPreconditionsMet = false;
          break;
        }
      }
      if (allPreconditionsMet) {
        renderReady.push(event.id);
      } else {
        renderWaiting.push(event.id);
      }
    }
  }

  // Blockers
  const blockers: Blocker[] = [];
  for (const event of ctx.events) {
    if (event.id === 'system:genesis') continue;
    const eventResult = validationResults.get(event.id);
    if (eventResult && !eventResult.passed) {
      const missingPreconditions = event.preconditions.filter((pc) => {
        const currentVal = state.entities[pc.entityId]?.[pc.attribute];
        return currentVal === undefined || currentVal === null;
      });

      blockers.push({
        event: event.id,
        reason: eventResult.errors.map((e) => e.message).join('; '),
        missingPreconditions: missingPreconditions.map((pc) => ({
          entity: pc.entityId,
          attribute: pc.attribute,
          expectedValue: pc.value,
          currentValue: state.entities[pc.entityId]?.[pc.attribute] ?? null,
        })),
      });
    }
  }

  // Next Actions
  const nextActions = generateNextActions(issResult, allErrors, threadSnapshots, renderBlocked);

  // Guidance
  const guidance = generateGuidance(
    issResult,
    allErrors,
    threadSnapshots,
    renderReady,
    renderBlocked,
    nextActions,
  );

  return {
    project: ctx.data.config?.project ?? 'unknown',
    timestamp: new Date().toISOString(),
    iss: issResult,
    validation: {
      lastRun: new Date().toISOString(),
      errors: allErrors,
      warnings: allWarnings,
    },
    threads: threadSnapshots,
    render: {
      ready: renderReady,
      blocked: renderBlocked,
      waiting: renderWaiting,
      completed: renderCompleted,
    },
    blockers,
    nextActions,
    guidance,
  };
}

// ============================================================================
// mcp_nova_validate — Validate project or specific event
// ============================================================================

export function mcpNovaValidate(
  projectPath: string,
  eventId?: string,
): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const ctx = initializeContext(projectPath);
  const state = ctx.stateManager.getCurrentState();

  const aggregator = new ResultAggregator();
  const overrides = ctx.data.config?.validatorOverrides;

  if (eventId) {
    const event = ctx.events.find((e) => e.id === eventId);
    if (!event) throw new Error(`Event "${eventId}" not found`);
    const chapter = Math.max(1, Math.ceil(event.narrativeOrder / 3));
    const result = aggregator.validate(event, state, ctx.registry, ctx.events, chapter, overrides);
    return { errors: result.errors, warnings: result.warnings };
  }

  const results = aggregator.validateAll(ctx.events, state, ctx.registry, overrides);
  const allErrors: ValidationIssue[] = [];
  const allWarnings: ValidationIssue[] = [];
  for (const [, r] of results) {
    allErrors.push(...r.errors);
    allWarnings.push(...r.warnings);
  }
  return { errors: allErrors, warnings: allWarnings };
}

// ============================================================================
// mcp_nova_iss — Get ISS score
// ============================================================================

export function mcpNovaIss(projectPath: string) {
  const ctx = initializeContext(projectPath);

  const threads = ctx.data.worldInitialState?.threads ?? [];
  const issResult = calculateISS({
    projectDir: projectPath,
    entityRegistry: ctx.registry,
    events: ctx.events,
    threads: threads.map((t) => ({ id: t.id, name: t.name })),
    rules: ctx.data.rules,
  });

  const antiPatterns = detectAntiPatterns({
    projectDir: projectPath,
    entityRegistry: ctx.registry,
    events: ctx.events,
    threads: threads.map((t) => ({ id: t.id, name: t.name })),
    rules: ctx.data.rules,
  });

  return { iss: issResult, antiPatterns };
}

// ============================================================================
// mcp_nova_read_state — Get current world state for an entity
// ============================================================================

export function mcpNovaReadState(projectPath: string, entityId?: string) {
  const ctx = initializeContext(projectPath);
  const state = ctx.stateManager.getCurrentState();

  if (entityId) {
    return {
      entity: ctx.registry.resolve(entityId),
      state: state.entities[entityId] ?? {},
      knowledge: state.knowledge[entityId] ?? { knownFacts: [] },
    };
  }

  return {
    entities: state.entities,
    relationships: state.relationships,
    threads: state.threads,
    rules: state.rules,
  };
}

// ============================================================================
// mcp_nova_thread_status — Get thread progress
// ============================================================================

export function mcpNovaThreadStatus(projectPath: string, threadId?: string) {
  const ctx = initializeContext(projectPath);
  const state = ctx.stateManager.getCurrentState();

  if (threadId) {
    return state.threads[threadId] ?? null;
  }

  return state.threads;
}

// ============================================================================
// mcp_nova_render — Compile context for rendering
// ============================================================================

export function mcpNovaRender(projectPath: string, eventId: string) {
  const ctx = initializeContext(projectPath);

  const targetEvent = ctx.events.find((e) => e.id === eventId);
  if (!targetEvent) throw new Error(`Event "${eventId}" not found`);

  const state = ctx.stateManager.getStateAt(targetEvent.narrativeOrder - 1);
  const compiler = new ContextCompiler();
  const pkg = compiler.compile(targetEvent, state, ctx.registry);

  return {
    contextPackage: pkg,
    markdown: pkg.markdown,
    characterCount: pkg.characterSnapshots.length,
    worldFactCount: pkg.worldFacts.length,
    threadCount: pkg.activeThreads.length,
  };
}

// ============================================================================
// mcp_nova_assemble — Assemble the novel
// ============================================================================

export function mcpNovaAssemble(projectPath: string, outputPath?: string) {
  const ctx = initializeContext(projectPath);
  return assembleNovel({
    projectDir: projectPath,
    outputPath,
    title: ctx.data.config?.title,
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

export function createMCPServer(projectPath: string) {
  return {
    tools: {
      nova_status: () => mcpNovaStatus(projectPath),
      nova_validate: (eventId?: string) => mcpNovaValidate(projectPath, eventId),
      nova_iss: () => mcpNovaIss(projectPath),
      nova_read_state: (entityId?: string) => mcpNovaReadState(projectPath, entityId),
      nova_thread_status: (threadId?: string) => mcpNovaThreadStatus(projectPath, threadId),
      nova_render: (eventId: string) => mcpNovaRender(projectPath, eventId),
      nova_assemble: (outputPath?: string) => mcpNovaAssemble(projectPath, outputPath),
    },
  };
}
