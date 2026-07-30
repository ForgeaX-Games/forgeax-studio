import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_SCRIPT = path.join(HERE, "build-marketplace.mjs");
const CHECKED_IN_DATA = path.join(HERE, "marketplace.data.json");
const MARKETPLACE_FALLBACK =
  "https://github.com/ForgeaX-Games/forgeax-marketplace/tree/main/extensions";

function git(cwd, args, date) {
  execFileSync("git", args, {
    cwd,
    env: date
      ? {
          ...process.env,
          GIT_AUTHOR_DATE: `${date}T12:00:00Z`,
          GIT_COMMITTER_DATE: `${date}T12:00:00Z`,
        }
      : process.env,
    stdio: "ignore",
  });
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "marketplace-builder-"));
  const websiteDir = path.join(root, "scripts", "website");
  const marketplaceDir = path.join(root, "packages", "marketplace");
  const extensionsDir = path.join(marketplaceDir, "extensions");
  const standaloneDir = path.join(extensionsDir, "standalone");
  const bundledDir = path.join(extensionsDir, "bundled");
  await mkdir(websiteDir, { recursive: true });
  await copyFile(SOURCE_SCRIPT, path.join(websiteDir, "build-marketplace.mjs"));

  const manifest = (id, version) => ({
    schemaVersion: 1,
    id,
    version,
    kind: "workbench",
    displayName: { zh: id, en: id },
    description: { zh: "fixture", en: "fixture" },
    provides: {},
  });
  await Promise.all([
    writeJson(
      path.join(standaloneDir, "forgeax-extension.json"),
      manifest("@forgeax/standalone", "1.2.3"),
    ),
    writeJson(path.join(standaloneDir, "package.json"), {
      name: "@forgeax/standalone",
      version: "1.2.3",
      repository: {
        type: "git",
        url: "git+https://github.com/ForgeaX-Games/standalone.git",
      },
    }),
    writeJson(
      path.join(bundledDir, "forgeax-extension.json"),
      manifest("@forgeax-extension/bundled", "0.4.0"),
    ),
    writeJson(
      path.join(extensionsDir, "string-http", "forgeax-extension.json"),
      manifest("@forgeax/string-http", "1.0.0"),
    ),
    writeJson(path.join(extensionsDir, "string-http", "package.json"), {
      name: "@forgeax/string-http",
      version: "1.0.0",
      repository: "http://example.test/string-http.git",
    }),
    writeJson(
      path.join(extensionsDir, "object-https", "forgeax-extension.json"),
      manifest("@forgeax/object-https", "1.0.0"),
    ),
    writeJson(path.join(extensionsDir, "object-https", "package.json"), {
      name: "@forgeax/object-https",
      version: "1.0.0",
      repository: {
        type: "git",
        url: "https://example.test/object-https.git",
      },
    }),
    ...[
      ["javascript-repo", "javascript:alert(1)"],
      ["file-repo", "file:///tmp/private.git"],
      ["ssh-repo", "ssh://git@example.test/private.git"],
      ["garbage-repo", "not a URL"],
    ].flatMap(([dir, repository]) => [
      writeJson(
        path.join(extensionsDir, dir, "forgeax-extension.json"),
        manifest(`@forgeax/${dir}`, "1.0.0"),
      ),
      writeJson(path.join(extensionsDir, dir, "package.json"), {
        name: `@forgeax/${dir}`,
        version: "1.0.0",
        repository,
      }),
    ]),
  ]);

  git(marketplaceDir, ["init"]);
  git(marketplaceDir, ["config", "user.name", "Fixture"]);
  git(marketplaceDir, ["config", "user.email", "fixture@example.test"]);
  git(marketplaceDir, ["add", "."]);
  git(marketplaceDir, ["commit", "-m", "add extensions"], "2024-01-02");

  const standaloneManifest = path.join(
    standaloneDir,
    "forgeax-extension.json",
  );
  const updated = JSON.parse(await readFile(standaloneManifest, "utf8"));
  updated.description.en = "updated fixture";
  await writeJson(standaloneManifest, updated);
  git(marketplaceDir, ["add", "."]);
  git(marketplaceDir, ["commit", "-m", "update standalone"], "2024-03-04");

  return {
    cleanup: () => rm(root, { recursive: true, force: true }),
    dataFile: path.join(websiteDir, "marketplace.data.json"),
    script: path.join(websiteDir, "build-marketplace.mjs"),
  };
}

test("builds standalone and bundled repository URLs from their owning sources", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  execFileSync(process.execPath, [fixture.script], { stdio: "ignore" });
  const data = JSON.parse(await readFile(fixture.dataFile, "utf8"));

  assert.equal(
    data.standalone.repoUrl,
    "https://github.com/ForgeaX-Games/standalone",
  );
  assert.notEqual(
    data.standalone.repoUrl,
    `${MARKETPLACE_FALLBACK}/standalone`,
  );
  assert.doesNotMatch(data.standalone.repoUrl, /^(?:git\+)|\.git$/u);
  assert.equal(
    data["string-http"].repoUrl,
    "http://example.test/string-http",
  );
  assert.equal(
    data["object-https"].repoUrl,
    "https://example.test/object-https",
  );
  assert.equal(data.bundled.repoUrl, `${MARKETPLACE_FALLBACK}/bundled`);
  for (const dir of [
    "javascript-repo",
    "file-repo",
    "ssh-repo",
    "garbage-repo",
  ]) {
    assert.equal(data[dir].repoUrl, `${MARKETPLACE_FALLBACK}/${dir}`);
  }
});

test("derives creation and update dates from the real extensions directory", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  execFileSync(process.execPath, [fixture.script], { stdio: "ignore" });
  const data = JSON.parse(await readFile(fixture.dataFile, "utf8"));

  assert.equal(data.standalone.created, "2024-01-02");
  assert.equal(data.standalone.updated, "2024-03-04");
  assert.equal(data.bundled.created, "2024-01-02");
  assert.equal(data.bundled.updated, "2024-01-02");
});

test("canonical generation is deterministic and full-history output matches checked-in data", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "marketplace-canonical-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const firstFile = path.join(temp, "first.json");
  const secondFile = path.join(temp, "second.json");
  const original = await readFile(CHECKED_IN_DATA);
  t.after(() => writeFile(CHECKED_IN_DATA, original));

  const run = (output) =>
    execFileSync(process.execPath, [SOURCE_SCRIPT], {
      env: { ...process.env, MARKETPLACE_DATA_OUT: output },
      stdio: "ignore",
    });
  run(firstFile);
  assert.equal(
    existsSync(firstFile),
    true,
    "builder must honor MARKETPLACE_DATA_OUT instead of rewriting canonical data",
  );
  run(secondFile);

  const first = await readFile(firstFile);
  const second = await readFile(secondFile);
  assert.equal(
    Buffer.compare(second, first),
    0,
    "two canonical generations must be byte-identical",
  );
  const hasFullHistory =
    execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: path.join(HERE, "..", ".."),
      encoding: "utf8",
    }).trim() !== "true";
  if (hasFullHistory) {
    assert.equal(
      Buffer.compare(first, original),
      0,
      "full-history generated data must be byte-identical to the checked-in file",
    );
  }

  const wbGameVideo = JSON.parse(first.toString("utf8"))["wb-game-video"];
  assert.deepEqual(
    {
      version: wbGameVideo.version,
      repoUrl: wbGameVideo.repoUrl,
      ...(hasFullHistory
        ? { created: wbGameVideo.created, updated: wbGameVideo.updated }
        : {}),
    },
    {
      version: "0.1.5",
      repoUrl: "https://github.com/ForgeaX-Games/forgeax-wb-game-video",
      ...(hasFullHistory
        ? { created: "2026-07-14", updated: "2026-07-30" }
        : {}),
    },
  );
});
