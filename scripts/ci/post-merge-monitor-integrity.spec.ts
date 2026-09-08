import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "../..");
const monitor = readFileSync(join(root, ".github/workflows/post-merge-monitor.yml"), "utf8");

describe("post-merge recovery monitor", () => {
  test("distinguishes current, stale, partial, unknown, and recovery-needed observations", () => {
    for (const status of ["current", "stale", "partial", "unknown", "recovery-needed"]) expect(monitor).toContain(status);
    for (const field of ["candidateId", "attempt", "subjectDigest", "releaseComplete", "mutation"]) expect(monitor).toContain(field);
    expect(monitor).toContain("releaseComplete: false");
  });

  test("creates scoped issue alerts while keeping release mutation suppressed", () => {
    expect(monitor).toContain("candidateId: wr.head_sha");
    expect(monitor).toContain("mutation: 'suppressed'");
    expect(monitor).toContain("manual-reconcile");
    expect(monitor).toContain("issues: write");
    expect(monitor).toContain("issues.create");
    expect(monitor).toContain("issues.update");
    expect(monitor).toContain("post-merge,ci-failure");
    expect(monitor).toContain("matchingIssues");
    expect(monitor).toContain("workflowIssues");
    expect(monitor).toContain("duplicate red");
    expect(monitor).toContain("Auto-closed");
    expect(monitor).not.toContain("gh release create");
    expect(monitor).not.toContain("gh release upload");
    expect(monitor).not.toContain("git push");
  });

  test("only ignores a cancelled run when a newer main run supersedes it", () => {
    expect(monitor).toContain("if: steps.inspect.outputs.conclusion == 'cancelled'");
    expect(monitor).toContain("A real failure is actionable even when main has advanced");
    expect(monitor).toContain("cancelled run superseded by newer run");
    expect(monitor).not.toContain("Runs for different main SHAs can finish out of order. Ignore an older");
  });

  test("does not turn stale or unknown evidence into release completion", () => {
    const staleOrUnknown = monitor.includes("stale") && monitor.includes("unknown");
    expect(staleOrUnknown).toBe(true);
    expect(monitor).toContain("releaseComplete: false");
    expect(monitor).toContain("observation only");
  });
});
