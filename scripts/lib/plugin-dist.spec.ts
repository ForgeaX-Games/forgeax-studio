// @ts-nocheck
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isBrokenDist,
  isPluginDistStale,
  pluginSourceRevision,
  writeDistSourceStamp,
} from './plugin-dist.ts';

const roots: string[] = [];

function tempPlugin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeax-plugin-'));
  roots.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"scripts":{"build":"echo ok"}}');
  writeFileSync(join(dir, 'src', 'index.ts'), 'export {}');
  return dir;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('plugin-dist freshness', () => {
  it('treats missing dist as stale', () => {
    const plugin = tempPlugin();
    expect(isPluginDistStale(plugin)).toBe(true);
  });

  it('treats dist without index.html as broken/stale', () => {
    const plugin = tempPlugin();
    const dist = join(plugin, 'dist');
    mkdirSync(dist, { recursive: true });
    expect(isBrokenDist(dist)).toBe(true);
    expect(isPluginDistStale(plugin)).toBe(true);
  });

  it('treats dist with missing asset refs as broken', () => {
    const plugin = tempPlugin();
    const dist = join(plugin, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<script src="assets/app.js"></script>');
    expect(isBrokenDist(dist)).toBe(true);
  });

  it('treats dist without source stamp as stale', () => {
    const plugin = tempPlugin();
    const dist = join(plugin, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<script src="assets/app.js"></script>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    expect(isBrokenDist(dist)).toBe(false);
    expect(isPluginDistStale(plugin)).toBe(true);
  });

  it('treats matching stamp as fresh', () => {
    const plugin = tempPlugin();
    const dist = join(plugin, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<script src="assets/app.js"></script>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    writeDistSourceStamp(dist, pluginSourceRevision(plugin));
    expect(isPluginDistStale(plugin)).toBe(false);
  });

  it('treats mismatched stamp as stale after source edit', () => {
    const plugin = tempPlugin();
    const dist = join(plugin, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<script src="assets/app.js"></script>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    writeDistSourceStamp(dist, 'old-revision');
    expect(isPluginDistStale(plugin)).toBe(true);
  });
});
