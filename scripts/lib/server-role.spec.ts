import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as serverRole from './server-role.ts';

const { resolveActiveServerRole } = serverRole;
const fileSymlinkIt = process.platform === 'win32' ? it.skip : it;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-server-role-'));
  roots.push(root);
  writePackage(root, 'server', {
    name: '@forgeax/server',
    entry: 'src/main.ts',
  });
  return root;
}

function writePackage(
  root: string,
  directory: string,
  options: {
    name: string;
    entry?: string;
    metadata?: unknown;
    createEntry?: boolean;
  },
): void {
  const packageDir = join(root, 'packages', directory);
  mkdirSync(packageDir, { recursive: true });
  const packageJson: Record<string, unknown> = { name: options.name };
  if (options.metadata !== undefined) packageJson.forgeaxStudio = options.metadata;
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(packageJson)}\n`);
  if (options.entry && options.createEntry !== false) {
    const entry = join(packageDir, options.entry);
    mkdirSync(join(entry, '..'), { recursive: true });
    writeFileSync(entry, '');
  }
}

function override(
  root: string,
  directory: string,
  priority: number,
  entry = 'src/main.ts',
  createEntry = true,
): void {
  writePackage(root, directory, {
    name: `@example/${directory}`,
    entry,
    createEntry,
    metadata: { runtimeRole: 'server', entry, priority },
  });
}

describe('resolveActiveServerRole', () => {
  it('falls back to the base server when no override exists', () => {
    const root = fixture();

    expect(resolveActiveServerRole({ root })).toEqual({
      packageDir: join(root, 'packages/server'),
      entry: 'src/main.ts',
      packageName: '@forgeax/server',
      priority: 0,
    });
  });

  it('selects the unique server override', () => {
    const root = fixture();
    override(root, 'server-pro', 10, 'src/start.ts');

    expect(resolveActiveServerRole({ root })).toEqual({
      packageDir: join(root, 'packages/server-pro'),
      entry: 'src/start.ts',
      packageName: '@example/server-pro',
      priority: 10,
    });
  });

  it('forces the base server for the explicit base profile', () => {
    const root = fixture();
    override(root, 'server-pro', 10);

    expect(resolveActiveServerRole({ root, profile: 'base' }).packageName).toBe('@forgeax/server');
  });

  it('selects the highest-priority override', () => {
    const root = fixture();
    override(root, 'server-standard', 10);
    override(root, 'server-pro', 20);

    expect(resolveActiveServerRole({ root, profile: 'auto' }).packageName).toBe('@example/server-pro');
  });

  it('rejects multiple highest-priority overrides', () => {
    const root = fixture();
    override(root, 'server-a', 20);
    override(root, 'server-b', 20);

    expect(() => resolveActiveServerRole({ root })).toThrow(/priority.*20|20.*priority/i);
  });

  it('rejects a missing override entry file', () => {
    const root = fixture();
    override(root, 'server-pro', 10, 'src/main.ts', false);

    expect(() => resolveActiveServerRole({ root })).toThrow(/entry.*(missing|exist)/i);
  });

  it('rejects a packages child symlink that resolves outside packages', () => {
    const root = fixture();
    const externalRoot = fixture();
    override(externalRoot, 'external-server', 10);
    symlinkSync(
      join(externalRoot, 'packages/external-server'),
      join(root, 'packages/linked-server'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => resolveActiveServerRole({ root })).toThrow(/package.*outside|packages.*contain/i);
  });

  fileSymlinkIt('rejects an entry symlink that resolves outside its package', () => {
    const root = fixture();
    override(root, 'server-pro', 10, 'src/main.ts', false);
    const outsideEntry = join(root, 'outside.ts');
    writeFileSync(outsideEntry, '');
    mkdirSync(join(root, 'packages/server-pro/src'), { recursive: true });
    symlinkSync(outsideEntry, join(root, 'packages/server-pro/src/main.ts'));

    expect(() => resolveActiveServerRole({ root })).toThrow(/entry.*outside|package.*contain/i);
  });

  it.each(['../outside.ts', '/tmp/outside.ts'])('rejects unsafe entry path %s', (entry) => {
    const root = fixture();
    override(root, 'server-pro', 10, entry, false);

    expect(() => resolveActiveServerRole({ root })).toThrow(/entry.*(relative|package|path)/i);
  });

  it('rejects a server role entry outside src', () => {
    const root = fixture();
    override(root, 'server-pro', 10, 'bin/main.ts');

    expect(() => resolveActiveServerRole({ root })).toThrow(/entry.*src/i);
  });

  it('rejects malformed server role metadata', () => {
    const root = fixture();
    writePackage(root, 'server-pro', {
      name: '@example/server-pro',
      metadata: { runtimeRole: 'server', entry: 'src/main.ts', priority: 'high' },
    });

    expect(() => resolveActiveServerRole({ root })).toThrow(/metadata.*priority|priority.*metadata/i);
  });
});

describe('serverRuntimeInvocation', () => {
  it('matches the absolute entry argv used to launch Bun', () => {
    const role = {
      packageDir: join(tmpdir(), 'studio/packages/server'),
      entry: 'src/main.ts',
      packageName: '@forgeax/server',
      priority: 0,
    };
    const invocation = serverRole.serverRuntimeInvocation(role);
    const command = `bun --watch ${invocation.entryPath}`;

    expect(new RegExp(invocation.orphanSignature).test(command)).toBe(true);
  });
});

describe('server orphan command matching', () => {
  it('matches only the launcher and active server entry, not unrelated commands under the root', () => {
    const root = join(tmpdir(), 'studio');
    const role = {
      packageDir: join(root, 'packages/server'),
      entry: 'src/main.ts',
      packageName: '@forgeax/server',
      priority: 0,
    };
    const needles = serverRole.serverOrphanNeedles(root, role);

    expect(serverRole.matchesServerOrphanCommand(`bun ${join(root, 'scripts/run.ts')}`, needles)).toBe(true);
    expect(
      serverRole.matchesServerOrphanCommand(
        `bun --watch ${serverRole.serverRuntimeInvocation(role).entryPath}`,
        needles,
      ),
    ).toBe(true);
    expect(serverRole.matchesServerOrphanCommand(`bun test ${join(root, 'scripts/fx.spec.ts')}`, needles)).toBe(false);
    expect(serverRole.matchesServerOrphanCommand(`bun build ${join(root, 'packages/studio/src/main.ts')}`, needles)).toBe(false);
  });
});

describe('isPathContained', () => {
  it('distinguishes descendants from sibling paths without filesystem access', () => {
    const parent = join(tmpdir(), 'studio/packages');

    expect(serverRole.isPathContained(parent, join(parent, 'server/src/main.ts'))).toBe(true);
    expect(serverRole.isPathContained(parent, join(parent, '../outside/main.ts'))).toBe(false);
  });
});
