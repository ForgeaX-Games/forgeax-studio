import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const ci = read('.github/workflows/ci.yml');
const boundaries = read('.github/workflows/boundaries.yml');
const pins = read('.github/workflows/submodule-pins.yml');
const mirror = read('.github/workflows/mirror-multi.yml');
const mirrorTemplate = read('scripts/mirror/ci/mirror-multi.yml');
const postMergeWorkflow = read('.github/workflows/post-merge-gate.yml');
const postMergeMonitor = read('.github/workflows/post-merge-monitor.yml');
const postMergeScript = read('scripts/ci/post-merge-gate.sh');
const pinChangeScript = read('scripts/ci/submodule-pin-change.sh');
const tokenAccessScript = read('scripts/ci/check-internal-token-access.sh');

const jobBlock = (workflow: string, name: string): string => {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const next = workflow.slice(bodyStart).search(/\n  [a-zA-Z0-9_-]+:\n/);
  return workflow.slice(start, next === -1 ? undefined : bodyStart + next);
};

describe('CI workflow orchestration', () => {
  it('keeps the forgeax-build-game contract in the required non-docs boundary workflow', () => {
    expect(jobBlock(boundaries, 'full-boundaries')).toContain('run: bun run test:forgeax-build-game');
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
  });

  it('lets superseded runs stop without weakening fail-closed gates', () => {
    for (const [workflow, heavyJob, aggregateJob] of [
      [ci, 'build', 'check'],
      [boundaries, 'full-boundaries', 'lint-boundaries'],
      [pins, 'validate', 'check'],
    ] as const) {
      expect(jobBlock(workflow, heavyJob)).toMatch(
        /\n    if: \$\{\{ !cancelled\(\) && needs\.changes\.result == 'success'/,
      );
      expect(jobBlock(workflow, aggregateJob)).toContain('if: ${{ !cancelled() }}');
    }
  });

  it('keeps orchestration jobs on the self-hosted runner pool', () => {
    for (const [workflow, jobs] of [
      [ci, ['changes', 'check']],
      [boundaries, ['changes', 'lint-boundaries']],
      [pins, ['changes', 'check']],
      [postMergeWorkflow, ['compare']],
      [postMergeMonitor, ['monitor']],
    ] as const) {
      for (const job of jobs) {
        expect(jobBlock(workflow, job)).toContain('runs-on: [self-hosted, Linux, X64]');
        expect(jobBlock(workflow, job)).not.toContain('runs-on: ubuntu-latest');
      }
      expect(workflow).not.toContain('runs-on: ubuntu-latest');
    }

    const pinDecision = jobBlock(pins, 'changes');
    expect(pinDecision).toContain('Prepare self-hosted checkout');
    expect(pinDecision).not.toContain('secrets.INTERNAL_TOKEN');
    expect(jobBlock(postMergeWorkflow, 'compare')).toContain('Prepare self-hosted checkout');
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
    expect(pins).toContain('name: full submodule pin validation');
    expect(pins).toContain('name: submodule pin reachability + main-ancestry');
    expect(pins).toContain('ok (no gitlink, .gitmodules, or validator change)');
  });

  it('runs exactly one mirror assemble path per PR shape', () => {
    for (const workflow of [mirror, mirrorTemplate]) {
      expect(workflow).toMatch(
        /name: Assemble \+ scrub \+ gate \(docs-only\)\n\s+if: steps\.changes\.outputs\.code != 'true'\n\s+run: bash scripts\/mirror\/publish-multi\.sh assemble/,
      );
      expect(workflow).toMatch(
        /name: Mirror install smoke \(assemble \+ recursive-clone layout \+ bun install\)\n\s+if: steps\.changes\.outputs\.code == 'true'\n\s+run: bash scripts\/mirror\/smoke-install\.sh/,
      );
    }
  });

  it('uses persistent local dependency stores and bounded package typechecks', () => {
    expect(ci).toContain('name: Configure runner-local dependency stores');
    expect(ci).toContain('BUN_INSTALL_CACHE_DIR=');
    expect(ci).toContain('NPM_CONFIG_USERCONFIG=');
    expect(ci).not.toContain('name: Cache bun install');
    expect(ci).not.toContain('name: Cache pnpm store');
    expect(ci).toContain("FORGEAX_PLUGIN_BUILD_CONCURRENCY: '2'");
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
    }

    expect(tokenAccessScript).toContain("git config -f \"$modules_file\"");
    expect(tokenAccessScript).toContain('gh api "repos/$repo" --silent');
    expect(tokenAccessScript).toContain('INTERNAL_TOKEN cannot read $repo');
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

});
