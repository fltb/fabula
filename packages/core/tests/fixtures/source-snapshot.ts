// ============================================================================
// Test Fixture — Immutable ProjectSourceSnapshotV1 construction
// ============================================================================
// Shared deterministic builder for the frozen source contract. It creates
// logical-POSIX documents sorted by logicalPath, SHA-256 content/source
// hashes, JSON-safe parse results and diagnostics derived from the supplied
// text, plus pure helpers to alter source bytes (each producing a fresh
// snapshot with a recomputed sourceHash).
//
// Parse-result and diagnostic semantics mirror `src/entity/source-analysis.ts`
// (the canonical reference; keep the topology rules in sync with it). The
// fixture never touches MemoryStorage, project paths, or the Node filesystem.
// ============================================================================

import YAML from 'yaml';
import type { ZodType } from 'zod/v3';
import type {
  ProjectSourceSnapshotV1,
  SourceChangeV1,
  SourceDiagnosticV1,
  SourceDocumentV1,
  SourceParseResultV1,
} from '../../src/contracts/source.ts';
import {
  chapterMetadataSchema,
  characterDefinitionSchema,
  eventFileSchema,
  factionDefinitionSchema,
  itemDefinitionSchema,
  locationDefinitionSchema,
  narratorAssertionSchema,
  narratorProfileSchema,
  plannedDiscourseLedgerSourceSchema,
  projectConfigSchema,
  relationshipDeclarationSchema,
  ruleDeclarationSchema,
  worldInitialStateSchema,
} from '../../src/schemas/index.ts';
import {
  buildSourceSnapshot,
  computeSourceDocumentHash,
} from '../../src/source/source-identity.ts';

// ── Authoring topology (mirrors source-analysis.ts) ─────────────────────────

interface TopologyRule {
  readonly re: RegExp;
  readonly schema: ZodType<unknown> | null;
}

const TOPOLOGY_RULES: readonly TopologyRule[] = [
  { re: /^nova\.yaml$/, schema: projectConfigSchema },
  { re: /^definitions\/state_initial\.yaml$/, schema: worldInitialStateSchema },
  { re: /^definitions\/entity-types\.yaml$/, schema: null },
  { re: /^definitions\/thread-types\.yaml$/, schema: null },
  { re: /^definitions\/propositions\.yaml$/, schema: null },
  { re: /^definitions\/relationship-types\.yaml$/, schema: null },
  { re: /^definitions\/rule-types\.yaml$/, schema: null },
  {
    re: /^definitions\/(characters|locations|items|factions|relationships|rules|narrators|assertions)\/[^/]+\.(yaml|yml)$/,
    schema: null,
  },
  { re: /^definitions\/discourse-ledger\.yaml$/, schema: plannedDiscourseLedgerSourceSchema },
  { re: /^chapters\/chapter_\d{2}\/_chapter\.yaml$/, schema: chapterMetadataSchema },
  { re: /^chapters\/chapter_\d{2}\/E[^/]+\.(yaml|yml)$/, schema: eventFileSchema },
];

const SCHEMA_BY_DIRECTORY: Record<string, ZodType<unknown>> = {
  characters: characterDefinitionSchema,
  locations: locationDefinitionSchema,
  items: itemDefinitionSchema,
  factions: factionDefinitionSchema,
  relationships: relationshipDeclarationSchema,
  rules: ruleDeclarationSchema,
  narrators: narratorProfileSchema,
  assertions: narratorAssertionSchema,
};

function ruleFor(logicalPath: string): TopologyRule | null {
  const rule = TOPOLOGY_RULES.find((candidate) => candidate.re.test(logicalPath)) ?? null;
  if (rule && logicalPath.startsWith('definitions/')) {
    const directory = logicalPath.split('/')[1];
    if (directory in SCHEMA_BY_DIRECTORY)
      return { ...rule, schema: SCHEMA_BY_DIRECTORY[directory] };
  }
  return rule;
}

/** True when the logical path is inside the frozen authoring topology. */
export function isAuthoringPath(logicalPath: string): boolean {
  return ruleFor(logicalPath) !== null;
}

// ── Hashing (canonical identity semantics) ──────────────────────────────────
//
// Document and project hashes come from the single canonical pure
// implementation in `src/source/source-identity.ts` (exported as
// `computeSourceDocumentHash` / `computeSourceHash` / `buildSourceSnapshot`).
// Fixture-built snapshots therefore carry exactly the same content identity
// as Core source analysis and Node Host materializers.

// ── JSON-safe parse results and diagnostics ─────────────────────────────────

type JsonValueLike =
  | string
  | number
  | boolean
  | null
  | JsonValueLike[]
  | { [key: string]: JsonValueLike };

function toJsonValue(value: unknown): JsonValueLike | null {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return value;
  if (Array.isArray(value)) {
    const out: JsonValueLike[] = [];
    for (const item of value) {
      const converted = toJsonValue(item);
      if (converted === null && item !== null) return null;
      out.push(converted);
    }
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, JsonValueLike> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const converted = toJsonValue(item);
      if (converted === null && item !== null) return null;
      out[key] = converted;
    }
    return out;
  }
  return null;
}

function diagnostic(
  code: string,
  severity: SourceDiagnosticV1['severity'],
  message: string,
  logicalPath: string | null,
): SourceDiagnosticV1 {
  return { code, severity, message, logicalPath };
}

/** Derive the JSON-safe parse result and diagnostics for one logical document. */
export function parseSourceDocument(
  logicalPath: string,
  content: string,
): { parseResult: SourceParseResultV1; diagnostics: readonly SourceDiagnosticV1[] } {
  const rule = ruleFor(logicalPath);
  if (!rule) return { parseResult: { status: 'not_applicable', value: null }, diagnostics: [] };
  try {
    const parsed = YAML.parse(content);
    const value = toJsonValue(parsed);
    if (value === null && parsed !== null) throw new Error('non-json value');
    const diagnostics: SourceDiagnosticV1[] = [];
    if (rule.schema) {
      const checked = rule.schema.safeParse(parsed);
      if (!checked.success) {
        diagnostics.push(
          diagnostic(
            'SOURCE_SCHEMA_INVALID',
            'error',
            checked.error.issues
              .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
              .join('; '),
            logicalPath,
          ),
        );
      }
    }
    return {
      parseResult: { status: diagnostics.length ? 'invalid' : 'parsed', value },
      diagnostics,
    };
  } catch (error) {
    return {
      parseResult: { status: 'invalid', value: null },
      diagnostics: [
        diagnostic(
          'SOURCE_YAML_INVALID',
          'error',
          `YAML parsing failed: ${error instanceof Error ? error.message : 'invalid document'}`,
          logicalPath,
        ),
      ],
    };
  }
}

// ── Snapshot construction ───────────────────────────────────────────────────

/** Build one sorted, hashed, JSON-safe source document from logical text. */
export function createSourceDocument(logicalPath: string, content: string): SourceDocumentV1 {
  const { parseResult, diagnostics } = parseSourceDocument(logicalPath, content);
  return {
    version: 1,
    logicalPath,
    content,
    contentHash: computeSourceDocumentHash(content),
    parseResult,
    diagnostics: [...diagnostics],
  };
}

/**
 * Build an immutable ProjectSourceSnapshotV1 from `{ logicalPath: content }`
 * entries. Documents are sorted by logicalPath; contentHash and sourceHash are
 * canonical SHA-256 identities; parse results and diagnostics are derived from
 * the supplied text (invalid YAML stays an invalid document, never a throw).
 */
export function createSourceSnapshot(
  entries: Readonly<Record<string, string>>,
): ProjectSourceSnapshotV1 {
  const documents = Object.entries(entries).map(([logicalPath, content]) =>
    createSourceDocument(logicalPath, content),
  );
  return buildSourceSnapshot(documents);
}

/** Wrap externally built documents into a canonical snapshot (sorted + rehashed). */
export function toSourceSnapshot(documents: readonly SourceDocumentV1[]): ProjectSourceSnapshotV1 {
  return buildSourceSnapshot(documents);
}

/** Extract the `{ logicalPath: content }` map back out of a snapshot. */
export function sourceEntryMap(snapshot: ProjectSourceSnapshotV1): Record<string, string> {
  return Object.fromEntries(
    snapshot.documents.map((document) => [document.logicalPath, document.content]),
  );
}

// ── Pure source alteration (fresh snapshots, recomputed sourceHash) ─────────

/** Replace or add one logical document, returning a fresh snapshot. */
export function withDocument(
  snapshot: ProjectSourceSnapshotV1,
  logicalPath: string,
  content: string,
): ProjectSourceSnapshotV1 {
  return buildSourceSnapshot([
    ...snapshot.documents.filter((document) => document.logicalPath !== logicalPath),
    createSourceDocument(logicalPath, content),
  ]);
}

/** Remove one logical document, returning a fresh snapshot. */
export function withoutDocument(
  snapshot: ProjectSourceSnapshotV1,
  logicalPath: string,
): ProjectSourceSnapshotV1 {
  return buildSourceSnapshot(
    snapshot.documents.filter((document) => document.logicalPath !== logicalPath),
  );
}

// ── SourceChangeV1 construction for analyzeSource inputs ────────────────────

/** Build a SourceChangeV1 against `snapshot`; `afterContent: null` means delete. */
export function toSourceChange(
  snapshot: ProjectSourceSnapshotV1,
  logicalPath: string,
  afterContent: string | null,
): SourceChangeV1 {
  const before =
    snapshot.documents.find((document) => document.logicalPath === logicalPath) ?? null;
  return {
    logicalPath,
    beforeContent: before?.content ?? null,
    beforeHash: before?.contentHash ?? null,
    afterContent,
    afterHash: afterContent === null ? null : computeSourceDocumentHash(afterContent),
  };
}

/** Batch SourceChangeV1 construction; `{ path: null }` entries mean deletion. */
export function toSourceChanges(
  snapshot: ProjectSourceSnapshotV1,
  entries: Readonly<Record<string, string | null>>,
): SourceChangeV1[] {
  return Object.entries(entries).map(([logicalPath, afterContent]) =>
    toSourceChange(snapshot, logicalPath, afterContent),
  );
}
