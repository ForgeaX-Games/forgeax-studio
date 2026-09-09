import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "run-trufflehog-release-scan.sh");
const pinnedImage = "trufflesecurity/trufflehog:3.96.0@sha256:aa821cf4ace8861c7d096d83818cdf7bb9719028a52d37a52eaad44086a52577";

function runWithFakeDocker({ dockerExitCode = 0, mode = "package", scanRootExists = true } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "forgeax-trufflehog-wrapper-"));
  const fakeBin = join(fixture, "bin");
  const scanRoot = join(fixture, "scan-root");
  const dockerArgs = join(fixture, "docker-args.txt");
  mkdirSync(fakeBin);
  if (scanRootExists) mkdirSync(scanRoot);
  const fakeDocker = join(fakeBin, "docker");
  writeFileSync(fakeDocker, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$DOCKER_ARGS_FILE"\nexit "$FAKE_DOCKER_EXIT_CODE"\n`);
  chmodSync(fakeDocker, 0o755);

  const result = spawnSync("bash", [script, "--mode", mode, "--path", scanRoot], {
    encoding: "utf8",
    env: {
      ...process.env,
      DOCKER_ARGS_FILE: dockerArgs,
      FAKE_DOCKER_EXIT_CODE: String(dockerExitCode),
      PATH: `${fakeBin}:${process.env.PATH}`,
      RUNNER_TEMP: fixture,
    },
  });

  return {
    cleanup: () => rmSync(fixture, { force: true, recursive: true }),
    dockerArgs,
    result,
  };
}

test("invokes the immutable multi-platform TruffleHog image", () => {
  const fixture = runWithFakeDocker();
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.match(fixture.result.stdout, /TruffleHog release scan passed/u);
    const args = readFileSync(fixture.dockerArgs, "utf8").split("\n");
    assert.ok(args.includes(pinnedImage));
    for (const flag of ["--fail", "--fail-on-scan-errors", "--no-update"]) {
      assert.ok(args.includes(flag));
    }
    assert.doesNotMatch(fixture.result.stdout + fixture.result.stderr, /real-secret-value/u);
  } finally {
    fixture.cleanup();
  }
});

test("package mode scans without directory exclusions", () => {
  const fixture = runWithFakeDocker({ mode: "package" });
  try {
    const args = readFileSync(fixture.dockerArgs, "utf8");
    assert.doesNotMatch(args, /--exclude-paths/u);
  } finally {
    fixture.cleanup();
  }
});

test("source mode applies the source-only exclusion list", () => {
  const fixture = runWithFakeDocker({ mode: "source" });
  try {
    const args = readFileSync(fixture.dockerArgs, "utf8");
    assert.match(args, /--exclude-paths/u);
  } finally {
    fixture.cleanup();
  }
});

test("rejects unknown scan modes before Docker", () => {
  const fixture = runWithFakeDocker({ mode: "unknown" });
  try {
    assert.notEqual(fixture.result.status, 0);
    assert.equal(existsSync(fixture.dockerArgs), false);
  } finally {
    fixture.cleanup();
  }
});

test("preserves the Docker scan status", () => {
  const fixture = runWithFakeDocker({ dockerExitCode: 23 });
  try {
    assert.equal(fixture.result.status, 23);
    assert.match(fixture.result.stdout, /TruffleHog blocked the release/u);
  } finally {
    fixture.cleanup();
  }
});

test("fails before Docker when the scan root cannot be resolved", () => {
  const fixture = runWithFakeDocker({ scanRootExists: false });
  try {
    assert.notEqual(fixture.result.status, 0);
    assert.equal(existsSync(fixture.dockerArgs), false);
  } finally {
    fixture.cleanup();
  }
});
