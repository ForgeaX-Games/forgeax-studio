#!/usr/bin/env node

// Compare the source-controlled required-check manifest with GitHub's active
// branch ruleset. The ruleset remains the enforcement point; this command
// makes drift fail in CI instead of leaving two silently diverging lists.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("./required-checks.json", import.meta.url), "utf8"),
);

export function compareRequiredChecks(localNames, remoteNames) {
  const local = [...new Set(localNames)].sort();
  const remote = [...new Set(remoteNames)].sort();
  return {
    ok: local.length === remote.length && local.every((name, index) => name === remote[index]),
    local,
    remote,
    missingRemotely: local.filter((name) => !remote.includes(name)),
    extraRemotely: remote.filter((name) => !local.includes(name)),
  };
}

function ghJson(args) {
  return JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8" }));
}

function repositoryName() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    encoding: "utf8",
  }).trim();
}

export function main() {
  const repo = repositoryName();
  const rulesetName = process.env.FORGEAX_REQUIRED_RULESET_NAME ?? "basic";
  const rulesets = ghJson([`repos/${repo}/rulesets`]);
  const active = rulesets.find(
    (ruleset) => ruleset.name === rulesetName && ruleset.enforcement === "active",
  );
  if (!active) throw new Error(`active ${rulesetName} ruleset not found for ${repo}`);

  const detail = ghJson([`repos/${repo}/rulesets/${active.id}`]);
  const rule = detail.rules?.find((candidate) => candidate.type === "required_status_checks");
  const remote = rule?.parameters?.required_status_checks?.map(({ context }) => context) ?? [];
  const result = compareRequiredChecks(manifest, remote);
  console.log(JSON.stringify({ repo, ruleset: active.id, rulesetName, ...result }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
