import { afterEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstanceCommand } from './instance.ts';
import { resolveRuntimeInstance, runtimeInstanceConfigPath, writeRuntimeInstanceConfig } from './lib/runtime-instance.ts';
import { StartLock } from './lib/startlock.ts';

const roots: string[] = [];
function root(): string {
  const value = join(tmpdir(), `forgeax-instance-cli-${crypto.randomUUID()}`);
  mkdirSync(value, { recursive: true });
  const canonical = realpathSync(value);
  roots.push(canonical);
  return canonical;
}
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe('instance CLI', () => {
  test('initializes an isolated instance and prints only configuration paths plus derivations', () => {
    const checkout = root();
    const write = mock(() => {});
    const previous = console.log;
    console.log = write;
    try {
      runInstanceCommand(['init', '--slot', '1', '--isolate-user', '--env-file', '/private/env'], checkout);
    } finally { console.log = previous; }
    expect(resolveRuntimeInstance({ root: checkout })).toMatchObject({ slot: 1, isolateUser: true, envFile: '/private/env' });
    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain('28920');
    expect(output).toContain('/private/env');
    expect(output).not.toContain('SECRET=');
  });

  test('requires a valid init grammar and keeps show read-only', () => {
    const checkout = root();
    expect(() => runInstanceCommand(['init'], checkout)).toThrow(/requires --slot/);
    expect(() => runInstanceCommand(['init', '--slot', 'nope'], checkout)).toThrow(/must be an integer/);
    expect(() => runInstanceCommand(['show', '--force'], checkout)).toThrow(/usage/);
    expect(() => runInstanceCommand(['delete'], checkout)).toThrow(/usage/);
  });

  test('refuses first init while runtime state exists without creating config', () => {
    const checkout = root();
    const state = join(checkout, '.forgeax/runtime/web-dev.json');
    mkdirSync(join(checkout, '.forgeax/runtime'), { recursive: true });
    writeFileSync(state, '{"pid":123}');
    expect(() => runInstanceCommand(['init', '--slot', '1'], checkout)).toThrow(/bun fx stop.*then retry/);
    expect(existsSync(runtimeInstanceConfigPath(checkout))).toBe(false);
  });

  test('refuses force replacement while runtime state exists and preserves config bytes', () => {
    const checkout = root();
    writeRuntimeInstanceConfig({ root: checkout, slot: 1 });
    const config = runtimeInstanceConfigPath(checkout);
    const before = readFileSync(config, 'utf8');
    mkdirSync(join(checkout, '.forgeax/runtime'), { recursive: true });
    writeFileSync(join(checkout, '.forgeax/runtime/web-dev.json'), '{"pid":123}');
    expect(() => runInstanceCommand(['init', '--slot', '2', '--force'], checkout)).toThrow(/bun fx stop.*then retry/);
    expect(readFileSync(config, 'utf8')).toBe(before);
    expect(resolveRuntimeInstance({ root: checkout }).slot).toBe(1);
  });

  test('does not create or replace config while a live start owns the run lock', () => {
    const checkout = root();
    const liveStart = new StartLock(checkout);
    liveStart.acquireOrThrow();
    try {
      expect(() => runInstanceCommand(['init', '--slot', '1'], checkout)).toThrow(/another run is already starting/);
      expect(existsSync(runtimeInstanceConfigPath(checkout))).toBe(false);

      writeRuntimeInstanceConfig({ root: checkout, slot: 1 });
      const before = readFileSync(runtimeInstanceConfigPath(checkout), 'utf8');
      expect(() => runInstanceCommand(['init', '--slot', '2', '--force'], checkout)).toThrow(/another run is already starting/);
      expect(readFileSync(runtimeInstanceConfigPath(checkout), 'utf8')).toBe(before);
    } finally {
      liveStart.release();
    }
  });

  test('releases the run lock after a successful init', () => {
    const checkout = root();
    const output = console.log;
    console.log = () => {};
    try { runInstanceCommand(['init', '--slot', '1'], checkout); } finally { console.log = output; }
    const nextStart = new StartLock(checkout);
    expect(() => nextStart.acquireOrThrow()).not.toThrow();
    nextStart.release();
  });

  test('bootstraps safely from a dead legacy pid lock without a runtime state file', () => {
    const checkout = root();
    const lockDir = join(checkout, '.forgeax/run.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'pid'), '999999999');
    const output = console.log;
    console.log = () => {};
    try { runInstanceCommand(['init', '--slot', '1'], checkout); } finally { console.log = output; }
    expect(resolveRuntimeInstance({ root: checkout }).slot).toBe(1);
    expect(existsSync(lockDir)).toBe(false);
  });
});
