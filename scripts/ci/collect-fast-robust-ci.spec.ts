import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { collectFromFixture } from './collect-fast-robust-ci';
import { parseFastRobustCiEvidence } from './fast-robust-ci-evidence.schema';

const directory = fileURLToPath(new URL('.', import.meta.url));
const fixtureDirectory = join(directory, 'fixtures', 'fast-robust-ci');
const source = {
  studioSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  studioOriginMainSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  studioRemoteMainSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  engineEvidenceSha: '6c06e414a7f5c5c2dab9facd5919c04513b102ce',
};

function workflowContent(): string {
  return [
    'name: Fixture CI',
    'on: [pull_request, push]',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  check:',
    '    name: check',
    '    runs-on: [self-hosted, Linux, X64]',
    '    timeout-minutes: 10',
    '  publish:',
    '    name: publish',
    '    needs: check',
    '    runs-on: ${{ matrix.os }}',
  ].join('\n') + '\n';
}

function timestamp(offsetSeconds: number): string {
  return new Date(Date.parse('2026-08-07T12:00:00Z') + offsetSeconds * 1000).toISOString();
}

function baseInput(count = 21): any {
  const runRoster: any[] = [];
  const jobsByRun: Record<string, any[]> = {};
  const artifactsByRun: Record<string, any[]> = {};
  for (let index = 0; index < count; index += 1) {
    const id = 10000 + index;
    const createdAt = timestamp(index * 60);
    const startedAt = timestamp(index * 60 + 5);
    const completedAt = timestamp(index * 60 + 35);
    runRoster.push({
      id,
      status: 'completed',
      conclusion: 'success',
      event: 'pull_request',
      run_attempt: 1,
      head_sha: `${String(index + 1).padStart(40, '0')}`,
      head_branch: `feature-${index}`,
      created_at: createdAt,
      run_started_at: startedAt,
      updated_at: completedAt,
    });
    jobsByRun[String(id)] = [{
      id,
      name: 'check',
      status: 'completed',
      conclusion: 'success',
      labels: ['self-hosted', 'Linux', 'X64'],
      created_at: startedAt,
      started_at: startedAt,
      completed_at: completedAt,
      steps: [],
    }];
    artifactsByRun[String(id)] = [];
  }
  return {
    workflowFiles: [{ path: '.github/workflows/ci.yml', content: workflowContent() }],
    ruleset: { requiredContexts: ['check'] },
    runRoster,
    jobsByRun,
    artifactsByRun,
    submoduleStatus: ' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa packages/fixture\n',
    workspaceManifests: [
      { path: 'package.json', data: { workspaces: ['packages/*'] } },
      { path: 'packages/fixture/package.json', data: { name: '@fixture/pkg' } },
    ],
    source,
  };
}

describe('fast-robust-ci evidence collector', () => {
  it('derives a schema-valid packet with 20+ comparable samples and separate timing facts', () => {
    const evidence = collectFromFixture(baseInput(21), { root: directory, repo: 'fixture/repo', engineEvidenceSha: source.engineEvidenceSha, engineRemoteMainSha: null, rawDir: null, maxRuns: 100 });
    expect(evidence.history.population.status).toBe('pass');
    expect(evidence.history.population.sampleCount).toBe(21);
    expect(evidence.history.comparableSamples[0].admissionSeconds).toBe(5);
    expect(evidence.history.comparableSamples[0].queueProxySeconds).toBe(5);
    expect(evidence.history.comparableSamples[0].activeDurationSeconds).toBe(30);
    expect(evidence.history.comparableSamples[0].artifactReadySeconds).toBeNull();
    expect(evidence.history.comparableSamples[0].firstDecisiveFailure.status).toBe('not-observed');
    expect((evidence as any).wallClock).toBeUndefined();
    expect(evidence.census.workspaceOwners.entries).toContainEqual({
      workspacePattern: 'packages/*',
      manifestPath: 'packages/fixture/package.json',
      packageName: '@fixture/pkg',
      owner: 'submodule:packages/fixture',
      status: 'resolved',
    });
    expect(evidence.controlPlane.edges.needs).toEqual([
      { workflowPath: '.github/workflows/ci.yml', fromJob: 'check', toJob: 'publish' },
    ]);
    expect(evidence.transferDecisions).toHaveLength(18);
    expect(() => parseFastRobustCiEvidence(evidence)).not.toThrow();
  });

  it('claims a repository-owned first decisive failure only when ownership is explicit', () => {
    const input = baseInput(20);
    input.runRoster[0].conclusion = 'failure';
    input.jobsByRun['10000'][0].conclusion = 'failure';
    input.jobsByRun['10000'][0].failureOwnership = 'repository';
    input.jobsByRun['10000'][0].steps = [{ name: 'owned test', conclusion: 'failure', completed_at: timestamp(12) }];
    const evidence = collectFromFixture(input, { root: directory, repo: 'fixture/repo', engineEvidenceSha: source.engineEvidenceSha, engineRemoteMainSha: null, rawDir: null, maxRuns: 100 });
    expect(evidence.history.comparableSamples[0].firstDecisiveFailure.status).toBe('claimed');
    expect(evidence.history.comparableSamples[0].firstDecisiveFailure.secondsFromAdmission).toBe(12);
  });

  it('rejects malformed workflow YAML before emitting a graph', () => {
    const input = baseInput(1);
    input.workflowFiles[0].content = readFileSync(join(fixtureDirectory, 'malformed-workflow.yml'), 'utf8');
    expect(() => collectFromFixture(input, { root: directory, repo: 'fixture/repo', engineEvidenceSha: source.engineEvidenceSha, engineRemoteMainSha: null, rawDir: null, maxRuns: 100 })).toThrow(/ci-evidence-workflow-yaml-invalid/);
  });

  it('rejects a zero-job packet instead of turning it into a timing sample', () => {
    const input = JSON.parse(readFileSync(join(fixtureDirectory, 'zero-job.json'), 'utf8'));
    expect(() => collectFromFixture(input, { root: directory, repo: 'fixture/repo', engineEvidenceSha: source.engineEvidenceSha, engineRemoteMainSha: null, rawDir: null, maxRuns: 100 })).toThrow(/ci-evidence-zero-job/);
  });

  it('keeps mixed roster and runner facts out of the comparable population', () => {
    const input = JSON.parse(readFileSync(join(fixtureDirectory, 'mixed-topology.json'), 'utf8'));
    const evidence = collectFromFixture(input, { root: directory, repo: 'fixture/repo', engineEvidenceSha: source.engineEvidenceSha, engineRemoteMainSha: null, rawDir: null, maxRuns: 100 });
    expect(evidence.history.population.status).toBe('no-claim');
    expect(evidence.history.population.sampleCount).toBe(2);
    const excluded = evidence.history.runs.find((run) => run.runId === 9103);
    expect(excluded?.eligibility.comparable).toBe(false);
    expect(excluded?.eligibility.reasons).toEqual(expect.arrayContaining(['mixed-roster', 'mixed-runner-class']));
    expect(evidence.history.population.noClaimReasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(['mixed-roster', 'mixed-runner-class', 'insufficient-comparable-samples']));
    expect(evidence.history.comparableSamples.find((sample) => sample.runId === 9102)?.firstDecisiveFailure.status).toBe('candidate-no-claim');
  });

  it('requires the full transfer decision packet and rejects incomplete schema output', () => {
    const evidence = collectFromFixture(baseInput(20), { root: directory, repo: 'fixture/repo', engineEvidenceSha: source.engineEvidenceSha, engineRemoteMainSha: null, rawDir: null, maxRuns: 100 });
    expect(new Set(evidence.transferDecisions.map((decision) => decision.id)).size).toBe(18);
    const broken = structuredClone(evidence) as any;
    delete broken.history.population;
    expect(() => parseFastRobustCiEvidence(broken)).toThrow();
  });
});
