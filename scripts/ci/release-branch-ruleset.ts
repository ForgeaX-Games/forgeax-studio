#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Ruleset = Record<string, any>;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

export function comparableRuleset(ruleset: Ruleset) {
  return stable({
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    bypass_actors: ruleset.bypass_actors ?? [],
    conditions: ruleset.conditions,
    rules: ruleset.rules,
  });
}

export function rulesetsMatch(expected: Ruleset, observed: Ruleset) {
  return JSON.stringify(comparableRuleset(expected)) === JSON.stringify(comparableRuleset(observed));
}

function gh(repository: string, args: string[], input?: string) {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf8', input, env: process.env }).trim();
}

export function main() {
  const root = join(import.meta.dir, '..', '..');
  const expected = JSON.parse(readFileSync(join(root, '.github/release-branch-ruleset.json'), 'utf8'));
  const repository = process.env.GITHUB_REPOSITORY || gh('', ['repos/{owner}/{repo}', '--jq', '.full_name']);
  const summaries = JSON.parse(gh(repository, [`repos/${repository}/rulesets`]));
  const summary = summaries.find((item: Ruleset) => item.name === expected.name);
  const observed = summary ? JSON.parse(gh(repository, [`repos/${repository}/rulesets/${summary.id}`])) : undefined;
  const apply = process.argv.includes('--apply');

  if (observed && rulesetsMatch(expected, observed)) {
    console.log(JSON.stringify({ status: 'aligned', repository, rulesetId: summary.id }, null, 2));
    return;
  }
  if (!apply) {
    console.error(JSON.stringify({ status: observed ? 'drifted' : 'missing', repository, expected, observed }, null, 2));
    process.exitCode = 1;
    return;
  }

  const endpoint = summary ? `repos/${repository}/rulesets/${summary.id}` : `repos/${repository}/rulesets`;
  const method = summary ? 'PUT' : 'POST';
  const updated = JSON.parse(gh(repository, ['--method', method, endpoint, '--input', '-'], JSON.stringify(expected)));
  console.log(JSON.stringify({ status: summary ? 'updated' : 'created', repository, rulesetId: updated.id }, null, 2));
}

if (import.meta.main) main();
