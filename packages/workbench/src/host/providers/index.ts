/**
 * Host-only provider credential foundation: per-provider API credentials kept
 * in an injected OS credential adapter or the restricted XDG file fallback.
 * Never imported by browser code; `src/contracts/index.ts` does not re-export
 * any of these types, so no credential value or secret-bearing type can reach
 * browser DTOs, Yjs documents, MCP tools, or Git commits through this package.
 */

export type {
  CredentialStoreErrorCode,
  OsCredentialStore,
  ProviderCredentialStore,
  ProviderCredentialStoreOptions,
  XdgConfigEnv,
  XdgCredentialFileStoreOptions,
} from './credential-store.js';
export {
  assertValidProviderId,
  CredentialStoreError,
  createProviderCredentialStore,
  DEFAULT_PROVIDER_PROFILE,
  isValidProviderId,
  PROVIDER_ID_PATTERN,
  providerCredentialKey,
  resolveXdgConfigDir,
  XdgCredentialFileStore,
} from './credential-store.js';
