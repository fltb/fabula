/**
 * AuthoringManifest — the only source of truth for what may enter the authoring
 * tree. The manifest is pure: no filesystem, no git, no shell. It validates
 * logical project paths and raw bytes. Paths use forward slashes only; any
 * absolute, traversal, hidden, runtime (`.nova/**`), Git-internal (`.git/**`)
 * or otherwise non-authoring path is rejected with a structured
 * {@link ManifestValidationError}. Every entry's bytes must be valid UTF-8
 * with LF-only line endings.
 *
 * Adopted scenes (`scenes/<eventId>.md`) are the only non-YAML authoring
 * content and the only conditional one: a scene path is allowed only when the
 * request carries a host-verified {@link AdoptSceneClaim} whose eventId matches
 * the path and whose prose hash matches the entry bytes exactly. A single
 * manifest may not list the same logical path twice — ambiguity is rejected,
 * never resolved by last-write-wins.
 */

import { createHash } from 'node:crypto';

/** Entity definition directories that may be recursively authored. */
export const ENTITY_DIRECTORIES = [
  'characters',
  'locations',
  'items',
  'factions',
  'relationships',
  'rules',
  'narrators',
  'assertions',
] as const;

/** Mandatory root authoring files. */
export const ROOT_AUTHORING_FILES = [
  'nova.yaml',
  'definitions/state_initial.yaml',
  'definitions/entity-types.yaml',
  'definitions/thread-types.yaml',
  'definitions/propositions.yaml',
  'definitions/relationship-types.yaml',
  'definitions/rule-types.yaml',
] as const;

/** Optional root authoring file; Core treats a missing ledger as empty. */
export const OPTIONAL_ROOT_AUTHORING_FILE = 'definitions/discourse-ledger.yaml';

export const AUTHORING_TOPOLOGY = {
  rootFiles: ROOT_AUTHORING_FILES,
  optionalRootFile: OPTIONAL_ROOT_AUTHORING_FILE,
  entityDirectories: ENTITY_DIRECTORIES,
} as const;

export type AuthoringEntryKind =
  | 'root-yaml'
  | 'ledger-yaml'
  | 'entity-yaml'
  | 'chapter-yaml'
  | 'scene-md';

/** Entry modes understood by the manifest. */
export type AuthoringMode = 'blob' | 'executable' | 'symlink' | 'gitlink';

export interface AuthoringEntry {
  /** Logical, forward-slash-separated project path. */
  readonly path: string;
  /** Raw file bytes; must be valid UTF-8 with LF-only line endings. */
  readonly bytes: Uint8Array;
  /** Optional entry mode. Symlinks and gitlinks are always rejected. */
  readonly mode?: AuthoringMode;
}

/**
 * Host-verified proof that a scene's prose was accepted by Core as a
 * `SceneRevisionEnvelopeV1` and may be introduced as a new author-owned scene.
 * Constructing a claim is the submit service's job; the manifest validates the
 * claim shape and requires the entry bytes to hash to the claimed prose.
 */
export interface AdoptSceneClaim {
  readonly eventId: string;
  readonly revisionId: string;
  /** sha256 hex digest of the accepted prose (UTF-8). */
  readonly proseHash: string;
  /** Must be true: only accepted (released) revisions can be adopted. */
  readonly released: boolean;
  readonly acceptedAt: string;
}

/** The minimal envelope subset needed to derive an {@link AdoptSceneClaim}. */
export interface AdoptSceneEnvelopeSubset {
  readonly eventId: string;
  readonly revisionId: string;
  readonly proseHash: string;
  readonly released: boolean;
  readonly createdAt: string;
}

/** Map an accepted scene revision envelope to an adopt claim. */
export function adoptClaimFromEnvelope(envelope: AdoptSceneEnvelopeSubset): AdoptSceneClaim {
  return {
    eventId: envelope.eventId,
    revisionId: envelope.revisionId,
    proseHash: envelope.proseHash,
    released: envelope.released,
    acceptedAt: envelope.createdAt,
  };
}
export type ManifestRejectionCode =
  | 'empty-path'
  | 'control-character'
  | 'backslash-path'
  | 'absolute-path'
  | 'empty-segment'
  | 'dot-segment'
  | 'traversal-path'
  | 'git-internal-path'
  | 'nova-runtime-path'
  | 'hidden-component'
  | 'non-authoring-path'
  | 'unknown-extension'
  | 'duplicate-path'
  | 'missing-required-root'
  | 'adopt-scene-unproven'
  | 'adopt-claim-invalid'
  | 'adopt-claim-event-mismatch'
  | 'adopt-scene-content-mismatch'
  | 'nul-byte'
  | 'carriage-return'
  | 'invalid-utf8'
  | 'symlink-entry'
  | 'gitlink-entry'
  | 'unknown-mode';

/** Structured rejection thrown by {@link AuthoringManifest}. */
export class ManifestValidationError extends Error {
  readonly code: ManifestRejectionCode;
  readonly path: string;
  constructor(code: ManifestRejectionCode, message: string, path: string) {
    super(message);
    this.name = 'ManifestValidationError';
    this.code = code;
    this.path = path;
  }
}

export type PathClassification =
  | { readonly ok: true; readonly kind: AuthoringEntryKind }
  | { readonly ok: false; readonly code: ManifestRejectionCode; readonly message: string };

const ENTITY_DIRECTORY_PATTERN =
  /^definitions\/(characters|locations|items|factions|relationships|rules|narrators|assertions)\//;
const CHAPTER_FILE_PATTERN = /^chapters\/chapter_[0-9]{2}\/(_chapter|E[^/]+)\.yaml$/;
const SCENE_FILE_PATTERN = /^scenes\/([^/]+)\.md$/;
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
/**
 * Classify a logical authoring path without touching the filesystem. Allowed
 * shapes are exactly: the mandatory root files, the optional discourse ledger,
 * recursive YAML under the entity definition directories, one-level chapter
 * YAML, and conditionally allowed scene Markdown.
 */
export function classifyAuthoringPath(path: string): PathClassification {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, code: 'empty-path', message: 'Authoring path must be a non-empty string' };
  }
  if (hasControlCharacter(path)) {
    return {
      ok: false,
      code: 'control-character',
      message: `Authoring path contains control characters: ${JSON.stringify(path)}`,
    };
  }
  if (path.includes('\\')) {
    return {
      ok: false,
      code: 'backslash-path',
      message: `Authoring path uses backslashes; only forward-slash logical paths are accepted: ${path}`,
    };
  }
  if (path.startsWith('/')) {
    return {
      ok: false,
      code: 'absolute-path',
      message: `Absolute authoring path rejected: ${path}`,
    };
  }
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '')
      return {
        ok: false,
        code: 'empty-segment',
        message: `Authoring path contains an empty segment: ${path}`,
      };
    if (segment === '.')
      return {
        ok: false,
        code: 'dot-segment',
        message: `Authoring path contains a '.' segment: ${path}`,
      };
    if (segment === '..')
      return {
        ok: false,
        code: 'traversal-path',
        message: `Authoring path escapes the authoring root: ${path}`,
      };
  }
  for (const segment of segments) {
    if (segment === '.git')
      return {
        ok: false,
        code: 'git-internal-path',
        message: `Git internal path rejected: ${path}`,
      };
    if (segment === '.nova')
      return {
        ok: false,
        code: 'nova-runtime-path',
        message: `Runtime artifact path rejected: ${path}`,
      };
  }
  for (const segment of segments) {
    if (segment.startsWith('.'))
      return {
        ok: false,
        code: 'hidden-component',
        message: `Hidden path component rejected: ${path}`,
      };
  }
  if ((ROOT_AUTHORING_FILES as readonly string[]).includes(path))
    return { ok: true, kind: 'root-yaml' };
  if (path === OPTIONAL_ROOT_AUTHORING_FILE) return { ok: true, kind: 'ledger-yaml' };
  if (ENTITY_DIRECTORY_PATTERN.test(path) && path.endsWith('.yaml'))
    return { ok: true, kind: 'entity-yaml' };
  if (CHAPTER_FILE_PATTERN.test(path)) return { ok: true, kind: 'chapter-yaml' };
  if (SCENE_FILE_PATTERN.test(path)) return { ok: true, kind: 'scene-md' };
  if (path.endsWith('.yaml') || path.endsWith('.md')) {
    return {
      ok: false,
      code: 'non-authoring-path',
      message: `Path is outside the authoring topology: ${path}`,
    };
  }
  return { ok: false, code: 'unknown-extension', message: `Unknown authoring file type: ${path}` };
}

/** Validate the shape of an adopt claim. */
export function validateAdoptClaim(
  claim: AdoptSceneClaim,
):
  | { readonly ok: true; readonly eventId: string }
  | { readonly ok: false; readonly code: 'adopt-claim-invalid'; readonly message: string } {
  const fail = (
    message: string,
  ): { readonly ok: false; readonly code: 'adopt-claim-invalid'; readonly message: string } => ({
    ok: false,
    code: 'adopt-claim-invalid',
    message,
  });
  if (typeof claim !== 'object' || claim === null) return fail('Adopt claim must be an object');
  if (
    typeof claim.eventId !== 'string' ||
    claim.eventId.length === 0 ||
    claim.eventId.includes('/') ||
    hasControlCharacter(claim.eventId)
  ) {
    return fail('Adopt claim eventId must be a non-empty path-safe identifier');
  }
  if (typeof claim.revisionId !== 'string' || claim.revisionId.length === 0) {
    return fail('Adopt claim revisionId must be a non-empty string');
  }
  if (!/^[a-f0-9]{64}$/.test(claim.proseHash)) {
    return fail('Adopt claim proseHash must be a sha256 hex digest');
  }
  if (claim.released !== true) {
    return fail('Only accepted (released) scene revisions can be adopted');
  }
  if (typeof claim.acceptedAt !== 'string' || claim.acceptedAt.length === 0) {
    return fail('Adopt claim acceptedAt must be a non-empty timestamp');
  }
  return { ok: true, eventId: claim.eventId };
}

/** True when the entry bytes are exactly the claimed accepted prose. */
export function sceneBytesMatchClaim(bytes: Uint8Array, claim: AdoptSceneClaim): boolean {
  return createHash('sha256').update(bytes).digest('hex') === claim.proseHash;
}

function validateAuthoringBytes(
  bytes: Uint8Array,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ManifestRejectionCode; readonly message: string } {
  if (bytes.includes(0))
    return { ok: false, code: 'nul-byte', message: 'Authoring content contains NUL bytes' };
  if (bytes.includes(0x0d)) {
    return {
      ok: false,
      code: 'carriage-return',
      message: 'Authoring content must use LF-only line endings (CR byte found)',
    };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, code: 'invalid-utf8', message: 'Authoring content is not valid UTF-8' };
  }
  return { ok: true };
}

function validateAuthoringMode(
  mode: AuthoringMode | undefined,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ManifestRejectionCode; readonly message: string } {
  if (mode === undefined || mode === 'blob' || mode === 'executable') return { ok: true };
  if (mode === 'symlink')
    return {
      ok: false,
      code: 'symlink-entry',
      message: 'Symlink entries cannot be authored through the manifest',
    };
  if (mode === 'gitlink')
    return {
      ok: false,
      code: 'gitlink-entry',
      message: 'Gitlink entries cannot be authored through the manifest',
    };
  return {
    ok: false,
    code: 'unknown-mode',
    message: `Unrecognized authoring entry mode: ${String(mode)}`,
  };
}

export type ManifestCheck =
  | { readonly ok: true; readonly kind: AuthoringEntryKind }
  | {
      readonly ok: false;
      readonly code: ManifestRejectionCode;
      readonly message: string;
      readonly path: string;
    };

export interface AuthoringManifestOptions {
  /** Scenes already accepted at the current native revision do not need a new proof. */
  readonly pathsInHead?: ReadonlySet<string>;
  /** Host-verified adopt claims keyed by event id for newly introduced scenes. */
  readonly adoptClaims?: ReadonlyMap<string, AdoptSceneClaim>;
}

export class AuthoringManifest {
  private readonly pathsInHead: ReadonlySet<string>;
  private readonly adoptClaims: ReadonlyMap<string, AdoptSceneClaim>;

  constructor(options: AuthoringManifestOptions = {}) {
    this.pathsInHead = options.pathsInHead ?? new Set();
    this.adoptClaims = options.adoptClaims ?? new Map();
  }

  /** Validate a single entry; returns a structured result instead of throwing. */
  checkEntry(entry: AuthoringEntry): ManifestCheck {
    const pathResult = classifyAuthoringPath(entry.path);
    if (!pathResult.ok) {
      return { ok: false, code: pathResult.code, message: pathResult.message, path: entry.path };
    }
    if (pathResult.kind === 'scene-md' && !this.pathsInHead.has(entry.path)) {
      const sceneMatch = SCENE_FILE_PATTERN.exec(entry.path);
      const eventId = sceneMatch?.[1] ?? '';
      const claim = this.adoptClaims.get(eventId);
      if (!claim) {
        return {
          ok: false,
          code: 'adopt-scene-unproven',
          message: `Scene ${entry.path} is not backed by a verified adopt claim`,
          path: entry.path,
        };
      }
      const claimResult = validateAdoptClaim(claim);
      if (!claimResult.ok) {
        return {
          ok: false,
          code: 'adopt-claim-invalid',
          message: claimResult.message,
          path: entry.path,
        };
      }
      if (claimResult.eventId !== eventId) {
        return {
          ok: false,
          code: 'adopt-claim-event-mismatch',
          message: `Adopt claim eventId ${claimResult.eventId} does not match scene path ${entry.path}`,
          path: entry.path,
        };
      }
      if (!sceneBytesMatchClaim(entry.bytes, claim)) {
        return {
          ok: false,
          code: 'adopt-scene-content-mismatch',
          message: `Scene ${entry.path} bytes do not match the accepted revision prose (${claim.revisionId})`,
          path: entry.path,
        };
      }
    }
    const bytesResult = validateAuthoringBytes(entry.bytes);
    if (!bytesResult.ok) {
      return { ok: false, code: bytesResult.code, message: bytesResult.message, path: entry.path };
    }
    const modeResult = validateAuthoringMode(entry.mode);
    if (!modeResult.ok) {
      return { ok: false, code: modeResult.code, message: modeResult.message, path: entry.path };
    }
    return { ok: true, kind: pathResult.kind };
  }
  /** Validate all entries atomically; the first rejection aborts the whole submit. */
  validate(entries: readonly AuthoringEntry[]): void {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.path)) {
        throw new ManifestValidationError(
          'duplicate-path',
          `Duplicate authoring path in manifest: ${entry.path}`,
          entry.path,
        );
      }
      seen.add(entry.path);
      this.validateEntry(entry);
    }
    const paths = new Set(entries.map((entry) => entry.path));
    for (const requiredPath of ROOT_AUTHORING_FILES) {
      if (!paths.has(requiredPath)) {
        throw new ManifestValidationError(
          'missing-required-root',
          `Complete authoring source is missing required root ${requiredPath}`,
          requiredPath,
        );
      }
    }
  }
  /** Validate a single entry, throwing {@link ManifestValidationError} on rejection. */
  validateEntry(entry: AuthoringEntry): void {
    const check = this.checkEntry(entry);
    if (!check.ok) throw new ManifestValidationError(check.code, check.message, check.path);
  }
}
