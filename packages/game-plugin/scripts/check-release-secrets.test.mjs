import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSensitiveMatches, scanTree } from "./check-release-secrets.mjs";

function rules(text, path = "fixture.txt", mode = "package") {
  return findSensitiveMatches(text, path, { mode }).map((finding) => finding.rule);
}

test("blocks common vendor token formats", () => {
  assert.ok(rules(`npm_${"A".repeat(36)}`).includes("npm-token"));
  assert.ok(rules(`ghp_${"A".repeat(36)}`).includes("github-token"));
  assert.ok(rules(`AKIA${"A".repeat(16)}`).includes("aws-access-key"));
  assert.ok(rules(`sk-${"A".repeat(24)}`).includes("openai-token"));
});

test("blocks private keys and JWTs", () => {
  const privateKey = ["-----BEGIN ", "PRIVATE KEY-----", "\nsecret"].join("");
  const jwt = ["eyJ", "A".repeat(12), ".", "B".repeat(12), ".", "C".repeat(12)].join("");
  assert.ok(rules(privateKey).includes("private-key"));
  assert.ok(rules(jwt).includes("jwt"));
});

test("blocks credential fields and auth headers", () => {
  assert.ok(rules(`api_key: ${"real-secret-value"}`).some((rule) => rule.startsWith("credential-field:")));
  assert.ok(rules(`access_token = \"${"real-secret-value"}\"`).some((rule) => rule.startsWith("credential-field:")));
  const headerValue = ["Author", "ization", ": Bearer ", "real-secret-value"].join("");
  const cookieValue = ["Cook", "ie", ": session=", "real-session-value"].join("");
  assert.ok(rules(headerValue).includes("authorization-or-cookie"));
  assert.ok(rules(cookieValue).includes("authorization-or-cookie"));
});

test("blocks quoted credential literals but allows unquoted environment references", () => {
  const quotedKey = ["api", "_key", ': "', "RealCredential12345", '"'].join("");
  const quotedHeader = ['"Author', 'ization": "Bearer ', "RealCredential12345", '"'].join("");
  const commentCredential = ["// sec", "ret: ", "RealCredential12345"].join("");
  const environmentReference = ["api", "_key: process.env.API_KEY"].join("");
  assert.ok(rules(quotedKey).includes("credential-field:api_key"));
  assert.ok(rules(quotedHeader).includes("authorization-or-cookie"));
  assert.ok(rules(commentCredential).includes("credential-field:secret"));
  assert.deepEqual(rules(environmentReference), []);
});

test("blocks credential URLs, sensitive paths, and local paths", () => {
  const slash = String.fromCharCode(47);
  const backslash = String.fromCharCode(92);
  const credentialUrl = ["https", "://user:", "password@example.test/api"].join("");
  const credentialQuery = ["https", "://example.test/api?", "access_", "token=", "real-secret"].join("");
  const unixPath = [slash, "Users", slash, "simon", slash, "project", slash, "index.js"].join("");
  const linuxPath = [slash, "home", slash, "simon", slash, "project", slash, "index.js"].join("");
  const windowsPath = ["C:", backslash, "Users", backslash, "simon", backslash, "project", backslash, "index.js"].join("");
  assert.ok(rules(credentialUrl).includes("credential-url"));
  assert.ok(rules(credentialQuery).includes("credential-query"));
  assert.ok(rules(unixPath).includes("local-absolute-path"));
  assert.ok(rules(linuxPath).includes("local-absolute-path"));
  assert.ok(rules(windowsPath).includes("local-absolute-path"));
  assert.ok(rules("placeholder", ".env.production").includes("sensitive-filename"));
  assert.ok(rules("placeholder", "dist/session-token.json").includes("sensitive-filename"));
  assert.ok(rules("placeholder", "dist/auth-cookie.txt").includes("sensitive-filename"));
});

test("allows anonymous system temporary paths", () => {
  assert.deepEqual(rules("output=/tmp/release-artifact.tgz"), []);
  assert.deepEqual(rules("cache=/var/tmp/forgeax-cache"), []);
});

test("allows safe examples and environment references", () => {
  assert.deepEqual(rules(["api", "_key: ${API_KEY}"].join("")), []);
  assert.deepEqual(rules(["access_", "token: YOUR_ACCESS_TOKEN"].join("")), []);
  assert.deepEqual(rules(["sec", "ret: REDACTED"].join("")), []);
  assert.deepEqual(rules("apiKey = process.env.API_KEY"), []);
  assert.deepEqual(rules("/api/v1/projects"), []);
});

test("allows empty, boolean, and computed credential fields in compiled code", () => {
  assert.deepEqual(rules(["Secret", 'Key: ""'].join("")), []);
  assert.deepEqual(rules(["pass", "word: !0"].join("")), []);
  assert.deepEqual(rules(["const secret", "Key = nonEmptyString(upload.tmp_secret_key);"].join("")), []);
  assert.deepEqual(rules(["const credential", "s = parseSts(response.body);"].join("")), []);
  assert.deepEqual(rules(["Secret", "Key: input.SecretKey || options.SecretKey || empty"].join("")), []);
  assert.deepEqual(rules("sessionToken: parts[2]"), []);
  assert.deepEqual(rules("this.credentials = credentials;"), []);
  assert.deepEqual(rules("const credentials = {"), []);
  assert.ok(rules('credentials = "literal-password"').includes("credential-field:credentials"));
});

test("blocks symbolic links before applying skipped directory names", () => {
  const fixture = mkdtempSync(join(tmpdir(), "forgeax-release-secret-symlink-"));
  const scanRoot = join(fixture, "scan-root");
  const skippedDirectory = join(scanRoot, ".git");
  const externalDirectory = join(fixture, "external-directory");
  try {
    mkdirSync(skippedDirectory, { recursive: true });
    mkdirSync(externalDirectory);
    writeFileSync(join(skippedDirectory, "secret.txt"), `npm_${"A".repeat(36)}`);
    writeFileSync(join(externalDirectory, "secret.txt"), `npm_${"B".repeat(36)}`);
    symlinkSync(externalDirectory, join(scanRoot, "node_modules"), "dir");

    assert.deepEqual(scanTree(scanRoot, { mode: "source" }), [
      { rule: "symbolic-link", path: "node_modules", line: 1 },
    ]);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("blocks inside-root, outside-root, and broken symbolic links without reading targets", () => {
  const fixture = mkdtempSync(join(tmpdir(), "forgeax-release-secret-symlink-"));
  const scanRoot = join(fixture, "scan-root");
  const insideDirectory = join(scanRoot, ".cache");
  const insideSecret = join(insideDirectory, "inside-secret.txt");
  const externalSecret = join(fixture, "external-secret.txt");
  try {
    mkdirSync(insideDirectory, { recursive: true });
    writeFileSync(insideSecret, `npm_${"A".repeat(36)}`);
    writeFileSync(externalSecret, `npm_${"B".repeat(36)}`);
    symlinkSync(join(fixture, "missing-secret.txt"), join(scanRoot, "broken-link.txt"), "file");
    symlinkSync(insideSecret, join(scanRoot, "inside-link.txt"), "file");
    symlinkSync(externalSecret, join(scanRoot, "outside-link.txt"), "file");

    const findings = scanTree(scanRoot, { mode: "source" }).sort((left, right) => left.path.localeCompare(right.path));
    assert.deepEqual(findings, [
      { rule: "symbolic-link", path: "broken-link.txt", line: 1 },
      { rule: "symbolic-link", path: "inside-link.txt", line: 1 },
      { rule: "symbolic-link", path: "outside-link.txt", line: 1 },
    ]);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("source mode skips generated directories while package mode scans every directory", () => {
  const fixture = mkdtempSync(join(tmpdir(), "forgeax-release-secret-modes-"));
  const scanRoot = join(fixture, "scan-root");
  const token = "npm_" + "A".repeat(36);
  try {
    for (const name of [".cache", ".npm", ".turbo", "coverage", "node_modules"]) {
      mkdirSync(join(scanRoot, name), { recursive: true });
      writeFileSync(join(scanRoot, name, "credential.txt"), token);
    }

    assert.deepEqual(scanTree(scanRoot, { mode: "source" }), []);
    assert.deepEqual(
      [...new Set(scanTree(scanRoot, { mode: "package" }).map((finding) => finding.path))].sort(),
      [
        ".cache/credential.txt",
        ".npm/credential.txt",
        ".turbo/credential.txt",
        "coverage/credential.txt",
        "node_modules/credential.txt",
      ],
    );
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("package mode checks sensitive binary filenames before skipping binary contents", () => {
  const fixture = mkdtempSync(join(tmpdir(), "forgeax-release-secret-binary-"));
  const scanRoot = join(fixture, "scan-root");
  try {
    mkdirSync(scanRoot);
    writeFileSync(join(scanRoot, "auth-cookie.bin"), Buffer.from([0, 1, 2, 3]));
    assert.deepEqual(scanTree(scanRoot, { mode: "package" }), [
      { rule: "sensitive-filename", path: "auth-cookie.bin", line: 1 },
    ]);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});
