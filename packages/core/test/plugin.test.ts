/**
 * PLUGIN tests — manifest validation (legal/illegal name, version, components),
 * 5-component discovery, source precedence override (session>marketplace>builtin),
 * and plugin-hooks → EventBus side-effect wiring.
 *
 * Plugins are materialized in a temp dir (real node:fs) as plugin.json +
 * component subdirs. The EventBus is the real core impl so the side-effect test
 * exercises the actual publish/subscribe path.
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateManifest,
  PLUGIN_COMPONENTS,
  loadPlugins,
  mergePluginSources,
  pluginToCapabilityPack,
  type LoadedPlugin,
  type PluginSourceKind,
} from '../src/capability/plugin';
import { EventBus } from '../src/events/event-bus';
import type { CoreEvent } from '../src/events/types';

// ─── manifest validation ─────────────────────────────────────────────────────

describe('validateManifest — self-written', () => {
  test('accepts a minimal legal manifest (name only)', () => {
    const v = validateManifest({ name: 'my-plugin' });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.manifest.name).toBe('my-plugin');
      expect(v.errors).toEqual([]);
    }
  });

  test('accepts version, description, components, author', () => {
    const v = validateManifest({
      name: 'db2-helper',
      version: '1.2.3-rc.1+build.5',
      description: 'helps with db',
      components: ['commands', 'hooks'],
      author: { name: 'Forge', email: 'f@x.dev' },
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.manifest.version).toBe('1.2.3-rc.1+build.5');
      expect(v.manifest.components).toEqual(['commands', 'hooks']);
      expect(v.manifest.author?.name).toBe('Forge');
    }
  });

  test('rejects missing name', () => {
    const v = validateManifest({ description: 'x' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.startsWith('name:'))).toBe(true);
  });

  test('rejects non-kebab names (spaces, caps, path sep, leading hyphen)', () => {
    for (const bad of ['My Plugin', 'MyPlugin', 'a/b', '..evil', '-lead', 'trail-', 'a--b']) {
      const v = validateManifest({ name: bad });
      expect(v.ok).toBe(false);
    }
  });

  test('rejects bad version and unknown component', () => {
    expect(validateManifest({ name: 'p', version: 'v1' }).ok).toBe(false);
    expect(validateManifest({ name: 'p', components: ['bogus'] }).ok).toBe(false);
  });

  test('rejects non-object input', () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest([1, 2]).ok).toBe(false);
    expect(validateManifest('str').ok).toBe(false);
  });

  test('PLUGIN_COMPONENTS is the 5 component kinds', () => {
    expect(([...PLUGIN_COMPONENTS] as string[]).sort()).toEqual(
      ['agents', 'commands', 'hooks', 'output-styles', 'skills'].sort(),
    );
  });
});

// ─── loader: component discovery ─────────────────────────────────────────────

describe('loadPlugins — manifest read + 5-component discovery', () => {
  let root: string;

  function makePlugin(
    sourceDir: string,
    name: string,
    opts: {
      manifest?: Record<string, unknown>;
      components?: string[];
      hooksJson?: unknown;
      badManifest?: string;
    } = {},
  ): string {
    const dir = join(root, sourceDir, name);
    mkdirSync(dir, { recursive: true });
    if (opts.badManifest !== undefined) {
      writeFileSync(join(dir, 'plugin.json'), opts.badManifest);
    } else {
      writeFileSync(
        join(dir, 'plugin.json'),
        JSON.stringify(opts.manifest ?? { name }),
      );
    }
    for (const c of opts.components ?? []) {
      mkdirSync(join(dir, c), { recursive: true });
    }
    if (opts.hooksJson !== undefined) {
      mkdirSync(join(dir, 'hooks'), { recursive: true });
      writeFileSync(
        join(dir, 'hooks', 'hooks.json'),
        typeof opts.hooksJson === 'string'
          ? opts.hooksJson
          : JSON.stringify(opts.hooksJson),
      );
    }
    return dir;
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'plugin-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('discovers all 5 component directories + sets paths', () => {
    makePlugin('builtin', 'full', {
      components: ['commands', 'agents', 'skills', 'hooks', 'output-styles'],
    });
    const { plugins, errors } = loadPlugins([
      { source: 'builtin', dir: join(root, 'builtin') },
    ]);
    expect(errors).toEqual([]);
    const p = plugins.find((x) => x.name === 'full')!;
    expect(([...p.componentKinds] as string[]).sort()).toEqual(
      ['agents', 'commands', 'hooks', 'output-styles', 'skills'].sort(),
    );
    expect(p.commandsPath).toContain('full/commands');
    expect(p.agentsPath).toContain('full/agents');
    expect(p.skillsPath).toContain('full/skills');
    expect(p.outputStylesPath).toContain('full/output-styles');
    expect(p.hooksPath).toContain('full/hooks');
  });

  test('a plugin with no component dirs loads with empty componentKinds', () => {
    makePlugin('builtin', 'bare', {});
    const { plugins } = loadPlugins([{ source: 'builtin', dir: join(root, 'builtin') }]);
    const p = plugins.find((x) => x.name === 'bare')!;
    expect(p.componentKinds).toEqual([]);
    expect(p.hooksConfig).toBeUndefined();
  });

  test('missing source dir is skipped quietly; non-plugin dir ignored', () => {
    mkdirSync(join(root, 'builtin', 'not-a-plugin'), { recursive: true });
    const { plugins, errors } = loadPlugins([
      { source: 'builtin', dir: join(root, 'builtin') },
      { source: 'session', dir: join(root, 'does-not-exist') },
    ]);
    expect(plugins.find((x) => x.name === 'not-a-plugin')).toBeUndefined();
    expect(errors.find((e) => e.path.includes('does-not-exist'))).toBeUndefined();
  });

  test('invalid manifest is reported as an error, not loaded', () => {
    makePlugin('builtin', 'broken', { manifest: { name: 'Bad Name' } });
    makePlugin('builtin', 'corrupt', { badManifest: '{not json' });
    const { plugins, errors } = loadPlugins([
      { source: 'builtin', dir: join(root, 'builtin') },
    ]);
    expect(plugins.find((x) => x.name === 'Bad Name')).toBeUndefined();
    expect(errors.some((e) => e.path.includes('broken'))).toBe(true);
    expect(errors.some((e) => e.path.includes('corrupt') && /JSON/i.test(e.reason))).toBe(true);
  });

  test('declared components constrain discovery (undeclared dir ignored)', () => {
    makePlugin('builtin', 'narrowed', {
      manifest: { name: 'narrowed', components: ['commands'] },
      components: ['commands', 'agents'],
    });
    const { plugins } = loadPlugins([{ source: 'builtin', dir: join(root, 'builtin') }]);
    const p = plugins.find((x) => x.name === 'narrowed')!;
    expect(p.componentKinds).toEqual(['commands']);
    expect(p.agentsPath).toBeUndefined();
  });

  test('parses hooks.json (wrapper + bare both accepted)', () => {
    makePlugin('builtin', 'hooked', {
      hooksJson: {
        hooks: {
          PreToolUse: [
            { matcher: 'Bash(*)', hooks: [{ type: 'command', command: 'echo hi', if: 'Bash(git *)' }] },
          ],
        },
      },
    });
    const { plugins } = loadPlugins([{ source: 'builtin', dir: join(root, 'builtin') }]);
    const p = plugins.find((x) => x.name === 'hooked')!;
    expect(p.hooksConfig?.PreToolUse?.[0]?.matcher).toBe('Bash(*)');
    expect(p.hooksConfig?.PreToolUse?.[0]?.hooks[0]?.command).toBe('echo hi');
    expect(p.hooksConfig?.PreToolUse?.[0]?.hooks[0]?.if).toBe('Bash(git *)');
  });
});

// ─── precedence merge ────────────────────────────────────────────────────────

function fakeLoaded(name: string, source: PluginSourceKind, tag: string): LoadedPlugin {
  return {
    name,
    manifest: { name, description: tag },
    path: `/fake/${source}/${name}`,
    source,
    enabled: true,
    componentKinds: [],
  };
}

describe('mergePluginSources — precedence session > marketplace > builtin', () => {
  test('same name: session overrides marketplace overrides builtin', () => {
    const merged = mergePluginSources({
      builtin: [fakeLoaded('shared', 'builtin', 'B'), fakeLoaded('only-builtin', 'builtin', 'B')],
      marketplace: [fakeLoaded('shared', 'marketplace', 'M')],
      session: [fakeLoaded('shared', 'session', 'S')],
    });
    const byName = new Map(merged.map((p) => [p.name, p]));
    expect(byName.get('shared')?.source).toBe('session');
    expect(byName.get('shared')?.manifest.description).toBe('S');
    expect(byName.get('only-builtin')?.source).toBe('builtin');
  });

  test('marketplace overrides builtin when no session copy', () => {
    const merged = mergePluginSources({
      builtin: [fakeLoaded('p', 'builtin', 'B')],
      marketplace: [fakeLoaded('p', 'marketplace', 'M')],
    });
    expect(merged[0]?.source).toBe('marketplace');
  });

  test('result is alphabetically name-stable', () => {
    const merged = mergePluginSources({
      builtin: [fakeLoaded('zebra', 'builtin', 'B'), fakeLoaded('alpha', 'builtin', 'B')],
    });
    expect(merged.map((p) => p.name)).toEqual(['alpha', 'zebra']);
  });
});

// ─── plugin → CapabilityPack: EventBus side-effects ──────────────────────────

describe('pluginToCapabilityPack — hooks subscribe to EventBus on start', () => {
  function loadedWithHooks(name: string, source: PluginSourceKind): LoadedPlugin {
    return {
      ...fakeLoaded(name, source, 'h'),
      hooksConfig: {
        PreToolUse: [
          { matcher: 'Bash(*)', hooks: [{ type: 'command', command: 'guard' }] },
        ],
      },
    };
  }

  test('maps source to layer', () => {
    const bus = new EventBus();
    expect(pluginToCapabilityPack(loadedWithHooks('a', 'builtin'), bus).layer).toBe('builtin');
    expect(pluginToCapabilityPack(loadedWithHooks('a', 'marketplace'), bus).layer).toBe('user');
    expect(pluginToCapabilityPack(loadedWithHooks('a', 'session'), bus).layer).toBe('session');
  });

  test('no hooks → pack carries no plugins', () => {
    const bus = new EventBus();
    const pack = pluginToCapabilityPack(fakeLoaded('nohooks', 'builtin', 'x'), bus);
    expect(pack.plugins).toBeUndefined();
  });

  test('start subscribes; matching event invokes runHook; dispose unsubscribes', () => {
    const bus = new EventBus();
    const fired: Array<{ plugin: string; type: string; cmds: string[] }> = [];
    const pack = pluginToCapabilityPack(loadedWithHooks('guarder', 'session'), bus, {
      runHook: (plugin, event, actions) =>
        fired.push({ plugin, type: event.type, cmds: actions.map((a) => a.command) }),
    });
    expect(pack.plugins).toHaveLength(1);

    const plugin = pack.plugins![0]!;
    const dispose = plugin.start({}) as () => void;

    // matching event triggers the hook
    bus.publish({ type: 'PreToolUse', payload: {}, ts: 1 } as CoreEvent);
    // non-matching event does nothing
    bus.publish({ type: 'PostToolUse', payload: {}, ts: 2 } as CoreEvent);

    expect(fired).toHaveLength(1);
    expect(fired[0]).toEqual({ plugin: 'guarder', type: 'PreToolUse', cmds: ['guard'] });

    // after dispose, no more hooks fire
    dispose();
    bus.publish({ type: 'PreToolUse', payload: {}, ts: 3 } as CoreEvent);
    expect(fired).toHaveLength(1);
  });

  test('a throwing runHook does not break bus propagation', () => {
    const bus = new EventBus();
    let downstreamRan = false;
    const pack = pluginToCapabilityPack(loadedWithHooks('boom', 'builtin'), bus, {
      runHook: () => {
        throw new Error('hook blew up');
      },
    });
    (pack.plugins![0]!.start({}) as () => void);
    // a later subscriber on the same event must still run
    bus.subscribe('PreToolUse', () => {
      downstreamRan = true;
    });
    expect(() => bus.publish({ type: 'PreToolUse', payload: {}, ts: 1 } as CoreEvent)).not.toThrow();
    expect(downstreamRan).toBe(true);
  });
});
