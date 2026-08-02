# Fabula

Fabula is a narrative-engineering system: structured author YAML becomes canonical story state, controlled render context, two-pass scene output, and output-level validation before assembly.

**Verified current status:** [docs/current-state.md](docs/current-state.md). It is the operational source of truth; this README is a concise entry point.

## Current baseline

| Area | Verified state |
| --- | --- |
| Packages | `@novalistically/core`, `@novalistically/node-host`, `@novalistically/bench`, `@novalistically/cli`, `@novalistically/workbench` |
| Validation | 28 built-in validators; GreyLine is explicit opt-in |
| Pass 2 | A 20-field static analysis-content schema, validated separately from Pass 1 prose |
| Root tests | 2,881 passing tests |
| Workbench | Host: 367 passing tests; Client: 36 passing tests |
| Checks | typecheck, build, bundle, and public-API checks pass; lint has zero errors |

Test counts and implementation detail evolve. Consult [docs/current-state.md](docs/current-state.md) before relying on them for planning or review.

## System boundary

```mermaid
flowchart LR
  A[Author YAML] --> H[Node Host snapshot and ports]
  H --> C[Core semantic pipeline]
  C --> P1[Pass 1 prose]
  P1 --> P2[Pass 2 structured analysis]
  P2 --> V[Validators and release gate]
  V --> O[Host-owned materialization]
```

- **Core** is deterministic and pure: it owns narrative semantics, schemas, graphs, prompts, render coordination, and validator contracts. It performs no filesystem, Git, SQLite, process, or provider I/O.
- **Node Host** owns snapshot storage, provider execution, operations, cache materialization, and diagnostics.
- **CLI** owns the `commander` command and Host-bound MCP entry points over Node Host adapters.
- **Workbench Host** owns collaborative editing, Yjs, SQLite, authentication, scoped agent capabilities, and Git-backed authoring history.
- Git is Workbench authoring history only. It is not a Core revision model.

See [docs/architecture.md](docs/architecture.md) and [docs/reference/wiring.md](docs/reference/wiring.md) for the complete boundary and runtime flow.

## Packages

| Package | Purpose |
| --- | --- |
| [`packages/core`](packages/core) | Pure narrative domain, schema validation, graph/state compilation, rendering contracts, validators |
| [`packages/node-host`](packages/node-host) | Concrete filesystem/provider/operation/cache adapters and Host services |
| [`packages/bench`](packages/bench) | Functional and performance benchmarks |
| [`packages/cli`](packages/cli) | Command-line and MCP entry points over Node Host |
| [`packages/workbench`](packages/workbench) | Browser-first collaborative authoring Host and client |

## Authoring topology

A project is path-specific, not a generic definitions/events blob:

```text
nova.yaml
definitions/
  state_initial.yaml
  entity-types.yaml
  characters/ locations/ items/ factions/ relationships/ rules/ narrators/ assertions/
discourse-ledger.yaml                         # optional
chapters/chapter_NN/
  _chapter.yaml                               # optional
  E*.yaml
```

`definitions/state_initial.yaml` and `definitions/entity-types.yaml` are required. `discourse-ledger.yaml` and chapter `_chapter.yaml` files are optional; role-based entity directories are loaded separately. See [YAML Contract Reference](docs/reference/yaml-contract/README.md) for the full format.

## Agent guidance and durable memory

- [AGENTS.md](AGENTS.md) is the repository-wide operational contract: boundaries, commands, source topology, and invariants.
- [`agents/`](agents/) contains role-specific prompt contracts. [Scribe](agents/scribe/prompt.md) is Pass 1 only: it emits prose and never analysis, state mutations, or validator decisions.
- Keep durable architectural invariants in `AGENTS.md`; keep verified, time-sensitive repository facts in [docs/current-state.md](docs/current-state.md). Do not duplicate volatile test counts or implementation status into model prompts.

## Start and use the CLI

### Install and build

The workspace requires Node `26.5.0` through `fnm`.

```bash
git clone <repository-url> fabula
cd fabula
fnm exec --using=26.5.0 -- npm install
fnm exec --using=26.5.0 -- npm run build
fnm exec --using=26.5.0 -- npx nova --help
```

### Create and inspect an authoring project

```bash
# Create a minimal valid project without Git history.
npx nova project init my-novel
cd my-novel

# Validate the complete source snapshot, inspect progress, and export its DAG.
npx nova validate
npx nova status
npx nova graph --format mermaid

# Inspect source documents before changing them.
npx nova source list
npx nova entity list character
```

`project init` creates `nova.yaml`, the required initial-state and entity-type files, a narrator, an optional discourse ledger, and a first chapter/event. `validate` must pass before treating a project as render-ready.

### Render deliberately

`nova render` defaults to the `ai-sdk` provider. Configure it explicitly in the invoking shell; the CLI does **not** auto-load `.env`.

```bash
export NOVALISTICALLY_AI_API_KEY='<provider-key>'
export NOVALISTICALLY_AI_BASE_URL='https://your-openai-compatible-endpoint/v1' # optional
export NOVALISTICALLY_AI_MODEL='your-model'                                    # optional

npx nova render E1
npx nova render --chapter 1
npx nova render --all
```

For deterministic reference rendering instead of a live provider, supply both the mock provider and a directory containing `<eventId>.json` entries shaped as `{ "prose": "...", "analysis": { ... } }`. The data must match the current project's event contracts; do not reuse another fixture's recordings. Render exits nonzero whenever the release gate leaves a scene unreleased, regardless of provider.

```bash
npx nova render E1 --provider mock-pass2 --reference-dir path/to/matching-reference-data
```

Use `source preview` before `source apply`; the latter writes through source-hash CAS:

```bash
npx nova source preview definitions/characters/narrator.yaml narrator-draft.yaml
npx nova source apply definitions/characters/narrator.yaml narrator-draft.yaml
```

## Development

The workspace requires Node `26.5.0` through `fnm`.

```bash
fnm exec --using=26.5.0 -- npm install
fnm exec --using=26.5.0 -- npm test
fnm exec --using=26.5.0 -- npm run typecheck
fnm exec --using=26.5.0 -- npm run build
fnm exec --using=26.5.0 -- npm run lint
fnm exec --using=26.5.0 -- npm run bench
```

CLI configuration is explicit; it does not auto-load `.env`. See [docs/reference/cli.md](docs/reference/cli.md).

## Documentation

- [Current verified state](docs/current-state.md)
- [Documentation index](docs/README.md)
- [Core/Host architecture](docs/architecture.md)
- [Runtime wiring](docs/reference/wiring.md)
- [YAML Contract Reference](docs/reference/yaml-contract/README.md)
- [CLI reference](docs/reference/cli.md)

Historical documents are explicitly marked under [`docs/archive/`](docs/archive/); they are not implementation authority.

## Fixtures

- `fixtures/most-dangerous-game/` — English, 6 scenes / 3 chapters
- `fixtures/arcane-aftermath/` — Chinese, 2 events
- `fixtures/zhu-fu/` and `fixtures/zhu-fu-variants/` — regression and variation suites
- `fixtures/dream-of-red-chamber/` — 36 events (`E01`–`E36`) across 4 chapters

## License

MIT
