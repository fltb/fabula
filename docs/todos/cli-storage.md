# cli-storage: CLI command paths and storage abstraction audit

## Group Status: [x] complete — all 4 items done. Build+test green (1400/1400).

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| CLI-5 | [x] | — | `docs/TODO.md` lines 1316-1322 — removed unused InMemoryEntityRegistry import + registry creation in review command; build + cli tests green |
| STORAGE-2 | [x] | — | `docs/TODO.md` lines 1259-1274 — audited 7 modules; fixed api.ts (computeProjectHash, getProjectStatus, renderNovel dry-run) to use Storage; mapper/novel/output/reporters confirmed Storage-backed; validation-reporter.ts violation deferred |
| CLI-4 | [x] | API-1 [x] ✅ | `docs/TODO.md` lines 1306-1314 — commit command refactored to use initializeProject; exported from core index; build green |
| CLI-3 | [x] | API-2 [x] ✅ | `docs/TODO.md` lines 1296-1304 — diffEvent migrated to compileStoryBoundaries (fixes timeAnchors crash); `nova diff E1` on zhu-fu outputs 5 readable attribute changes; build+test green |

## Group-level dependencies
- **api-core-validator**: API-1 [x] ✅ (project cache), API-2 [x] ✅ (story boundaries) — both done, CLI-3/4 unblocked.

## Sub-plan

### STORAGE-2: Full module I/O audit — replace direct fs with Storage abstraction

**Scope**: Two phases — (1) AUDIT every core module and CLI entry point for direct `node:fs` usage, (2) FIX violations by routing through `Storage` interface.

**Storage interface** (storage/types.ts): `exists`, `read`, `readOptional`, `write`, `commitBatch`, `mkdirp`, `list`, `listFiles`, `remove`, `removeAll`. `FsStorage` and `MemoryStorage` implement it.

#### Phase 1: AUDIT (grep-based, produces a checklist)

Each module must be checked. For each, the evidence standard is: `grep -n "from 'node:fs'\|require('fs')\|fs\." <file>` output, classified as "Storage-backed" or "direct fs violation".

| Module | File | Evidence standard |
|--------|------|-------------------|
| api.ts | `packages/core/src/api.ts` | `grep -n "fs\." packages/core/src/api.ts` — known violations at lines 336 (mkdirSync), 558-569 (existsSync+readdirSync in getProjectStatus), 66-84 (existsSync+readdirSync+readFileSync in computeProjectHash) |
| CLI | `packages/cli/src/index.ts` | `grep -n "fs\." packages/cli/src/index.ts` — line 6 import; check all call sites |
| EntityMapper | `packages/core/src/entity/mapper.ts` | `grep -n "fs\." packages/core/src/entity/mapper.ts` — check if uses readYamlFile or direct fs |
| assembler | `packages/core/src/assembler/novel.ts` | `grep -n "fs\." packages/core/src/assembler/novel.ts` — check output/novel.md write |
| pipeline output | `packages/core/src/pipeline/output.ts` | `grep -n "fs\." packages/core/src/pipeline/output.ts` — check scene file writes |
| validation reporter | `packages/core/src/reporter/validation-reporter.ts` | `grep -n "fs\." packages/core/src/reporter/validation-reporter.ts` — check output/validation.md write |
| bench reporters | `packages/bench/src/reporters.ts` | `grep -n "fs\." packages/bench/src/reporters.ts` — check output/bench/ writes |
| render-cache | `packages/core/src/cache/render-cache.ts` | Already verified clean by STORAGE-1 — no fs import |
| snapshot | `packages/core/src/state/snapshot.ts` | Already uses Storage — `grep "fs\."` should return 0 (uses `storage.exists/read/write/listFiles`) |
| event-store | `packages/core/src/state/event-store.ts` | Already uses Storage — verify |

#### Phase 2: FIX (only for confirmed violations)

**api.ts fixes**:

1. `getProjectStatus()` (lines 558-569): Replace `fs.existsSync(scenesDir)`, `fs.readdirSync(scenesDir, {withFileTypes:true})`, `fs.readdirSync(dirPath).filter(...)` with Storage calls. Add `storage?: Storage` parameter (default `new FsStorage()`).
   - `fs.existsSync(p)` → `storage.exists(p)`
   - `fs.readdirSync(dir, {withFileTypes:true})` → `storage.list(dir)` (returns `DirEntry[]` with `isDirectory()`)
   - `fs.readdirSync(dir).filter(f => f.endsWith('.md'))` → `storage.listFiles(dir).filter(f => f.endsWith('.md'))`

2. `computeProjectHash()` (lines 66-84): Replace `fs.existsSync`, `fs.readdirSync`, `fs.readFileSync` with Storage calls. Move the function to accept `storage: Storage` parameter or make it part of `initializeProject` where storage is available.
   - `fs.existsSync(p)` → `storage.exists(p)`
   - `fs.readdirSync(dir).sort()` → `storage.listFiles(dir).sort()`
   - `fs.readFileSync(p)` → `storage.read(p)`

3. `renderNovel()` dry-run path (line 336): `fs.mkdirSync(dryRunDir, {recursive:true})` → `storage.mkdirp(dryRunDir)`. Add `storage` to the function (already has `storage?: Storage` in `RenderNovelOptions`).

**CLI fixes**:

4. `packages/cli/src/index.ts`: Check each `fs.*` call site. CLI-specific concerns (reading `.env`, checking CWD) may be acceptable as direct fs. File-writing operations should use Storage. The CLI already imports `FsStorage` (line 18).

**Modules already clean** (verify, don't fix):
- `render-cache.ts` — STORAGE-1 confirmed clean
- `snapshot.ts` — uses `storage.exists/read/write/listFiles`
- `event-store.ts` — verify uses Storage
- `mapper.ts` — verify uses `readYamlFile` (which may or may not be Storage-backed; check implementation)
- `assembler/novel.ts` — verify
- `pipeline/output.ts` — verify
- `reporter/validation-reporter.ts` — verify

**Target files** (primary fix):
- `packages/core/src/api.ts` — add `storage?: Storage` to `getProjectStatus` and `initializeProject`, replace fs calls in `getProjectStatus`, `computeProjectHash`, `renderNovel` dry-run
- `packages/cli/src/index.ts` — pass `new FsStorage()` to API calls

**Edge cases**:
- `storage.list()` returns `DirEntry[]` with `.isDirectory()` — matches `fs.readdirSync({withFileTypes:true})` dirent API
- `storage.read()` throws if file missing — same as `fs.readFileSync` for non-existent files
- Backward compat: `storage` param defaults to `new FsStorage()` so existing callers without the param work unchanged

**Acceptance**: 
- `npm run build` green
- `npx vitest run --exclude '**/e2e.test.ts'` green
- `grep -n "from 'node:fs'" packages/core/src/api.ts` returns 0 (or only in type imports)
- `grep -n "fs\.\(existsSync\|readdirSync\|readFileSync\|mkdirSync\|writeFileSync\)" packages/core/src/api.ts` returns 0
- zhu-fu `nova validate` still works (0 errors, 0 warnings)
- zhu-fu `nova render E0 --dry-run` still works

**Evidence**:
- `grep "fs\.\(existsSync\|readdirSync\|readFileSync\|mkdirSync\)" packages/core/src/api.ts` returns 0 matches
- Per-module audit results: each module's `grep "fs\."` output recorded as "clean" or "fixed"
- `npx vitest run --exclude '**/e2e.test.ts'` full suite green
- zhu-fu fixture validate + render dry-run pass

### CLI-4: commit command — use initializeProject instead of inline duplication

**Scope**: The `commit` command (cli/src/index.ts:559-585) creates its own `EntityMapper` + `StateManager`, duplicating `initializeProject()` in api.ts. Refactor to call the shared init.

**Current code** (cli/src/index.ts:559-585):
```ts
program
  .command('commit')
  .description('Commit current state (auto-run after validation)')
  .action(() => {
    const projectDir = ensureProjectDir();
    const mapper = new EntityMapper(projectDir);
    const data = mapper.loadProject();
    const events = mapper.loadAllEvents(data.chapters);
    if (events.length <= 1) { console.log('Nothing to commit.'); return; }
    const snapshotsDir = path.join(projectDir, '.nova', 'snapshots');
    const stateManager = new StateManager(snapshotsDir);
    for (const event of events) { stateManager.commit(event); }
    const lastEvent = events[events.length - 1];
    console.log(`✅ Committed: ${lastEvent.id} — "${lastEvent.title}"`);
    console.log(`   Narrative order: ${lastEvent.narrativeOrder}`);
  });
```

**Problem**: `initializeProject()` (api.ts:159-203) does the same `EntityMapper` + `StateManager` setup, plus uses the project cache (API-1). The commit command bypasses the cache and may desync.

**Change**:
1. Check if `initializeProject` is exported from `@novalistically/core`. If not, export it from `packages/core/src/index.ts`.
2. Replace the inline init with:
   ```ts
   const { events, stateManager } = initializeProject(projectDir);
   ```
3. Keep the commit loop and output logic. The `events.length <= 1` guard stays.
4. Remove the now-unused `EntityMapper` and `StateManager` imports from CLI if no other command uses them directly. Check with grep first.

**IMPORTANT**: `initializeProject` returns `stateManager` which is already initialized via `stateManager.initialize(events)`. The commit command's `for (const event of events) { stateManager.commit(event); }` loop is the actual commit action — `initialize` sets up the event store, `commit` advances state. Verify this is correct: `StateManager.initialize()` stores events, `StateManager.commit(event)` advances state and creates snapshots. The commit command should still loop through all events.

**Target file**: `packages/cli/src/index.ts` (commit command block, ~line 559-585)

**Acceptance**: `npm run build` green, `nova commit` on zhu-fu fixture works (commits events, creates snapshots), no duplicated init logic.

**Evidence**: 
- `node packages/cli/dist/index.js commit` in `fixtures/zhu-fu/` produces "Committed" output
- `grep -c "new EntityMapper" packages/cli/src/index.ts` returns 0 (if no other command needs it) or documented why it remains
- `npm run build` exit 0

### CLI-3: diff command — verify output format readability

**Scope**: The `diff` command (cli/src/index.ts:537-557) uses `JSON.stringify(result.before[key])` / `JSON.stringify(result.after[key])` for output. Verify readability; improve if needed.

**Current output format** (cli/src/index.ts:550-556):
```ts
console.log(`\nChanges: ${result.changed.length} attributes`);
console.log('━'.repeat(50));
for (const key of result.changed) {
  console.log(`  ${key}:`);
  console.log(`    before: ${JSON.stringify(result.before[key])}`);
  console.log(`    after:  ${JSON.stringify(result.after[key])}`);
}
```

**Steps**:
1. Build the CLI: `npm run build`
2. Run `node packages/cli/dist/index.js diff E1` in `fixtures/zhu-fu/`
3. Check output: if values are simple (strings, numbers, booleans), `JSON.stringify` is fine. If nested objects, use `JSON.stringify(value, null, 2)`.
4. If output is already readable → mark done with evidence (paste the output).
5. If not → change `JSON.stringify(result.before[key])` to `JSON.stringify(result.before[key], null, 2)` for multi-line nested objects. Add a helper that detects nested objects and pretty-prints them.

**Target file**: `packages/cli/src/index.ts` (diff command output, ~line 550-556)

**Acceptance**: `nova diff E1` on zhu-fu produces readable output with clear before/after values.

**Evidence**: Output of `node packages/cli/dist/index.js diff E1` in `fixtures/zhu-fu/` — shows readable attribute changes.

## Evidence

### CLI-5 [x]
- `npm run build` exit 0
- `npx vitest run packages/cli/tests/` — 2 files 2 tests pass

### STORAGE-2
- `grep "fs\.\(existsSync\|readdirSync\|readFileSync\|mkdirSync\)" packages/core/src/api.ts` returns 0
- Per-module audit grep results recorded
- `npx vitest run --exclude '**/e2e.test.ts'` full suite green
- zhu-fu `nova validate` + `nova render E0 --dry-run` pass

### CLI-4
- `node packages/cli/dist/index.js commit` in zhu-fu produces "Committed" output
- `grep -c "new EntityMapper" packages/cli/src/index.ts` — count reduced
- `npm run build` exit 0

### CLI-3
- `node packages/cli/dist/index.js diff E1` output — readable attribute changes
- `npm run build` exit 0
