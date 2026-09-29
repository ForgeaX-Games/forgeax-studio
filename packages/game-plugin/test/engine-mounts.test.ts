import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneUnselectedEngineMounts } from '../src/devkit/engine-mounts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'engine-host-mounts-'));
  const mounts = ['.agents/skills', '.claude/skills', '.cursor/skills', '.codebuddy/skills', '.workbuddy/skills', '.forgeax/skills'].map(root => ({ root, skills: ['forgeax-engine-sdk'] }));
  for (const mount of mounts) {
    mkdirSync(join(root, mount.root), { recursive: true });
    symlinkSync('../../skills/forgeax-engine-sdk', join(root, mount.root, 'forgeax-engine-sdk'));
    writeFileSync(join(root, mount.root, '.gitignore'), '# BEGIN FORGEAX MANAGED SKILLS\n/forgeax-engine-sdk\n# END FORGEAX MANAGED SKILLS\n');
  }
  writeFileSync(join(root, '.forgeax/skill-install-manifest.json'), JSON.stringify({ schemaVersion: '1.0.0', sourceRoot: 'skills', mounts }));
  return root;
}

test('Codex-only init removes pristine other-host mounts and updates Engine ownership', () => {
  const root = fixture();
  try {
    expect(pruneUnselectedEngineMounts(root, ['codex'])).toHaveLength(4);
    for (const host of ['.claude', '.cursor', '.codebuddy', '.workbuddy']) expect(existsSync(join(root, host))).toBeFalse();
    expect(existsSync(join(root, '.agents/skills'))).toBeTrue();
    expect(existsSync(join(root, '.forgeax/skills'))).toBeTrue();
    expect(JSON.parse(readFileSync(join(root, '.forgeax/skill-install-manifest.json'), 'utf8')).mounts).toHaveLength(2);
    expect(pruneUnselectedEngineMounts(root, ['codex'])).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preserves selected hosts, custom files, edited ignores and retargeted links', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, '.cursor/skills/custom.md'), 'user');
    writeFileSync(join(root, '.codebuddy/skills/.gitignore'), 'user');
    unlinkSync(join(root, '.workbuddy/skills/forgeax-engine-sdk'));
    symlinkSync('../../custom-sdk', join(root, '.workbuddy/skills/forgeax-engine-sdk'));
    expect(pruneUnselectedEngineMounts(root, ['codex', 'claude'])).toEqual([]);
    expect(readFileSync(join(root, '.cursor/skills/custom.md'), 'utf8')).toBe('user');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('never traverses a symlinked host directory', () => {
  const root = fixture();
  try {
    rmSync(join(root, '.claude'), { recursive: true });
    symlinkSync('.cursor', join(root, '.claude'));
    expect(pruneUnselectedEngineMounts(root, ['codex', 'cursor', 'codebuddy', 'workbuddy'])).toEqual([]);
    expect(existsSync(join(root, '.cursor/skills/.gitignore'))).toBeTrue();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
