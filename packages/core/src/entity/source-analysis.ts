import YAML from 'yaml';
import type { ZodType } from 'zod';
import type {
  JsonValue,
  ProjectSourceSnapshotV1,
  SourceAnalysisV1,
  SourceChangeV1,
  SourceDiagnosticV1,
  SourceDocumentV1,
} from '../contracts/index.js';
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
  relationshipDefinitionSchema,
  ruleDefinitionSchema,
  worldInitialStateSchema,
} from '../schemas/index.js';
import {
  compareLogicalPaths,
  computeSourceDocumentHash,
  computeSourceHash,
} from '../source/source-identity.js';

interface Rule {
  readonly re: RegExp;
  readonly schema: ZodType<unknown> | null;
}

const rules: readonly Rule[] = [
  { re: /^nova\.yaml$/, schema: projectConfigSchema },
  { re: /^definitions\/state_initial\.yaml$/, schema: worldInitialStateSchema },
  { re: /^definitions\/entity-types\.yaml$/, schema: null },
  {
    re: /^definitions\/(characters|locations|items|factions|relationships|rules|narrators|assertions)\/[^/]+\.(yaml|yml)$/,
    schema: null,
  },
  { re: /^definitions\/discourse-ledger\.yaml$/, schema: plannedDiscourseLedgerSourceSchema },
  { re: /^chapters\/chapter_\d{2}\/_chapter\.yaml$/, schema: chapterMetadataSchema },
  { re: /^chapters\/chapter_\d{2}\/E[^/]+\.(yaml|yml)$/, schema: eventFileSchema },
];

const schemaByDirectory: Record<string, ZodType<unknown>> = {
  characters: characterDefinitionSchema,
  locations: locationDefinitionSchema,
  items: itemDefinitionSchema,
  factions: factionDefinitionSchema,
  relationships: relationshipDefinitionSchema,
  rules: ruleDefinitionSchema,
  narrators: narratorProfileSchema,
  assertions: narratorAssertionSchema,
};

function ruleFor(path: string): Rule | null {
  const rule = rules.find((candidate) => candidate.re.test(path)) ?? null;
  if (rule && path.startsWith('definitions/')) {
    const directory = path.split('/')[1];
    if (directory in schemaByDirectory) return { ...rule, schema: schemaByDirectory[directory] };
  }
  return rule;
}

function validPath(path: string): boolean {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/')) return false;
  const parts = path.split('/');
  return (
    parts.every((part) => part.length > 0 && part !== '.' && part !== '..') &&
    path === parts.join('/')
  );
}

function jsonValue(value: unknown): JsonValue | null {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    for (const item of value) {
      const v = jsonValue(item);
      if (v === null && item !== null) return null;
      out.push(v);
    }
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const v = jsonValue(item);
      if (v === null && item !== null) return null;
      out[key] = v;
    }
    return out;
  }
  return null;
}

function parseDocument(
  path: string,
  content: string,
): {
  parseResult: SourceDocumentV1['parseResult'];
  diagnostics: SourceDiagnosticV1[];
} {
  const rule = ruleFor(path);
  if (!rule) {
    return { parseResult: { status: 'not_applicable', value: null }, diagnostics: [] };
  }
  try {
    const parsed = YAML.parse(content);
    const value = jsonValue(parsed);
    if (value === null && parsed !== null) throw new Error('non-json value');
    const diagnostics: SourceDiagnosticV1[] = [];
    if (rule.schema) {
      const checked = rule.schema.safeParse(parsed);
      if (!checked.success) {
        diagnostics.push({
          code: 'SOURCE_SCHEMA_INVALID',
          severity: 'error',
          message: checked.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; '),
          logicalPath: path,
        });
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
        {
          code: 'SOURCE_YAML_INVALID',
          severity: 'error',
          message: `YAML parsing failed: ${error instanceof Error ? error.message : 'invalid document'}`,
          logicalPath: path,
        },
      ],
    };
  }
}

export interface SourceAnalysisOptions {
  /** Optional pure ontology preflight over the candidate documents. */
  readonly validateOntology?: (
    documents: readonly SourceDocumentV1[],
  ) => readonly SourceDiagnosticV1[];
}

/**
 * Pure value-level source analysis: overlay `changes` onto `current` as candidate
 * documents, validate logical POSIX containment and authoring topology, parse and
 * schema-check changed YAML, and produce a canonical ordered snapshot with a
 * content-only sourceHash. No host paths, file I/O, transactions, revisions,
 * heads, or publication output.
 */
export function analyzeSource(
  current: ProjectSourceSnapshotV1,
  changes: readonly SourceChangeV1[],
  options: SourceAnalysisOptions = {},
): SourceAnalysisV1 {
  const diagnostics: SourceDiagnosticV1[] = [];
  const overlay = new Map(current.documents.map((d) => [d.logicalPath, d]));

  for (const change of changes) {
    if (!validPath(change.logicalPath) || ruleFor(change.logicalPath) === null) {
      diagnostics.push({
        code: 'SOURCE_PATH_INVALID',
        severity: 'error',
        message: 'Logical path is outside the authoring topology',
        logicalPath: change.logicalPath,
      });
      continue;
    }
    const existing = overlay.get(change.logicalPath);
    if (existing && change.beforeHash !== null && existing.contentHash !== change.beforeHash) {
      diagnostics.push({
        code: 'SOURCE_PRECONDITION_MISMATCH',
        severity: 'error',
        message: 'Before hash does not match current document',
        logicalPath: change.logicalPath,
      });
    }
    if (change.afterContent === null) {
      overlay.delete(change.logicalPath);
    } else {
      const parsed = parseDocument(change.logicalPath, change.afterContent);
      overlay.set(change.logicalPath, {
        version: 1,
        logicalPath: change.logicalPath,
        content: change.afterContent,
        contentHash: change.afterHash ?? computeSourceDocumentHash(change.afterContent),
        parseResult: parsed.parseResult,
        diagnostics: parsed.diagnostics,
      });
      diagnostics.push(...parsed.diagnostics);
    }
  }

  const candidateDocuments = [...overlay.values()].sort((a, b) =>
    compareLogicalPaths(a.logicalPath, b.logicalPath),
  );
  const candidate: ProjectSourceSnapshotV1 = {
    version: 1,
    documents: candidateDocuments,
    sourceHash: computeSourceHash(candidateDocuments),
  };
  diagnostics.push(...(options.validateOntology?.(candidateDocuments) ?? []));

  const affectedEventIds = [
    ...new Set(
      changes
        .map((c) => c.logicalPath.match(/^chapters\/chapter_\d{2}\/(E[^/]+)\.(?:yaml|yml)$/)?.[1])
        .filter((v): v is string => v !== undefined),
    ),
  ].sort(compareLogicalPaths);

  return {
    version: 1,
    current,
    candidate,
    changes: [...changes],
    affectedEventIds,
    diagnostics,
  };
}
