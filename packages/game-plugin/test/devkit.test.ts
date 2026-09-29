import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundledSkills,
  installDevKit,
  installedEngineSkills,
  hasDevKit,
  installHostDevKit,
  isEngineSkill,
  removeDevKit,
} from '../src/devkit/install';

describe('game development kit', () => {
  test('installs the packaged skill without requiring a harness checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-devkit-'));
    try {
      const result = installDevKit(root, ['codex']);
      expect(result.changed).toBeTrue();
      expect(result.mounted).toBeFalse();
      expect(result.skillIds).toContain('forgeax-game');
      const primary = join(root, '.agents', 'skills', 'forgeax-game');
      expect(existsSync(join(primary, 'SKILL.md'))).toBeTrue();
      const installedSkill = readFileSync(join(primary, 'SKILL.md'), 'utf8');
      expect(installedSkill).toBe(readFileSync(new URL('../skills/forgeax-game/SKILL.md', import.meta.url), 'utf8'));
      expect(installedSkill).toContain('forgeax_run_current_game');
      expect(installedSkill).toContain('art-3d-asset-library');
      expect(existsSync(join(root, '.agents', 'rules', 'forgeax-game.md'))).toBeTrue();

      // Skills live only in host mounts now. The plain project-root copies served no
      // host and were pure duplication inside the user's repository.
      expect(existsSync(join(root, 'skills'))).toBeFalse();
      expect(existsSync(join(root, 'rules'))).toBeFalse();

      // Only the named host is mounted; unrelated hosts are not this user's problem.
      expect(existsSync(join(root, '.claude', 'skills'))).toBeFalse();
      expect(existsSync(join(root, '.cursor', 'skills'))).toBeFalse();

      const second = installDevKit(root, ['codex']);
      expect(second.changed).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('writes selected host mounts without a harness manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-host-devkit-'));
    try {
      const result = installHostDevKit(root, ['codex', 'workbuddy', 'zcode']);
      expect(result.skillPaths).toEqual([
        join(root, '.agents', 'skills'),
        join(root, '.codebuddy', 'skills'),
        join(root, '.zcode', 'skills'),
      ]);
      expect(result.rulePaths).toEqual([
        join(root, '.agents', 'rules', 'forgeax-game.md'),
        join(root, '.codebuddy', 'rules', 'forgeax-game.md'),
      ]);
      expect(result.note).toContain('installed for 3 hosts');
      expect(existsSync(join(root, '.codebuddy', 'skills', 'forgeax-game', 'SKILL.md'))).toBeTrue();
      expect(existsSync(join(root, '.zcode', 'skills', 'forgeax-game', 'SKILL.md'))).toBeTrue();
      expect(existsSync(join(root, '.zcode', 'rules'))).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('replaces a stale host symlink with a self-contained copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-host-link-'));
    const source = mkdtempSync(join(tmpdir(), 'forgeax-game-host-source-'));
    try {
      const first = installHostDevKit(source, ['codex']);
      mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
      symlinkSync(join(first.skillPaths[0]!, 'forgeax-game'), join(root, '.agents', 'skills', 'forgeax-game'), 'dir');
      const result = installHostDevKit(root, ['codex']);
      expect(result.changed).toBeTrue();
      expect(readFileSync(join(root, '.agents', 'skills', 'forgeax-game', 'SKILL.md'), 'utf8')).toContain('forgeax_run_current_game');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });
  test('discovers Engine-owned authoring skills only from the selected released game', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-engine-owned-skills-'));
    try {
      writeFileSync(join(root, 'forge.json'), `${JSON.stringify({ id: 'demo', entry: 'src/main.ts' })}\n`);
      writeFileSync(join(root, 'package.json'), `${JSON.stringify({ dependencies: { '@forgeax/engine': 'fixture' } })}\n`);
      const engineSkill = join(root, 'skills', 'forgeax-engine-ecs');
      mkdirSync(engineSkill, { recursive: true });
      writeFileSync(join(engineSkill, 'SKILL.md'), '# ECS\n');
      expect(bundledSkills(root).map((skill) => skill.id)).toEqual(['forgeax-engine-ecs', 'forgeax-game']);
      expect(installDevKit(root, ['codex']).skillIds).toEqual(['forgeax-engine-ecs', 'forgeax-game']);
      expect(existsSync(join(root, '.agents', 'skills', 'forgeax-engine-ecs', 'SKILL.md'))).toBeTrue();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('materializes fresh Engine links without duplicate backup skills', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-fresh-engine-link-'));
    try {
      const source = join(root, 'skills', 'forgeax-engine-ecs');
      const destination = join(root, '.agents', 'skills', 'forgeax-engine-ecs');
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, 'SKILL.md'), '# ECS\n');
      mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
      symlinkSync(source, destination, 'dir');
      expect(installHostDevKit(root, ['codex'], [{ id: 'forgeax-engine-ecs', path: source }]).changed).toBeTrue();
      expect(lstatSync(destination).isSymbolicLink()).toBeFalse();
      expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe('# ECS\n');
      expect(existsSync(`${destination}.bak.latest`)).toBeFalse();
      expect(installHostDevKit(root, ['codex'], [{ id: 'forgeax-engine-ecs', path: source }]).changed).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('never contributes Studio harness skills from a source checkout', () => {
    // Only this plugin's own skill and selected-game Engine skills may reach a host.
    for (const skill of bundledSkills()) {
      expect(skill.id === 'forgeax-game' || isEngineSkill(skill.id)).toBeTrue();
    }
  });

  test('installs every bundled Engine skill into project and host mounts', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-engine-skills-'));
    try {
      const result = installDevKit(root, ['codex']);
      const expected = bundledSkills().filter((skill) => isEngineSkill(skill.id)).map((skill) => skill.id);
      expect(installedEngineSkills(root)).toEqual(expected);
      for (const id of expected) {
        expect(existsSync(join(root, '.agents', 'skills', id, 'SKILL.md'))).toBeTrue();
      }
      expect(result.skillIds).toEqual(bundledSkills().map((skill) => skill.id));
      // One routing rule regardless of skill count: the Engine skills are authored
      // knowledge, not host routing.
      expect(existsSync(join(root, '.agents', 'rules', 'forgeax-game.md'))).toBeTrue();
      expect(existsSync(join(root, '.agents', 'rules', 'forgeax-engine-ecs.md'))).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('installs nothing when no host is named', () => {
    // `install` runs before a project exists; installing at user level as a fallback is
    // what produced a second copy that hosts load alongside the project's.
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-nohost-'));
    try {
      const result = installHostDevKit(root, []);
      expect(result.changed).toBeFalse();
      expect(result.skillIds).toEqual([]);
      expect(result.note).toContain('No host was selected');
      expect(existsSync(join(root, '.claude'))).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uninstall removes only what this plugin mounted', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-uninstall-'));
    try {
      installDevKit(root, ['claude', 'zcode']);
      // A neighbouring skill the user owns must survive.
      const foreign = join(root, '.claude', 'skills', 'my-own-skill');
      mkdirSync(foreign, { recursive: true });
      writeFileSync(join(foreign, 'SKILL.md'), '# mine\n');

      expect(hasDevKit(root)).toBeTrue();
      const removal = removeDevKit(root);
      expect(removal.skillCount).toBeGreaterThan(0);
      expect(hasDevKit(root)).toBeFalse();
      expect(installedEngineSkills(root)).toEqual([]);
      expect(existsSync(join(root, '.claude', 'rules', 'forgeax-game.md'))).toBeFalse();
      expect(existsSync(join(root, '.zcode', 'skills', 'forgeax-game'))).toBeFalse();
      expect(existsSync(join(foreign, 'SKILL.md'))).toBeTrue();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
