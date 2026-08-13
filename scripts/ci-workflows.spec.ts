import { describe, expect, it } from 'bun:test';
import './ci/workflow-admission.spec';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCiContractFiles } from '../packages/recursive-input-contract/src/ci-contract.ts';

const ROOT = join(import.meta.dir, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const ciManifest = loadCiContractFiles(ROOT).manifest;

const ci = read('.github/workflows/ci.yml');
const sfc07 = read('.github/workflows/sfc07.yml');
const boundaries = read('.github/workflows/boundaries.yml');
const pins = read('.github/workflows/submodule-pins.yml');
const nightly = read('.github/workflows/nightly-e2e.yml');
const mirror = read('.github/workflows/mirror-multi.yml');
const mirrorTemplate = read('scripts/mirror/ci/mirror-multi.yml');
const mirrorPublishDryrun = read('.github/workflows/mirror-publish-dryrun.yml');
const mirrorPublishDryrunTemplate = read('scripts/mirror/ci/mirror-publish-dryrun.yml');
const authorWorkflow = read('.github/workflows/require-human-author.yml');
const postMergeWorkflow = read('.github/workflows/post-merge-gate.yml');
const postMergeMonitor = read('.github/workflows/post-merge-monitor.yml');
const weeklyRelease = read('.github/workflows/weekly-release.yml').replace(/\r\n/gu, '\n');
const postMergeScript = read('scripts/ci/post-merge-gate.sh');
const pinChangeScript = read('scripts/ci/submodule-pin-change.sh');
const tokenAccessScript = read('scripts/ci/check-internal-token-access.sh');
const recursiveInputAction = read('.github/actions/fetch-submodules/action.yml');
const ordinaryContractSources = [...new Set(ciManifest.consumers
  .filter((consumer) => consumer.trustScope === 'ordinary-ci')
  .flatMap((consumer) => [
    read(consumer.workflow),
    ...(consumer.workflow.startsWith('.github/workflows/mirror-')
      ? [read(`scripts/mirror/ci/${consumer.workflow.slice('.github/workflows/'.length)}`)]
      : []),
  ]))];
const trustedContractSources = [...new Set(ciManifest.consumers
  .filter((consumer) => consumer.trustScope === 'trusted-base-ci')
  .flatMap((consumer) => [
    read(consumer.workflow),
    ...(consumer.workflow.startsWith('.github/workflows/mirror-')
      ? [read(`scripts/mirror/ci/${consumer.workflow.slice('.github/workflows/'.length)}`)]
      : []),
  ]))];

const jobBlock = (workflow: string, name: string): string => {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const next = workflow.slice(bodyStart).search(/\n  [a-zA-Z0-9_-]+:\n/);
  return workflow.slice(start, next === -1 ? undefined : bodyStart + next);
};

const requiredValidationJobs = [
  [ci, 'check', 'typecheck + build + script smoke'],
  [boundaries, 'lint-boundaries', 'dependency-cruiser boundary lint'],
  [pins, 'check', 'submodule pin reachability + main-ancestry'],
  [mirror, 'dryrun', 'mirror dry-run (assemble + scrub + gate)'],
  [mirrorPublishDryrun, 'publish-dryrun', 'mirror publish dry-run (external push)'],
] as const;

describe('CI workflow orchestration', () => {
  it('keeps SFC-07 standard, heavy, and aggregate on distinct capability paths', () => {
    const scope = jobBlock(ci, 'sfc07-scope');
    const standard = jobBlock(ci, 'sfc07-standard');
    const heavy = jobBlock(ci, 'sfc07-heavy');
    const aggregate = jobBlock(ci, 'sfc07');

    expect(scope).toContain('dorny/paths-filter@v3');
    expect(scope).toContain('change-class=non-code');
    expect(standard).toMatch(/runs-on: \[self-hosted, Linux, X64, standard\]/);
    expect(standard).toContain('consumer-id: sfc07-standard');
    expect(standard).toContain('sfc07 run --profile standard');
    expect(standard).toContain('Stage recursive input manifest for SFC-07 aggregate');
    expect(standard).toContain('bun-version-file: .bun-version');
    expect(standard.indexOf('Setup Bun')).toBeLessThan(standard.indexOf('Fetch submodules'));
    expect(standard).toContain('uses: actions/setup-node@v5');
    expect(standard).toContain('id: pnpm-version');
    expect(standard).toContain('uses: pnpm/action-setup@v5');
    expect(standard.indexOf('Setup pnpm')).toBeLessThan(standard.indexOf('Install dependencies'));
    expect(heavy).toMatch(/runs-on: \[self-hosted, Linux, X64, heavy\]/);
    expect(heavy).toContain('consumer-id: sfc07-heavy');
    expect(heavy).toContain('--samples 5 --retries 0 --base-url http://localhost:18920');
    expect(heavy).toContain('Stage recursive input manifest for SFC-07 aggregate');
    expect(heavy).toContain('bun-version-file: .bun-version');
    expect(heavy.indexOf('Setup Bun')).toBeLessThan(heavy.indexOf('Fetch submodules'));
    expect(heavy).toContain('uses: actions/setup-node@v5');
    expect(heavy).toContain('id: pnpm-version');
    expect(heavy).toContain('uses: pnpm/action-setup@v5');
    expect(heavy.indexOf('Setup pnpm')).toBeLessThan(heavy.indexOf('Install dependencies'));
    expect(heavy).toContain('dtolnay/rust-toolchain@stable');
    expect(heavy).toContain("toolchain: '1.93'");
    expect(heavy).toContain('targets: wasm32-unknown-unknown');
    expect(heavy).toContain('wasm-pack@0.14.0');
    expect(heavy).toContain('bun scripts/ci/ensure-engine-wgpu-wasm.ts');
    expect(heavy).toContain('Touch engine artifacts for runtime freshness gates');
    expect(heavy).toContain("FORGEAX_SKIP_GAMES: '1'");
    expect(heavy).toContain("FORGEAX_VITE_FORCE_CLEAN: '1'");
    expect(heavy).toContain('name: Install Chromium for SFC-07 assembled profile');
    expect(heavy).toContain('chromium-headless-shell');
    expect(heavy).toContain('verified SFC-07 Chromium headless launch/close');
    expect(heavy.indexOf('Setup wasm-pack')).toBeLessThan(heavy.indexOf('Install dependencies'));
    expect(heavy.indexOf('Install dependencies')).toBeLessThan(heavy.indexOf('Ensure Engine wgpu WASM'));
    expect(aggregate).toContain('needs: [sfc07-scope, sfc07-standard, sfc07-heavy]');
    expect(aggregate).toContain('--heavy-recursive-input-manifest');
    expect(aggregate).toContain('standard/recursive-input-manifest.json');
    expect(aggregate).toContain('heavy/recursive-input-manifest.json');
    expect(aggregate).toContain('uses: actions/setup-node@v5');

    for (const job of ['standard', 'heavy'] as const) {
      const scheduled = jobBlock(sfc07, job);
      expect(scheduled).toContain(`consumer-id: sfc07-scheduled-${job}`);
      expect(scheduled).toContain('Stage recursive input manifest for scheduled aggregate');
      expect(scheduled).toContain('requested-classes: source,large-file-storage');
      expect(scheduled).toContain('bun-version-file: .bun-version');
      expect(scheduled.indexOf('Setup Bun')).toBeLessThan(scheduled.indexOf('Fetch submodules'));
      expect(scheduled).toContain('uses: actions/setup-node@v5');
      expect(scheduled).toContain('id: pnpm-version');
      expect(scheduled).toContain('uses: pnpm/action-setup@v5');
      expect(scheduled.indexOf('Setup pnpm')).toBeLessThan(scheduled.indexOf('Install dependencies'));
      if (job === 'heavy') {
        expect(scheduled).toContain('dtolnay/rust-toolchain@stable');
        expect(scheduled).toContain('wasm-pack@0.14.0');
        expect(scheduled).toContain('bun scripts/ci/ensure-engine-wgpu-wasm.ts');
        expect(scheduled).toContain('Touch engine artifacts for runtime freshness gates');
        expect(scheduled).toContain("FORGEAX_VITE_FORCE_CLEAN: '1'");
        expect(scheduled.indexOf('Setup wasm-pack')).toBeLessThan(scheduled.indexOf('Install dependencies'));
        expect(scheduled.indexOf('Install dependencies')).toBeLessThan(scheduled.indexOf('Ensure Engine wgpu WASM'));
      }
    }
    const scheduledAggregate = jobBlock(sfc07, 'aggregate');
    expect(scheduledAggregate).toContain('uses: actions/setup-node@v5');
    expect(scheduledAggregate).toContain('standard/recursive-input-manifest.json');
    expect(scheduledAggregate).toContain('heavy/recursive-input-manifest.json');

  });

  it('runs the floating-harness ownership gate before runner policy validation', () => {
    const runnerPolicy = jobBlock(ci, 'runner-policy');
    expect(runnerPolicy).toContain('name: Enforce floating harness ownership');
    expect(runnerPolicy).toContain('bun scripts/ci/check-repo-ownership.ts');
  });

  it('runs source validation for Studio PRs without a root-docs shortcut', () => {
    for (const [workflow, job, context] of requiredValidationJobs) {
      const block = jobBlock(workflow, job);
      expect(block).toContain(`name: ${context}`);
      expect(block).not.toContain('uses: dorny/paths-filter@v3');
      expect(block).not.toContain('docs-only');
      expect(block).not.toContain('docs/**');
    }

    expect(ci).not.toContain('decide docs-only fast-path');
    expect(boundaries).not.toContain('decide docs-only fast-path');
    expect(authorWorkflow).not.toContain('paths-ignore:');
    expect(authorWorkflow).not.toContain("- 'docs/**'");
  });

  it('declares the ordinary recursive input contract at every ordinary action call', () => {
    for (const workflow of ordinaryContractSources) {
      const actionCalls = workflow.match(/uses: \.\/\.github\/actions\/fetch-submodules/g) ?? [];
      const contractCalls = workflow.match(/contract-mode: ordinary-ci/g) ?? [];
      const trustCalls = workflow.match(/trust-scope: ordinary-ci/g) ?? [];
      const classCalls = workflow.match(/requested-classes: source,large-file-storage/g) ?? [];
      const attemptCalls = workflow.match(/producer-attempt: \$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g) ?? [];
      const manifestCalls = workflow.match(/manifest-path: \$\{\{ runner\.temp \}\}\/forgeax-recursive-input-/g) ?? [];

      expect(actionCalls.length).toBeGreaterThan(0);
      expect(contractCalls.length).toBe(actionCalls.length);
      expect(trustCalls.length).toBe(actionCalls.length);
      expect(classCalls.length).toBe(actionCalls.length);
      expect(attemptCalls.length).toBe(actionCalls.length);
      expect(manifestCalls.length).toBe(actionCalls.length);
      expect(workflow).not.toMatch(/requested-classes:.*build-output/);
    }
  });

  it('keeps ordinary workflow checks independent without an input aggregate barrier', () => {
    for (const workflow of ordinaryContractSources) {
      expect(workflow).not.toMatch(/needs:.*(?:recursive-input|ordinary-input)/);
      expect(workflow).not.toContain('ordinary-input-aggregate');
      expect(workflow).not.toContain('trusted-base-ci');
    }
  });

  it('does not wire the ordinary contract into release or weekly-release workflows', () => {
    const ordinarySource = ordinaryContractSources.join('\n');
    expect(ordinarySource).not.toContain('weekly-release');
    expect(ordinarySource).not.toContain('release-publish');
  });

  it('keeps reviewed TruffleHog metadata out of the release history scan', () => {
    const securityScan = jobBlock(weeklyRelease, 'security-scan');
    expect(securityScan).toContain('trufflehog-release-excludes.txt');
    expect(securityScan).toContain('scripts/trufflehog-release-allowlist\\.json');
    expect(securityScan).toContain('--exclude-paths "$RUNNER_TEMP/trufflehog-release-excludes.txt"');
  });

  it('keeps the forgeax-build-game source-harness contract in the required non-docs boundary workflow', () => {
    const boundaryJob = jobBlock(boundaries, 'lint-boundaries');
    expect(boundaryJob).toContain('name: Ensure source Studio harness');
    expect(boundaryJob).toContain('GH_TOKEN: ${{ secrets.INTERNAL_TOKEN }}');
    expect(boundaryJob).toContain('run: bun scripts/sync-package-harness.mjs --ensure');
    expect(boundaryJob).toContain('run: bun run test:forgeax-build-game');
    expect(boundaryJob.indexOf('run: bun scripts/sync-package-harness.mjs --ensure')).toBeLessThan(
      boundaryJob.indexOf('run: bun run test:forgeax-build-game'),
    );
  });

  it('keeps post-merge tree reuse in one permission-complete workflow', () => {
    expect(postMergeWorkflow).toContain('workflow_call:');
    expect(postMergeWorkflow).toContain('pull-requests: read');
    expect(postMergeWorkflow).toContain('run: bash scripts/ci/post-merge-gate.sh');
    expect(postMergeScript).toContain('commits/${GITHUB_SHA}/pulls');
    expect(postMergeScript).toContain('.merge_commit_sha');
    expect(postMergeScript).toContain('.merged_at');
    expect(postMergeScript).not.toContain('git log -1');
    expect(postMergeScript).toContain('skip_checks=true');
    expect(postMergeScript).toContain('skip_checks=false');

    for (const caller of [ci, boundaries, pins]) {
      expect(caller).toMatch(
        /\n  post-merge-gate:\n    if: .+\n    permissions:\n      contents: read\n      pull-requests: read\n    uses: .\/.github\/workflows\/post-merge-gate.yml/,
      );
      expect(jobBlock(caller, 'post-merge-gate')).not.toContain('secrets: inherit');
      expect(caller).toContain('needs.post-merge-gate.outputs.skip_checks');
    }
  });

  it('cancels stale PR heads without canceling main or manual runs', () => {
    for (const workflow of [ci, boundaries, pins]) {
      expect(workflow).toContain("format('pr-{0}', github.event.pull_request.number)");
      expect(workflow).toContain('|| github.run_id');
      expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    }
    for (const workflow of [mirror, mirrorTemplate]) {
      expect(workflow).toContain("format('pr-{0}', github.event.pull_request.number)");
      expect(workflow).toContain("|| 'publish'");
      expect(workflow).not.toContain('|| github.run_id');
      expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    }
    for (const workflow of [mirrorPublishDryrun, mirrorPublishDryrunTemplate]) {
      expect(workflow).toContain("format('pr-{0}', github.event.pull_request.number)");
      expect(workflow).toContain("|| 'manual'");
      expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request_target' }}");

      const mergeCheckout = workflow.indexOf('name: Checkout PR merge tree without submodules');
      const prHeadCheckout = workflow.indexOf('name: Checkout PR-head workflow definitions');
      expect(mergeCheckout).toBeGreaterThanOrEqual(0);
      expect(prHeadCheckout).toBeGreaterThan(mergeCheckout);
    }
  });

  it('lets superseded runs stop without weakening fail-closed gates', () => {
    for (const [workflow, requiredJob] of [
      [ci, 'check'],
      [boundaries, 'lint-boundaries'],
      [pins, 'check'],
    ] as const) {
      expect(jobBlock(workflow, requiredJob)).toContain('if: ${{ !cancelled() }}');
      expect(workflow).not.toContain('\n  changes:\n');
    }
    expect(ci).not.toContain('\n  build:\n');
    expect(boundaries).not.toContain('\n  full-boundaries:\n');
    expect(pins).not.toContain('\n  validate:\n');
  });

  it('keeps orchestration jobs on the self-hosted runner pool', () => {
    for (const [workflow, jobs] of [
      [ci, ['check']],
      [boundaries, ['lint-boundaries']],
      [pins, ['check']],
      [postMergeWorkflow, ['compare']],
      [postMergeMonitor, ['monitor']],
    ] as const) {
      for (const job of jobs) {
        expect(jobBlock(workflow, job)).toMatch(/runs-on: \[self-hosted, Linux, X64, (?:standard|heavy)\]/);
        expect(jobBlock(workflow, job)).not.toContain('runs-on: ubuntu-latest');
      }
      expect(workflow).not.toContain('runs-on: ubuntu-latest');
    }

    const pinJob = jobBlock(pins, 'check');
    expect(pinJob).toContain('Prepare self-hosted checkout for pin-scope decision');
    const decisionCheckoutStart = pinJob.indexOf('name: Checkout PR head without submodules');
    const decisionCheckoutEnd = pinJob.indexOf('\n      - name:', decisionCheckoutStart + 1);
    expect(pinJob.slice(decisionCheckoutStart, decisionCheckoutEnd)).not.toContain('secrets.INTERNAL_TOKEN');
    expect(jobBlock(postMergeWorkflow, 'compare')).toContain('Prepare self-hosted checkout');
    expect(jobBlock(ci, 'runner-policy')).toContain('Prepare runner-policy checkout');
    expect(jobBlock(ci, 'runner-policy')).toContain('core.hooksPath');
  });

  it('fast-paths the pin guard only when no gitlink contract changed', () => {
    expect(pins).toContain('bash scripts/ci/submodule-pin-change.sh "$BASE_SHA" "$HEAD_SHA"');
    expect(pins).toContain('Unable to compare PR base and head');
    expect(pinChangeScript).toContain('git diff --raw --no-renames');
    expect(pinChangeScript).toContain('$1 == ":160000" ||');
    expect(pinChangeScript).toContain('$2 == "160000" ||');
    expect(pinChangeScript).toContain('$6 == ".gitmodules" ||');
    expect(pinChangeScript).toContain('$6 == ".github/workflows/submodule-pins.yml" ||');
    expect(pinChangeScript).toContain('index($6, ".github/actions/fetch-submodules/") == 1');
    expect(pins).toContain('name: submodule pin reachability + main-ancestry');
    expect(pins).toContain('ok (no gitlink, .gitmodules, or validator change)');
  });

  it('runs mirror assembly on every PR validation path', () => {
    for (const workflow of [mirror, mirrorTemplate]) {
      expect(workflow).not.toContain('Assemble + scrub + gate (docs-only)');
      expect(workflow).toMatch(
        /name: Mirror install smoke \(assemble \+ recursive-clone layout \+ bun install\)\n\s+run: bash scripts\/mirror\/smoke-install\.sh/,
      );
    }
  });

  it('runs the focused template gate only on the full validation path', () => {
    const check = jobBlock(ci, 'check');
    const start = check.indexOf('name: Test engine-owned templates and external game activation');
    const end = check.indexOf('\n      - name:', start + 1);
    const step = check.slice(start, end === -1 ? undefined : end);
    expect(step).toContain("if: steps.scope.outputs.run == 'true'");
  });

  it('runs the local fast-CI contract only on the full validation path', () => {
    const check = jobBlock(ci, 'check');
    const start = check.indexOf('name: Test local bun fx ci contract');
    const end = check.indexOf('\n      - name:', start + 1);
    const step = check.slice(start, end === -1 ? undefined : end);
    expect(step).toContain("if: steps.scope.outputs.run == 'true'");
  });

  it('uses persistent local dependency stores and bounded package typechecks', () => {
    expect(ci).toContain('name: Configure runner-local dependency stores');
    expect(ci).toContain('BUN_INSTALL_CACHE_DIR=');
    expect(ci).toContain('NPM_CONFIG_USERCONFIG=');
    expect(ci).not.toContain('name: Cache bun install');
    expect(ci).not.toContain('name: Cache pnpm store');
    expect(ci).toContain("FORGEAX_PLUGIN_BUILD_CONCURRENCY: '1'");
    expect(ci).toContain('FORGEAX_TYPECHECK_CONCURRENCY');
    expect(ci).toContain('bun scripts/ci/run-package-typechecks.ts');
    expect(ci).toContain('FORGEAX_STATIC_GATE_CONCURRENCY');
    expect(ci).toContain('FORGEAX_VITE_BUILD_CONCURRENCY');
    expect(ci).toContain('bun scripts/ci/run-post-install-checks.ts');
    expect(ci).toContain('scripts/ci/*.ts');
    expect(pins).toContain("FORGEAX_PIN_CHECK_CONCURRENCY: '4'");
    expect(pins).toContain('export GIT_CONFIG_GLOBAL="${auth_config}"');
    expect(pins).not.toContain('git config --global "http.https://github.com/.extraheader"');
  });

  it('hardens mirror publish credentials and verifies token scope before recursion', () => {
    const publish = jobBlock(mirror, 'publish');
    expect(publish).toContain('name: Prepare self-hosted checkout');
    expect(publish).toContain("git config --global --unset-all credential.helper");
    expect(publish).toContain('Wiping persistent workspace');

    for (const workflow of [mirror, mirrorTemplate]) {
      const workflowPublish = jobBlock(workflow, 'publish');
      expect(workflowPublish).toContain('name: Verify INTERNAL_TOKEN access to top-level submodules');
      expect(workflowPublish).toContain('GH_TOKEN: ${{ secrets.INTERNAL_TOKEN }}');
      expect(workflowPublish).toContain('run: bash scripts/ci/check-internal-token-access.sh');
      expect(workflowPublish).toContain('name: Mirror install smoke (assemble + recursive-clone layout + bun install)');
      expect(workflowPublish).toContain('run: bash scripts/mirror/smoke-install.sh');
    }

    expect(tokenAccessScript).toContain("git config -f \"$modules_file\"");
    expect(tokenAccessScript).toContain('gh api "repos/$repo" --silent');
    expect(tokenAccessScript).toContain('INTERNAL_TOKEN cannot read $repo');
  });

  it('replays the post-merge mirror publisher during PR validation without mutation', () => {
    for (const workflow of [mirrorPublishDryrun, mirrorPublishDryrunTemplate]) {
      expect(workflow).toContain('pull_request_target:');
      expect(workflow).toContain('name: mirror publish dry-run (external push)');
      expect(workflow).toContain('github.event.pull_request.merge_commit_sha');
      expect(workflow).toContain('ref: ${{ github.event_name == \'workflow_dispatch\' && github.ref || github.event.pull_request.base.sha }}');
      expect(workflow).toContain('MIRROR_TOKEN: ${{ secrets.MIRROR_TOKEN }}');
      expect(workflow).toContain('name: Verify INTERNAL_TOKEN access to top-level submodules');
      expect(workflow).toContain('run: bash .trusted-base/scripts/ci/check-internal-token-access.sh');
      expect(workflow).toContain('name: Mirror install smoke (assemble + recursive-clone layout + bun install');
      expect(workflow).toContain('MIRROR_DRY_RUN=1 bash .trusted-base/scripts/mirror/publish-multi.sh push');
      expect(workflow).toContain('MIRROR_LIB: ${{ github.workspace }}/.trusted-base/scripts/mirror/lib.sh');
    }
    const publish = read('scripts/mirror/publish-multi.sh');
    expect(publish).toContain('check_mirror_token');
    expect(publish).toContain('MIRROR_DRY_RUN=1');
    expect(publish).toContain('git push -q "${options[@]}"');
    expect(publish).toContain('dry-run: skip opening the mirror superproject PR');
    const smoke = read('scripts/mirror/smoke-install.sh');
    expect(smoke).toContain('MIRROR_ROOT');
    expect(smoke).toContain('MIRROR_PUBLISHER');
  });

  it('monitors every main validation and scopes recovery to the failed workflow', () => {
    expect(postMergeMonitor).toContain(
      'workflows: [ci, boundaries, submodule-pins, mirror-multi]',
    );
    expect(postMergeMonitor).toContain('github.event.workflow_run.workflow_id');
    expect(postMergeMonitor).toContain("core.setOutput('workflowName', wr.name)");
    expect(postMergeMonitor).toContain('**workflow**: `');
    expect(postMergeMonitor).toContain("core.setOutput('workflowIssues'");
    expect(postMergeMonitor).not.toContain("core.setOutput('allOpenIssues'");
  });

  it('derives nightly contract admission from the package owner registry', () => {
    expect(nightly).toContain('bun scripts/ci/nightly-contract-roster.ts');
    expect(nightly).toContain('nightly contract owner roster');
    expect(nightly).toContain('bun scripts/build-extensions.ts --only @forgeax-extension/wb-game-video --fail-on-error');
    expect(nightly).toContain('bunx playwright install chromium');
    expect(nightly).not.toContain('packages/types');
    expect(nightly).not.toContain('working-directory: packages/host-sdk');
    expect(nightly).not.toContain('name: server - install + full test suite');
    expect(nightly).not.toContain('name: contract-error-modes (canonical doc-to-test pin)');
    expect(nightly).not.toContain('continue-on-error');
  });

});

describe('trusted recursive input isolation', () => {
  const trustedWorkflows = trustedContractSources;

  it('declares a separate trusted input result instead of reusing ordinary manifest/cache state', () => {
    for (const workflow of trustedWorkflows) {
      const fetchStepStart = workflow.indexOf('      - name: Fetch PR submodules with trusted retry policy');
      const fetchStepEnd = workflow.indexOf('\n      - name:', fetchStepStart + 1);
      const fetchStep = workflow.slice(fetchStepStart, fetchStepEnd === -1 ? undefined : fetchStepEnd);

      expect(fetchStep).toContain('uses: ./.trusted-base/.github/actions/fetch-submodules');
      expect(fetchStep).toContain('contract-mode: trusted-base');
      expect(fetchStep).toContain('trust-scope: trusted-base-ci');
      expect(fetchStep).toContain('requested-classes: source,large-file-storage');
      expect(fetchStep).toContain('producer-attempt: ${{ github.run_id }}-${{ github.run_attempt }}');
      expect(fetchStep).toContain('manifest-path: ${{ runner.temp }}/forgeax-trusted-recursive-input-');
      expect(fetchStep).not.toContain('manifest-path: ${{ runner.temp }}/forgeax-recursive-input-');
      expect(fetchStep).toContain('job: ${{ github.job }}');
    }
  });

  it('keeps the trusted producer and validator in base while the PR tree is source-as-data', () => {
    expect(recursiveInputAction).toContain('CONTRACT_MODE');
    expect(recursiveInputAction).toContain('trusted-base');
    expect(recursiveInputAction).toContain('GITHUB_ACTION_PATH');
    expect(recursiveInputAction).toContain('trust-adapter.ts');
    expect(recursiveInputAction).toContain('source-as-data');
    expect(recursiveInputAction).toContain('trusted-base-ci');
    expect(recursiveInputAction).toContain('ordinary-ci');
    expect(recursiveInputAction).toMatch(/trusted-base[\s\S]*validator/);

    for (const workflow of trustedWorkflows) {
      const tokenPosition = workflow.indexOf('MIRROR_TOKEN: ${{ secrets.MIRROR_TOKEN }}');
      const publishPosition = workflow.indexOf('MIRROR_DRY_RUN=1 bash .trusted-base/scripts/mirror/publish-multi.sh push');
      expect(tokenPosition).toBeGreaterThanOrEqual(0);
      expect(publishPosition).toBeGreaterThan(tokenPosition);
      expect(workflow).toContain('MIRROR_PUBLISHER: ${{ github.workspace }}/.trusted-base/scripts/mirror/publish-multi.sh');
      expect(workflow).toContain('MIRROR_LIB: ${{ github.workspace }}/.trusted-base/scripts/mirror/lib.sh');
      expect(workflow).toContain('source-as-data');
    }
  });
});
