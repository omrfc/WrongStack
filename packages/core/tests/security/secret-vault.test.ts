import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DefaultSecretVault,
  decryptConfigSecrets,
  encryptConfigSecrets,
  rewriteConfigEncrypted,
} from '../../src/security/secret-vault.js';

async function makeVault() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-vault-'));
  const keyFile = path.join(dir, '.key');
  return { dir, keyFile, vault: new DefaultSecretVault({ keyFile }) };
}

describe('DefaultSecretVault', () => {
  it('encrypt/decrypt round-trip with auto-generated key', async () => {
    const { dir, vault } = await makeVault();
    const enc = vault.encrypt('sk-test-1234');
    expect(enc.startsWith('enc:v1:')).toBe(true);
    expect(enc).not.toContain('sk-test-1234');
    expect(vault.decrypt(enc)).toBe('sk-test-1234');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('passes plaintext through unchanged on decrypt', async () => {
    const { dir, vault } = await makeVault();
    expect(vault.decrypt('plain-key')).toBe('plain-key');
    expect(vault.isEncrypted('plain-key')).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not re-encrypt an already-encrypted value', async () => {
    const { dir, vault } = await makeVault();
    const enc = vault.encrypt('secret');
    const enc2 = vault.encrypt(enc);
    expect(enc2).toBe(enc);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('different IVs produce different ciphertexts for the same plaintext', async () => {
    const { dir, vault } = await makeVault();
    const a = vault.encrypt('same');
    const b = vault.encrypt('same');
    expect(a).not.toBe(b);
    expect(vault.decrypt(a)).toBe('same');
    expect(vault.decrypt(b)).toBe('same');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects malformed encrypted values', async () => {
    const { dir, vault } = await makeVault();
    expect(() => vault.decrypt('enc:v1:bad')).toThrow(/malformed/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates key file with restrictive mode (best-effort)', async () => {
    const { dir, keyFile, vault } = await makeVault();
    vault.encrypt('x');
    const stat = fsSync.statSync(keyFile);
    expect(stat.size).toBe(32);
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('decryptConfigSecrets walks nested apiKey fields', async () => {
    const { dir, vault } = await makeVault();
    const cfg = {
      apiKey: vault.encrypt('top'),
      providers: {
        a: { apiKey: vault.encrypt('aaa') },
        b: { apiKey: 'plain', baseUrl: 'http://x' },
      },
      mcpServers: { s: { authToken: vault.encrypt('mcp') } },
    };
    const dec = decryptConfigSecrets(cfg, vault) as typeof cfg;
    expect(dec.apiKey).toBe('top');
    expect(dec.providers.a.apiKey).toBe('aaa');
    expect(dec.providers.b.apiKey).toBe('plain');
    expect(dec.providers.b.baseUrl).toBe('http://x');
    expect(dec.mcpServers.s.authToken).toBe('mcp');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('encryptConfigSecrets covers refreshToken / sessionKey / password / private_key (suffix matching)', async () => {
    const { dir, vault } = await makeVault();
    const enc = encryptConfigSecrets(
      {
        refreshToken: 'r-1',
        sessionKey: 's-1',
        password: 'p-1',
        client_secret: 'cs-1',
        private_key: 'pk-1',
        Bearer: 'B-1',
        publicKey: 'pub-not-secret',
        baseUrl: 'http://x',
      },
      vault,
    ) as Record<string, string>;
    expect(enc.refreshToken?.startsWith('enc:v1:')).toBe(true);
    expect(enc.sessionKey?.startsWith('enc:v1:')).toBe(true);
    expect(enc.password?.startsWith('enc:v1:')).toBe(true);
    expect(enc.client_secret?.startsWith('enc:v1:')).toBe(true);
    expect(enc.private_key?.startsWith('enc:v1:')).toBe(true);
    expect(enc.Bearer?.startsWith('enc:v1:')).toBe(true);
    // publicKey is on the override list — must NOT be encrypted.
    expect(enc.publicKey).toBe('pub-not-secret');
    expect(enc.baseUrl).toBe('http://x');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('encryptConfigSecrets idempotent on already-encrypted values', async () => {
    const { dir, vault } = await makeVault();
    const enc1 = encryptConfigSecrets({ providers: { a: { apiKey: 'plain' } } }, vault) as {
      providers: { a: { apiKey: string } };
    };
    expect(enc1.providers.a.apiKey.startsWith('enc:v1:')).toBe(true);
    const enc2 = encryptConfigSecrets(enc1, vault) as typeof enc1;
    expect(enc2.providers.a.apiKey).toBe(enc1.providers.a.apiKey);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('migratePlaintextSecrets encrypts plaintext apiKey fields in place', async () => {
    const { dir, vault } = await makeVault();
    const cfgPath = path.join(dir, 'config.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify(
        {
          version: 1,
          provider: 'a',
          model: 'm',
          apiKey: 'top-level-plain',
          providers: {
            a: { type: 'a', apiKey: 'nested-plain' },
            b: { type: 'b', apiKey: vault.encrypt('already-encrypted') },
          },
          mcpServers: { s: { authToken: 'mcp-plain' } },
        },
        null,
        2,
      ),
    );
    const { migrated } = await (
      await import('../../src/security/secret-vault.js')
    ).migratePlaintextSecrets(cfgPath, vault);
    expect(migrated).toBe(3); // top-level apiKey + providers.a.apiKey + mcpServers.s.authToken
    const after = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as {
      apiKey: string;
      providers: { a: { apiKey: string }; b: { apiKey: string } };
      mcpServers: { s: { authToken: string } };
    };
    expect(after.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(after.providers.a.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(after.providers.b.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(after.mcpServers.s.authToken.startsWith('enc:v1:')).toBe(true);
    expect(vault.decrypt(after.apiKey)).toBe('top-level-plain');
    expect(vault.decrypt(after.providers.a.apiKey)).toBe('nested-plain');
    expect(vault.decrypt(after.mcpServers.s.authToken)).toBe('mcp-plain');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('migratePlaintextSecrets is a no-op when nothing is plaintext', async () => {
    const { dir, vault } = await makeVault();
    const cfgPath = path.join(dir, 'config.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        version: 1,
        providers: { a: { type: 'a', apiKey: vault.encrypt('already') } },
      }),
    );
    const before = await fs.readFile(cfgPath, 'utf8');
    const { migrated } = await (
      await import('../../src/security/secret-vault.js')
    ).migratePlaintextSecrets(cfgPath, vault);
    expect(migrated).toBe(0);
    const after = await fs.readFile(cfgPath, 'utf8');
    expect(after).toBe(before);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('migratePlaintextSecrets ignores missing files', async () => {
    const { dir, vault } = await makeVault();
    const result = await (
      await import('../../src/security/secret-vault.js')
    ).migratePlaintextSecrets(path.join(dir, 'nope.json'), vault);
    expect(result.migrated).toBe(0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rewriteConfigEncrypted merges + encrypts + writes 0600 file', async () => {
    const { dir, vault } = await makeVault();
    const cfgPath = path.join(dir, 'config.json');
    await fs.writeFile(cfgPath, JSON.stringify({ version: 1, provider: 'a', model: 'm' }, null, 2));
    await rewriteConfigEncrypted(cfgPath, vault, {
      providers: { foo: { type: 'foo', apiKey: 'newkey', family: 'openai' } },
    });
    const raw = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as {
      providers: { foo: { apiKey: string } };
      version: number;
    };
    expect(raw.version).toBe(1);
    expect(raw.providers.foo.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(vault.decrypt(raw.providers.foo.apiKey)).toBe('newkey');
    await fs.rm(dir, { recursive: true, force: true });
  });
});
