import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/mcp/protocol';
import { createForgeaxMcpServer } from '../src/mcp/forgeax-server';
import {
  INSTALL_CLIENTS,
  launchSpec,
  type ClientSpec,
  type LaunchSpec,
} from '../src/install/clients';
import {
  RELEASE_IDENTITY,
  RELEASE_IDENTITY_MIME,
  RELEASE_IDENTITY_URI,
  releaseIdentityJson,
} from '../src/install/release-manifest';
import {
  installConfigs,
  InstallTransactionError,
} from '../src/install/transaction';
import { INSTALL_VERIFY_TIMEOUT_MS, type InstallVerification } from '../src/install/verify';

const LAUNCH: LaunchSpec = launchSpec('npx');
const HOME_CONFIGS = [
  ['codex', ['.codex', 'config.toml']],
  ['cursor', ['.cursor', 'mcp.json']],
  ['claude', ['.claude.json']],
] as const;

function verification(identity = RELEASE_IDENTITY): InstallVerification {
  return {
    serverName: 'forgeax',
    serverVersion: identity.gameVersion,
    tools: ['forgeax_status_lite', 'forgeax_run_current_game'],
    resources: ['forgeax://status', RELEASE_IDENTITY_URI],
    releaseIdentity: identity,
    releaseIdentityMimeType: RELEASE_IDENTITY_MIME,
    handshake: ['initialize', 'tools/list', 'resources/list', 'resources/read'],
  };
}

function fixture(): { root: string; home: string; state: string; verify: (launch: LaunchSpec, timeoutMs?: number) => Promise<InstallVerification> } {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-install-unit-'));
  const home = join(root, 'home');
  const state = join(root, 'state');
  mkdirSync(home, { recursive: true });
  return { root, home, state, verify: async () => verification() };
}

function configPath(home: string, client: (typeof HOME_CONFIGS)[number][0]): string {
  const parts = HOME_CONFIGS.find(([id]) => id === client)![1];
  return join(home, ...parts);
}

function fileHash(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function installRoot(state: string): string {
  return join(state, 'install');
}

function expectInstallError(error: unknown, code: string): InstallTransactionError {
  expect(error).toBeInstanceOf(InstallTransactionError);
  const typed = error as InstallTransactionError;
  expect(typed.code).toBe(code);
  return typed;
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

describe('GP-INSTALL release identity and transaction', () => {
  test('INS-01: unbound resource is listed/read and install writes the exact three launch shapes', async () => {
    const server = createForgeaxMcpServer();
    const listed = await dispatch(server, { id: 1, method: 'resources/list' });
    const resources = (listed?.result as { resources: Array<Record<string, unknown>> }).resources;
    const identityResource = resources.find((resource) => resource.uri === RELEASE_IDENTITY_URI);
    expect(identityResource).toMatchObject({ uri: RELEASE_IDENTITY_URI, mimeType: RELEASE_IDENTITY_MIME });

    const read = await dispatch(server, { id: 2, method: 'resources/read', params: { uri: RELEASE_IDENTITY_URI } });
    const contents = (read?.result as { contents: Array<Record<string, unknown>> }).contents;
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({ uri: RELEASE_IDENTITY_URI, mimeType: RELEASE_IDENTITY_MIME });
    expect(contents[0]!.text).toBe(releaseIdentityJson());

    const f = fixture();
    try {
      const result = await installConfigs({ home: f.home, stateRoot: f.state, launch: LAUNCH, verify: f.verify });
      expect(result.targets.map((target) => target.client).sort()).toEqual(['claude', 'codex', 'cursor']);
      expect(result.targets.every((target) => target.status === 'UPDATED')).toBeTrue();
      expect(result.lockOrder).toEqual([...result.lockOrder].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))));
      expect(lstatSync(f.state).mode & 0o7777).toBe(0o700);
      expect(lstatSync(installRoot(f.state)).mode & 0o7777).toBe(0o700);
      expect(JSON.parse(readFileSync(configPath(f.home, 'cursor'), 'utf8'))).toEqual({
        mcpServers: { forgeax: { command: 'npx', args: LAUNCH.args } },
      });
      expect(JSON.parse(readFileSync(configPath(f.home, 'claude'), 'utf8'))).toEqual({
        mcpServers: { forgeax: { command: 'npx', args: LAUNCH.args } },
      });
      const codex = readFileSync(configPath(f.home, 'codex'), 'utf8');
      expect(codex).toContain('[mcp_servers.forgeax]');
      expect(codex).toContain('command = "npx"');
      expect(codex).toContain('"@forgeax/game@0.3.10"');
    } finally {
      cleanup(f.root);
    }
  });

  test('INS-02: foreign JSON bytes and file modes survive an owned-range merge', async () => {
    const f = fixture();
    const cursor = configPath(f.home, 'cursor');
    mkdirSync(join(f.home, '.cursor'), { recursive: true });
    const originalDirectoryMode = lstatSync(join(f.home, '.cursor')).mode & 0o7777;
    const foreignPrefix = '{\n  "theme" : "dark",\n  "mcpServers" : {\n    "other" : { "command" : "keep", "args" : [] }';
    const foreignSuffix = '\n  },\n  "sentinel" : "keep-me"\n}\n';
    writeFileSync(cursor, `${foreignPrefix}${foreignSuffix}`);
    chmodSync(cursor, 0o640);
    try {
      await installConfigs({ home: f.home, stateRoot: f.state, launch: LAUNCH, verify: f.verify });
      const content = readFileSync(cursor, 'utf8');
      expect(content).toContain(foreignPrefix);
      expect(content).toContain(foreignSuffix);
      expect(content).toContain('"other" : { "command" : "keep", "args" : [] }');
      expect(content).toContain('"sentinel" : "keep-me"');
      expect(lstatSync(cursor).mode & 0o7777).toBe(0o640);
      expect(lstatSync(join(f.home, '.cursor')).mode & 0o7777).toBe(originalDirectoryMode);
      for (const [, parts] of HOME_CONFIGS) {
        const path = join(f.home, ...parts);
        expect(lstatSync(path).mode & 0o7777).toBe(path === cursor ? 0o640 : 0o600);
      }
    } finally {
      cleanup(f.root);
    }
  });

  test('passes the bounded cold-start timeout into the install handshake', async () => {
    const f = fixture();
    let timeoutMs: number | undefined;
    try {
      await installConfigs({
        home: f.home,
        stateRoot: f.state,
        launch: LAUNCH,
        verify: async (_launch, timeout) => {
          timeoutMs = timeout;
          return verification();
        },
      });
      expect(timeoutMs).toBe(INSTALL_VERIFY_TIMEOUT_MS);
      expect(timeoutMs).toBe(120_000);
    } finally {
      cleanup(f.root);
    }
  });

  test('INS-03: malformed and structurally competing data fail before any target/state mutation', async () => {
    const f = fixture();
    const cursor = configPath(f.home, 'cursor');
    mkdirSync(join(f.home, '.cursor'), { recursive: true });
    writeFileSync(cursor, '{ "mcpServers": ["user-owned"] }\n');
    const before = fileHash(cursor);
    try {
      const error = await installConfigs({ home: f.home, stateRoot: f.state, launch: LAUNCH, verify: f.verify }).catch((value) => value);
      expectInstallError(error, 'INSTALL_CONFIG_INVALID');
      expect(fileHash(cursor)).toBe(before);
      expect(existsSync(configPath(f.home, 'codex'))).toBeFalse();
      expect(existsSync(configPath(f.home, 'claude'))).toBeFalse();
      expect(existsSync(installRoot(f.state))).toBeFalse();
      expect(readdirSync(join(f.home, '.cursor'))).toEqual(['mcp.json']);
    } finally {
      cleanup(f.root);
    }
  });

  test('INS-03: malformed TOML is rejected before the JSON targets are touched', async () => {
    const f = fixture();
    const codex = configPath(f.home, 'codex');
    mkdirSync(join(f.home, '.codex'), { recursive: true });
    writeFileSync(codex, '[mcp_servers.forgeax\ncommand = "not closed"\n');
    const before = fileHash(codex);
    try {
      const error = await installConfigs({ home: f.home, stateRoot: f.state, launch: LAUNCH, verify: f.verify }).catch((value) => value);
      expectInstallError(error, 'INSTALL_CONFIG_INVALID');
      expect(fileHash(codex)).toBe(before);
      expect(existsSync(configPath(f.home, 'cursor'))).toBeFalse();
      expect(existsSync(configPath(f.home, 'claude'))).toBeFalse();
      expect(existsSync(installRoot(f.state))).toBeFalse();
    } finally {
      cleanup(f.root);
    }
  });

  test('INS-03: an unterminated foreign TOML value is rejected before any target write', async () => {
    const f = fixture();
    const codex = configPath(f.home, 'codex');
    mkdirSync(join(f.home, '.codex'), { recursive: true });
    writeFileSync(codex, 'model = "unterminated\n');
    const before = fileHash(codex);
    try {
      const error = await installConfigs({ home: f.home, stateRoot: f.state, launch: LAUNCH, verify: f.verify }).catch((value) => value);
      expectInstallError(error, 'INSTALL_CONFIG_INVALID');
      expect(fileHash(codex)).toBe(before);
      expect(existsSync(configPath(f.home, 'cursor'))).toBeFalse();
      expect(existsSync(configPath(f.home, 'claude'))).toBeFalse();
      expect(existsSync(installRoot(f.state))).toBeFalse();
    } finally {
      cleanup(f.root);
    }
  });

  test('INS-04 and INS-09: injected later-write failure reverses commits and removes missing preimages', async () => {
    const f = fixture();
    const codex = configPath(f.home, 'codex');
    mkdirSync(join(f.home, '.codex'), { recursive: true });
    const original = 'model = "foreign"\n\n[mcp_servers.other]\ncommand = "keep"\n';
    writeFileSync(codex, original);
    chmodSync(codex, 0o640);
    const before = {
      codex: fileHash(codex),
      cursor: fileHash(configPath(f.home, 'cursor')),
      claude: fileHash(configPath(f.home, 'claude')),
      mode: lstatSync(codex).mode & 0o7777,
    };
    try {
      const error = await installConfigs({
        home: f.home,
        stateRoot: f.state,
        launch: LAUNCH,
        verify: f.verify,
        faults: { failAfterCommit: 2 },
      }).catch((value) => value);
      expectInstallError(error, 'INSTALL_FAULT_INJECTED');
      expect(fileHash(codex)).toBe(before.codex);
      expect(fileHash(configPath(f.home, 'cursor'))).toBe(before.cursor);
      expect(fileHash(configPath(f.home, 'claude'))).toBe(before.claude);
      expect(lstatSync(codex).mode & 0o7777).toBe(before.mode);
      expect(existsSync(join(f.home, '.cursor', '.mcp.json.forgeax.lock'))).toBeFalse();
      expect(existsSync(join(f.home, '.claude.json.forgeax.lock'))).toBeFalse();
      expect(existsSync(installRoot(f.state))).toBeTrue();
      expect(readdirSync(installRoot(f.state))).toEqual([]);

      const rerun = await installConfigs({ home: f.home, stateRoot: f.state, launch: LAUNCH, verify: f.verify });
      expect(rerun.targets.every((target) => target.status === 'UPDATED')).toBeTrue();
    } finally {
      cleanup(f.root);
    }
  });

  test('INS-05: an exact rerun is CURRENT with unchanged bytes and timestamps', async () => {
    const f = fixture();
    try {
      const first = await installConfigs({ home: f.home, stateRoot: f.state, launch: LAUNCH, verify: f.verify });
      const paths = first.targets.map((target) => target.path);
      const before = paths.map((path) => ({ path, hash: fileHash(path), mtime: lstatSync(path).mtimeMs }));
      const second = await installConfigs({ home: f.home, stateRoot: f.state, launch: LAUNCH, verify: f.verify });
      expect(second.phase).toBe('CURRENT');
      expect(second.targets.every((target) => target.status === 'CURRENT')).toBeTrue();
      expect(paths.map((path) => ({ path, hash: fileHash(path), mtime: lstatSync(path).mtimeMs }))).toEqual(before);
      expect(existsSync(installRoot(f.state))).toBeTrue();
      expect(readdirSync(installRoot(f.state))).toEqual([]);
    } finally {
      cleanup(f.root);
    }
  });

  test('INS-06 and REC-02: a concurrent postimage is preserved with a retained recovery journal', async () => {
    const f = fixture();
    let racedPath = '';
    try {
      const error = await installConfigs({
        home: f.home,
        stateRoot: f.state,
        launch: LAUNCH,
        verify: f.verify,
        faults: {
          afterCommit: (target) => {
            if (!racedPath) {
              racedPath = target.path;
              writeFileSync(target.path, '{ "foreign": "concurrent" }\n');
            }
          },
          failAfterCommit: 2,
        },
      }).catch((value) => value);
      expectInstallError(error, 'INSTALL_RECOVERY_REQUIRED');
      expect(racedPath).not.toBe('');
      expect(readFileSync(racedPath, 'utf8')).toBe('{ "foreign": "concurrent" }\n');
      const recoveryDirs = readdirSync(installRoot(f.state), { withFileTypes: true });
      expect(recoveryDirs.some((entry) => entry.isDirectory())).toBeTrue();

      // Resolve only the named concurrent edit.  Recovery removes the exact
      // transaction postimages, then the same visible install converges.
      rmSync(racedPath, { force: true });
      const rerun = await installConfigs({ home: f.home, stateRoot: f.state, launch: LAUNCH, verify: f.verify });
      expect(rerun.phase).toBe('COMMITTED');
      expect(existsSync(installRoot(f.state))).toBeTrue();
      expect(readdirSync(installRoot(f.state))).toEqual([]);
    } finally {
      cleanup(f.root);
    }
  });

  test('INS-07: a wrong release identity fails before locks, config writes, or state creation', async () => {
    const f = fixture();
    const before = HOME_CONFIGS.map(([, parts]) => fileHash(join(f.home, ...parts)));
    try {
      const wrong = { ...RELEASE_IDENTITY, engineSdkVersion: '0.1.4' } as unknown as typeof RELEASE_IDENTITY;
      const verify = async () => verification(wrong);
      const error = await installConfigs({ home: f.home, stateRoot: f.state, launch: LAUNCH, verify }).catch((value) => value);
      expectInstallError(error, 'INSTALL_LAUNCH_MISMATCH');
      expect(HOME_CONFIGS.map(([, parts]) => fileHash(join(f.home, ...parts)))).toEqual(before);
      expect(existsSync(installRoot(f.state))).toBeFalse();
      expect(readdirSync(f.home)).toEqual([]);
    } finally {
      cleanup(f.root);
    }
  });

  test('INS-08: symlink targets and duplicate canonical targets fail closed', async () => {
    const f = fixture();
    const outside = join(f.root, 'outside.json');
    const cursor = configPath(f.home, 'cursor');
    mkdirSync(join(f.home, '.cursor'), { recursive: true });
    writeFileSync(outside, '{ "foreign": true }\n');
    symlinkSync(outside, cursor);
    try {
      const symlinkError = await installConfigs({ home: f.home, stateRoot: f.state, launch: LAUNCH, verify: f.verify }).catch((value) => value);
      expectInstallError(symlinkError, 'INSTALL_CONFIG_INVALID');
      expect(readFileSync(outside, 'utf8')).toBe('{ "foreign": true }\n');
      expect(existsSync(installRoot(f.state))).toBeFalse();

      const first: ClientSpec = INSTALL_CLIENTS.find((client) => client.id === 'cursor')!;
      const duplicate = { ...first, id: 'cursor' } as ClientSpec;
      const duplicateError = await installConfigs({
        home: f.home,
        stateRoot: join(f.root, 'state-duplicate'),
        clients: [first, duplicate],
        launch: LAUNCH,
        verify: f.verify,
      }).catch((value) => value);
      expectInstallError(duplicateError, 'INSTALL_CONFIG_INVALID');
    } finally {
      cleanup(f.root);
    }
  });

  test('PKG-01: package and launcher identities have one binary and exact normal dependencies', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    expect(manifest.bin).toEqual({ 'forgeax-game': 'dist/main.js', game: 'dist/main.js' });
    expect(manifest.dependencies).toEqual({ '@forgeax/engine-sdk': '0.3.3', pnpm: '11.7.0' });
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.peerDependenciesMeta).toBeUndefined();
    expect(LAUNCH).toEqual({
      command: 'npx',
      args: ['-y', '-p', '@forgeax/game@0.3.10', 'forgeax-game', 'mcp'],
    });
    expect(JSON.parse(releaseIdentityJson())).toEqual(RELEASE_IDENTITY);
  });
});
