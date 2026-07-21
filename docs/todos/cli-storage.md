# cli-storage: CLI command paths and storage abstraction audit

## Group Status: [-] in progress — CLI-5 [x]; CLI-3, CLI-4, STORAGE-2 open

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| CLI-5 | [x] | — | `docs/TODO.md` lines 1316-1322 — removed unused InMemoryEntityRegistry import + registry creation in review command; build + cli tests green |
| STORAGE-2 | [ ] | — | `docs/TODO.md` lines 1259-1274 — audit all I/O call points for direct `fs` usage bypassing `Storage` abstraction |
| CLI-4 | [ ] | API-1 [x] ✅ | `docs/TODO.md` lines 1306-1314 — `commit` command duplicates `initializeProject()` logic; refactor to call shared init |
| CLI-3 | [ ] | API-2 [x] ✅ | `docs/TODO.md` lines 1296-1304 — `diff` command output format verification; test `nova diff E1` readability |

## Group-level dependencies
- **api-core-validator**: API-1 [x] ✅ (project cache), API-2 [x] ✅ (story boundaries) — both done, CLI-3/4 unblocked.

## Sub-plan

### STORAGE-2: Full module I/O audit — replace direct fs with Storage abstraction

**Scope**: Audit every core module and CLI entry point for direct `node:fs` usage that should go through the `Storage` interface. The `Storage` interface (storage/types.ts) provides: `exists`, `read`, `readOptional`, `write`, `commitBatch`, `mkdirp`, `list`, `listFiles`, `remove`, `removeAll`. `FsStorage` and `MemoryStorage` implement it.

**Known violations to fix**:
1. **`packages/core/src/api.ts`** — `getProjectStatus()` lines 558-569: uses `fs.existsSync(scenesDir)`, `fs.readdirSync(scenesDir, {withFileTypes:true})`, `fs.readdirSync(dirPath).filter(...)`. These should use `storage.exists()`, `storage.list()`, `storage.listFiles()`.
   - Also `computeProjectHash()` lines 66-84: `fs.existsSync`, `fs.readdirSync`, `fs.readFileSync` — should use Storage.
   - Also `renderNovel()` line 336: `fs.mkdirSync(dryRunDir, {recursive:true})` — should use `storage.mkdirp()`.
   - Also `initializeProject()` — uses `new EntityMapper(projectDir)` which internally uses fs. This is acceptable IF EntityMapper is the abstraction layer. Check if EntityMapper uses Storage or direct fs.

2. **`packages/cli/src/index.ts`** — line 6: `import * as fs from 'node:fs'`. Check all usages. The CLI is the top-level entry point; some direct fs may be acceptable for CLI-specific concerns (reading `.env`, checking CWD). But file-writing operations should go through Storage.

3. **`packages/core/src/entity/mapper.ts`** — check if `EntityMapper` uses `fs` directly or via `readYamlFile`/Storage.

4. **`packages/core/src/assembler/novel.ts`** — `output/novel.md` write — check if via Storage.

5. **`packages/core/src/pipeline/output.ts`** — scene file writes — check if via Storage.

6. **`packages/core/src/reporter/validation-reporter.ts`** — `output/validation.md` write — check if via Storage.

**Approach**:
- The `api.ts` functions currently don't receive a `Storage` parameter. They construct paths from `projectDir` and use `fs` directly. The fix: add an optional `storage?: Storage` parameter to `getProjectStatus()`, `renderNovel()`, and `initializeProject()`. Default to `new FsStorage()` when not provided (backward compat). Replace all `fs.*` calls with `storage.*` calls.
- For `computeProjectHash`, either accept a `Storage` parameter or move the hashing into `initializeProject` where Storage is available.
- For CLI: the CLI creates `FsStorage` (already imported at line 18) and passes it to API functions.
- For modules that already accept `Storage` (render-cache, snapshot, event-store): verify no direct fs leaks remain.

**Target files** (primary):
- `packages/core/src/api.ts` — add `storage?: Storage` param, replace fs calls
- `packages/cli/src/index.ts` — pass `new FsStorage()` to API calls, remove direct fs where possible

**Target files** (audit-only, fix if needed):
- `packages/core/src/entity/mapper.ts`
- `packages/core/src/assembler/novel.ts`
- `packages/core/src/pipeline/output.ts`
- `packages/core/src/reporter/validation-reporter.ts`

**Edge cases**:
- `fs.existsSync` → `storage.exists()` (return type matches: boolean)
- `fs.readdirSync(dir, {withFileTypes:true})` → `storage.list(dir)` returns `DirEntry[]` with `isFile()`/`isDirectory()`
- `fs.readFileSync(path)` → `storage.read(path)` (throws if missing, same semantics)
- `fs.mkdirSync(dir, {recursive:true})` → `storage.mkdirp(dir)`
- `fs.readdirSync(dir).filter(f => f.endsWith('.md'))` → `storage.listFiles(dir).filter(f => f.endsWith('.md'))`

**Acceptance**: `npm run build` green, `npx vitest run --exclude '**/e2e.test.ts'` green, `grep -r "from 'node:fs'" packages/core/src/api.ts` returns no matches (or only in Storage-backed helpers), zhu-fu validate + render dry-run still work.

### CLI-4: commit command — use initializeProject instead of inline duplication

**Scope**: The `commit` command (cli/src/index.ts ~line 541) creates its own `EntityMapper` + `StateManager`, duplicating `initializeProject()` in api.ts. Refactor to call the shared init.

**Target file**: `packages/cli/src/index.ts`

**Steps**:
1. Find the `commit` command (search for `.command('commit')`).
2. Read the full command body to understand what it does beyond init.
3. Replace inline `new EntityMapper(projectDir)` + `mapper.loadProject()` + `mapper.loadAllEvents()` + `new StateManager(...)` + `stateManager.initialize(events)` with `const { mapper, data, events, stateManager } = initializeProject(projectDir)`.
4. Import `initializeProject` from `@novalistically/core` (may need to export it from core's index.ts if not already exported).
5. If the commit command does something `initializeProject` doesn't (e.g., creating snapshots), keep that logic but use the shared init for the common setup.

**Check**: Is `initializeProject` exported from `@novalistically/core`? If not, either export it or extract the shared logic to a CLI-local helper.

**Acceptance**: `npm run build` green, `nova commit` still works on zhu-fu fixture, no duplicated init logic.

### CLI-3: diff command — verify output format readability

**Scope**: The `diff` command uses `diffEvent()` API (already verified correct) but CLI output uses `JSON.stringify` for before/after values. Verify the output is readable for nested objects; improve formatting if needed.

**Target file**: `packages/cli/src/index.ts`

**Steps**:
1. Find the `diff` command (search for `.command('diff')`).
2. Read the full command body.
3. Check output format: if it uses `JSON.stringify(value)` for before/after, consider using `JSON.stringify(value, null, 2)` for nested objects, or a key-by-key diff format.
4. Test with `node packages/cli/dist/index.js diff E1` in `fixtures/zhu-fu/` (requires build first).
5. If output is readable → mark done with evidence. If not → improve formatting.

**Acceptance**: `nova diff E1` on zhu-fu produces readable output showing changed attributes with clear before/after values.

## Evidence
—
