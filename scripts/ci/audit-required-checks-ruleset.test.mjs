import assert from "node:assert/strict";
import { test } from "node:test";
import { compareRequiredChecks } from "./audit-required-checks-ruleset.mjs";

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
