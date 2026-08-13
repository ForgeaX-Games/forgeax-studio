import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { discoverWorkflowSourcePaths, WORKFLOW_PARSER_CONTRACT } from './workflow-source-set';
import { validateWorkflowSources } from './validate-workflow-sources';

const root = resolve(import.meta.dir, '../..');

function trackedWorkflowSources(): string[] {
  const captureRoot = join(tmpdir(), `forgeax-workflow-git-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(captureRoot, { recursive: true });
  const stdoutPath = join(captureRoot, 'stdout');
  const stderrPath = join(captureRoot, 'stderr');
  let output = '';
  try {
    const result = Bun.spawnSync(['git', 'ls-files', '--', '.github/workflows', 'scripts/mirror/ci'], {
      cwd: root,
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ls-files failed: ${readFileSync(stderrPath, 'utf8')}`);
    }
    output = readFileSync(stdoutPath, 'utf8');
  } finally {
    rmSync(captureRoot, { recursive: true, force: true });
  }
  return output
    .trim()
    .split('\n')
    .filter((path) => path.endsWith('.yml') || path.endsWith('.yaml'))
    .sort();
}

describe('workflow parser admission', () => {
  it('derives every checked-in workflow and mirrored source from the landed graph contract', () => {
    const paths = discoverWorkflowSourcePaths(root);
    expect(paths).toEqual(trackedWorkflowSources());
    expect(paths).toHaveLength(17);
    expect(paths).toContain('.github/workflows/mirror-publish-dryrun.yml');
    expect(paths).toContain('scripts/mirror/ci/mirror-publish-dryrun.yml');
    expect(WORKFLOW_PARSER_CONTRACT.sourceSet.directories).toEqual([
      '.github/workflows',
      'scripts/mirror/ci',
    ]);
  });

  it('fails closed on a malformed source and does not enter the reporter path', () => {
    const fixtureRoot = join(tmpdir(), `forgeax-workflow-admission-${Date.now()}`);
    const workflowDirectory = join(fixtureRoot, '.github', 'workflows');
    const mirrorDirectory = join(fixtureRoot, 'scripts', 'mirror', 'ci');
    mkdirSync(workflowDirectory, { recursive: true });
    mkdirSync(mirrorDirectory, { recursive: true });
    writeFileSync(
      join(workflowDirectory, 'valid.yml'),
      'name: valid\non: [pull_request]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n',
    );
    writeFileSync(
      join(mirrorDirectory, 'malformed-workflow.yml'),
      readFileSync(join(root, 'scripts/ci/fixtures/fast-robust-ci/malformed-workflow.yml')),
    );

    const parserArgsFile = join(fixtureRoot, 'parser-args.txt');
    const parser = join(fixtureRoot, 'fake-actionlint.mjs');
    writeFileSync(
      parser,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync } from 'node:fs';",
        `const args = process.argv.slice(2); appendFileSync(${JSON.stringify(parserArgsFile)}, args.join('\\n') + '\\n');`,
        "if (args.some((arg) => arg.endsWith('malformed-workflow.yml'))) process.exit(1);",
      ].join('\n') + '\n',
    );
    chmodSync(parser, 0o755);

    const reporterMarker = join(fixtureRoot, 'required-check-reported');
    let parserRejected = false;
    try {
      validateWorkflowSources(fixtureRoot, parser);
    } catch {
      parserRejected = true;
    }
    if (!parserRejected) writeFileSync(reporterMarker, 'reported');

    expect(parserRejected).toBe(true);
    expect(existsSync(reporterMarker)).toBe(false);
    expect(readFileSync(parserArgsFile, 'utf8')).toContain('malformed-workflow.yml');
  });

  it('keeps parser admission in trusted base before the token-bearing reporter', () => {
    const workflow = readFileSync(join(root, '.github/workflows/mirror-publish-dryrun.yml'), 'utf8');
    const parserPosition = workflow.indexOf('.trusted-base/scripts/ci/validate-workflow-sources.ts');
    const tokenPosition = workflow.indexOf('MIRROR_TOKEN: ${{ secrets.MIRROR_TOKEN }}');
    const parserStepStart = workflow.lastIndexOf('      - name: Validate every PR-head workflow and mirrored source');
    const parserStepEnd = workflow.indexOf('\n      - name:', parserStepStart + 1);
    const parserStep = workflow.slice(parserStepStart, parserStepEnd === -1 ? undefined : parserStepEnd);
    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain('path: pr-head');
    expect(workflow).toContain('scripts/mirror/ci');
    expect(workflow).toContain('uses: ./.trusted-base/.github/actions/fetch-submodules');
    expect(parserPosition).toBeGreaterThanOrEqual(0);
    expect(tokenPosition).toBeGreaterThan(parserPosition);
    expect(parserStep).not.toContain('secrets.');
  });
});
