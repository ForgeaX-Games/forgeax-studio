// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveCommand, stashPopArgsForMessage } from './fx.ts';

const ROOT = resolve(import.meta.dir, '..');
const script = (name: string) => resolve(ROOT, 'scripts', name);

describe('scripts/fx.ts command routing', () => {
  it('keeps package.json scripts focused on fx plus checks', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.fx).toBe('bun scripts/fx.ts');
    for (const legacy of ['setup', 'bootstrap', 'dev', 'dev:local', 'start', 'stop', 'app', 'web', 'build:plugins', 'version']) {
      expect(pkg.scripts[legacy]).toBeUndefined();
    }
  });

  it('routes setup to setup.ts', () => {
    expect(resolveCommand(['setup'])).toEqual({ type: 'script', script: script('setup.ts'), args: [] });
  });

  it('does not keep install as a setup alias', () => {
    expect(resolveCommand(['install', '--no-plugins'])).toEqual({
      type: 'unknown',
      command: 'install',
      args: ['--no-plugins'],
    });
  });

  it('does not expose bootstrap as a user-facing fx command', () => {
    expect(resolveCommand(['bootstrap'])).toEqual({
      type: 'unknown',
      command: 'bootstrap',
      args: [],
    });
  });

  it('keeps start as the single client-launching lifecycle command', () => {
    expect(resolveCommand(['start'])).toEqual({ type: 'internal', command: 'start', args: [] });
    expect(resolveCommand(['start', 'web', '--fresh'])).toEqual({ type: 'internal', command: 'start', args: ['web', '--fresh'] });
    expect(resolveCommand(['start', 'app', 'debug'])).toEqual({ type: 'internal', command: 'start', args: ['app', 'debug'] });
  });

  it('does not expose legacy dev/web/app commands at the fx top level', () => {
    expect(resolveCommand(['dev'])).toEqual({ type: 'unknown', command: 'dev', args: [] });
    expect(resolveCommand(['dev:local'])).toEqual({ type: 'unknown', command: 'dev:local', args: [] });
    expect(resolveCommand(['web'])).toEqual({ type: 'unknown', command: 'web', args: [] });
    expect(resolveCommand(['app'])).toEqual({ type: 'unknown', command: 'app', args: [] });
  });

  it('routes stop to the existing TS implementation', () => {
    expect(resolveCommand(['stop'])).toEqual({ type: 'script', script: script('stop.ts'), args: [] });
  });

  it('routes build and version aliases', () => {
    expect(resolveCommand(['build', 'plugins', '--force'])).toEqual({
      type: 'script',
      script: script('build-plugins.ts'),
      args: ['--force'],
    });
    expect(resolveCommand(['build', 'app'])).toEqual({ type: 'script', script: script('app.ts'), args: ['build'] });
    expect(resolveCommand(['build', 'desktop'])).toEqual({ type: 'internal', command: 'build', args: ['desktop'] });
    expect(resolveCommand(['build:plugins'])).toEqual({ type: 'script', script: script('build-plugins.ts'), args: [] });
    expect(resolveCommand(['version', 'json'])).toEqual({ type: 'script', script: script('lib/version.ts'), args: ['json'] });
  });

  it('keeps meta commands inside scripts/fx.ts', () => {
    expect(resolveCommand(['update', '--dry-run'])).toEqual({ type: 'internal', command: 'update', args: ['--dry-run'] });
    expect(resolveCommand(['status'])).toEqual({ type: 'internal', command: 'status', args: [] });
    expect(resolveCommand(['doctor', '--fix'])).toEqual({ type: 'internal', command: 'doctor', args: ['--fix'] });
    expect(resolveCommand(['restart'])).toEqual({ type: 'internal', command: 'restart', args: [] });
  });

  it('restores the exact update stash by message after a successful update', () => {
    expect(stashPopArgsForMessage('forgeax pre-update 2026-06-29T13:49:00.000Z')).toEqual([
      'stash',
      'pop',
      'stash^{/forgeax pre-update 2026-06-29T13:49:00.000Z}',
    ]);
  });
});
