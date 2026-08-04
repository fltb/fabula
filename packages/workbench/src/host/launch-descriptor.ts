/**
 * Workbench Host launch descriptor: validated absolute paths derived from the
 * artifact manifest and environment. The descriptor is the single source of
 * truth for everything the supervisor needs to spawn a Host child process.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { HostBuildIdentityV1 } from '@novalistically/workbench-protocol';
import { HOST_PROTOCOL_VERSION_V1 } from '@novalistically/workbench-protocol';

import {
  ARTIFACT_ENTRY_HOST,
  ARTIFACT_ENTRY_PERSISTENCE_WORKER,
  type ArtifactManifestBuildIdentityV1,
  type ArtifactManifestEntryV1,
  type HostArtifactManifestV1,
  loadArtifactManifest,
  resolveManifestEntryPath,
  verifyManifestIntegrity,
} from './artifact-manifest.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface LaunchDescriptorPaths {
  /** Absolute path to the Node.js executable (process.execPath at build time). */
  readonly nodePath: string;
  /** Absolute path to the built Host entry (dist/host/host/main.js). */
  readonly hostEntry: string;
  /** Absolute path to the built persistence worker entry (dist/host/persistence/worker.js). */
  readonly workerEntry: string;
  /** Absolute path to the packaged client assets directory (dist/client). */
  readonly assetsRoot: string;
  /** Resolved Host home directory for durable state. */
  readonly hostHome: string;
  /** Resolved database path under hostHome. */
  readonly databasePath: string;
  /** Resolved XDG config directory for credential storage. */
  readonly credentialBase: string;
}

export interface HostLaunchDescriptorV1 {
  readonly version: 1;
  /** Absolute path of the manifest that was validated to create this descriptor. */
  readonly manifestPath: string;
  readonly manifest: HostArtifactManifestV1;
  readonly hostEntry: ArtifactManifestEntryV1;
  readonly workerEntry: ArtifactManifestEntryV1;
  readonly paths: LaunchDescriptorPaths;
  readonly build: HostBuildIdentityV1;
  readonly mode: 'workbench' | 'listener';
  readonly dev: boolean;
}
// ─── Environment helpers ───────────────────────────────────────────────────

function opt(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

function resolveCredentialBase(env: Record<string, string | undefined>): string {
  const explicit = opt(env.XDG_CONFIG_HOME);
  if (explicit !== undefined) return resolve(explicit);
  const home = opt(env.HOME);
  if (home !== undefined) return resolve(home, '.config');
  throw new Error('Cannot resolve credential base: set XDG_CONFIG_HOME or HOME');
}

function resolveHostHome(env: Record<string, string | undefined>): string {
  const override = opt(env.WORKBENCH_HOME);
  if (override !== undefined) return resolve(override);
  const xdg = opt(env.XDG_STATE_HOME);
  if (xdg !== undefined) return resolve(xdg, 'fabula', 'workbench');
  const home = opt(env.HOME);
  if (home !== undefined) return resolve(home, '.local', 'state', 'fabula', 'workbench');
  throw new Error('Cannot resolve Host home: set WORKBENCH_HOME, XDG_STATE_HOME, or HOME');
}

// ─── Descriptor derivation ─────────────────────────────────────────────────

export interface BuildDescriptorOptions {
  readonly manifestPath: string;
  readonly env?: Record<string, string | undefined>;
  /** Override the assets root (used in dev mode where Vite serves assets). */
  readonly assetsRootOverride?: string;
  /** Override the database path (used in dev mode with explicit path). */
  readonly mode?: 'workbench' | 'listener';
  readonly dev?: boolean;
  readonly databasePathOverride?: string;
}

/**
 * Derive a validated `HostLaunchDescriptorV1` from the artifact manifest and
 * environment. Fails with a typed error if any required path is missing or
 * the manifest fails integrity verification.
 */
export function buildLaunchDescriptor(options: BuildDescriptorOptions): HostLaunchDescriptorV1 {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const manifestPath = resolve(options.manifestPath);
  const manifest = loadArtifactManifest(manifestPath);
  validateNodeVersion(manifest);

  const integrity = verifyManifestIntegrity(manifest);
  if (!integrity.ok) {
    throw new LaunchDescriptorError(
      'ARTIFACT_INTEGRITY_FAILED',
      'manifest',
      `Artifact manifest integrity check failed:
  ${integrity.errors.join('\n  ')}`,
    );
  }

  const hostEntry = lookupEntry(manifest, ARTIFACT_ENTRY_HOST);
  const workerEntry = lookupEntry(manifest, ARTIFACT_ENTRY_PERSISTENCE_WORKER);

  const hostEntryPath = resolveManifestEntryPath(manifest, ARTIFACT_ENTRY_HOST);
  if (hostEntryPath === undefined) {
    throw new LaunchDescriptorError(
      'MANIFEST_ENTRY_MISSING',
      ARTIFACT_ENTRY_HOST,
      `Artifact manifest missing required entry point: ${ARTIFACT_ENTRY_HOST}`,
    );
  }
  const workerEntryPath = resolveManifestEntryPath(manifest, ARTIFACT_ENTRY_PERSISTENCE_WORKER);
  if (workerEntryPath === undefined) {
    throw new LaunchDescriptorError(
      'MANIFEST_ENTRY_MISSING',
      ARTIFACT_ENTRY_PERSISTENCE_WORKER,
      `Artifact manifest missing required entry point: ${ARTIFACT_ENTRY_PERSISTENCE_WORKER}`,
    );
  }

  const hostHome = resolveHostHome(env);
  const databasePath =
    options.databasePathOverride !== undefined
      ? resolve(options.databasePathOverride)
      : resolve(hostHome, 'workbench.sqlite');
  const credentialBase = resolveCredentialBase(env);
  const assetsRoot =
    options.assetsRootOverride !== undefined
      ? resolve(options.assetsRootOverride)
      : resolve(manifest.outputRoot, '..', 'client');

  // Runtime validation: verify every referenced path exists on disk
  validatePaths({
    nodePath: process.execPath,
    hostEntry: hostEntryPath,
    workerEntry: workerEntryPath,
    assetsRoot,
    hostHome,
    databasePath,
    credentialBase,
  });

  return {
    version: 1,
    manifestPath,
    manifest,
    hostEntry,
    workerEntry,
    paths: {
      nodePath: process.execPath,
      hostEntry: hostEntryPath,
      workerEntry: workerEntryPath,
      assetsRoot,
      hostHome,
      databasePath,
      credentialBase,
    },
    build: buildIdentityFromManifest(manifest.build),
    mode: options.mode ?? 'workbench',
    dev: options.dev ?? false,
  };
}

function lookupEntry(
  manifest: HostArtifactManifestV1,
  entryPoint: string,
): ArtifactManifestEntryV1 {
  const entry = manifest.outputs.find((e) => e.entryPointFor === entryPoint);
  if (entry === undefined) {
    throw new LaunchDescriptorError(
      'MANIFEST_ENTRY_MISSING',
      entryPoint,
      `Artifact manifest missing required entry point: ${entryPoint}`,
    );
  }
  return entry;
}

function buildIdentityFromManifest(m: ArtifactManifestBuildIdentityV1): HostBuildIdentityV1 {
  return {
    version: 1,
    packageId: m.packageId,
    buildId: m.buildId,
    protocolVersion: HOST_PROTOCOL_VERSION_V1,
  };
}

// ─── Path validation ───────────────────────────────────────────────────────

export interface LaunchPaths {
  readonly nodePath: string;
  readonly hostEntry: string;
  readonly workerEntry: string;
  readonly assetsRoot: string;
  readonly hostHome: string;
  readonly databasePath: string;
  readonly credentialBase: string;
}

export class LaunchDescriptorError extends Error {
  readonly code: string;
  readonly field: string;
  constructor(code: string, field: string, message: string) {
    super(message);
    this.name = 'LaunchDescriptorError';
    this.code = code;
    this.field = field;
  }
}

export function validatePaths(paths: LaunchPaths): void {
  for (const [field, value] of Object.entries(paths)) {
    if (!isAbsolute(value)) {
      throw new LaunchDescriptorError(
        'PATH_NOT_ABSOLUTE',
        field,
        `Launch path must be absolute: ${field}`,
      );
    }
  }
  // Node executable
  try {
    if (!statSync(paths.nodePath).isFile()) throw new Error('not a file');
  } catch {
    throw new LaunchDescriptorError(
      'NODE_NOT_FOUND',
      'nodePath',
      `Node executable is not accessible: ${paths.nodePath}`,
    );
  }

  // Host and worker entries must both be regular files.
  try {
    if (!statSync(paths.hostEntry).isFile()) throw new Error('not a file');
  } catch {
    throw new LaunchDescriptorError(
      'HOST_ENTRY_NOT_FOUND',
      'hostEntry',
      `Host entry not found or inaccessible: ${paths.hostEntry}. Run build:host first.`,
    );
  }
  try {
    if (!statSync(paths.workerEntry).isFile()) throw new Error('not a file');
  } catch {
    throw new LaunchDescriptorError(
      'WORKER_ENTRY_NOT_FOUND',
      'workerEntry',
      `Persistence worker entry not found or inaccessible: ${paths.workerEntry}. Run build:host first.`,
    );
  }
  // Packaged client assets must be a directory.
  try {
    if (!statSync(paths.assetsRoot).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new LaunchDescriptorError(
      'ASSETS_ROOT_NOT_FOUND',
      'assetsRoot',
      `Client assets root not found or inaccessible: ${paths.assetsRoot}. Run build:client first.`,
    );
  }

  // Host home (created on demand, but parent must exist)
  const hostHomeParent = resolve(paths.hostHome, '..');
  if (!existsSync(hostHomeParent)) {
    throw new LaunchDescriptorError(
      'HOST_HOME_PARENT_NOT_FOUND',
      'hostHome',
      `Host home parent directory does not exist: ${hostHomeParent}`,
    );
  }

  const credentialParent = resolve(paths.credentialBase, '..');
  if (!existsSync(credentialParent)) {
    throw new LaunchDescriptorError(
      'CREDENTIAL_BASE_PARENT_NOT_FOUND',
      'credentialBase',
      `Credential base parent directory does not exist: ${credentialParent}`,
    );
  }
}

// ─── Node version check ────────────────────────────────────────────────────

/** Validate that the running Node version satisfies the manifest's requirement. */
export function validateNodeVersion(
  manifest: HostArtifactManifestV1,
  runtimeVersion?: string,
): void {
  const actual = runtimeVersion ?? process.versions.node;
  const required = manifest.build.nodeVersion;
  if (actual !== required) {
    throw new LaunchDescriptorError(
      'NODE_VERSION_MISMATCH',
      'nodeVersion',
      `Node version mismatch: built with ${required}, running with ${actual}`,
    );
  }
}
