import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedTarballName } from './accept-packed-runtime';
import { RUNTIME_PACKAGES, RUNTIME_VERSION, validateReleaseTrain, type PackedManifest } from './check-release-train';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = join(root, '.github', 'workflows', 'game-runtime-publish.yml');
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8') : '';
const runnerPolicy = readFileSync(join(root, 'scripts', 'ci', 'runner-policy.json'), 'utf8');

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

  test('admits the PR validation graph only for release-train change domains', () => {
    expect(() => Bun.YAML.parse(workflow)).not.toThrow();
    // Domain scoping 2026-08-19: PRs trigger the workflow, but runtime-scope
    // derives one immutable affected closure. Discovery failure fails Tier 0
    // closed instead of letting downstream jobs improvise a second scope.
    expect(workflow).toContain('pull_request:\n    branches: [main]');
    const scope = job('runtime-scope');
    expect(scope).toContain('gh api --paginate');
    expect(scope).toContain('bun scripts/ci/change-manifest.ts');
    expect(scope).toContain('runtime-run-common');
    expect(scope).toContain('runtime-run-universal');
    expect(scope).toContain('runtime-run-native');
    expect(scope).toContain('runtime-matrix');
    expect(scope).toContain('runtime-class=integration-only-root');
    expect(scope).toContain('runtime-matrix={"include":[]}');
    expect(scope).toContain('timeout-minutes: 2');
    expect(job('source-security')).toContain("needs.runtime-scope.outputs.run == 'true'");
    expect(job('runtime-validation')).toContain('SCOPE_RUN: ${{ needs.runtime-scope.outputs.run }}');
    expect(job('runtime-validation')).toContain('SCOPE_CLASS: ${{ needs.runtime-scope.outputs.change-class }}');
    expect(job('runtime-validation')).toContain('[ "$SCOPE_CLASS" = "integration-only-root" ]');
    expect(job('runtime-validation')).toContain('scope said skip but a producer ran');
    expect(workflow).toContain('push:\n    branches: [main]\n    tags: [\'v*\']');
    expect(workflow).toContain("schedule:\n    - cron: '17 2 * * *'");
    expect(workflow).toContain("tags: ['v*']");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('publish:');
    expect(workflow).toContain('default: false');
    expect(workflow).toContain('type: boolean');
    expect(workflow).not.toMatch(/\n\s+paths:\s/u);
    expect(workflow).not.toContain('continue-on-error');
    expect(workflow).not.toContain('RUNTIME_VERSION:');
    expect(workflow).not.toMatch(/node-version:\s*22/);
    expect(workflow).toContain('node-version-file: .nvmrc');
    expect(job('source-security')).toContain("require('./packages/game-runtime/common/package.json').version");
    expect(job('publish')).toContain("github.event_name == 'workflow_dispatch' && inputs.publish == true");
    for (const match of workflow.matchAll(/uses:\s+([^\s]+)/g)) {
      if (match[1].startsWith('./')) continue;
      expect(match[1], `moving action reference: ${match[1]}`).toMatch(/@[a-f0-9]{40}$/);
    }
  });

  test('requires only the producers selected by the affected Runtime closure', () => {
    const scope = job('runtime-scope');
    const aggregate = job('runtime-validation');
    expect(scope).toContain('change-class: ${{ steps.decide.outputs.runtime-class }}');
    expect(scope).toContain('matrix: ${{ steps.decide.outputs.runtime-matrix }}');
    expect(job('build-platform')).toContain(
      `fromJSON(needs.runtime-scope.outputs.matrix || '{"include":[]}')`,
    );
    for (const target of ['darwin-arm64', 'win32-x64', 'linux-x64']) {
      expect(job(`scan-platform-${target}`)).toContain(
        `contains(fromJSON(needs.runtime-scope.outputs.platforms || '[]'), '${target}')`,
      );
    }
    expect(aggregate).toContain('RUN_COMMON: ${{ needs.runtime-scope.outputs.run-common }}');
    expect(aggregate).toContain('RUN_UNIVERSAL: ${{ needs.runtime-scope.outputs.run-universal }}');
    expect(aggregate).toContain('RUN_NATIVE: ${{ needs.runtime-scope.outputs.run-native }}');
    expect(aggregate).toContain('require_skipped()');
  });

  test('blocks every build on source scans that run before dependency install', () => {
    const security = job('source-security');
    expect(security).toContain('git archive --format=tar HEAD --');
    expect(security).toContain('packages/game-runtime');
    expect(security).toContain('.github/workflows/game-runtime-publish.yml');
    expect(security).toContain('scripts/trufflehog-release-allowlist.json');
    expect(security).toContain('scripts/install-trufflehog-release-scanner.sh');
    expect(security).toContain('scripts/prepare-trufflehog-package-scan.py');
    expect(security).toContain('bash scripts/run-trufflehog-release-scan.sh --mode source --path "$RUNTIME_SOURCE_ROOT"');
    expect(security.indexOf('run-trufflehog-release-scan.sh --mode source')).toBeLessThan(security.indexOf('bun install'));
    expect(security).toContain('bun install --frozen-lockfile --ignore-scripts');
    expect(security).toContain('name: Validate Runtime build graph contracts');
    expect(security).toContain('scripts/ci/build-engine-packages.spec.ts');
    expect(security).toContain('scripts/game-runtime/package-graph.spec.ts');
    expect(security).toContain('scripts/ci/build-engine-packages.ts');
    expect(security).toContain('scripts/ci/ensure-engine-wgpu-wasm.ts');
    expect(security).not.toContain('scripts/build-desktop.ts');
    expect(security).toContain('scripts/lib/runtime-dependency-closure.ts');
    expect(security).toContain('scripts/lib/server-role.ts');
    expect(security).toContain('scripts/lib/version.ts');
    expect(security).toContain('bun test scripts/game-runtime/publish-workflow.spec.ts');
    for (const name of ['build-common', 'build-platform', 'build-universal']) {
      const build = job(name);
      expect(build).toContain('source-security');
      expect(build).toContain('submodules: false');
      expect(build).toContain('uses: ./.github/actions/fetch-submodules');
      expect(build).toContain('bun install --frozen-lockfile --ignore-scripts');
      expect(build).not.toMatch(/bun install --frozen-lockfile\s*(?:\r?\n|$)/);
    }
    expect(security).toContain('submodules: false');
    expect(security).toContain('uses: ./.github/actions/fetch-submodules');
  });

  test('publishes only after the complete Runtime validation aggregate passes', () => {
    const aggregate = job('runtime-validation');
    expect(aggregate).toContain('name: Runtime validation aggregate');
    expect(aggregate).toContain('if: ${{ !cancelled() }}');
    for (const producer of [
      'source-security',
      'build-common',
      'build-platform',
      'build-universal',
      'scan-common',
      'scan-platform-darwin-arm64',
      'scan-platform-win32-x64',
      'scan-platform-linux-x64',
      'scan-universal',
    ]) {
      expect(aggregate).toContain(`- ${producer}`);
      expect(aggregate).toContain(`needs.${producer}.result`);
    }
    expect(aggregate).toContain('Runtime validation graph is not green');
    expect(job('publish')).toContain('- runtime-validation');
  });

  test('projects the candidate and rechecks its digest before npm publish', () => {
    const security = job('source-security');
    const publish = job('publish');
    expect(security).toContain('scripts/replay-release-attestation.py');
    expect(security).toContain('shasum -a 256 -c -');
    expect(publish).toContain('runtime-projection');
    expect(publish).toContain('project_runtime_result');
    expect(publish).toContain('releaseSurface=game-runtime');
    expect(publish).toContain('runtime-digest-recheck');
    const projection = publish.indexOf('runtime-projection');
    const digestRecheck = publish.indexOf('runtime-digest-recheck');
    const firstPublish = publish.indexOf('npm publish');
    expect(projection).toBeGreaterThanOrEqual(0);
    expect(digestRecheck).toBeGreaterThan(projection);
    expect(firstPublish).toBeGreaterThan(digestRecheck);
  });

  test('fails closed when Runtime projection inputs or output are unavailable', () => {
    const publish = job('publish');
    expect(publish).toContain('set -euo pipefail');
    expect(publish).toContain('--runtime-candidate "$RUNNER_TEMP/runtime-candidate.json"');
    expect(publish).toContain('--runtime-evidence "$RUNNER_TEMP/runtime-evidence.json"');
    expect(publish).toContain('--output "$RUNNER_TEMP/runtime-result.json"');
    expect(publish).toContain('= "game-runtime"');
    const projection = publish.indexOf('python3 scripts/replay-release-attestation.py');
    const publishCommand = publish.indexOf('npm publish');
    expect(projection).toBeGreaterThanOrEqual(0);
    expect(publishCommand).toBeGreaterThan(projection);
  });

  test('materializes the recursive pin graph before any Runtime source work', () => {
    // Keep the private composition name split in this public-mirror-owned
    // test source; the assertion still covers the exact internal workflow.
    const privateServerWorkspace = ['packages/server', 'private'].join('-');
    const runtimeWorkspaceRoots = `packages/agent-host packages/build packages/chat packages/cli packages/dashboard packages/editor packages/game-plugin packages/interface packages/orchestrator packages/platform-io packages/server ${privateServerWorkspace} packages/settings`;
    for (const name of ['source-security', 'build-common', 'build-platform', 'build-universal']) {
      const block = job(name);
      const checkout = block.indexOf('actions/checkout');
      const materialize = block.indexOf('uses: ./.github/actions/fetch-submodules');
      expect(checkout, `${name} checkout`).toBeGreaterThanOrEqual(0);
      expect(materialize, `${name} recursive materializer`).toBeGreaterThan(checkout);
      expect(block.slice(checkout, materialize)).not.toContain('submodules: recursive');
      expect(block).toContain(`root-paths: ${runtimeWorkspaceRoots}`);
      expect(block).not.toContain('root-paths: packages/marketplace');
    }
  });

  test('builds all platform packages only on their native runners', () => {
    const platform = job('build-platform');
    expect(platform).toContain(
      `fromJSON(needs.runtime-scope.outputs.matrix || '{"include":[]}')`,
    );
    expect(platform).toContain('runs-on: ${{ matrix.runner }}');
    expect(platform).not.toContain('ubuntu-latest');
    expect(runnerPolicy).toContain('"dynamicSelfHostedRunners"');
    expect(runnerPolicy).toContain('"macos-latest"');
    expect(runnerPolicy).toContain('"windows-latest"');
    expect(platform).toContain('bun scripts/build-game-runtime.ts --target ${{ matrix.target }}');
    expect(platform).toContain('pnpm --dir packages/editor/packages/engine install --frozen-lockfile --ignore-scripts');
    expect(platform).toContain('dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c');
    expect(platform).toContain('taiki-e/install-action@7f4eb899022d8fe70b20c4f3de697aa85c309026');
    expect(platform).toContain('bun scripts/ci/ensure-engine-wgpu-wasm.ts');
    expect(platform).toContain('bun scripts/ci/build-engine-packages.ts --engine-root packages/editor/packages/engine');
    expect(platform.indexOf('build-engine-packages.ts')).toBeLessThan(platform.indexOf('bun scripts/build-game-runtime.ts'));
    expect(platform.indexOf('bun test scripts/build-game-runtime.spec.ts')).toBeLessThan(platform.indexOf('bun scripts/build-game-runtime.ts'));
    expect(platform).toContain("if: matrix.target == 'linux-x64'");
    const nativeBuild = platform.slice(platform.indexOf('Build native Runtime package'));
    expect(nativeBuild).toContain("FORGEAX_SKIP_HARNESS: '1'");
    expect(nativeBuild).toContain('GITHUB_TOKEN: ${{ secrets.INTERNAL_TOKEN }}');
    expect(nativeBuild).toContain('GH_TOKEN: ${{ secrets.INTERNAL_TOKEN }}');
    expect(platform).toContain('(cd "$consumer" && FORGEAX_RUNTIME_CACHE=');
    expect(platform).toContain('common_tgz="$(cd "$(dirname "$common_tgz")" && pwd)/$(basename "$common_tgz")"');
    expect(platform).toContain('bun test scripts/build-game-runtime.spec.ts');
    expect(platform).toContain('bun test scripts/game-runtime/package-graph.spec.ts');
    const packageGraphGate = platform.slice(
      platform.indexOf('Test Runtime package graph'),
      platform.indexOf('Gate preview-only Runtime contents'),
    );
    expect(packageGraphGate).toContain("if: matrix.target == 'linux-x64'");
    expect(platform).toContain('Gate preview-only Runtime contents');
    expect(platform).toContain('tar_args+=(--force-local)');
    expect(platform).toContain('tar "${tar_args[@]}" -tzf "$archive" > "$entries"');
    expect(platform).toContain('Runtime archive size (reported, not gated)');
    expect(platform).toContain('Packed consumer game preview');
    expect(platform).toContain('require("node:path").basename');
    expect(platform).toContain('crypto.createHash("sha256")');
    expect(platform).not.toContain('shasum -a 256 "$tgz"');
    expect(platform).toContain('needs: [runtime-scope, source-security, build-common, build-universal]');
    expect(platform).toContain('name: runtime-universal-candidate');
    expect(platform).toContain('npm install --prefix packages/game-plugin --ignore-scripts --no-audit --no-fund --no-package-lock --no-save');
    expect(platform).toContain('bun packages/game-plugin/scripts/accept-packed-consumer.ts');
    expect(platform).toContain('--platform "${{ steps.pack.outputs.tgz }}"');
    expect(platform).toContain('--universal "$universal_tgz"');
    expect(platform).not.toMatch(/300\s*(?:MB|MiB)/i);
    expect(job('scan-platform-darwin-arm64')).not.toContain('github.event_name');
    expect(job('scan-platform-win32-x64')).not.toContain('github.event_name');
  });

  test('routes Linux jobs by workload rather than by job family', () => {
    expect(job('source-security')).toContain('runs-on: [self-hosted, Linux, X64, standard]');
    expect(job('build-common')).toContain('runs-on: [self-hosted, Linux, X64, heavy]');
    expect(runnerPolicy).toContain('"self-hosted"');
    expect(runnerPolicy).toContain('"heavy"');
    expect(job('build-universal')).toContain('runs-on: [self-hosted, Linux, X64, standard]');
    expect(job('build-universal')).not.toContain('runs-on: [self-hosted, Linux, X64, heavy]');
    for (const name of [
      'scan-common',
      'scan-platform-linux-x64',
      'scan-universal',
    ]) {
      expect(job(name)).toContain('runs-on: [self-hosted, Linux, X64, standard]');
    }
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
    expect(publish).toContain('actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683');
    expect(publish).toContain('ref: ${{ github.sha }}');
    expect(publish).toContain('submodules: false');
    expect(publish).not.toMatch(/setup-bun|bun install|bun scripts|npm pack/);
    expect(publish).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
    const firstPublish = publish.indexOf("publish_scanned '@forgeax/game-runtime-common'");
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
      "publish_scanned '@forgeax/game-runtime-common' \"${{ steps.candidates.outputs.common }}\"",
      "publish_scanned '@forgeax/game-runtime-darwin-arm64' \"${{ steps.candidates.outputs.darwin }}\"",
      "publish_scanned '@forgeax/game-runtime-win32-x64' \"${{ steps.candidates.outputs.win32 }}\"",
      "publish_scanned '@forgeax/game-runtime-linux-x64' \"${{ steps.candidates.outputs.linux }}\"",
      "publish_scanned '@forgeax/game-runtime' \"${{ steps.candidates.outputs.universal }}\"",
    ].map((command) => publish.indexOf(command));
    expect(commands.every((index) => index >= firstPublish)).toBeTrue();
    expect(commands).toEqual([...commands].sort((a, b) => a - b));
  });
});
