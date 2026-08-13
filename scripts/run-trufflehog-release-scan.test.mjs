import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "run-trufflehog-release-scan.sh");
const pinnedImage = "trufflesecurity/trufflehog:3.96.0@sha256:aa821cf4ace8861c7d096d83818cdf7bb9719028a52d37a52eaad44086a52577";

function runWithFakeDocker({ dockerExitCode = 0, dockerOutput = "", mode = "package", scanRootExists = true } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "forgeax-trufflehog-wrapper-"));
  const fakeBin = join(fixture, "bin");
  const scanRoot = join(fixture, "scan-root");
  const dockerArgs = join(fixture, "docker-args.txt");
  mkdirSync(fakeBin);
  if (scanRootExists) mkdirSync(scanRoot);
  const fakeDocker = join(fakeBin, "docker");
  writeFileSync(fakeDocker, `#!/usr/bin/env bash\nif [ "$1" = "info" ]; then exit 0; fi\nprintf '%s\\n' "$@" > "$DOCKER_ARGS_FILE"\nprintf '%s' "$FAKE_DOCKER_OUTPUT"\nexit "$FAKE_DOCKER_EXIT_CODE"\n`);
  chmodSync(fakeDocker, 0o755);

  const env = {
    ...process.env,
    DOCKER_ARGS_FILE: dockerArgs,
    FAKE_DOCKER_OUTPUT: dockerOutput,
    FAKE_DOCKER_EXIT_CODE: String(dockerExitCode),
    PATH: `${fakeBin}:${process.env.PATH}`,
    RUNNER_TEMP: fixture,
  };
  delete env.TRUFFLEHOG_BIN;
  const result = spawnSync("bash", [script, "--mode", mode, "--path", scanRoot], {
    encoding: "utf8",
    env,
  });

  return {
    cleanup: () => rmSync(fixture, { force: true, recursive: true }),
    dockerArgs,
    result,
  };
}

function runWithFakeScanner({ scannerExitCode = 0, scannerOutput = "", mode = "package" } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "forgeax-trufflehog-native-"));
  const fakeBin = join(fixture, "bin");
  const scanRoot = join(fixture, "scan-root");
  const scannerArgs = join(fixture, "scanner-args.txt");
  mkdirSync(fakeBin);
  mkdirSync(scanRoot);
  const fakeScanner = join(fakeBin, "trufflehog");
  writeFileSync(fakeScanner, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$SCANNER_ARGS_FILE"\nprintf '%s' "$FAKE_SCANNER_OUTPUT"\nexit "$FAKE_SCANNER_EXIT_CODE"\n`);
  chmodSync(fakeScanner, 0o755);

  const result = spawnSync("bash", [script, "--mode", mode, "--path", scanRoot], {
    encoding: "utf8",
    env: {
      ...process.env,
      SCANNER_ARGS_FILE: scannerArgs,
      FAKE_SCANNER_OUTPUT: scannerOutput.replaceAll("__SCAN_ROOT__", scanRoot),
      FAKE_SCANNER_EXIT_CODE: String(scannerExitCode),
      TRUFFLEHOG_BIN: fakeScanner,
      PATH: process.env.PATH,
      RUNNER_TEMP: fixture,
    },
  });

  return {
    cleanup: () => rmSync(fixture, { force: true, recursive: true }),
    scannerArgs,
    result,
    scanRoot,
  };
}

test("invokes the immutable multi-platform TruffleHog image", () => {
  const fixture = runWithFakeDocker();
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.match(fixture.result.stdout, /TruffleHog release scan passed/u);
    const args = readFileSync(fixture.dockerArgs, "utf8").split("\n");
    assert.ok(args.includes(pinnedImage));
    for (const flag of ["--fail-on-scan-errors", "--no-update"]) {
      assert.ok(args.includes(flag));
    }
    assert.equal(args.includes("--fail"), false);
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

test("uses a configured host scanner and preserves native source paths", () => {
  const fixture = runWithFakeScanner({
    mode: "source",
    scannerOutput: `${JSON.stringify({
      DetectorName: "fixture-detector",
      DetectorType: 42,
      DecoderName: "PLAIN",
      Verified: false,
      Raw: "real-secret-value",
      SourceMetadata: { Data: { Filesystem: { file: "__SCAN_ROOT__/file.txt", line: 7 } } },
    })}\n`,
  });
  try {
    assert.equal(fixture.result.status, 183, fixture.result.stderr);
    const args = readFileSync(fixture.scannerArgs, "utf8").trim().split("\n");
    assert.equal(args[0], "filesystem");
    assert.ok(args.includes(fixture.scanRoot));
    const excludeIndex = args.indexOf("--exclude-paths");
    assert.ok(excludeIndex >= 0);
    assert.ok(readFileSync(args[excludeIndex + 1], "utf8").includes("scripts/trufflehog-release-allowlist\\.json"));
    assert.match(fixture.result.stdout, /file\.txt/u);
    assert.doesNotMatch(fixture.result.stdout, /real-secret-value/u);
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
    assert.match(fixture.result.stdout, /TruffleHog scan failed/u);
  } finally {
    fixture.cleanup();
  }
});

test("prints only sanitized finding metadata when the scanner reports a finding", () => {
  const fixture = runWithFakeDocker({
    dockerExitCode: 0,
    dockerOutput: `${JSON.stringify({
      DetectorName: "fixture-detector",
      DetectorType: 42,
      DecoderName: "PLAIN",
      Verified: false,
      Raw: "real-secret-value",
      SourceMetadata: { Data: { Filesystem: { file: "/scan/package/file.txt", line: 7 } } },
    })}\n`,
  });
  try {
    assert.equal(fixture.result.status, 183);
    assert.match(fixture.result.stdout, /fixture-detector/u);
    assert.match(fixture.result.stdout, /file\.txt/u);
    assert.doesNotMatch(fixture.result.stdout, /real-secret-value/u);
  } finally {
    fixture.cleanup();
  }
});

test("keeps the release scan allowlist explicit and content-bound", () => {
  const allowlist = JSON.parse(readFileSync(resolve(dirname(script), "trufflehog-release-allowlist.json"), "utf8"));
  assert.equal(allowlist.version, 1);
  assert.equal(allowlist.entries.length, 14);
  const lobEntries = allowlist.entries.filter((entry) => entry.detector === "Lob");
  assert.equal(lobEntries.length, 3);
  for (const entry of lobEntries) {
    assert.equal(entry.mode, "package");
    assert.equal(entry.detector, "Lob");
    assert.equal(entry.detectorType, 490);
    assert.ok(Array.isArray(entry.decoders));
    assert.ok(entry.decoders.length > 0);
    assert.ok(entry.decoders.every((decoder) => /^[A-Z_]+$/u.test(decoder)));
    assert.match(entry.path, /^assets\/engine-sdk\/source\/wgpu-wasm\/src\/rhi\.rs$/u);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u);
    assert.match(entry.raw, /^test_[a-z0-9_]+$/u);
  }
  const runtimeEntries = allowlist.entries.filter((entry) => entry.path === "assets/runtime/linux-x64/forgeax-game-runtime-linux-x64.tar.gz");
  assert.equal(runtimeEntries.length, 11);
  assert.ok(runtimeEntries.every((entry) => entry.mode === "package"));
  assert.ok(runtimeEntries.every((entry) => ["GCP", "Postgres", "URI"].includes(entry.detector)));
  assert.ok(runtimeEntries.every((entry) => Number.isInteger(entry.detectorType)));
  assert.ok(runtimeEntries.every((entry) => Array.isArray(entry.decoders) && entry.decoders.length > 0));
  assert.ok(runtimeEntries.every((entry) => entry.verified === false));
  assert.ok(runtimeEntries.every((entry) => Array.isArray(entry.sha256) && entry.sha256.length === 2));
  assert.ok(runtimeEntries.every((entry) => entry.sha256.every((digest) => /^[a-f0-9]{64}$/u.test(digest))));
  assert.deepEqual(
    new Set(runtimeEntries.flatMap((entry) => entry.sha256)),
    new Set([
      "adc6ef6d097bf4d03e0597de7ad57be1a9f9e23a69a9b90f306073a78c46a06f",
      "ee1393dd994a0200ba31de057b7d8271f75a43e88df3676319fbd8c85ef5cc1d",
    ]),
  );
  assert.deepEqual(
    new Set(runtimeEntries.map((entry) => entry.line)),
    new Set([12, 14, 23, 24, 25, 595, 1945, 204, 257, 310, 4235]),
  );
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
