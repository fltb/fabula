// Pure Core render-cache identity and repository eligibility.
import { hasAnalysisResultShape } from '../schemas/analysis.ts';
import { sha256 } from './pure-sha256.js';
import type { ProjectSourceSnapshotV1 } from '../contracts/source.js';
import type { RenderCacheRecord, RenderCacheRepository, LayeredCacheKey } from '../ports/render-cache-repository.js';
import type { Fact } from '../types/entity.js';

export function canonicalJson(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export function sha256Canonical(input: unknown): string {
  return sha256(canonicalJson(input));
}

/** Source identity is supplied by the host materialized snapshot; provenance is irrelevant. */
export function computeSourceContentHash(snapshot: ProjectSourceSnapshotV1): string {
  return snapshot.sourceHash;
}

export function buildLogicalKeyMaterial(input: {
  sourceContentHash: string; sceneContractHash: string; worldStateHash: string;
  plannedDiscourseHash: string; branchDiscourseScopeHash: string;
  logicalDisclosureSummaryHash?: string; catalogVersionHashes: Record<string, string>;
  graphHash: string; styleProfileHash: string; promptProviderId: string;
  promptProviderVersion?: string; language: string; targetLengthWords: number;
  analysisContractHash?: string; validatorOverrideHash?: string; pluginIdentityHash?: string;
}): string { return sha256Canonical(input); }

export function buildSurfaceKeyMaterial(input: {
  logicalKeyString: string; groupManifestHash: string; surfacePolicyHash: string;
  sourceProseHashes: string[]; extractorVersion: string;
}): string { return sha256Canonical(input); }

export function buildValidationKeyMaterial(input: {
  surfaceKeyString: string; proseHash: string; pass2SchemaModelId: string;
  validatorPolicyVersion: string; provider: string; analysisPromptHash: string;
  samplingConfigHash: string; validatorPolicy: string; referencePolicy: string;
}): string { return sha256Canonical(input); }

export function buildAttemptKeyMaterial(input: {
  validationKeyString: string; attemptNumber: number; priorProseHash?: string;
  retryGuidanceHash?: string; materialMutation?: Record<string, unknown>;
}): string { return sha256Canonical(input); }

export function computeFlatCacheKey(layers: { logical: string; surface: string; validation: string; attempt: string }): string {
  return sha256Canonical(layers);
}

/** Deliberately excludes fact values: sourceHash and layered identity certify values. */
export function computeEvidenceHash(eventId: string, preconditions: Fact[], postconditions: Fact[]): string {
  const ids = [...preconditions, ...postconditions].map((fact) => fact.id).sort();
  return sha256Canonical({ eventId, factIds: ids });
}

export interface CacheDiagnostics {
  eventId: string;
  diagnosis: 'miss' | 'corrupt' | 'stale' | 'valid';
  detail?: string;
  storedKey?: string;
  expectedKey?: string;
}

export interface CacheLookup {
  readonly key: LayeredCacheKey;
  readonly eventId?: string;
  /** Optional evidence identity carried by a cache output. */
  readonly evidenceHash?: string;
}

function completeRecord(record: unknown, key: LayeredCacheKey, evidenceHash?: string): record is RenderCacheRecord {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const candidate = record as Partial<RenderCacheRecord> & { output?: Record<string, unknown> };
  if (candidate.version !== 1 || !candidate.key || candidate.key.version !== key.version || candidate.key.sourceHash !== key.sourceHash) return false;
  if (!candidate.key.layers || canonicalJson(candidate.key.layers) !== canonicalJson(key.layers)) return false;
  if (typeof candidate.recordHash !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.recordHash)) return false;
  if (!candidate.output || typeof candidate.output !== 'object' || Array.isArray(candidate.output)) return false;
  if (typeof candidate.output.prose !== 'string' || candidate.output.prose.length === 0) return false;
  if (!hasAnalysisResultShape(candidate.output.analysis)) return false;
  if (evidenceHash !== undefined && candidate.output.evidenceHash !== evidenceHash) return false;
  return true;
}

/** Repository failures and malformed records are safe misses, never accepted output. */
export async function getCachedRender(
  repository: RenderCacheRepository,
  lookup: CacheLookup,
  diagnostics?: CacheDiagnostics[],
): Promise<RenderCacheRecord | null> {
  const eventId = lookup.eventId ?? lookup.key.layers.eventId ?? 'unknown';
  try {
    const record = await repository.get({ key: lookup.key });
    if (record === null) { diagnostics?.push({ eventId, diagnosis: 'miss', detail: 'No cache record' }); return null; }
    if (!completeRecord(record, lookup.key, lookup.evidenceHash)) {
      diagnostics?.push({ eventId, diagnosis: 'corrupt', detail: 'Incomplete or mismatched cache record' }); return null;
    }
    diagnostics?.push({ eventId, diagnosis: 'valid' });
    return record;
  } catch (error) {
    diagnostics?.push({ eventId, diagnosis: 'corrupt', detail: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function setCachedRender(
  repository: RenderCacheRepository,
  key: LayeredCacheKey,
  record: RenderCacheRecord,
): Promise<boolean> {
  if (!completeRecord(record, key)) return false;
  try { await repository.put({ key, record }); return true; } catch { return false; }
}

export async function clearEventCache(repository: RenderCacheRepository, key: LayeredCacheKey): Promise<void> {
  try { await repository.remove({ key }); } catch { /* best effort derived data */ }
}

export async function clearRenderCache(repository: RenderCacheRepository, keys: readonly LayeredCacheKey[]): Promise<void> {
  await Promise.all(keys.map((key) => clearEventCache(repository, key)));
}

export interface VerifyChainResult {
  totalCached: number; valid: number; stale: number; missing: number;
  details: Array<{ eventId: string; status: 'valid' | 'stale' | 'missing' | 'corrupt'; reason?: string }>;
}

/** Verify supplied records without enumerating host persistence. */
export function verifyEvidenceChain(records: ReadonlyMap<string, RenderCacheRecord | null>, keys: ReadonlyMap<string, LayeredCacheKey>): VerifyChainResult {
  const result: VerifyChainResult = { totalCached: 0, valid: 0, stale: 0, missing: 0, details: [] };
  for (const [eventId, key] of keys) {
    const record = records.get(eventId);
    if (record === undefined || record === null) { result.missing++; result.details.push({ eventId, status: 'missing' }); continue; }
    result.totalCached++;
    if (completeRecord(record, key)) { result.valid++; result.details.push({ eventId, status: 'valid' }); }
    else { result.stale++; result.details.push({ eventId, status: 'corrupt', reason: 'Invalid cache record' }); }
  }
  return result;
}

export type { LayeredCacheKey, RenderCacheRecord, RenderCacheRepository };
