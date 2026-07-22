// ============================================================================
// Novalistically — Schema Migration Registry
// ============================================================================
//
// The migration system enables safe, versioned upgrades of project schema
// files. Each migration function transforms data from version N to N+1.
// ============================================================================

export type MigrationFn = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * Map of target version → migration function.
 * Key is the version number being upgraded TO (e.g. key 2 = v1→v2).
 */
export const migrations: Map<number, MigrationFn> = new Map();

/**
 * Migrate data from currentVersion to targetVersion by applying
 * each intermediate migration in sequence.
 *
 * @param data - The raw project data object (must be mutable)
 * @param currentVersion - The current schema version of the data
 * @param targetVersion - The target schema version
 * @returns The migrated data with schemaVersion set to targetVersion
 * @throws If currentVersion > targetVersion (data too new for this software)
 */
export function migrateToLatest(
  data: Record<string, unknown>,
  currentVersion: number,
  targetVersion: number,
): Record<string, unknown> {
  if (currentVersion > targetVersion) {
    throw new Error(
      `Project schema version ${currentVersion} is newer than supported ${targetVersion}. Please upgrade Novalistically.`,
    );
  }

  let result = { ...data };

  for (let v = currentVersion + 1; v <= targetVersion; v++) {
    const fn = migrations.get(v);
    if (fn) {
      result = fn(result);
    }
  }

  result.schemaVersion = targetVersion;
  return result;
}

/** The latest schema version supported by this release. */
export const CURRENT_SCHEMA_VERSION = 1;
