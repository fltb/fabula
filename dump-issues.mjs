// ============================================================================
// Dump all validation issues from zhu-fu fixture
// ============================================================================
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  EntityMapper,
  InMemoryEntityRegistry,
  ResultAggregator,
  ReplayEngine,
} from '@novalistically/core';

const FIXTURE = path.resolve(
  '/home/float/myfile/Projects/novalistically/fixtures/zhu-fu',
);

// 1. Load entities
const mapper = new EntityMapper(FIXTURE);
const projectData = mapper.loadProject();
const registry = new InMemoryEntityRegistry();
registry.load(FIXTURE);

// 2. Load events
const allEvents = mapper.loadAllEvents(projectData.chapters);

// 3. Replay state
const replay = new ReplayEngine();
const state = replay.replay(allEvents);

// 4. Run all validators
const aggregator = new ResultAggregator();
const results = aggregator.validateAll(allEvents, state, registry);

// 5. Dump every issue
let totalErrors = 0;
let totalWarnings = 0;
let totalInfos = 0;

for (const [eventId, result] of results) {
  const allIssues = [...result.errors, ...result.warnings, ...result.infos];
  for (const issue of allIssues) {
    const sev = issue.severity.padEnd(7);
    console.log(
      `${sev} | validator=${issue.validator.padEnd(30)} | event=${issue.event.padEnd(20)} | entity=${issue.entity.padEnd(20)} | msg=${issue.message}`,
    );
    if (issue.attribute) {
      console.log(`       attribute=${issue.attribute}`);
    }
    if (issue.fixSuggestion) {
      console.log(`       fix=${issue.fixSuggestion}`);
    }
    if (issue.fixTarget?.file) {
      console.log(`       file=${issue.fixTarget.file}`);
    }
    console.log('');
  }
  totalErrors += result.errors.length;
  totalWarnings += result.warnings.length;
  totalInfos += result.infos.length;
}

console.log('='.repeat(80));
console.log(`TOTAL: Errors=${totalErrors}, Warnings=${totalWarnings}, Infos=${totalInfos}`);
console.log(`Events validated: ${results.size}`);
