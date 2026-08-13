import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareRequiredChecks,
  requiredContextsFromProducerManifest,
} from "./audit-required-checks-ruleset.mjs";

test("derives the exact required contexts from the producer manifest", () => {
  assert.deepEqual(requiredContextsFromProducerManifest(), [
    "typecheck + build + script smoke",
    "SFC-07 stable aggregate",
    "Runtime validation aggregate",
    "dependency-cruiser boundary lint",
    "mirror dry-run (assemble + scrub + gate)",
    "submodule pin reachability + main-ancestry",
    "mirror publish dry-run (external push)",
    "every commit has a human author",
  ]);
});

test("accepts the same required contexts regardless of order", () => {
  assert.deepEqual(
    compareRequiredChecks(["b", "a", "a"], ["a", "b"]),
    { ok: true, local: ["a", "b"], remote: ["a", "b"], missingRemotely: [], extraRemotely: [] },
  );
});

test("reports missing and extra ruleset contexts", () => {
  assert.deepEqual(
    compareRequiredChecks(["required-a", "required-b"], ["required-a", "stale"]),
    {
      ok: false,
      local: ["required-a", "required-b"],
      remote: ["required-a", "stale"],
      missingRemotely: ["required-b"],
      extraRemotely: ["stale"],
    },
  );
});
