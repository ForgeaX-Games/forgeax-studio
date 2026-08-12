import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedTarballName } from './accept-packed-runtime';
import { RUNTIME_PACKAGES, RUNTIME_VERSION, validateReleaseTrain, type PackedManifest } from './check-release-train';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = join(root, '.github', 'workflows', 'game-runtime-publish.yml');
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8') : '';

function job(name: string): string {
  const jobsStart = workflow.indexOf('\njobs:\n');
  const start = workflow.indexOf(`  ${name}:\n`, jobsStart);
  expect(start, `missing workflow job ${name}`).toBeGreaterThanOrEqual(0);
  const boundary = /^  [a-z][a-z0-9-]*:\s*$/gm;
  boundary.lastIndex = start + name.length + 4;
  const next = boundary.exec(workflow)?.index ?? -1;
  return workflow.slice(start, next < 0 ? workflow.length : next);
}

describe('Game Runtime publish workflow', () => {
  test('accepts only the exact five scoped npm tarball names', () => {
    expect(RUNTIME_PACKAGES.map(expectedTarballName)).toEqual([
      `forgeax-game-runtime-common-${RUNTIME_VERSION}.tgz`,
      `forgeax-game-runtime-darwin-arm64-${RUNTIME_VERSION}.tgz`,
      `forgeax-game-runtime-win32-x64-${RUNTIME_VERSION}.tgz`,
      `forgeax-game-runtime-linux-x64-${RUNTIME_VERSION}.tgz`,
      `forgeax-game-runtime-${RUNTIME_VERSION}.tgz`,
    ]);
  });

  test('validates dependency direction and native selectors as one release train', () => {
    const manifests = new Map<string, PackedManifest>([
      ['@forgeax/game-runtime-common', { name: '@forgeax/game-runtime-common', version: RUNTIME_VERSION }],
      ['@forgeax/game-runtime-darwin-arm64', {
        name: '@forgeax/game-runtime-darwin-arm64', version: RUNTIME_VERSION,
        dependencies: { '@forgeax/game-runtime-common': RUNTIME_VERSION }, os: ['darwin'], cpu: ['arm64'],
      }],
      ['@forgeax/game-runtime-win32-x64', {
        name: '@forgeax/game-runtime-win32-x64', version: RUNTIME_VERSION,
        dependencies: { '@forgeax/game-runtime-common': RUNTIME_VERSION }, os: ['win32'], cpu: ['x64'],
      }],
      ['@forgeax/game-runtime-linux-x64', {
        name: '@forgeax/game-runtime-linux-x64', version: RUNTIME_VERSION,
        dependencies: { '@forgeax/game-runtime-common': RUNTIME_VERSION }, os: ['linux'], cpu: ['x64'], libc: ['glibc'],
      }],
      ['@forgeax/game-runtime', {
        name: '@forgeax/game-runtime', version: RUNTIME_VERSION,
        optionalDependencies: {
          '@forgeax/game-runtime-darwin-arm64': RUNTIME_VERSION,
          '@forgeax/game-runtime-win32-x64': RUNTIME_VERSION,
          '@forgeax/game-runtime-linux-x64': RUNTIME_VERSION,
        },
      }],
    ]);
    expect(() => validateReleaseTrain(manifests)).not.toThrow();
    manifests.set('@forgeax/game-runtime', {
      ...manifests.get('@forgeax/game-runtime'),
      dependencies: { '@forgeax/game-runtime-common': RUNTIME_VERSION },
    });
    expect(() => validateReleaseTrain(manifests)).toThrow('Universal must not depend directly on common');
  });

  test('runs the same Linux graph on PRs and main, with full native validation at low frequency', () => {
    expect(() => Bun.YAML.parse(workflow)).not.toThrow();
    expect(workflow).toContain('pull_request:\n    branches: [main]');
    expect(workflow).toContain('push:\n    branches: [main]\n    tags: [\'v*\']');
    expect(workflow).toContain("schedule:\n    - cron: '17 2 * * *'");
    expect(workflow).toContain("tags: ['v*']");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('publish:');
    expect(workflow).toContain('type: boolean');
    expect(workflow).not.toContain('paths:');
    expect(workflow).not.toContain('continue-on-error');
    expect(workflow).not.toContain('RUNTIME_VERSION:');
    expect(workflow).not.toMatch(/node-version:\s*22/);
    expect(workflow).toContain('node-version-file: .nvmrc');
    expect(job('source-security')).toContain("require('./packages/game-runtime/common/package.json').version");
    expect(job('publish')).toContain("(github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v'))");
    expect(job('publish')).toContain("(github.event_name == 'workflow_dispatch' && inputs.publish == true)");
    for (const match of workflow.matchAll(/uses:\s+([^\s]+)/g)) {
      expect(match[1], `moving action reference: ${match[1]}`).toMatch(/@[a-f0-9]{40}$/);
    }
  });

  test('blocks every build on source scans that run before dependency install', () => {
    const security = job('source-security');
    expect(security).toContain('git archive --format=tar HEAD --');
    expect(security).toContain('packages/game-runtime');
    expect(security).toContain('.github/workflows/game-runtime-publish.yml');
    expect(security).toContain('scripts/trufflehog-release-allowlist.json');
    expect(security).toContain('scripts/install-trufflehog-release-scanner.sh');
    expect(security).toContain('bash scripts/run-trufflehog-release-scan.sh --mode source --path "$RUNTIME_SOURCE_ROOT"');
    expect(security.indexOf('run-trufflehog-release-scan.sh --mode source')).toBeLessThan(security.indexOf('bun install'));
    expect(security).toContain('bun install --frozen-lockfile --ignore-scripts');
    expect(security).toContain('scripts/ci/build-engine-packages.ts');
    expect(security).toContain('scripts/ci/ensure-engine-wgpu-wasm.ts');
    for (const name of ['build-common', 'build-platform', 'build-universal']) {
      const build = job(name);
      expect(build).toContain('source-security');
      expect(build).toContain('bun install --frozen-lockfile --ignore-scripts');
      expect(build).not.toMatch(/bun install --frozen-lockfile\s*(?:\r?\n|$)/);
    }
  });

  test('builds all platform packages only on their native runners', () => {
    const platform = job('build-platform');
    expect(platform).toContain('macos-latest');
    expect(platform).toContain('windows-latest');
    expect(platform).not.toContain('ubuntu-latest');
    expect(platform).toContain('darwin-arm64');
    expect(platform).toContain('win32-x64');
    expect(platform).toContain('linux-x64');
    expect(platform).toContain("github.event_name == 'pull_request'");
    expect(platform).toContain('"runner":["self-hosted","Linux","X64","heavy"]');
    expect(platform).toContain('bun scripts/build-game-runtime.ts --target ${{ matrix.target }}');
    expect(platform).toContain('pnpm --dir packages/editor/packages/engine install --frozen-lockfile --ignore-scripts');
    expect(platform).toContain('dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c');
    expect(platform).toContain('taiki-e/install-action@7f4eb899022d8fe70b20c4f3de697aa85c309026');
    expect(platform).toContain('bun scripts/ci/ensure-engine-wgpu-wasm.ts');
    expect(platform).toContain('bun scripts/ci/build-engine-packages.ts --engine-root packages/editor/packages/engine');
    expect(platform.indexOf('build-engine-packages.ts')).toBeLessThan(platform.indexOf('bun scripts/build-game-runtime.ts'));
    const nativeBuild = platform.slice(platform.indexOf('Build native Runtime package'));
    expect(nativeBuild).toContain('GITHUB_TOKEN: ${{ github.event_name == \'pull_request\' && github.token || secrets.INTERNAL_TOKEN }}');
    expect(nativeBuild).toContain('GH_TOKEN: ${{ github.event_name == \'pull_request\' && github.token || secrets.INTERNAL_TOKEN }}');
    expect(platform).toContain('(cd "$consumer" && FORGEAX_RUNTIME_CACHE=');
    expect(platform).toContain('common_tgz="$(cd "$(dirname "$common_tgz")" && pwd)/$(basename "$common_tgz")"');
    expect(platform).toContain('bun test scripts/build-game-runtime.spec.ts\n          bun test scripts/game-runtime/package-graph.spec.ts');
    expect(job('scan-platform-darwin-arm64')).toContain("github.event_name == 'workflow_dispatch'");
    expect(job('scan-platform-win32-x64')).toContain("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
  });

  test('installs the exact Engine package manager before declaration and native builds', () => {
    expect(job('build-common')).toContain('pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271');
    expect(job('build-common')).toContain('version: 11.7.0');
    const common = job('build-common');
    expect(common).toContain('pnpm --dir packages/editor/packages/engine install --frozen-lockfile --ignore-scripts');
    expect(common).toContain('dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c');
    expect(common).toContain('taiki-e/install-action@7f4eb899022d8fe70b20c4f3de697aa85c309026');
    expect(common).toContain("toolchain: '1.93'");
    expect(common).toContain('targets: wasm32-unknown-unknown');
    expect(common).toContain('tool: wasm-pack@0.14.0');
    expect(common).toContain('bun scripts/ci/ensure-engine-wgpu-wasm.ts');
    expect(common.indexOf('ensure-engine-wgpu-wasm.ts')).toBeLessThan(common.indexOf('bun scripts/build-game-runtime-sdk.ts'));
  });

  test('fresh-scans and re-uploads every exact Runtime tarball', () => {
    const scanJobs = [
      'scan-common',
      'scan-platform-darwin-arm64',
      'scan-platform-win32-x64',
      'scan-platform-linux-x64',
      'scan-universal',
    ];
    for (const name of scanJobs) {
      const block = job(name);
      expect(block).toContain('python3 scripts/verify-release-artifact.py');
      expect(block).toContain('check-release-secrets.mjs --mode package');
      expect(block).toContain('run-trufflehog-release-scan.sh --mode package');
      expect(block).toContain('actions/upload-artifact');
      expect(block).toContain('sha256: ${{ steps.verify.outputs.sha256 }}');
    }
  });

  test('uses a minimal publish runner and verifies all five digests before publishing', () => {
    expect(workflow.match(/NPM_TOKEN/g)).toHaveLength(1);
    const publish = job('publish');
    expect(publish).not.toMatch(/actions\/checkout|setup-bun|bun install|bun scripts|npm pack/);
    expect(publish).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
    const firstPublish = publish.indexOf('npm publish');
    expect(firstPublish).toBeGreaterThanOrEqual(0);
    for (const output of [
      'needs.scan-common.outputs.sha256',
      'needs.scan-platform-darwin-arm64.outputs.sha256',
      'needs.scan-platform-win32-x64.outputs.sha256',
      'needs.scan-platform-linux-x64.outputs.sha256',
      'needs.scan-universal.outputs.sha256',
    ]) {
      expect(publish.indexOf(output)).toBeLessThan(firstPublish);
    }
    const commands = [
      'steps.candidates.outputs.common',
      'steps.candidates.outputs.darwin',
      'steps.candidates.outputs.win32',
      'steps.candidates.outputs.linux',
      'steps.candidates.outputs.universal',
    ].map((output) => publish.indexOf(`npm publish "${'${{'} ${output} }}"`));
    expect(commands.every((index) => index >= firstPublish)).toBeTrue();
    expect(commands).toEqual([...commands].sort((a, b) => a - b));
  });
});
