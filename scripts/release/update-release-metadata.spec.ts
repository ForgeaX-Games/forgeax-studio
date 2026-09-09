import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderReleaseMetadata, updateReleaseMetadata, writeReleaseMetadataOutput } from './update-release-metadata.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(changelog = '# Changelog\n\n## 🚧 [Unreleased]\n\n---\n\n## v1.0.0\n'): string {
  const root = mkdtempSync(join(tmpdir(), 'release-metadata-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"forgeax-studio","version":"1.0.0"}\n');
  writeFileSync(join(root, 'CHANGELOG.md'), changelog);
  return root;
}

describe('Studio release metadata', () => {
  test('renders complete deterministic files and updates only Studio metadata', () => {
    const root = fixture();
    const rendered = renderReleaseMetadata(root, '1.0.1');
    updateReleaseMetadata(root, '1.0.1');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(rendered.packageJson);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(rendered.changelog);
    expect(rendered.changelog).toContain('## v1.0.1 · IDE-owned Release');
  });

  test('writes expected complete files to an isolated comparison directory', () => {
    const root = fixture();
    const output = join(root, 'expected');
    writeReleaseMetadataOutput(root, '1.0.1', output);
    expect(JSON.parse(readFileSync(join(output, 'package.json'), 'utf8')).version).toBe('1.0.1');
    expect(readFileSync(join(output, 'CHANGELOG.md'), 'utf8')).toContain('## v1.0.1 · IDE-owned Release');
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('1.0.0');
  });

  test('validates every input before writing either file', () => {
    const root = fixture('missing release structure');
    const beforePackage = readFileSync(join(root, 'package.json'), 'utf8');
    const beforeChangelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    expect(() => updateReleaseMetadata(root, '1.0.1')).toThrow('Unreleased marker');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(beforePackage);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(beforeChangelog);
  });

  test('uses an anchored exact heading check without false positives from nearby versions or prose', () => {
    const root = fixture('# Changelog\n\n## 🚧 [Unreleased]\n\nmentions ## v1.0.1 · IDE-owned Release inline\n\n---\n\n## v1.0.10 · IDE-owned Release\n');
    expect(() => renderReleaseMetadata(root, '1.0.1')).not.toThrow();
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## 🚧 [Unreleased]\n\n---\n\n## v1.0.1 · IDE-owned Release\n');
    expect(() => renderReleaseMetadata(root, '1.0.1')).toThrow('exact v1.0.1 release heading');
  });

  test('fails closed when package.json is already at the requested version', () => {
    const root = fixture();
    writeFileSync(join(root, 'package.json'), '{"version":"1.0.1"}\n');
    expect(() => updateReleaseMetadata(root, '1.0.1')).toThrow('already version');
  });
});
