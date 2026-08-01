// ============================================================================
// Fixture Calibration — read-only scan helper (test-side, never shipped)
// ============================================================================
//
// Step 2 of the epistemic NovelIR plan: calibrate the authored entity catalog
// against real fixtures before any enforcement is enabled. This module is a
// test-side, read-only helper: it scans authored fixture sources
// (recursive definitions YAML and chapters E-prefixed event YAML, excluding
// scenes/, .nova/, reference/ and render artifacts), derives the observed value
// shape of every entity attribute, and compares it with the authored
// definitions/entity-types.yaml.
//
// The five-literal valueType system is the ONLY supported representation:
//   string | number | boolean | string_list | string_map
// Anything else (arrays of objects, nested maps with non-string values, ...) is
// unrepresentable and is reported as a hard SHAPE_CONFLICT — no z.any escape hatch.
//
// Failure categories (exactly two):
//   POLICY_REQUIRED — observed attribute has no explicit authored catalog entry
//   SHAPE_CONFLICT  — one attribute observed with incompatible value shapes
//                     (two distinct literals, an unrepresentable shape, or a
//                     catalog valueType that contradicts the observed literal)
//
// Report-only (never a failure):
//   - undeclared entity references (facts on entities with no declaration/intro)
//   - catalog attributes never observed (excluding compiler-generated lifecycle)
//   - definition-baseline + event-introduction overlaps (duplicate activation
//     baseline; the migration contract says definition initialState must be
//     omitted once an authored introduces exists — flagged as a judgment call)
// ============================================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import YAML from 'yaml';
import type { EntityKind } from '../../src/types/entity.js';

export const VALUE_TYPES = ['string', 'number', 'boolean', 'string_list', 'string_map'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

export const REQUIRED_AT = ['introduction', 'activation', 'never'] as const;
export const WRITE_POLICIES = ['immutable', 'write_once', 'mutable', 'lifecycle_managed'] as const;
export const ENTITY_KINDS: readonly string[] = [
  'character',
  'location',
  'item',
  'concept',
  'faction',
  'rule',
];
export const LIFECYCLE_STATES = ['active', 'inactive', 'retired'] as const;
export const ELIGIBILITY = ['identity', 'live', 'historical'] as const;

/** Folder name → entity kind. Introduces `type` values are already singular. */
const KIND_BY_DIR: Record<string, string> = {
  characters: 'character',
  locations: 'location',
  items: 'item',
  factions: 'faction',
  rules: 'rule',
};

/** Definition-level metadata promoted into entity state by the mapper/registry. */
const PROMOTED_BY_KIND: Record<string, string[]> = {
  character: ['aliases', 'gender', 'appearance', 'age', 'profession', 'traits'],
  rule: ['category', 'type'],
};

/** Shapes that carry no value evidence and therefore cannot constrain valueType. */
const HINT_SHAPE: Record<string, true> = { hint: true, 'hint/op': true, unset: true };

export type FactSource = 'def_baseline' | 'def_promoted' | 'pre' | 'post' | 'choice';

export interface AttributeObservation {
  shapes: Set<string>;
  sources: Set<FactSource>;
}

export interface ProjectScan {
  /** kind → attribute → observation */
  kinds: Map<string, Map<string, AttributeObservation>>;
  /** entityId → attribute → observed shapes (entities with no declaration) */
  unresolved: Map<string, Map<string, Set<string>>>;
  /** entityId → kind, from definitions and event introduces */
  entityKindById: Map<string, string>;
  /** entities with a definition initialState (baseline activation) */
  baselineEntities: Set<string>;
  /** entities activated by an authored event introduces */
  introducedEntities: Set<string>;
  /** entityId → event files that introduce it (duplicates are a judgment call) */
  introductionEvents: Map<string, string[]>;
}

/** Narrow an unknown YAML node to a plain string-keyed record, else null. */
function asRecord(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function readStringField(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === 'string' ? v : null;
}

/** Map an observed YAML value to its shape class within/outside the five literals. */
export function classifyValue(v: unknown): string {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number' && Number.isFinite(v)) return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'string')) return 'string_list';
    return 'array_other';
  }
  if (v !== null && typeof v === 'object') {
    const values = Object.values(v as Record<string, unknown>);
    if (values.every((x) => typeof x === 'string')) return 'string_map';
    return 'object_other';
  }
  return `other:${typeof v}`;
}

function collectFiles(dir: string, out: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(p, out);
    else if (entry.name.endsWith('.yaml')) out.push(p);
  }
}

/** Locate fixture projects (directories containing nova.yaml) under `root`. */
export function findProjects(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const p = join(dir, entry.name);
      if (existsSync(join(p, 'nova.yaml'))) out.push(relative(root, p));
      else walk(p);
    }
  };
  walk(root);
  return out.sort();
}

function isSkippedDefinition(rel: string): boolean {
  return (
    rel === 'state_initial.yaml' ||
    rel === 'discourse-ledger.yaml' ||
    rel === 'entity-types.yaml' ||
    rel.startsWith('narrators/') ||
    rel.startsWith('assertions/')
  );
}

/** E-prefixed authored event files live directly under a chapter directory. */
function isAuthoredEventFile(file: string): boolean {
  return /^E\d+.*\.yaml$/.test(basename(file));
}

/**
 * Deterministic scan of one fixture project's authored sources.
 * Scan scope: recursive definitions YAML (incl. state_initial.yaml worldFacts)
 * and chapters E-prefixed event YAML. Excluded: scenes/, .nova/, reference/,
 * render requests, discourse-ledger.yaml, narrators/, assertions/,
 * entity-types.yaml.
 */
export function scanProject(projectDir: string): ProjectScan {
  const kinds = new Map<string, Map<string, AttributeObservation>>();
  const unresolved = new Map<string, Map<string, Set<string>>>();
  const entityKindById = new Map<string, string>();
  const baselineEntities = new Set<string>();
  const introducedEntities = new Set<string>();
  const introductionEvents = new Map<string, string[]>();

  const ensureKind = (kind: string): Map<string, AttributeObservation> => {
    let attrs = kinds.get(kind);
    if (!attrs) {
      attrs = new Map();
      kinds.set(kind, attrs);
    }
    return attrs;
  };

  const addFact = (
    entityId: string,
    attribute: string,
    shape: string,
    source: FactSource,
  ): void => {
    const kind = entityKindById.get(entityId);
    if (!kind) {
      let attrs = unresolved.get(entityId);
      if (!attrs) {
        attrs = new Map();
        unresolved.set(entityId, attrs);
      }
      let shapes = attrs.get(attribute);
      if (!shapes) {
        shapes = new Set();
        attrs.set(attribute, shapes);
      }
      shapes.add(shape);
      return;
    }
    const attrs = ensureKind(kind);
    let obs = attrs.get(attribute);
    if (!obs) {
      obs = { shapes: new Set(), sources: new Set() };
      attrs.set(attribute, obs);
    }
    obs.shapes.add(shape);
    obs.sources.add(source);
  };

  const defsDir = join(projectDir, 'definitions');
  const chapterDir = join(projectDir, 'chapters');

  // ── Pass 1: declare entities (definitions + worldFacts + introduces) ──────
  const stateFile = join(defsDir, 'state_initial.yaml');
  if (existsSync(stateFile)) {
    const state = asRecord(YAML.parse(readFileSync(stateFile, 'utf8')));
    if (state && Array.isArray(state.worldFacts)) {
      for (const wf of state.worldFacts) {
        const rec = asRecord(wf);
        if (!rec) continue;
        const id = readStringField(rec, 'id');
        if (!id) continue;
        entityKindById.set(id, 'concept');
        // worldFacts become concept entities with value + description baselines
        const valueShape = rec.value !== undefined ? classifyValue(rec.value) : 'hint';
        const descriptionShape =
          rec.description !== undefined ? classifyValue(rec.description) : 'hint';
        addFact(id, 'value', valueShape, 'def_baseline');
        addFact(id, 'description', descriptionShape, 'def_baseline');
      }
    }
  }

  const defFiles: string[] = [];
  if (existsSync(defsDir)) collectFiles(defsDir, defFiles);
  for (const f of defFiles) {
    const rel = relative(defsDir, f);
    if (isSkippedDefinition(rel)) continue;
    const kind = KIND_BY_DIR[rel.split('/')[0]];
    if (!kind) continue; // relationships & unknown dirs are outside the entity catalog
    const doc = asRecord(YAML.parse(readFileSync(f, 'utf8')));
    if (!doc) continue;
    // definitions carry either `id` or (rules) `ruleId`
    const id = readStringField(doc, 'id') ?? readStringField(doc, 'ruleId');
    if (!id) continue;
    entityKindById.set(id, kind);
  }

  const chapterFiles: string[] = [];
  if (existsSync(chapterDir)) collectFiles(chapterDir, chapterFiles);
  for (const f of chapterFiles) {
    if (!isAuthoredEventFile(f)) continue;
    const doc = asRecord(YAML.parse(readFileSync(f, 'utf8')));
    if (!doc || !Array.isArray(doc.introduces)) continue;
    for (const intro of doc.introduces) {
      const rec = asRecord(intro);
      if (!rec) continue;
      const id = readStringField(rec, 'id');
      const type = readStringField(rec, 'type');
      if (!id || !type) continue;
      entityKindById.set(id, KIND_BY_DIR[type] ?? type);
      introducedEntities.add(id);
      const events = introductionEvents.get(id) ?? [];
      events.push(basename(f));
      introductionEvents.set(id, events);
    }
  }

  // ── Pass 2: collect facts (definitions baselines, events, choices) ────────
  for (const f of defFiles) {
    const rel = relative(defsDir, f);
    if (isSkippedDefinition(rel)) continue;
    const kind = KIND_BY_DIR[rel.split('/')[0]];
    if (!kind) continue;
    const doc = asRecord(YAML.parse(readFileSync(f, 'utf8')));
    if (!doc) continue;
    // definitions carry either `id` or (rules) `ruleId`
    const id = readStringField(doc, 'id') ?? readStringField(doc, 'ruleId');
    if (!id) continue;

    for (const attr of PROMOTED_BY_KIND[kind] ?? []) {
      if (doc[attr] !== undefined) addFact(id, attr, classifyValue(doc[attr]), 'def_promoted');
    }
    const initialState = asRecord(doc.initialState);
    if (initialState) {
      baselineEntities.add(id);
      for (const [a, v] of Object.entries(initialState)) {
        addFact(id, a, classifyValue(v), 'def_baseline');
      }
    }
  }

  for (const f of chapterFiles) {
    if (!isAuthoredEventFile(f)) continue;
    const doc = asRecord(YAML.parse(readFileSync(f, 'utf8')));
    if (!doc) continue;

    if (Array.isArray(doc.preconditions)) {
      for (const p of doc.preconditions) {
        const rec = asRecord(p);
        if (!rec) continue;
        const entityId = readStringField(rec, 'entity');
        const attribute = readStringField(rec, 'attribute');
        if (!entityId || !attribute) continue;
        const shape = rec.value !== undefined ? classifyValue(rec.value) : 'hint/op';
        addFact(entityId, attribute, shape, 'pre');
      }
    }
    if (Array.isArray(doc.expectedPostconditions)) {
      for (const p of doc.expectedPostconditions) {
        const rec = asRecord(p);
        if (!rec) continue;
        const entityId = readStringField(rec, 'entity');
        const attribute = readStringField(rec, 'attribute');
        if (!entityId || !attribute) continue;
        let shape: string;
        if (rec.value !== undefined) shape = classifyValue(rec.value);
        else shape = rec.operation === 'unset' ? 'unset' : 'hint';
        addFact(entityId, attribute, shape, 'post');
      }
    }
    if (Array.isArray(doc.choices)) {
      for (const choice of doc.choices) {
        const choiceRec = asRecord(choice);
        if (!choiceRec || !Array.isArray(choiceRec.effects)) continue;
        for (const eff of choiceRec.effects) {
          const rec = asRecord(eff);
          if (!rec) continue;
          const entityId = readStringField(rec, 'entity');
          const attribute = readStringField(rec, 'attribute');
          if (!entityId || !attribute) continue;
          let shape: string;
          if (rec.value !== undefined) shape = classifyValue(rec.value);
          else shape = rec.operation === 'unset' ? 'unset' : 'hint';
          addFact(entityId, attribute, shape, 'choice');
        }
      }
    }
  }

  return {
    kinds,
    unresolved,
    entityKindById,
    baselineEntities,
    introducedEntities,
    introductionEvents,
  };
}

// ——— Authored catalog contract (mirrors the strict compiler schema) —————

export interface AuthoredAttributeSource {
  attributeId: string;
  valueType: ValueType;
  requiredAt: (typeof REQUIRED_AT)[number];
  writePolicy: (typeof WRITE_POLICIES)[number];
  allowedLifecycleStates?: string[];
  unsetAllowed: boolean;
  semanticRole?: string;
  typedReferenceConstraint?: { targetKind: EntityKind; targetTypeId?: string };
}

export interface AuthoredTypeSource {
  typeId: string;
  kind: EntityKind;
  attributes: Map<string, AuthoredAttributeSource>;
  lifecyclePolicy: { allowedTransitions: Array<[string, string]> };
  referenceCapabilities: { defaultEligibility: string };
  typedInvariants: unknown[];
}

/** Parse definitions/entity-types.yaml of a project (throws on YAML errors). */
export function loadCatalogDocument(projectDir: string): {
  raw: Record<string, unknown>;
  types: Map<string, AuthoredTypeSource>;
} {
  const file = join(projectDir, 'definitions', 'entity-types.yaml');
  const raw = asRecord(YAML.parse(readFileSync(file, 'utf8')));
  if (!raw) throw new Error(`${file}: catalog must be a YAML mapping`);
  const types = new Map<string, AuthoredTypeSource>();
  const typesRec = asRecord(raw.types);
  if (!typesRec) return { raw, types };
  for (const [typeId, t] of Object.entries(typesRec)) {
    const ty = asRecord(t);
    if (!ty) continue;
    const attributes = new Map<string, AuthoredAttributeSource>();
    const attrsRec = asRecord(ty.attributes);
    if (attrsRec) {
      for (const [attributeId, a] of Object.entries(attrsRec)) {
        const at = asRecord(a);
        if (!at) continue;
        attributes.set(attributeId, {
          attributeId: readStringField(at, 'attributeId') ?? '',
          valueType: at.valueType as ValueType,
          requiredAt: at.requiredAt as AuthoredAttributeSource['requiredAt'],
          writePolicy: at.writePolicy as AuthoredAttributeSource['writePolicy'],
          allowedLifecycleStates: Array.isArray(at.allowedLifecycleStates)
            ? (at.allowedLifecycleStates as string[])
            : undefined,
          unsetAllowed: at.unsetAllowed === true,
          semanticRole: readStringField(at, 'semanticRole') ?? undefined,
          typedReferenceConstraint: asRecord(at.typedReferenceConstraint)
            ? (at.typedReferenceConstraint as AuthoredAttributeSource['typedReferenceConstraint'])
            : undefined,
        });
      }
    }
    types.set(typeId, {
      typeId: readStringField(ty, 'typeId') ?? '',
      kind: ty.kind as EntityKind,
      attributes,
      lifecyclePolicy: (asRecord(ty.lifecyclePolicy) ??
        {}) as AuthoredTypeSource['lifecyclePolicy'],
      referenceCapabilities: (asRecord(ty.referenceCapabilities) ??
        {}) as AuthoredTypeSource['referenceCapabilities'],
      typedInvariants: Array.isArray(ty.typedInvariants) ? (ty.typedInvariants as unknown[]) : [],
    });
  }
  return { raw, types };
}

const TYPE_KEYS: Record<string, true> = {
  typeId: true,
  kind: true,
  attributes: true,
  lifecyclePolicy: true,
  referenceCapabilities: true,
  typedInvariants: true,
};
const ATTRIBUTE_KEYS: Record<string, true> = {
  attributeId: true,
  valueType: true,
  requiredAt: true,
  writePolicy: true,
  allowedLifecycleStates: true,
  unsetAllowed: true,
  semanticRole: true,
  typedReferenceConstraint: true,
};
const REF_CONSTRAINT_KEYS: Record<string, true> = { targetKind: true, targetTypeId: true };
const LIFECYCLE_POLICY_KEYS: Record<string, true> = { allowedTransitions: true };
const REFERENCE_CAPABILITY_KEYS: Record<string, true> = { defaultEligibility: true };

function unknownKeys(obj: Record<string, unknown>, allowed: Record<string, true>): string[] {
  return Object.keys(obj).filter((k) => !allowed[k]);
}

/** Structural validation mirroring the strict compiler schema. Returns problems. */
export function validateCatalogContract(raw: Record<string, unknown>): string[] {
  const problems: string[] = [];

  const walkKeys = (v: unknown, path: string): void => {
    if (v === null || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'version' || k === 'schemaVersion') {
        problems.push(`author-facing catalog must not carry version field '${k}' at ${path}`);
      }
      walkKeys(val, `${path}.${k}`);
    }
  };
  walkKeys(raw, 'entity-types.yaml');

  const typesRec = asRecord(raw.types);
  if (!typesRec) {
    problems.push('catalog must contain a top-level `types` map');
    return problems;
  }
  if (Object.keys(typesRec).length === 0) problems.push('`types` must not be empty');

  for (const [typeId, typeVal] of Object.entries(typesRec)) {
    const t = asRecord(typeVal);
    if (!t) {
      problems.push(`types.${typeId} must be a mapping`);
      continue;
    }
    const base = `types.${typeId}`;
    for (const k of unknownKeys(t, TYPE_KEYS)) problems.push(`unknown key ${k} at ${base}`);

    if (t.typeId !== typeId) {
      problems.push(
        `${base}.typeId must equal the map key (${JSON.stringify(t.typeId)} !== ${JSON.stringify(typeId)})`,
      );
    }
    if (typeof t.kind !== 'string' || !ENTITY_KINDS.includes(t.kind)) {
      problems.push(`${base}.kind must be one of ${ENTITY_KINDS.join('|')}`);
    }
    if (!Array.isArray(t.typedInvariants) || t.typedInvariants.length !== 0) {
      problems.push(
        `${base}.typedInvariants must be an empty array (no executable invariants yet)`,
      );
    }

    const lp = asRecord(t.lifecyclePolicy);
    if (!lp) {
      problems.push(`${base}.lifecyclePolicy must be a mapping`);
    } else {
      for (const k of unknownKeys(lp, LIFECYCLE_POLICY_KEYS)) {
        problems.push(`unknown key ${k} at ${base}.lifecyclePolicy`);
      }
      if (!Array.isArray(lp.allowedTransitions)) {
        problems.push(`${base}.lifecyclePolicy.allowedTransitions must be an array`);
      } else {
        for (const [i, pair] of lp.allowedTransitions.entries()) {
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            !pair.every((s) => LIFECYCLE_STATES.includes(s as string))
          ) {
            problems.push(
              `${base}.lifecyclePolicy.allowedTransitions[${i}] must be a [state, state] pair of ${LIFECYCLE_STATES.join('|')}`,
            );
          }
        }
      }
    }

    const rc = asRecord(t.referenceCapabilities);
    if (!rc) {
      problems.push(`${base}.referenceCapabilities must be a mapping`);
    } else {
      for (const k of unknownKeys(rc, REFERENCE_CAPABILITY_KEYS)) {
        problems.push(`unknown key ${k} at ${base}.referenceCapabilities`);
      }
      if (
        typeof rc.defaultEligibility !== 'string' ||
        !ELIGIBILITY.includes(rc.defaultEligibility)
      ) {
        problems.push(
          `${base}.referenceCapabilities.defaultEligibility must be one of ${ELIGIBILITY.join('|')}`,
        );
      }
    }

    const attrsRec = asRecord(t.attributes);
    if (!attrsRec) {
      problems.push(`${base}.attributes must be a mapping`);
      continue;
    }
    for (const [attributeId, attrVal] of Object.entries(attrsRec)) {
      const a = asRecord(attrVal);
      if (!a) {
        problems.push(`${base}.attributes.${attributeId} must be a mapping`);
        continue;
      }
      const attrPath = `${base}.attributes.${attributeId}`;
      for (const k of unknownKeys(a, ATTRIBUTE_KEYS)) {
        problems.push(`unknown key ${k} at ${attrPath}`);
      }

      if (a.attributeId !== attributeId) {
        problems.push(
          `${attrPath}.attributeId must equal the map key (${JSON.stringify(a.attributeId)} !== ${JSON.stringify(attributeId)})`,
        );
      }
      if (typeof a.valueType !== 'string' || !VALUE_TYPES.includes(a.valueType as ValueType)) {
        problems.push(`${attrPath}.valueType must be one of ${VALUE_TYPES.join('|')}`);
      }
      if (
        typeof a.requiredAt !== 'string' ||
        !REQUIRED_AT.includes(a.requiredAt as (typeof REQUIRED_AT)[number])
      ) {
        problems.push(`${attrPath}.requiredAt must be one of ${REQUIRED_AT.join('|')}`);
      }
      if (
        typeof a.writePolicy !== 'string' ||
        !WRITE_POLICIES.includes(a.writePolicy as (typeof WRITE_POLICIES)[number])
      ) {
        problems.push(`${attrPath}.writePolicy must be one of ${WRITE_POLICIES.join('|')}`);
      }
      if (typeof a.unsetAllowed !== 'boolean') {
        problems.push(`${attrPath}.unsetAllowed must be a boolean`);
      }
      if (a.allowedLifecycleStates !== undefined) {
        if (
          !Array.isArray(a.allowedLifecycleStates) ||
          !(a.allowedLifecycleStates as unknown[]).every((s) =>
            LIFECYCLE_STATES.includes(s as string),
          )
        ) {
          problems.push(
            `${attrPath}.allowedLifecycleStates must be an array of ${LIFECYCLE_STATES.join('|')}`,
          );
        }
      }
      if (a.semanticRole !== undefined && typeof a.semanticRole !== 'string') {
        problems.push(`${attrPath}.semanticRole must be a string`);
      }
      if (a.typedReferenceConstraint !== undefined) {
        const tc = asRecord(a.typedReferenceConstraint);
        if (!tc) {
          problems.push(`${attrPath}.typedReferenceConstraint must be a mapping`);
        } else {
          for (const k of unknownKeys(tc, REF_CONSTRAINT_KEYS)) {
            problems.push(`unknown key ${k} at ${attrPath}.typedReferenceConstraint`);
          }
          if (typeof tc.targetKind !== 'string' || !ENTITY_KINDS.includes(tc.targetKind)) {
            problems.push(
              `${attrPath}.typedReferenceConstraint.targetKind must be one of ${ENTITY_KINDS.join('|')}`,
            );
          }
          if (tc.targetTypeId !== undefined && typeof tc.targetTypeId !== 'string') {
            problems.push(`${attrPath}.typedReferenceConstraint.targetTypeId must be a string`);
          }
        }
      }
    }
  }
  return problems;
}

// ——— Calibration —————

export interface CalibrationFailure {
  category: 'POLICY_REQUIRED' | 'SHAPE_CONFLICT' | 'CONTRACT';
  project: string;
  kind?: string;
  attribute?: string;
  detail: string;
}

/**
 * Calibrate one project: scan authored sources, compare with the authored
 * catalog, and produce a deterministic report plus the failing entries.
 */
export function calibrateProject(
  projectDir: string,
  projectName: string,
): {
  failures: CalibrationFailure[];
  report: string;
} {
  const failures: CalibrationFailure[] = [];
  const lines: string[] = [];
  const scan = scanProject(projectDir);

  let catalog: { raw: Record<string, unknown>; types: Map<string, AuthoredTypeSource> } | null =
    null;
  try {
    catalog = loadCatalogDocument(projectDir);
  } catch (err) {
    failures.push({
      category: 'CONTRACT',
      project: projectName,
      detail: `unparseable entity-types.yaml: ${(err as Error).message}`,
    });
  }

  lines.push(`# ${projectName}`);
  if (catalog) {
    const contractProblems = validateCatalogContract(catalog.raw);
    for (const p of contractProblems) {
      failures.push({ category: 'CONTRACT', project: projectName, detail: p });
    }
    if (contractProblems.length > 0) lines.push(`contract problems: ${contractProblems.length}`);
  }

  const kinds = [...scan.kinds.keys()].sort();
  for (const kind of kinds) {
    const attrs = scan.kinds.get(kind)!;
    lines.push(`kind ${kind}`);
    for (const attr of [...attrs.keys()].sort()) {
      const obs = attrs.get(attr)!;
      const shapeList = [...obs.shapes].sort();
      const literals = shapeList.filter((s) => VALUE_TYPES.includes(s as ValueType));
      const unrepresentable = shapeList.filter(
        (s) => !HINT_SHAPE[s] && !VALUE_TYPES.includes(s as ValueType),
      );
      const distinctLiterals = [...new Set(literals)];
      const sourceList = [...obs.sources].sort().join(',');

      if (unrepresentable.length > 0 || distinctLiterals.length > 1) {
        failures.push({
          category: 'SHAPE_CONFLICT',
          project: projectName,
          kind,
          attribute: attr,
          detail: `observed shapes [${shapeList.join(', ')}] cannot be represented by a single valueType`,
        });
        lines.push(
          `  SHAPE_CONFLICT ${attr} observed=[${shapeList.join(', ')}] sources=${sourceList}`,
        );
        continue;
      }

      const catalogAttr = catalog?.types.get(kind)?.attributes.get(attr);
      // hint-only attributes carry no value evidence: any explicit valueType is authorial
      const expected = distinctLiterals.length === 1 ? distinctLiterals[0] : null;
      if (!catalogAttr) {
        failures.push({
          category: 'POLICY_REQUIRED',
          project: projectName,
          kind,
          attribute: attr,
          detail: `observed ${expected ?? 'hint-only'} shape (sources ${sourceList}) but no explicit authored policy`,
        });
        lines.push(
          `  POLICY_REQUIRED ${attr} observed=${expected ?? 'hint-only'} sources=${sourceList}`,
        );
        continue;
      }
      if (expected && catalogAttr.valueType !== expected) {
        failures.push({
          category: 'SHAPE_CONFLICT',
          project: projectName,
          kind,
          attribute: attr,
          detail: `catalog valueType=${catalogAttr.valueType} contradicts observed ${expected} (shapes [${shapeList.join(', ')}])`,
        });
        lines.push(
          `  SHAPE_CONFLICT ${attr} catalog=${catalogAttr.valueType} observed=[${shapeList.join(', ')}] sources=${sourceList}`,
        );
        continue;
      }
      lines.push(`  OK ${attr} valueType=${catalogAttr.valueType} sources=${sourceList}`);
    }
  }

  // Report-only: unused catalog attributes (excluding compiler-generated lifecycle)
  if (catalog) {
    const unused: string[] = [];
    for (const [typeId, type] of catalog.types) {
      for (const attr of type.attributes.keys()) {
        if (attr === 'lifecycle') continue; // compiler-generated runtime state machine
        const observed = scan.kinds.get(typeId)?.has(attr) ?? false;
        if (!observed) unused.push(`${typeId}.${attr}`);
      }
    }
    if (unused.length > 0) {
      lines.push(`unused catalog entries (report-only): ${unused.sort().join(', ')}`);
    }
  }

  // Report-only: undeclared entity references
  if (scan.unresolved.size > 0) {
    const parts: string[] = [];
    for (const [entityId, attrs] of [...scan.unresolved.entries()].sort()) {
      parts.push(`${entityId}(${[...attrs.keys()].sort().join(',')})`);
    }
    lines.push(`undeclared entity references (report-only): ${parts.join('; ')}`);
  }

  // Report-only: definition-baseline + event-introduction overlap (judgment call)
  const overlap = [...scan.baselineEntities].filter((id) => scan.introducedEntities.has(id)).sort();
  if (overlap.length > 0) {
    lines.push(
      `definition initialState + event introduces overlap (report-only judgment call): ${overlap.join(', ')}`,
    );
  }

  // Report-only: entities introduced by more than one event (duplicate activation)
  const duplicated = [...scan.introductionEvents.entries()]
    .filter(([, events]) => events.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (duplicated.length > 0) {
    lines.push(
      `duplicate introductions across events (report-only judgment call): ${duplicated
        .map(([id, events]) => `${id} in ${events.join('+')}`)
        .join('; ')}`,
    );
  }

  return { failures, report: lines.join('\n') };
}
