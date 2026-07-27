#!/usr/bin/env node
// ============================================================================
// zhu-fu-fidelity-report.mjs — Direct original-text fidelity scoring for 祝福
//
// Renders are compared scene-by-scene against fixed, contiguous spans of the
// checked-in original. The headline score is order-preserving Han-character
// LCS-F1: 2 × LCS(render, original) / (render Han + original Han).
//
// Usage:
//   node scripts/zhu-fu-fidelity-report.mjs fixtures/zhu-fu \
//     --render-dir fixtures/zhu-fu/.nova/smoke-candidates/<run> \
//     --label baseline --output /tmp/baseline.md
// ============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/** Fixed narrative spans in reference/original.txt, in discourse order. */
const ORIGINAL_SEGMENTS = Object.freeze({
  E0: {
    start: '旧历的年底毕竟最像年底',
    end: '即使只有我一个……。无论如何，我明天决计要走了。',
  },
  E1: {
    start: '我因为常见些但愿不如所料',
    end: '然而先前所见所闻的她的半生事迹的断片，至此也联成一片了。',
  },
  E2: {
    start: '她不是鲁镇人。',
    end: '她诚然是逃出来的，不多久，这推想就证实了。',
  },
  E3: {
    start: '此后大约十几天',
    end: '从此之后，四婶也就不再提起祥林嫂。',
  },
  E4: {
    start: '但有一年的秋季',
    end: '她单是一瞥他们，并不回答一句话。',
  },
  E5: {
    start: '鲁镇永远是过新年',
    end: '甚而至于常常忘却了去淘米。',
  },
  E6: {
    start: '祥林嫂怎么这样了？倒不如那时不留她。',
    end: '预备给鲁镇的人们以无限的幸福。',
  },
});

function usage() {
  return [
    'Usage: node scripts/zhu-fu-fidelity-report.mjs <fixture-dir> [options]',
    '',
    'Options:',
    '  --render-dir <dir>  Candidate directory containing E*.json prose files.',
    '  --label <name>      Label included in the report (default: current).',
    '  --output <path>     Markdown score report path (default: <fixture>/output/original-fidelity-report.md).',
    '  --json-output <path> Machine-readable metrics path (default: report path with .json).',
    '  --comparison-output <path> Full per-event original/generation/diff report path.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = [...argv];
  let fixtureDir = null;
  let renderDir = null;
  let label = 'current';
  let output = null;
  let jsonOutput = null;
  let comparisonOutput = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (
      arg === '--render-dir' ||
      arg === '--label' ||
      arg === '--output' ||
      arg === '--json-output' ||
      arg === '--comparison-output'
    ) {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--render-dir') renderDir = value;
      if (arg === '--label') label = value;
      if (arg === '--output') output = value;
      if (arg === '--json-output') jsonOutput = value;
      if (arg === '--comparison-output') comparisonOutput = value;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (!fixtureDir) {
      fixtureDir = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!fixtureDir) throw new Error('Fixture directory is required');
  const resolveFromRoot = (candidate) =>
    isAbsolute(candidate) ? candidate : join(REPO_ROOT, candidate);
  const resolvedFixture = resolveFromRoot(fixtureDir);
  const resolvedOutput = output
    ? resolveFromRoot(output)
    : join(resolvedFixture, 'output', 'original-fidelity-report.md');
  const resolvedJsonOutput = jsonOutput
    ? resolveFromRoot(jsonOutput)
    : resolvedOutput.endsWith('.md')
      ? `${resolvedOutput.slice(0, -2)}json`
      : `${resolvedOutput}.json`;

  return {
    fixtureDir: resolvedFixture,
    renderDir: renderDir ? resolveFromRoot(renderDir) : null,
    label,
    output: resolvedOutput,
    jsonOutput: resolvedJsonOutput,
    comparisonOutput: comparisonOutput ? resolveFromRoot(comparisonOutput) : null,
  };
}

function readText(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function readJson(path) {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readYaml(path) {
  const text = readText(path);
  if (text === null) return null;
  try {
    return YAML.parse(text);
  } catch {
    return null;
  }
}

function extractHan(text) {
  return text.match(HAN_RE) ?? [];
}

/**
 * Returns the LCS length using O(min(m, n)) memory. This is the direct,
 * order-preserving character-diff primitive behind the headline score.
 */
function lcsLength(left, right) {
  let shorter = left;
  let longer = right;
  if (left.length > right.length) {
    shorter = right;
    longer = left;
  }

  let previous = new Uint32Array(shorter.length + 1);
  let current = new Uint32Array(shorter.length + 1);
  for (const longChar of longer) {
    for (let column = 1; column <= shorter.length; column++) {
      if (longChar === shorter[column - 1]) {
        current[column] = previous[column - 1] + 1;
      } else {
        current[column] = Math.max(previous[column], current[column - 1]);
      }
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[shorter.length];
}

function bigramSet(chars) {
  const result = new Set();
  for (let index = 1; index < chars.length; index++) {
    result.add(chars[index - 1] + chars[index]);
  }
  return result;
}

function bigramF1(renderChars, originalChars) {
  const renderBigrams = bigramSet(renderChars);
  const originalBigrams = bigramSet(originalChars);
  if (renderBigrams.size === 0 || originalBigrams.size === 0) return null;

  let shared = 0;
  for (const bigram of renderBigrams) {
    if (originalBigrams.has(bigram)) shared++;
  }
  const precision = shared / renderBigrams.size;
  const recall = shared / originalBigrams.size;
  return {
    precision,
    recall,
    score: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

function score(renderText, originalText) {
  const renderChars = extractHan(renderText);
  const originalChars = extractHan(originalText);
  const lcs = lcsLength(renderChars, originalChars);
  const precision = renderChars.length === 0 ? 0 : lcs / renderChars.length;
  const recall = originalChars.length === 0 ? 0 : lcs / originalChars.length;
  const directScore =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const bigram = bigramF1(renderChars, originalChars);

  return {
    renderHan: renderChars.length,
    originalHan: originalChars.length,
    lcs,
    directScore,
    lcsPrecision: precision,
    lcsRecall: recall,
    bigramF1: bigram?.score ?? null,
  };
}

function selectOriginalSegment(originalText, eventId) {
  const selector = ORIGINAL_SEGMENTS[eventId];
  if (!selector) throw new Error(`No original-text selector for ${eventId}`);
  const start = originalText.indexOf(selector.start);
  if (start < 0) throw new Error(`${eventId}: original start marker not found`);
  const endStart = originalText.indexOf(selector.end, start + selector.start.length);
  if (endStart < 0)
    throw new Error(`${eventId}: original end marker not found after its start marker`);
  const segment = originalText.slice(start, endStart + selector.end.length);
  if (!originalText.includes(segment))
    throw new Error(`${eventId}: selected excerpt is not contained in original text`);
  return segment;
}

function discoverEvents(fixtureDir) {
  const chapterDir = join(fixtureDir, 'chapters', 'chapter_01');
  const events = [];
  for (const eventId of Object.keys(ORIGINAL_SEGMENTS)) {
    const names = {
      E0: 'E0_encounter.yaml',
      E1: 'E1_death_news.yaml',
      E2: 'E2_first_arrival.yaml',
      E3: 'E3_kidnapping.yaml',
      E4: 'E4_return_to_lu.yaml',
      E5: 'E5_threshold_rejection.yaml',
      E6: 'E6_expulsion_death.yaml',
    };
    const data = readYaml(join(chapterDir, names[eventId]));
    if (!data || data.event !== eventId || typeof data.narrativeOrder !== 'number') {
      throw new Error(`Could not read canonical event metadata for ${eventId}`);
    }
    events.push({
      eventId,
      title: typeof data.title === 'string' ? data.title : '',
      narrativeOrder: data.narrativeOrder,
    });
  }
  return events.sort((left, right) => left.narrativeOrder - right.narrativeOrder);
}

function readRenderedFixtureScene(fixtureDir, eventId) {
  const sceneDir = join(fixtureDir, 'scenes', 'chapter-01');
  const prose = readText(join(sceneDir, `${eventId}.md`));
  const metadata = readYaml(join(sceneDir, `${eventId}.yaml`));
  if (prose !== null) {
    return {
      prose,
      source: 'scene',
      released: typeof metadata?.released === 'boolean' ? metadata.released : null,
      attempts: typeof metadata?.attempts === 'number' ? metadata.attempts : null,
      validationErrors:
        typeof metadata?.validationErrors === 'number' ? metadata.validationErrors : null,
      validationIssueMessages: Array.isArray(metadata?.validationIssueMessages)
        ? metadata.validationIssueMessages.filter((issue) => typeof issue === 'string')
        : [],
      errorMessages: Array.isArray(metadata?.errors)
        ? metadata.errors.filter((error) => typeof error === 'string')
        : [],
      pass2Rejection: typeof metadata?.pass2Rejection === 'string' ? metadata.pass2Rejection : null,
    };
  }

  const response = readJson(join(fixtureDir, '.nova', 'responses', `${eventId}.json`));
  if (typeof response?.prose === 'string') {
    return {
      prose: response.prose,
      source: 'response',
      released: typeof response.released === 'boolean' ? response.released : null,
      attempts: typeof response.attempts === 'number' ? response.attempts : null,
      validationErrors:
        typeof response.validationErrors === 'number' ? response.validationErrors : null,
      validationIssueMessages: Array.isArray(response.validationIssueMessages)
        ? response.validationIssueMessages.filter((issue) => typeof issue === 'string')
        : [],
      errorMessages: Array.isArray(response.errors)
        ? response.errors.filter((error) => typeof error === 'string')
        : [],
      pass2Rejection: typeof response.pass2Rejection === 'string' ? response.pass2Rejection : null,
    };
  }
  return null;
}

function readRenderedCandidate(renderDir, eventId) {
  const candidate = readJson(join(renderDir, `${eventId}.json`));
  if (typeof candidate?.prose !== 'string') return null;
  return {
    prose: candidate.prose,
    source: 'candidate',
    released: typeof candidate.released === 'boolean' ? candidate.released : null,
    attempts: typeof candidate.metadata?.attempts === 'number' ? candidate.metadata.attempts : null,
    validationErrors:
      typeof candidate.validationErrors === 'number' ? candidate.validationErrors : null,
    validationIssueMessages: Array.isArray(candidate.validationIssueMessages)
      ? candidate.validationIssueMessages.filter((issue) => typeof issue === 'string')
      : [],
    errorMessages: Array.isArray(candidate.errors)
      ? candidate.errors.filter((error) => typeof error === 'string')
      : [],
    pass2Rejection: typeof candidate.pass2Rejection === 'string' ? candidate.pass2Rejection : null,
  };
}

function percent(value) {
  return value === null || value === undefined ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

function integer(value) {
  return value === null || value === undefined ? 'N/A' : value.toLocaleString('en-US');
}

function markdownCell(value) {
  return String(value).replaceAll('|', '\\|');
}

/**
 * Produces an order-preserving, line-level unified diff. Full source and
 * generated passages remain visible in the surrounding sections; this block
 * identifies which exact paragraphs are shared, removed, or added.
 */
function lineDiff(originalText, renderText) {
  const originalLines = originalText.split('\n');
  const renderLines = renderText.split('\n');
  const matrix = Array.from(
    { length: originalLines.length + 1 },
    () => new Uint16Array(renderLines.length + 1),
  );

  for (let row = originalLines.length - 1; row >= 0; row--) {
    for (let column = renderLines.length - 1; column >= 0; column--) {
      matrix[row][column] =
        originalLines[row] === renderLines[column]
          ? matrix[row + 1][column + 1] + 1
          : Math.max(matrix[row + 1][column], matrix[row][column + 1]);
    }
  }

  const lines = [`--- original`, `+++ generated`];
  let row = 0;
  let column = 0;
  while (row < originalLines.length || column < renderLines.length) {
    if (
      row < originalLines.length &&
      column < renderLines.length &&
      originalLines[row] === renderLines[column]
    ) {
      lines.push(`  ${originalLines[row]}`);
      row++;
      column++;
    } else if (
      column === renderLines.length ||
      (row < originalLines.length && matrix[row + 1][column] >= matrix[row][column + 1])
    ) {
      lines.push(`- ${originalLines[row]}`);
      row++;
    } else {
      lines.push(`+ ${renderLines[column]}`);
      column++;
    }
  }
  return lines.join('\n');
}

function reportMarkdown(result) {
  const lines = [
    '# 《祝福》原文直比评分',
    '',
    `- **标签**：${result.label}`,
    `- **时间**：${result.generatedAtCst} CST`,
    `- **生成时间（UTC）**：${result.generatedAt}`,
    `- **渲染来源**：${result.renderDir ?? 'fixture scenes / responses'}`,
    '- **主指标**：汉字序列的 LCS-F1（保序直接 diff；$2 × LCS / (生成汉字数 + 原文汉字数)$）。',
    '- **辅助指标**：去重汉字二元组 F1；用于辨识局部措辞重合，不替代主指标。',
    '- **原文分段**：固定为 `reference/original.txt` 的连续原文区间；每段在运行时用起止锚点验证。',
    '',
    '## 场景评分',
    '',
    '| Event | 标题 | 输出来源 | 生成汉字 | 原文汉字 | LCS | 直接 diff 分 | LCS 精度 | LCS 召回 | 二元组 F1 | Released | Attempts |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
  ];

  for (const event of result.events) {
    lines.push(
      [
        event.eventId,
        markdownCell(event.title),
        event.source,
        integer(event.renderHan),
        integer(event.originalHan),
        integer(event.lcs),
        percent(event.directScore),
        percent(event.lcsPrecision),
        percent(event.lcsRecall),
        percent(event.bigramF1),
        event.released === null ? 'N/A' : String(event.released),
        integer(event.attempts),
      ]
        .map((value) => ` ${value} `)
        .join('|')
        .replace(/^/, '|')
        .replace(/$/, '|'),
    );
  }

  const aggregate = result.aggregate;
  lines.push(
    '',
    '## 全文汇总',
    '',
    `- **场景宏平均 LCS-F1**：${percent(aggregate.macroDirectScore)}`,
    `- **全文 LCS-F1（拼接 E0→E6）**：${percent(aggregate.workDirectScore)}`,
    `- **全文生成 / 原文汉字**：${integer(aggregate.workRenderHan)} / ${integer(aggregate.workOriginalHan)}`,
    `- **全文 LCS**：${integer(aggregate.workLcs)}`,
    `- **全文二元组 F1**：${percent(aggregate.workBigramF1)}`,
    `- **缺失输出场景**：${aggregate.missingEventIds.length === 0 ? '无' : aggregate.missingEventIds.join(', ')}`,
    '',
    'LCS-F1 同时惩罚遗漏（召回）和新增/改写（精度）；它不判断主题是否正确，只量化与原句字序的一致性。',
    '',
  );
  return lines.join('\n');
}

function comparisonMarkdown(result) {
  const lines = [
    '# 《祝福》逐场景原文—生成全文对比',
    '',
    `- **标签**：${result.label}`,
    `- **时间**：${result.generatedAtCst} CST`,
    `- **生成时间（UTC）**：${result.generatedAt}`,
    `- **渲染来源**：${result.renderDir ?? 'fixture scenes / responses'}`,
    '- **读法**：每场依次给出完整原文段、完整生成文本和行级统一 diff。` ` 表示相同行，`-` 只在原文，`+` 只在生成文本。',
    '- **分数**：LCS-F1 是去除非汉字后保序字符的直接 diff；它与下方逐行 diff 一起使用。',
    '',
  ];

  for (const event of result.events) {
    lines.push(
      `## ${event.eventId} — ${event.title}`,
      '',
      `- **LCS-F1**：${percent(event.directScore)}；**LCS**：${integer(event.lcs)}；**生成 / 原文汉字**：${integer(event.renderHan)} / ${integer(event.originalHan)}`,
      `- **Release**：${event.released === null ? 'N/A' : String(event.released)}；**Attempts**：${integer(event.attempts)}；**最终记录的验证错误数**：${integer(event.validationErrors)}`,
      `- **Pass 2 rejection**：${event.pass2Rejection ?? 'N/A'}`,
      '',
    );
    if (event.validationIssueMessages.length > 0) {
      lines.push('- **验证 issue**：');
      for (const issue of event.validationIssueMessages) lines.push(`  - ${issue}`);
      lines.push('');
    }
    if (event.errorMessages.length > 0) {
      lines.push('- **错误链**：');
      for (const error of event.errorMessages) lines.push(`  - ${error}`);
      lines.push('');
    }
    if (
      event.released === false &&
      event.errorMessages.some((error) => error.startsWith('Pass 2 attempt'))
    ) {
      lines.push(
        '- **Gate 原因**：最终 Pass 2 provider exception 令 `analysis === null`；严格 release gate 因此拒绝该场景。',
        '',
      );
    }
    lines.push(
      '### 原文',
      '',
      '```text',
      event.originalText,
      '```',
      '',
      '### 生成文本',
      '',
      '```text',
      event.renderText ?? '(missing)',
      '```',
      '',
      '### 行级统一 diff',
      '',
      '```diff',
      lineDiff(event.originalText, event.renderText ?? ''),
      '```',
      '',
    );
  }

  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.fixtureDir))
    throw new Error(`Fixture directory not found: ${args.fixtureDir}`);
  if (args.renderDir && !existsSync(args.renderDir))
    throw new Error(`Render directory not found: ${args.renderDir}`);

  const originalPath = join(args.fixtureDir, 'reference', 'original.txt');
  const originalText = readText(originalPath);
  if (originalText === null) throw new Error(`Original text not found: ${originalPath}`);

  const events = discoverEvents(args.fixtureDir);
  const originalSegments = new Map(
    events.map((event) => [event.eventId, selectOriginalSegment(originalText, event.eventId)]),
  );
  const metrics = [];
  const comparisons = [];
  const missingEventIds = [];
  let aggregateRender = '';
  let aggregateOriginal = '';

  for (const event of events) {
    const rendered = args.renderDir
      ? readRenderedCandidate(args.renderDir, event.eventId)
      : readRenderedFixtureScene(args.fixtureDir, event.eventId);
    const originalSegment = originalSegments.get(event.eventId);
    if (!rendered) {
      missingEventIds.push(event.eventId);
      const missingMetric = {
        ...event,
        source: 'missing',
        renderHan: 0,
        originalHan: extractHan(originalSegment).length,
        lcs: 0,
        directScore: 0,
        lcsPrecision: 0,
        lcsRecall: 0,
        bigramF1: null,
        released: null,
        attempts: null,
        validationErrors: null,
        validationIssueMessages: [],
        errorMessages: [],
        pass2Rejection: null,
      };
      metrics.push(missingMetric);
      comparisons.push({ ...missingMetric, originalText: originalSegment, renderText: null });
      continue;
    }

    const sceneScore = score(rendered.prose, originalSegment);
    const metric = { ...event, ...rendered, ...sceneScore };
    metrics.push(metric);
    comparisons.push({ ...metric, originalText: originalSegment, renderText: rendered.prose });
    aggregateRender += rendered.prose;
    aggregateOriginal += originalSegment;
  }

  const work = score(aggregateRender, aggregateOriginal);
  const macroDirectScore =
    metrics.reduce((sum, event) => sum + event.directScore, 0) / metrics.length;
  const reportTime = new Date();
  const result = {
    version: 1,
    label: args.label,
    generatedAt: reportTime.toISOString(),
    generatedAtCst: reportTime.toLocaleString('sv-SE', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    }),
    fixtureDir: args.fixtureDir,
    renderDir: args.renderDir,
    events: metrics,
    aggregate: {
      macroDirectScore,
      workDirectScore: work.directScore,
      workRenderHan: work.renderHan,
      workOriginalHan: work.originalHan,
      workLcs: work.lcs,
      workBigramF1: work.bigramF1,
      missingEventIds,
    },
  };

  mkdirSync(dirname(args.output), { recursive: true });
  mkdirSync(dirname(args.jsonOutput), { recursive: true });
  writeFileSync(args.output, reportMarkdown(result));
  writeFileSync(args.jsonOutput, `${JSON.stringify(result, null, 2)}\n`);
  if (args.comparisonOutput) {
    mkdirSync(dirname(args.comparisonOutput), { recursive: true });
    writeFileSync(args.comparisonOutput, comparisonMarkdown({ ...result, events: comparisons }));
  }

  console.log(`Scored ${metrics.length} scenes (${args.label}).`);
  console.log(`  Work LCS-F1: ${percent(result.aggregate.workDirectScore)}`);
  console.log(`  Report: ${relative(REPO_ROOT, args.output)}`);
  console.log(`  Metrics: ${relative(REPO_ROOT, args.jsonOutput)}`);
  if (args.comparisonOutput) {
    console.log(`  Comparison: ${relative(REPO_ROOT, args.comparisonOutput)}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  console.error(usage());
  process.exit(1);
}
