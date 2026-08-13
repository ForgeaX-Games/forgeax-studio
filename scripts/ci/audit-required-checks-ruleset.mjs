#!/usr/bin/env bun

// Compare the producer-owned required-context contract with GitHub's active
// branch rulesets. The ruleset remains the enforcement point; this command
// makes drift fail in trusted admission instead of leaving two silently
// diverging context rosters.

import { execFileSync } from "node:child_process";
import { loadCiContractFiles } from "../../packages/recursive-input-contract/src/ci-contract.ts";
import { probeLiveRulesetsSync } from "../../packages/recursive-input-contract/src/ci-ruleset.ts";

const contract = loadCiContractFiles();
const manifest = contract.manifest;

export function requiredContextsFromProducerManifest() {
  return manifest.requiredContexts.map(({ name }) => name);
}

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

function repositoryName() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    encoding: "utf8",
  }).trim();
}

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function main() {
  const repo = repositoryName();
  const result = probeLiveRulesetsSync({
    repository: repo,
    ref: manifest.governance.ref,
    token: token(),
    expected: manifest.governance,
  });
  console.log(JSON.stringify({
    ...result,
    producerManifest: {
      path: contract.manifestPath,
      digest: contract.manifestDigest,
      contexts: requiredContextsFromProducerManifest(),
    },
  }, null, 2));
  if (result.status !== "aligned") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
