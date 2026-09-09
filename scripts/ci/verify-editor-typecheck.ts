#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const EDITOR_TYPECHECK_EVIDENCE_SCHEMA = 'forgeax-editor-typecheck-evidence/v1';
export const EDITOR_REPOSITORY = 'ForgeaX-Games/forgeax-editor';
export const EDITOR_TYPECHECK_NAME = 'typecheck';

const SHA40 = /^[a-f0-9]{40}$/;

export class EditorTypecheckEvidenceError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EditorTypecheckEvidenceError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new EditorTypecheckEvidenceError(code, message);
}

function requiredString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) fail('editor-typecheck-evidence-invalid', `${label} is required.`);
}

export function validateEditorTypecheckEvidence(
  evidence: unknown,
  { expectedRepository = EDITOR_REPOSITORY, expectedSha }: { expectedRepository?: string; expectedSha?: string } = {},
) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    fail('editor-typecheck-evidence-invalid', 'Editor typecheck evidence must be an object.');
  }
  const value = evidence as Record<string, unknown>;
  if (value.schema !== EDITOR_TYPECHECK_EVIDENCE_SCHEMA) fail('editor-typecheck-evidence-invalid', 'Unsupported editor typecheck evidence schema.');
  if (value.status !== 'passed') fail('editor-typecheck-evidence-failed', 'Editor typecheck evidence must be passed.');
  if (value.repository !== expectedRepository) fail('editor-typecheck-repository-mismatch', 'Editor typecheck evidence names an unexpected repository.');
  requiredString(value.deliveredSha, 'deliveredSha');
  if (!SHA40.test(value.deliveredSha)) fail('editor-typecheck-evidence-invalid', 'deliveredSha must be a 40-character lowercase SHA.');
  if (expectedSha !== undefined && value.deliveredSha !== expectedSha) fail('editor-typecheck-sha-mismatch', 'Editor typecheck evidence is not bound to the delivered editor SHA.');
  if (value.checkName !== EDITOR_TYPECHECK_NAME) fail('editor-typecheck-check-mismatch', 'Editor typecheck evidence must name the typecheck check-run.');
  const checkRun = value.checkRun;
  if (!checkRun || typeof checkRun !== 'object' || Array.isArray(checkRun)) fail('editor-typecheck-evidence-invalid', 'checkRun evidence is required.');
  const run = checkRun as Record<string, unknown>;
  if (run.name !== EDITOR_TYPECHECK_NAME || run.status !== 'completed' || run.conclusion !== 'success' || run.headSha !== value.deliveredSha) {
    fail('editor-typecheck-check-mismatch', 'The successful typecheck check-run must be completed on the delivered editor SHA.');
  }
  return value;
}

function resolveDeliveredSha(editorPath: string): string {
  const sha = execFileSync('git', ['-C', editorPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!SHA40.test(sha)) fail('editor-typecheck-sha-invalid', `The delivered editor SHA is invalid: ${sha}`);
  return sha;
}

function checkRuns(repository: string, sha: string): Record<string, unknown>[] {
  const endpoint = `repos/${repository}/commits/${sha}/check-runs?per_page=100`;
  // Older runner images ship a gh version without `--slurp`. Ask gh's
  // pagination-aware jq mode to emit one check-run JSON object per line so
  // the same command works on both current and legacy runner images.
  const raw = execFileSync('gh', ['api', '--paginate', '--jq', '.check_runs[]', endpoint], { encoding: 'utf8' });
  try {
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((run): run is Record<string, unknown> => Boolean(run && typeof run === 'object' && !Array.isArray(run)));
  } catch (error) {
    fail('editor-typecheck-api-invalid', `GitHub check-runs response must contain one JSON object per line: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function verifyEditorTypecheck({
  repository = process.env.EDITOR_CI_REPOSITORY || EDITOR_REPOSITORY,
  editorPath = process.env.EDITOR_PATH || 'packages/editor',
  checkName = process.env.EDITOR_TYPECHECK_NAME || EDITOR_TYPECHECK_NAME,
} = {}) {
  if (checkName !== EDITOR_TYPECHECK_NAME) fail('editor-typecheck-check-mismatch', `Unsupported editor check name: ${checkName}`);
  const sha = resolveDeliveredSha(editorPath);
  const matching = checkRuns(repository, sha).filter((run) => run.name === checkName && run.head_sha === sha);
  const successful = matching.find((run) => run.status === 'completed' && run.conclusion === 'success');
  if (!successful) fail('editor-typecheck-not-passed', `No completed successful ${checkName} check-run exists for ${repository}@${sha}.`);
  const evidence = {
    schema: EDITOR_TYPECHECK_EVIDENCE_SCHEMA,
    status: 'passed',
    repository,
    editorPath,
    deliveredSha: sha,
    checkName,
    checkRun: {
      id: successful.id ?? null,
      name: successful.name,
      status: successful.status,
      conclusion: successful.conclusion,
      headSha: successful.head_sha,
      htmlUrl: successful.html_url ?? null,
      completedAt: successful.completed_at ?? null,
    },
  };
  return validateEditorTypecheckEvidence(evidence, { expectedRepository: repository, expectedSha: sha });
}

function option(args: string[], name: string, fallback?: string) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const evidence = verifyEditorTypecheck({
      repository: option(args, '--repository'),
      editorPath: option(args, '--editor-path'),
      checkName: option(args, '--check-name'),
    });
    const outputPath = option(args, '--output');
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }
    console.log(JSON.stringify(evidence));
  } catch (error) {
    console.error(`[editor-typecheck] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
