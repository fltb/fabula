import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CredentialStoreError,
  createProviderCredentialStore,
  isValidProviderId,
  type OsCredentialStore,
  PROVIDER_ID_PATTERN,
  resolveXdgConfigDir,
  XdgCredentialFileStore,
} from '../src/host/providers/index.js';

const tempDirs: string[] = [];
function newTempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fabula-credential-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('cross-process lock', () => {
  it('serializes read-modify-write across separate store instances', async () => {
    const configDir = newTempConfigDir();
    const first = new XdgCredentialFileStore({ configDir });
    const second = new XdgCredentialFileStore({ configDir });
    await Promise.all([
      first.set('alpha', 'secret-alpha'),
      second.set('beta', 'secret-beta'),
      first.set('gamma', 'secret-gamma'),
      second.set('delta', 'secret-delta'),
    ]);
    await expect(first.get('alpha')).resolves.toBe('secret-alpha');
    await expect(second.get('beta')).resolves.toBe('secret-beta');
    await expect(first.get('gamma')).resolves.toBe('secret-gamma');
    await expect(second.get('delta')).resolves.toBe('secret-delta');
  });

  it('recovers a lock whose payload was never written (crash between create and write)', async () => {
    const configDir = newTempConfigDir();
    const fabulaDir = join(configDir, 'fabula');
    await mkdir(fabulaDir, { recursive: true });
    await writeFile(join(fabulaDir, 'providers.json.lock'), 'partial', { mode: 0o600 });
    const store = new XdgCredentialFileStore({ configDir, lockStaleMs: 0 });
    await store.set('openai', 'sk-after-abandoned-lock');
    await expect(store.get('openai')).resolves.toBe('sk-after-abandoned-lock');
  });

  it('steals a lock whose owner process has exited', async () => {
    const configDir = newTempConfigDir();
    const fabulaDir = join(configDir, 'fabula');
    await mkdir(fabulaDir, { recursive: true });
    const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    expect(exited.status).toBe(0);
    await writeFile(
      join(fabulaDir, 'providers.json.lock'),
      JSON.stringify({ pid: exited.pid, createdAt: Date.now() }),
      { mode: 0o600 },
    );
    const store = new XdgCredentialFileStore({ configDir });
    await store.set('openai', 'sk-after-dead-owner');
    await expect(store.get('openai')).resolves.toBe('sk-after-dead-owner');
  });

  it('times out with a typed error while a live holder keeps the lock', async () => {
    const configDir = newTempConfigDir();
    const fabulaDir = join(configDir, 'fabula');
    await mkdir(fabulaDir, { recursive: true });
    await writeFile(
      join(fabulaDir, 'providers.json.lock'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
      { mode: 0o600 },
    );
    const store = new XdgCredentialFileStore({ configDir, lockRetryMs: 5, lockTimeoutMs: 60 });
    const error = await store.set('openai', 'sk-blocked-secret').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('CREDENTIAL_IO_ERROR');
    expect(String((error as Error).message)).not.toContain('sk-blocked-secret');
  });

  it('removes the lock file after operations', async () => {
    const configDir = newTempConfigDir();
    const store = new XdgCredentialFileStore({ configDir });
    await store.set('openai', 'sk-lock-released');
    await store.get('openai');
    await expect(stat(join(configDir, 'fabula', 'providers.json.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('provider credential store', () => {
  it('stores, reads, and removes secrets per provider', async () => {
    const store = createProviderCredentialStore({ configDir: newTempConfigDir() });
    await store.set('deepseek', 'sk-test-deepseek-1');
    await store.set('openai', 'sk-test-openai-2');
    await expect(store.get('deepseek')).resolves.toBe('sk-test-deepseek-1');
    await expect(store.get('openai')).resolves.toBe('sk-test-openai-2');
    await expect(store.get('anthropic')).resolves.toBeNull();
    await store.remove('deepseek');
    await expect(store.get('deepseek')).resolves.toBeNull();
    await expect(store.get('openai')).resolves.toBe('sk-test-openai-2');
    await store.remove('deepseek'); // removing a missing credential is idempotent
  });

  it('stores profile-scoped AI-SDK credentials under ai-sdk:<profile> keys', async () => {
    const store = createProviderCredentialStore({ configDir: newTempConfigDir() });
    await store.set('ai-sdk:default', 'sk-default-profile');
    await store.set('ai-sdk:prod-eu', 'sk-prod-eu');
    await expect(store.get('ai-sdk:default')).resolves.toBe('sk-default-profile');
    await expect(store.get('ai-sdk:prod-eu')).resolves.toBe('sk-prod-eu');
    await expect(store.get('openai')).resolves.toBeNull();
    await store.remove('ai-sdk:prod-eu');
    await expect(store.get('ai-sdk:prod-eu')).resolves.toBeNull();
    await expect(store.get('ai-sdk:default')).resolves.toBe('sk-default-profile');
  });

  it('falls back to the legacy bare ai-sdk key when reading ai-sdk:default', async () => {
    const configDir = newTempConfigDir();
    const legacy = new XdgCredentialFileStore({ configDir });
    await legacy.set('ai-sdk', 'sk-legacy-bare');
    const store = createProviderCredentialStore({ configDir });
    await expect(store.get('ai-sdk:default')).resolves.toBe('sk-legacy-bare');
    // A profile-scoped write supersedes the legacy key without losing unrelated entries.
    await store.set('ai-sdk:default', 'sk-canonical');
    await expect(store.get('ai-sdk:default')).resolves.toBe('sk-canonical');
    await expect(store.get('ai-sdk')).resolves.toBe('sk-legacy-bare');
  });

  it('keeps credentials across a host restart (new store instance, same directory)', async () => {
    const configDir = newTempConfigDir();
    const first = createProviderCredentialStore({ configDir });
    await first.set('openai', 'sk-restart-openai');
    const second = createProviderCredentialStore({ configDir });
    await expect(second.get('openai')).resolves.toBe('sk-restart-openai');
    const direct = new XdgCredentialFileStore({ configDir });
    await expect(direct.get('openai')).resolves.toBe('sk-restart-openai');
  });

  it('overwrites an existing credential on re-set', async () => {
    const store = createProviderCredentialStore({ configDir: newTempConfigDir() });
    await store.set('openai', 'sk-v1');
    await store.set('openai', 'sk-v2');
    await expect(store.get('openai')).resolves.toBe('sk-v2');
  });

  it('keeps unrelated providers when one is updated (read-modify-write)', async () => {
    const store = new XdgCredentialFileStore({ configDir: newTempConfigDir() });
    await store.set('alpha', 'secret-alpha');
    await store.set('beta', 'secret-beta');
    await store.set('alpha', 'secret-alpha-updated');
    await expect(store.get('beta')).resolves.toBe('secret-beta');
    await expect(store.get('alpha')).resolves.toBe('secret-alpha-updated');
  });

  it('serializes concurrent writes without losing entries', async () => {
    const store = new XdgCredentialFileStore({ configDir: newTempConfigDir() });
    await Promise.all([
      store.set('alpha', 'secret-alpha'),
      store.set('beta', 'secret-beta'),
      store.set('gamma', 'secret-gamma'),
    ]);
    await expect(store.get('alpha')).resolves.toBe('secret-alpha');
    await expect(store.get('beta')).resolves.toBe('secret-beta');
    await expect(store.get('gamma')).resolves.toBe('secret-gamma');
  });
});

describe('filesystem permissions and containment', () => {
  it('creates the config directory 0700 and the credential file 0600', async () => {
    const configDir = newTempConfigDir();
    const store = new XdgCredentialFileStore({ configDir });
    await store.set('openai', 'sk-permissions');
    const dirMode = (await stat(join(configDir, 'fabula'))).mode & 0o777;
    const fileMode = (await stat(join(configDir, 'fabula', 'providers.json'))).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it('enforces exact permissions even when the umask would strip creation modes', async () => {
    const configDir = newTempConfigDir();
    const previousUmask = process.umask(0o700);
    try {
      const store = new XdgCredentialFileStore({ configDir });
      await store.set('openai', 'sk-umask');
    } finally {
      process.umask(previousUmask);
    }
    const dirMode = (await stat(join(configDir, 'fabula'))).mode & 0o777;
    const fileMode = (await stat(join(configDir, 'fabula', 'providers.json'))).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it('never writes provider credentials outside the fixed config document', async () => {
    const configDir = newTempConfigDir();
    const store = new XdgCredentialFileStore({ configDir });
    await store.set('openai', 'sk-contained');
    const files = await readdir(join(configDir, 'fabula'));
    expect(files.filter((name) => !name.startsWith('providers.json.tmp-'))).toEqual([
      'providers.json',
    ]);
  });
});

describe('provider id validation', () => {
  const INVALID_IDS = [
    '',
    'OpenAI',
    'open_ai',
    'open ai',
    '123abc',
    '-openai',
    'openai!',
    '..',
    'x'.repeat(64),
  ];

  it('rejects invalid provider ids without touching storage', async () => {
    const store = createProviderCredentialStore({ configDir: newTempConfigDir() });
    for (const bad of INVALID_IDS) {
      await expect(store.set(bad, 'sk-secret')).rejects.toMatchObject({
        code: 'INVALID_PROVIDER_ID',
      });
      await expect(store.get(bad)).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ID' });
      await expect(store.remove(bad)).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ID' });
    }
  });

  it('rejects invalid provider ids on the concrete file store too', async () => {
    const store = new XdgCredentialFileStore({ configDir: newTempConfigDir() });
    await expect(store.set('Bad Provider', 'sk-secret')).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_ID',
    });
  });

  it('accepts well-formed provider ids', () => {
    for (const good of [
      'openai',
      'anthropic',
      'deepseek',
      'openrouter',
      'a',
      'x'.repeat(63),
      'my-provider-2',
      'ai-sdk',
      'ai-sdk:default',
      'ai-sdk:prod-eu-1',
    ]) {
      expect(isValidProviderId(good)).toBe(true);
    }
    expect(PROVIDER_ID_PATTERN.test('openai')).toBe(true);
    expect(PROVIDER_ID_PATTERN.test('ai-sdk:default')).toBe(true);
    for (const bad of INVALID_IDS) {
      expect(isValidProviderId(bad)).toBe(false);
    }
    for (const bad of [
      'ai-sdk:',
      'ai-sdk:123abc',
      'ai-sdk:open_ai',
      'openai:foo',
      'AI-SDK:default',
    ]) {
      expect(isValidProviderId(bad)).toBe(false);
    }
  });
});

describe('fallback atomicity and error safety', () => {
  it('ignores stale temp files left by a crashed writer', async () => {
    const configDir = newTempConfigDir();
    const fabulaDir = join(configDir, 'fabula');
    await mkdir(fabulaDir, { recursive: true });
    await writeFile(join(fabulaDir, 'providers.json.tmp-stale-garbage'), 'partial garbage', {
      mode: 0o600,
    });
    const store = new XdgCredentialFileStore({ configDir });
    await store.set('openai', 'sk-after-crash');
    await store.set('anthropic', 'sk-after-crash-2');
    await expect(store.get('openai')).resolves.toBe('sk-after-crash');
    await expect(store.get('anthropic')).resolves.toBe('sk-after-crash-2');
    const raw = await readFile(join(fabulaDir, 'providers.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({ openai: 'sk-after-crash', anthropic: 'sk-after-crash-2' });
  });

  it('rejects a corrupt document instead of serving garbage and never leaks its content', async () => {
    const configDir = newTempConfigDir();
    const fabulaDir = join(configDir, 'fabula');
    await mkdir(fabulaDir, { recursive: true });
    await writeFile(join(fabulaDir, 'providers.json'), '{"openai": "sk-leaked-secret"', {
      mode: 0o600,
    });
    const store = new XdgCredentialFileStore({ configDir });
    const error = await store.get('openai').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('CORRUPT_CREDENTIAL_FILE');
    expect(String((error as Error).message)).not.toContain('sk-leaked-secret');
    expect((error as CredentialStoreError).cause).toBeUndefined();
  });

  it('rejects invalid provider keys and non-string values in an existing document', async () => {
    const configDir = newTempConfigDir();
    const fabulaDir = join(configDir, 'fabula');
    await mkdir(fabulaDir, { recursive: true });
    const store = new XdgCredentialFileStore({ configDir });
    await writeFile(join(fabulaDir, 'providers.json'), '{"Bad Key": "x"}', { mode: 0o600 });
    await expect(store.get('openai')).rejects.toMatchObject({ code: 'CORRUPT_CREDENTIAL_FILE' });
    await writeFile(join(fabulaDir, 'providers.json'), '{"openai": 42}', { mode: 0o600 });
    await expect(store.get('openai')).rejects.toMatchObject({ code: 'CORRUPT_CREDENTIAL_FILE' });
  });

  it('fails with a typed error and no secret in the message when storage cannot be written', async () => {
    const configDir = newTempConfigDir();
    await writeFile(join(configDir, 'fabula'), 'a file blocks the config directory', 'utf8');
    const store = new XdgCredentialFileStore({ configDir });
    const error = await store.set('openai', 'sk-blocked-secret').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('CREDENTIAL_IO_ERROR');
    expect(String((error as Error).message)).not.toContain('sk-blocked-secret');
    await expect(store.get('openai')).rejects.toMatchObject({ code: 'CREDENTIAL_IO_ERROR' });
  });
});

describe('xdg config directory resolution', () => {
  it('prefers XDG_CONFIG_HOME over HOME', () => {
    expect(resolveXdgConfigDir({ XDG_CONFIG_HOME: '/custom/xdg', HOME: '/home/user' })).toBe(
      '/custom/xdg',
    );
  });

  it('falls back to HOME/.config', () => {
    expect(resolveXdgConfigDir({ HOME: '/home/user' })).toBe('/home/user/.config');
  });

  it('fails closed when neither variable is set', () => {
    expect(() => resolveXdgConfigDir({})).toThrow(CredentialStoreError);
  });

  it('places the credential document under the resolved config directory', () => {
    const explicit = new XdgCredentialFileStore({ env: { XDG_CONFIG_HOME: '/custom/xdg' } });
    expect(explicit.filePath).toBe('/custom/xdg/fabula/providers.json');
    const homeDefault = new XdgCredentialFileStore({ env: { HOME: '/home/user' } });
    expect(homeDefault.filePath).toBe('/home/user/.config/fabula/providers.json');
  });
});

describe('injected OS credential adapter', () => {
  it('wins over the file fallback and never touches the fallback location', async () => {
    const configDir = newTempConfigDir();
    const calls: string[] = [];
    const osStore: OsCredentialStore = {
      label: 'test-os',
      async set(providerId, secret) {
        calls.push(`set:${providerId}:${secret}`);
      },
      async get(providerId) {
        calls.push(`get:${providerId}`);
        return null;
      },
      async remove(providerId) {
        calls.push(`remove:${providerId}`);
      },
    };
    const store = createProviderCredentialStore({ configDir, osCredentialStore: osStore });
    await store.set('openai', 'sk-os');
    await store.get('openai');
    await store.remove('openai');
    expect(calls).toEqual(['set:openai:sk-os', 'get:openai', 'remove:openai']);
    await expect(
      readFile(join(configDir, 'fabula', 'providers.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still validates provider ids on the OS path', async () => {
    const osStore: OsCredentialStore = {
      label: 'test-os',
      async set() {},
      async get() {
        return null;
      },
      async remove() {},
    };
    const store = createProviderCredentialStore({ osCredentialStore: osStore });
    await expect(store.set('Bad Provider', 'sk')).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_ID',
    });
  });

  it('never includes a credential value in wrapper errors', async () => {
    const osStore: OsCredentialStore = {
      label: 'test-os',
      async set() {
        throw new Error('keychain rejected sk-os-very-secret');
      },
      async get() {
        return null;
      },
      async remove() {},
    };
    const store = createProviderCredentialStore({ osCredentialStore: osStore });
    const error = await store.set('openai', 'sk-os-very-secret').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('OS_CREDENTIAL_STORE_ERROR');
    expect(String((error as Error).message)).not.toContain('sk-os-very-secret');
  });
});

describe('host-only provider credential boundary', () => {
  it('does not export provider credential types through the browser contract barrel', async () => {
    const barrel = await readFile(
      fileURLToPath(new URL('../src/contracts/index.ts', import.meta.url)),
      'utf8',
    );
    expect(barrel).not.toMatch(
      /ProviderCredentialStore|OsCredentialStore|XdgCredentialFileStore|CredentialStoreError|ProviderSecret|ApiKey/,
    );
  });

  it('keeps client code clear of provider credential imports', async () => {
    const clientDir = fileURLToPath(new URL('../src/client', import.meta.url));
    for (const name of await readdir(clientDir, { recursive: true })) {
      if (!String(name).endsWith('.ts') && !String(name).endsWith('.tsx')) continue;
      const source = await readFile(`${clientDir}/${String(name)}`, 'utf8');
      expect(source, String(name)).not.toMatch(/host\/providers|CredentialStore|OsCredential/);
    }
  });

  it('keeps provider credentials out of SQL, the persistence worker, and Git history', async () => {
    const providersDir = fileURLToPath(new URL('../src/host/providers', import.meta.url));
    for (const name of await readdir(providersDir)) {
      const source = await readFile(`${providersDir}/${String(name)}`, 'utf8');
      expect(source, String(name)).not.toMatch(
        /node:sqlite|DatabaseSync|kysely|persistence\/worker|host\/git/,
      );
    }
  });
});
