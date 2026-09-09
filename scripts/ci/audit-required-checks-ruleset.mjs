#!/usr/bin/env bun

// Compare the producer-owned required-context contract with GitHub's active
// branch rulesets. The ruleset remains the enforcement point; this command
// makes drift fail in trusted admission instead of leaving two silently
// diverging context rosters.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadCiContractFiles } from "../../packages/recursive-input-contract/src/ci-contract.ts";
import { probeLiveRulesetsSync } from "../../packages/recursive-input-contract/src/ci-ruleset.ts";

function contractRootFromArgs() {
  const flagIndex = process.argv.indexOf("--root");
  if (flagIndex < 0) return undefined;
  const root = process.argv[flagIndex + 1];
  if (!root || root.startsWith("--")) throw new Error("--root requires a repository root");
  return root;
}

const contract = loadCiContractFiles(contractRootFromArgs());
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

const ADMISSION_FIELDS = [
  "rootRevision",
  "recursiveInputDigest",
  "trustScope",
  "attempt",
  "requiredContextsDigest",
  "governanceObservation",
  "sourceAsDataRevision",
];

export function validateMirrorAdmission(expected, observed) {
  const candidateId = createHash("sha256")
    .update(JSON.stringify(expected, Object.keys(expected).sort()))
    .digest("hex");
  if (observed?.governanceObservation === "unverified") {
    return {
      ok: false,
      code: "mirror.admission.governance-unverified",
      candidateId,
      expected: "aligned live governance observation",
      actual: "unverified",
      sourceWork: { status: "suppressed" },
      recoveryActions: ["observe-live-ruleset", "retry-cold"],
    };
  }
  const codes = {
    rootRevision: "root",
    recursiveInputDigest: "recursive-input",
    trustScope: "trust-scope",
    attempt: "attempt",
    requiredContextsDigest: "required-contexts",
    governanceObservation: "governance",
    sourceAsDataRevision: "source-as-data",
  };
  for (const field of ADMISSION_FIELDS) {
    if (expected?.[field] !== observed?.[field]) {
      return {
        ok: false,
        code: `mirror.admission.${codes[field]}-mismatch`,
        candidateId,
        expected: String(expected?.[field] ?? "missing"),
        actual: String(observed?.[field] ?? "missing"),
        sourceWork: { status: "suppressed" },
        recoveryActions: ["discard-partial-state", "retry-cold", "rebuild-admission"],
      };
    }
  }
  return { ok: true, code: "mirror.admission-passed", candidateId, sourceWork: { status: "permitted" }, recoveryActions: [] };
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
