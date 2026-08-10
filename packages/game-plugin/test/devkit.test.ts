import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
      expect(readFileSync(join(primary, 'SKILL.md'), 'utf8')).toContain('forgeax_run_current_game');
      expect(existsSync(join(root, '.agents', 'rules', 'forgeax-game.md'))).toBeTrue();

      // Skills live only in host mounts now. The plain project-root copies served no
      // host and were pure duplication inside the user's repository.
      expect(existsSync(join(root, 'skills'))).toBeFalse();
      expect(existsSync(join(root, 'rules'))).toBeFalse();

      // Only the named host is mounted; the other seven are not this user's problem.
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
      const result = installHostDevKit(root, ['codex', 'workbuddy']);
      expect(result.skillPaths).toEqual([
        join(root, '.agents', 'skills'),
        join(root, '.codebuddy', 'skills'),
      ]);
      expect(result.rulePaths).toEqual([
        join(root, '.agents', 'rules', 'forgeax-game.md'),
        join(root, '.codebuddy', 'rules', 'forgeax-game.md'),
      ]);
      expect(result.note).toContain('installed for 2 hosts');
      expect(existsSync(join(root, '.codebuddy', 'skills', 'forgeax-game', 'SKILL.md'))).toBeTrue();
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
  // Engine skills arrive with the generated SDK snapshot. In a standalone clone before
  // `build`, only the plugin's own skill exists — that is a build state, not a defect,
  // so these two content assertions declare the precondition. The authoritative content
  // gate is scripts/check-package-artifact.ts, which fails a release carrying zero.
  const engineSnapshotPresent = (): boolean =>
    bundledSkills().some((skill) => isEngineSkill(skill.id));

  test.skipIf(!engineSnapshotPresent())('ships the Engine authoring skills alongside the plugin skill', () => {
    const engine = bundledSkills().filter((skill) => isEngineSkill(skill.id));
    // The ladder's first rung. Without these the model has only type signatures,
    // which cannot state Engine conventions such as schedule ordering.
    expect(engine.length).toBeGreaterThan(0);
    expect(engine.map((skill) => skill.id)).toContain('forgeax-engine-ecs');
  });

  test.skipIf(!engineSnapshotPresent())('ships an Engine skill index covering every bundled Engine skill', () => {
    // A guessed skill id fails the lookup silently, so the shipped set must be stated
    // rather than inferred from package names.
    const plugin = bundledSkills().find((skill) => skill.id === 'forgeax-game')!;
    const index = join(plugin.path, 'references', 'engine-skills.md');
    expect(existsSync(index)).toBeTrue();
    const text = readFileSync(index, 'utf8');
    for (const skill of bundledSkills().filter((entry) => isEngineSkill(entry.id))) {
      expect(text).toContain(skill.id);
    }
    // The trap that motivated it: the id does not track the package name.
    expect(text).toContain('forgeax-engine-render-pipeline');
  });

  test('never contributes Studio harness skills from a source checkout', () => {
    // The repo's skills/ directory also holds Studio-internal skills. Only this
    // plugin's own skill and the Engine authoring skills may reach a user's host.
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
      installDevKit(root, ['claude']);
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
      expect(existsSync(join(foreign, 'SKILL.md'))).toBeTrue();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
