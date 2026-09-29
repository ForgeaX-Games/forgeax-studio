#!/usr/bin/env node

// src/main.ts
import { resolve as resolve14 } from "node:path";

// src/mcp/protocol.ts
var MCP_PROTOCOL_VERSION = "2024-11-05";
var METHOD_NOT_FOUND = -32601;
var INTERNAL_ERROR = -32603;
function textResult(text, isError = false) {
  return { ...isError ? { isError: true } : {}, content: [{ type: "text", text }] };
}
function toToolResult(out) {
  if (out === undefined)
    return textResult("");
  if (typeof out === "string")
    return textResult(out);
  if (Array.isArray(out))
    return { content: out };
  return textResult(JSON.stringify(out));
}
function notFound(name, available) {
  const hint = available.length ? `Available tools: ${available.join(", ")}.` : "This server exposes no tools right now.";
  return {
    isError: true,
    content: [{ type: "text", text: `not_found: tool ${JSON.stringify(name)} is not exposed. ${hint}` }],
    structuredContent: { code: "not_found", tool: name, availableTools: available }
  };
}
async function dispatch(spec, msg) {
  const { id, method, params } = msg;
  if (id == null)
    return null;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: spec.serverInfo,
        ...spec.instructions ? { instructions: spec.instructions } : {}
      }
    };
  }
  if (method?.startsWith("notifications/"))
    return null;
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: spec.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      }
    };
  }
  if (method === "resources/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        resources: spec.resources.map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType
        }))
      }
    };
  }
  if (method === "resources/read") {
    const uri = typeof params?.uri === "string" ? params.uri : "";
    const resource = spec.resources.find((r) => r.uri === uri);
    if (!resource) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: INTERNAL_ERROR, message: `unknown resource: ${uri}` }
      };
    }
    try {
      const ctx = await spec.buildContext();
      const text = await resource.read(ctx);
      return {
        jsonrpc: "2.0",
        id,
        result: { contents: [{ uri, mimeType: resource.mimeType, text }] }
      };
    } catch (e) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: INTERNAL_ERROR, message: `resource read failed: ${errorMessage(e)}` }
      };
    }
  }
  if (method === "tools/call") {
    const name = typeof params?.name === "string" ? params.name : "";
    const args = params?.arguments ?? {};
    const tool = spec.tools.find((t) => t.name === name);
    if (!tool) {
      return { jsonrpc: "2.0", id, result: notFound(name, spec.tools.map((t) => t.name)) };
    }
    try {
      const ctx = await spec.buildContext();
      const out = await tool.run(args, ctx);
      return { jsonrpc: "2.0", id, result: toToolResult(out) };
    } catch (e) {
      return { jsonrpc: "2.0", id, result: textResult(`error: ${errorMessage(e)}`, true) };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` } };
}
function errorMessage(e) {
  return e instanceof Error ? e.message : String(e);
}

// src/mcp/crash-log.ts
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
var DEFAULT_MAX_BYTES = 1024 * 1024;
var DEFAULT_MAX_ENTRY_BYTES = 16 * 1024;
function numFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw)
    return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function crashLogPath() {
  return process.env.FORGEAX_GAME_CRASH_LOG || join(homedir(), ".forgeax", "game-mcp-crash.log");
}
function writeCrashLog(scope, err) {
  try {
    const path = crashLogPath();
    mkdirSync(dirname(path), { recursive: true });
    const maxBytes = numFromEnv("FORGEAX_GAME_CRASH_LOG_MAX_BYTES", DEFAULT_MAX_BYTES);
    const maxEntry = numFromEnv("FORGEAX_GAME_CRASH_LOG_MAX_ENTRY_BYTES", DEFAULT_MAX_ENTRY_BYTES);
    try {
      if (statSync(path).size >= maxBytes)
        renameSync(path, `${path}.1`);
    } catch {}
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    const entry = `${new Date().toISOString()} [${scope}] ${detail}
`;
    appendFileSync(path, entry.length > maxEntry ? `${entry.slice(0, maxEntry)}…(truncated)
` : entry);
  } catch {}
}

// src/mcp/stdio.ts
var CLIENT_GONE_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ECONNRESET"]);
function isClientGone(e) {
  const code = e?.code;
  return code !== undefined && CLIENT_GONE_CODES.has(code);
}
function runStdioServer(spec) {
  let buffer = "";
  let shuttingDown = false;
  let inputClosed = false;
  let inFlight = 0;
  const shutdown = () => {
    if (shuttingDown)
      return;
    shuttingDown = true;
    process.stdin.pause();
    Promise.resolve(spec.shutdown?.()).catch((error) => writeCrashLog("shutdown", error)).finally(() => {
      process.exitCode = 0;
    });
  };
  const finishAfterDrain = () => {
    if (inputClosed && inFlight === 0)
      shutdown();
  };
  const send = (payload) => new Promise((resolve) => {
    try {
      process.stdout.write(`${JSON.stringify(payload)}
`, (error) => {
        if (error) {
          if (isClientGone(error))
            shutdown();
          else
            writeCrashLog("stdout-write", error);
        }
        resolve();
      });
    } catch (e) {
      if (isClientGone(e))
        shutdown();
      else
        writeCrashLog("stdout-write", e);
      resolve();
    }
  });
  process.stdout.on("error", (e) => {
    if (isClientGone(e))
      shutdown();
    else
      writeCrashLog("stdout", e);
  });
  process.stderr.on("error", () => {});
  const handle = (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    inFlight++;
    dispatch(spec, msg).then(async (res) => {
      if (res)
        await send(res);
    }).catch(async (e) => {
      writeCrashLog("dispatch", e);
      if (msg.id != null) {
        await send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: errorMessage(e) } });
      }
    }).finally(() => {
      inFlight--;
      finishAfterDrain();
    });
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf(`
`)) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim())
        handle(line);
    }
  });
  const onInputClosed = () => {
    inputClosed = true;
    finishAfterDrain();
  };
  process.stdin.on("end", onInputClosed);
  process.stdin.on("close", onInputClosed);
  process.on("uncaughtException", (e) => {
    if (isClientGone(e))
      shutdown();
    else
      writeCrashLog("uncaughtException", e);
  });
  process.on("unhandledRejection", (e) => writeCrashLog("unhandledRejection", e));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

// src/mcp/forgeax-server.ts
import { readFileSync as readFileSync10 } from "node:fs";
import { resolve as resolve8 } from "node:path";

// src/status/collect.ts
import { readFileSync as readFileSync6 } from "node:fs";
import { join as join5 } from "node:path";

// src/agents-md/managed-block.ts
import { createHash } from "node:crypto";
var BLOCK_VERSION = 1;
var BEGIN = "<!-- BEGIN FORGEAX GAME PLUGIN";
var END = "<!-- END FORGEAX GAME PLUGIN -->";
var BLOCK_RE = /<!-- BEGIN FORGEAX GAME PLUGIN \(v(\d+) sha256:([0-9a-f]{12})\) -->\n([\s\S]*?)\n<!-- END FORGEAX GAME PLUGIN -->/;
function bodyHash(body) {
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}
function renderBlock(body) {
  const trimmed = body.trim();
  return `${BEGIN} (v${BLOCK_VERSION} sha256:${bodyHash(trimmed)}) -->
${trimmed}
${END}`;
}
function inspectBlock(fileContent, expectedBody) {
  if (fileContent === undefined)
    return { status: "missing_file", expectedVersion: BLOCK_VERSION };
  const m = BLOCK_RE.exec(fileContent);
  if (!m)
    return { status: "missing_block", expectedVersion: BLOCK_VERSION };
  const foundVersion = Number.parseInt(m[1], 10);
  const foundHash = m[2];
  const foundBody = m[3];
  const expectedHash = bodyHash(expectedBody.trim());
  const current = foundVersion === BLOCK_VERSION && foundHash === expectedHash && foundHash === bodyHash(foundBody.trim());
  return {
    status: current ? "current" : "outdated",
    foundVersion,
    expectedVersion: BLOCK_VERSION
  };
}
function upsertBlock(fileContent, body) {
  const block = renderBlock(body);
  if (fileContent === undefined || fileContent.trim() === "")
    return `${block}
`;
  if (BLOCK_RE.test(fileContent))
    return fileContent.replace(BLOCK_RE, block);
  return `${fileContent.replace(/\s*$/, "")}

${block}
`;
}
function removeBlock(fileContent) {
  return fileContent.replace(BLOCK_RE, "").replace(/\n{3,}/g, `

`).replace(/\s*$/, `
`);
}

// src/devkit/install.ts
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync2,
  readdirSync,
  realpathSync as realpathSync2,
  rmSync,
  statSync as statSync2,
  writeFileSync
} from "node:fs";
import { dirname as dirname3, join as join3, relative, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/project/locate.ts
import { readFileSync, realpathSync } from "node:fs";
import { dirname as dirname2, join as join2, resolve } from "node:path";
var SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
var GUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function isProjectRoot(dir) {
  return engineGameId(dir) !== undefined;
}
function engineGameId(root) {
  try {
    const manifest = JSON.parse(readFileSync(join2(root, "forge.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join2(root, "package.json"), "utf8"));
    return typeof manifest.id === "string" && SLUG_RE.test(manifest.id) && (manifest.schemaVersion === "3.0.0" ? manifest.roots !== null && typeof manifest.roots === "object" && !Array.isArray(manifest.roots) && Object.entries(manifest.roots).every(([realm, guid]) => ["host", "frontend", "engine", "build"].includes(realm) && typeof guid === "string" && GUID_RE.test(guid)) : manifest.schemaVersion === "2.0.0" ? typeof manifest.defaultScene === "string" && GUID_RE.test(manifest.defaultScene) : (manifest.schemaVersion === undefined || manifest.schemaVersion === "1.0.0") && typeof manifest.entry === "string") && typeof pkg.dependencies?.["@forgeax/engine"] === "string" ? manifest.id : undefined;
  } catch {
    return;
  }
}
function findInstanceRoot(start) {
  let dir = resolve(start);
  for (;; ) {
    if (isProjectRoot(dir))
      return dir;
    const parent = dirname2(dir);
    if (parent === dir)
      return;
    dir = parent;
  }
}
function resolveProject(explicitDir) {
  if (explicitDir?.trim()) {
    const from = resolve(explicitDir.trim());
    const root2 = findInstanceRoot(from);
    return root2 ? { root: root2, source: "explicit", searchedFrom: from } : { source: "none", searchedFrom: from };
  }
  const envRoot = process.env.FORGEAX_PROJECT_ROOT?.trim();
  if (envRoot) {
    const from = resolve(envRoot);
    if (isProjectRoot(from))
      return { root: from, source: "env", searchedFrom: from };
  }
  const cwd = process.cwd();
  const root = findInstanceRoot(cwd);
  return root ? { root, source: "cwd-walkup", searchedFrom: cwd } : { source: "none", searchedFrom: cwd };
}
function activeGame(root) {
  return engineGameId(root);
}
function listGames(root) {
  const direct = engineGameId(root);
  return direct ? [direct] : [];
}
function gameDir(root, slug) {
  if (!SLUG_RE.test(slug))
    return;
  return engineGameId(root) === slug ? realpathSync(root) : undefined;
}

// src/routing.ts
var ROUTING_TEXT = `## ForgeaX game development

This project is a ForgeaX game workspace. Route game work through the \`forgeax\` MCP
server rather than reconstructing it from shell commands. The current host Agent owns
reasoning and game-code edits; the plugin owns the exact Engine Preview adapter.

- Game implementation and failure recovery: follow the \`forgeax-game\` project skill.
  The published plugin carries the Skill and host rules; install or refresh it with
  \`forgeax-game devkit install\`. A local \`forgeax-install\` checkout is optional.

- Starting or resuming work, or unsure what is running: read the \`forgeax://status\`
  resource first. Clients without resource support call \`forgeax_status_lite\`.
  Status is read-only and never writes to the workspace.
- Running, previewing, or verifying the game ("run it", "let me see it", "does it
  work"): call \`forgeax_run_current_game\`. It invokes the exact installed Engine
  CLI build, starts or reuses Engine-owned Preview, and reports its verified
  release/build/instance identity.
- Reading build or Preview errors: read the returned \`preview.stdout_log\` and
  \`preview.stderr_log\` paths with your own file-reading tool. Log tailing is
  deliberately not an MCP tool — the log is a file, so read it like one.
- Generating art or 3D assets ("make a sprite", "I need a texture", "generate a
  model of…"): call \`forgeax_generate_image\` (text-to-image, or image-to-image
  with a local \`image\`) or \`forgeax_generate_3d\` (text-to-3D via \`prompt\`,
  image-to-3D via \`image\`). Both save into the active game's \`assets/\` directory
  and return the project-relative path to reference from code. Image-to-3D accepts a
  public https URL, or a local file path when COS is configured (it is uploaded and
  passed as a short-lived presigned URL). They need \`FORGEAX_LITELLM_API_KEY\` (and
  \`FORGEAX_COS_*\` for local-file image-to-3D) in the environment.
- Reusing a library 3D asset: read the installed \`art-3d-asset-library\` Skill
  and use its pinned CLI to search candidates and import the selected ID.
  If not enabled, report the missing setup. Do not relabel procedural geometry
  or generated models as library results.
- Creating a game, switching the active game, installing or upgrading the plugin:
  these are one-time operations and are CLI subcommands, not MCP tools. Run
  \`npx -y @forgeax/game <init|use|doctor|devkit|upgrade>\`.

In an empty standalone directory, \`forgeax-game init\` creates the released Engine
game and installs this guidance. In an existing exact Engine game it refreshes the
binding idempotently. Follow \`forge.json\` and the installed Engine authoring layout
(v2 uses \`assets/\` and \`plugins[]\`), rather than prescribing \`src/\`. Studio's
\`.forgeax/games/<slug>\` layout is a different hosted-project boundary and must not be
invented here. Before claiming a requested game complete, replace the Empty template
identity in \`forge.json\`, \`package.json\`, and README, keep tests/controls accurate,
and call \`forgeax_run_current_game\`. Mount UI under the Engine Host \`uiRoot\` or
\`#game-ui\`; the released Host provides \`#game-ui\`, so direct \`document.body\`
mutation is rejected. Export and behavior-test at least one named game-specific state
transition or rule; renaming the Empty template test is not completion.
Any run-tool error means the game is not previewed: never curl, reuse, open, or report
an existing localhost port. HTTP 200 is not ownership evidence. Only a successful tool
result containing \`preview.status: ready\`, root, build digest, instance ID, and its own
\`preview_url\` authorizes a Preview claim, not a gameplay-verification claim.
For playable-game requests, check the requested interactions and visible feedback
with an available browser tool. If unavailable, report gameplay as unverified and
provide manual checks; do not stop useful implementation or invent test results.
Use the installed Engine contract for Host access and UI lifecycle, and verify
requested UI is mounted rather than silently skipping it when a Host lookup fails.
Never substitute Studio, Editor, PATH, or a source checkout for the installed Engine
release.`;

// src/devkit/install.ts
var PLUGIN_SKILL_ID = "forgeax-game";
var ENGINE_SKILL_PREFIX = "forgeax-engine-";
var DEVKIT_VERSION = 2;
var HOST_MOUNTS = {
  codex: { skills: ".agents/skills", rules: ".agents/rules" },
  claude: { skills: ".claude/skills", rules: ".claude/rules" },
  cursor: { skills: ".cursor/skills", rules: ".cursor/rules" },
  trae: { skills: ".trae/skills", rules: ".trae/rules" },
  codebuddy: { skills: ".codebuddy/skills", rules: ".codebuddy/rules" },
  workbuddy: { skills: ".codebuddy/skills", rules: ".codebuddy/rules" },
  windsurf: { skills: ".codeium/windsurf/skills", rules: ".codeium/windsurf/rules" },
  vscode: { skills: ".vscode/skills", rules: ".vscode/rules" },
  zcode: { skills: ".zcode/skills" },
  opencode: { skills: ".config/opencode/skills", rules: ".config/opencode/rules" }
};
function skillRoots(projectRoot) {
  const here = dirname3(fileURLToPath(import.meta.url));
  const isPluginSkill = (id) => id === PLUGIN_SKILL_ID;
  const anySkill = () => true;
  return [
    { path: resolve2(here, "..", "assets", "skills"), accepts: anySkill },
    { path: resolve2(here, "..", "..", "assets", "skills"), accepts: anySkill },
    ...projectRoot && activeGame(projectRoot) && gameDir(projectRoot, activeGame(projectRoot)) ? [{
      path: resolve2(gameDir(projectRoot, activeGame(projectRoot)), "skills"),
      accepts: isEngineSkill
    }] : [],
    { path: resolve2(here, "..", "..", "skills"), accepts: isPluginSkill }
  ];
}
function bundledSkills(projectRoot) {
  const found = new Map;
  for (const root of skillRoots(projectRoot)) {
    if (!existsSync(root.path))
      continue;
    for (const entry of readdirSync(root.path, { withFileTypes: true })) {
      if (!entry.isDirectory() || found.has(entry.name) || !root.accepts(entry.name))
        continue;
      const path = join3(root.path, entry.name);
      if (existsSync(join3(path, "SKILL.md")))
        found.set(entry.name, path);
    }
  }
  if (!found.has(PLUGIN_SKILL_ID)) {
    throw new Error("the packaged ForgeaX game skill is missing; rebuild or reinstall @forgeax/game");
  }
  return [...found].map(([id, path]) => ({ id, path })).sort((left, right) => left.id.localeCompare(right.id));
}
function isEngineSkill(id) {
  return id.startsWith(ENGINE_SKILL_PREFIX);
}
function describeSkills(ids) {
  const engine = ids.filter(isEngineSkill).length;
  return `${ids.length} skills (${engine} Engine authoring)`;
}
function filesUnder(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join3(current, entry.name);
    return entry.isDirectory() ? filesUnder(root, path) : [relative(root, path)];
  });
}
function sameFile(left, right) {
  return existsSync(right) && readFileSync2(left).equals(readFileSync2(right));
}
function copySkill(source, destination) {
  const destinationIsSymlink = existsSync(destination) && lstatSync(destination).isSymbolicLink();
  const linksToSource = destinationIsSymlink && realpathSync2(source) === realpathSync2(destination);
  if (!destinationIsSymlink && existsSync(destination) && realpathSync2(source) === realpathSync2(destination))
    return false;
  const files = filesUnder(source);
  const changed = destinationIsSymlink || files.some((path) => !sameFile(join3(source, path), join3(destination, path)));
  if (!changed)
    return false;
  if (existsSync(destination)) {
    if (!linksToSource) {
      const backup = `${destination}.bak.latest`;
      rmSync(backup, { recursive: true, force: true });
      cpSync(destination, backup, { recursive: true });
    }
    rmSync(destination, { recursive: true, force: true });
  }
  for (const path of files) {
    const target = join3(destination, path);
    mkdirSync2(dirname3(target), { recursive: true });
    copyFileSync(join3(source, path), target);
  }
  return true;
}
function writeTextIfChanged(path, content) {
  const destinationIsSymlink = existsSync(path) && lstatSync(path).isSymbolicLink();
  if (!destinationIsSymlink && existsSync(path) && readFileSync2(path, "utf8") === content)
    return false;
  if (existsSync(path)) {
    const backup = `${path}.bak.latest`;
    rmSync(backup, { force: true });
    copyFileSync(path, backup);
    if (destinationIsSymlink)
      rmSync(path, { force: true });
  }
  mkdirSync2(dirname3(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return true;
}
function selectedHostIds(clients) {
  return [...new Set(clients.map((id) => id === "workbuddy" ? "codebuddy" : id))].filter((id) => HOST_MOUNTS[id]);
}
function hostSkillDirs(projectRoot) {
  return [...new Set(Object.values(HOST_MOUNTS).map((mount) => mount.skills))].map((mount) => join3(projectRoot, mount));
}
function installHostDevKit(projectRoot, clients, skills = bundledSkills()) {
  const skillPaths = [];
  const rulePaths = [];
  let changed = false;
  for (const id of selectedHostIds(clients)) {
    const mount = HOST_MOUNTS[id];
    const skillsDir = join3(projectRoot, mount.skills);
    for (const skill of skills) {
      changed = copySkill(skill.path, join3(skillsDir, skill.id)) || changed;
    }
    skillPaths.push(skillsDir);
    if (mount.rules) {
      const rulePath = join3(projectRoot, mount.rules, `${PLUGIN_SKILL_ID}.md`);
      changed = writeTextIfChanged(rulePath, ROUTING_TEXT) || changed;
      rulePaths.push(rulePath);
    }
  }
  const skillIds = skills.map((skill) => skill.id);
  const noun = skillPaths.length === 1 ? "host" : "hosts";
  return {
    changed,
    skillPaths,
    rulePaths,
    skillIds: skillPaths.length ? skillIds : [],
    note: skillPaths.length ? `${describeSkills(skillIds)} installed for ${skillPaths.length} ${noun}.` : "No host was selected, so no skills were installed. Run `forgeax-game install --ide <hosts>`."
  };
}
function replayForgeaxInstall(projectRoot) {
  const manifestPath = join3(projectRoot, ".forgeax-harness", "install-manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      mounted: false,
      note: "Package-owned host mounts are active; forgeax-install is optional compatibility for additional harness capabilities."
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync2(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest.harnessRoot || !manifest.specPath) {
    throw new Error(`${manifestPath} does not record harnessRoot and specPath`);
  }
  if (manifest.targetRoot && resolve2(manifest.targetRoot) !== resolve2(projectRoot)) {
    throw new Error(`${manifestPath} belongs to ${manifest.targetRoot}, not ${projectRoot}`);
  }
  const installer = join3(manifest.harnessRoot, "skills", "forgeax-install", "scripts", "install_harness.py");
  if (!existsSync(installer) || !existsSync(manifest.specPath)) {
    return {
      mounted: false,
      note: "Package-owned host mounts are active; the recorded forgeax-install checkout is unavailable (optional)."
    };
  }
  const python = manifest.pythonInterpreter && existsSync(manifest.pythonInterpreter) ? manifest.pythonInterpreter : "python3";
  const result = spawnSync(python, [installer, "--spec", manifest.specPath, "--target-root", projectRoot], { cwd: manifest.harnessRoot, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`forgeax-install could not mount ${PLUGIN_SKILL_ID}: ${detail}`);
  }
  return { mounted: true, note: "Mounted by forgeax-install into all configured agent hosts." };
}
function installDevKit(projectRoot, clients) {
  const skills = bundledSkills(projectRoot);
  const hosts = installHostDevKit(projectRoot, clients, skills);
  const mounted = replayForgeaxInstall(projectRoot);
  return {
    skillsRoot: hosts.skillPaths[0] ?? projectRoot,
    skillIds: hosts.skillIds,
    rulePath: hosts.rulePaths[0] ?? "",
    changed: hosts.changed,
    hostPaths: hosts.skillPaths,
    ...mounted,
    note: `${hosts.note} ${mounted.note}`
  };
}
function hasDevKit(projectRoot) {
  return hostSkillDirs(projectRoot).some((dir) => {
    const skillPath = join3(dir, PLUGIN_SKILL_ID, "SKILL.md");
    return existsSync(skillPath) && statSync2(skillPath).isFile();
  });
}
function installedEngineSkills(projectRoot) {
  const found = new Set;
  for (const dir of hostSkillDirs(projectRoot)) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isEngineSkill(entry.name))
        continue;
      if (existsSync(join3(dir, entry.name, "SKILL.md")))
        found.add(entry.name);
    }
  }
  return [...found].sort();
}
function removeDevKit(projectRoot) {
  const owned = new Set(bundledSkills(projectRoot).map((skill) => skill.id));
  const removed = [];
  let skillCount = 0;
  for (const mount of new Set(Object.values(HOST_MOUNTS).map((entry) => entry.skills))) {
    const dir = join3(projectRoot, mount);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const bare = entry.name.replace(/\.bak\.latest$/, "");
      if (!owned.has(bare) && !isEngineSkill(bare))
        continue;
      rmSync(join3(dir, entry.name), { recursive: true, force: true });
      if (!entry.name.endsWith(".bak.latest"))
        skillCount += 1;
    }
    removed.push(dir);
  }
  const ruleMounts = Object.values(HOST_MOUNTS).flatMap((entry) => entry.rules ? [entry.rules] : []);
  for (const mount of new Set(ruleMounts)) {
    for (const suffix of [".md", ".md.bak.latest"]) {
      rmSync(join3(projectRoot, mount, `${PLUGIN_SKILL_ID}${suffix}`), { force: true });
    }
  }
  for (const legacy of ["skills", "rules"]) {
    const dir = join3(projectRoot, legacy);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const bare = entry.name.replace(/\.bak\.latest$/, "").replace(/\.md$/, "");
      if (!owned.has(bare) && !isEngineSkill(bare))
        continue;
      rmSync(join3(dir, entry.name), { recursive: true, force: true });
    }
    try {
      if (readdirSync(dir).length === 0)
        rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  return { removed, skillCount };
}
function bundledEngineSkillCount(projectRoot) {
  try {
    return bundledSkills(projectRoot).filter((skill) => isEngineSkill(skill.id)).length;
  } catch {
    return 0;
  }
}

// src/engine/release.ts
import { existsSync as existsSync3, lstatSync as lstatSync3, readFileSync as readFileSync4, realpathSync as realpathSync4 } from "node:fs";
import { isAbsolute as isAbsolute2, relative as relative3, resolve as resolve4, sep as sep2 } from "node:path";

// src/engine/constants.ts
var ENGINE_VERSION = "0.3.3";
var ENGINE_COMMIT = "4ad48ef03d8f8f1bb74f5bf7cde71c4799d51060";
var ENGINE_SDK_PACKAGE = "@forgeax/engine-sdk";
var PNPM_VERSION = "11.7.0";

// src/engine/carrier.ts
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync as existsSync2,
  lstatSync as lstatSync2,
  mkdtempSync,
  readFileSync as readFileSync3,
  readdirSync as readdirSync2,
  realpathSync as realpathSync3,
  rmSync as rmSync2,
  writeFileSync as writeFileSync2
} from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname as dirname4, isAbsolute, relative as relative2, resolve as resolve3, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var SDK_MANIFEST_SCHEMA = "1.8.0";
var SDK_CLI_RELATIVE = ["bin", "forgeax.mjs"];
var CARRIER_ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "npm_config_registry",
  "NPM_CONFIG_REGISTRY",
  "npm_config_userconfig",
  "NPM_CONFIG_USERCONFIG",
  "npm_config_globalconfig",
  "NPM_CONFIG_GLOBALCONFIG",
  "npm_config_cafile",
  "NPM_CONFIG_CAFILE",
  "npm_config_ca",
  "NPM_CONFIG_CA",
  "npm_config_cert",
  "NPM_CONFIG_CERT",
  "npm_config_key",
  "NPM_CONFIG_KEY",
  "npm_config_strict_ssl",
  "NPM_CONFIG_STRICT_SSL",
  "npm_config_proxy",
  "NPM_CONFIG_PROXY",
  "npm_config_https_proxy",
  "NPM_CONFIG_HTTPS_PROXY",
  "npm_config_http_proxy",
  "NPM_CONFIG_HTTP_PROXY",
  "npm_config_noproxy",
  "NPM_CONFIG_NOPROXY",
  "npm_config_offline",
  "NPM_CONFIG_OFFLINE",
  "npm_config_prefer_offline",
  "NPM_CONFIG_PREFER_OFFLINE",
  "npm_config_cache",
  "NPM_CONFIG_CACHE",
  "npm_config_store_dir",
  "NPM_CONFIG_STORE_DIR"
];
var CARRIER_ENVIRONMENT_EXCLUDE = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "FORGEAX_SDK_ROOT",
  "npm_execpath",
  "NPM_EXEC_PATH",
  "npm_node_execpath",
  "NPM_NODE_EXEC_PATH",
  "npm_config_execpath",
  "NPM_CONFIG_EXECPATH",
  "npm_config_node_execpath",
  "NPM_CONFIG_NODE_EXECPATH",
  "npm_config_node_options",
  "NPM_CONFIG_NODE_OPTIONS",
  "npm_config_script_shell",
  "NPM_CONFIG_SCRIPT_SHELL",
  "npm_config_shell",
  "NPM_CONFIG_SHELL",
  "npm_config_prefix",
  "NPM_CONFIG_PREFIX",
  "PNPM_HOME",
  "pnpm_home",
  "COREPACK_HOME",
  "COREPACK_BIN_PATH"
];
function packageJson(path) {
  try {
    const value = JSON.parse(readFileSync3(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("not-an-object");
    return value;
  } catch (error) {
    throw new Error(`engine_sdk_manifest_invalid: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function confined(root, candidate) {
  const rel = relative2(root, candidate);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function canonicalRegularFile(path, code, root) {
  if (!existsSync2(path) || !lstatSync2(path).isFile())
    throw new Error(`${code}: ${path}`);
  const canonical = realpathSync3(path);
  if (!confined(root, canonical))
    throw new Error(`${code}_escape: ${canonical}`);
  return canonical;
}
function pluginRootFromModule() {
  let cursor = resolve3(dirname4(fileURLToPath2(import.meta.url)));
  for (;; ) {
    const manifestPath = resolve3(cursor, "package.json");
    try {
      if (packageJson(manifestPath).name === "@forgeax/game")
        return realpathSync3(cursor);
    } catch {}
    const parent = dirname4(cursor);
    if (parent === cursor)
      throw new Error("engine_sdk_plugin_missing: cannot locate @forgeax/game package root");
    cursor = parent;
  }
}
function manifestFromEntry(entry, name) {
  let cursor = resolve3(dirname4(entry));
  for (;; ) {
    const manifestPath = resolve3(cursor, "package.json");
    try {
      if (packageJson(manifestPath).name === name)
        return realpathSync3(manifestPath);
    } catch {}
    const parent = dirname4(cursor);
    if (parent === cursor)
      throw new Error(`engine_sdk_dependency_invalid: ${name} package.json was not found`);
    cursor = parent;
  }
}
function installationRoot(pluginRoot) {
  let cursor = pluginRoot;
  let found;
  for (;; ) {
    if (basename(cursor) === "node_modules")
      found = cursor;
    const parent = dirname4(cursor);
    if (parent === cursor)
      break;
    cursor = parent;
  }
  if (found === undefined) {
    throw new Error(`engine_sdk_install_root_missing: ${pluginRoot} is not inside a node_modules installation`);
  }
  return realpathSync3(found);
}
function resolveDependency(pluginRoot, installRoot, name, missingCode) {
  const packageRequire = createRequire(resolve3(pluginRoot, "package.json"));
  let manifestPath;
  try {
    try {
      manifestPath = packageRequire.resolve(`${name}/package.json`, { paths: [pluginRoot] });
    } catch {
      manifestPath = manifestFromEntry(packageRequire.resolve(name, { paths: [pluginRoot] }), name);
    }
  } catch (error) {
    throw new Error(`${missingCode}: ${name} is not installed in the Game Plugin dependency graph${error instanceof Error ? ` (${error.message})` : ""}`);
  }
  const canonicalManifest = realpathSync3(manifestPath);
  const root = realpathSync3(dirname4(canonicalManifest));
  if (!confined(installRoot, pluginRoot) || !confined(installRoot, root)) {
    throw new Error(`engine_sdk_dependency_escape: ${name} resolves outside the Game Plugin installation root`);
  }
  return { root, manifest: packageJson(canonicalManifest) };
}
function sdkManifest(path) {
  const value = packageJson(path);
  const packageEntries = Array.isArray(value.packages) ? value.packages : [];
  const requiredPackages = new Map;
  const packageNames = new Set;
  let packagesValid = Array.isArray(value.packages);
  for (const entry of packageEntries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      packagesValid = false;
      continue;
    }
    const name = entry.name;
    const version = entry.version;
    if (typeof name !== "string" || typeof version !== "string" || packageNames.has(name)) {
      packagesValid = false;
    } else {
      packageNames.add(name);
      requiredPackages.set(name, version);
    }
  }
  if (!packagesValid || value.schemaVersion !== SDK_MANIFEST_SCHEMA || value.sdkVersion !== ENGINE_VERSION || value.engineCommit !== ENGINE_COMMIT || value.requirements?.pnpm !== PNPM_VERSION || requiredPackages.get("@forgeax/engine") !== ENGINE_VERSION || requiredPackages.get("@forgeax/engine-devkit") !== ENGINE_VERSION) {
    throw new Error("engine_sdk_manifest_mismatch: carrier does not identify the approved Engine/DevKit/pnpm set");
  }
  return value;
}
function packageBin(manifest, name) {
  if (typeof manifest.bin === "string")
    return manifest.bin;
  if (manifest.bin !== null && typeof manifest.bin === "object") {
    const value = manifest.bin[name];
    if (typeof value === "string" && value.length > 0)
      return value;
  }
  throw new Error(`engine_sdk_cli_invalid: ${name} package does not declare a ${name} binary`);
}
function resolveGamePluginCarrier(options = {}) {
  const configuredRoot = resolve3(options.pluginRoot ?? pluginRootFromModule());
  let pluginRoot;
  try {
    pluginRoot = realpathSync3(configuredRoot);
  } catch (error) {
    throw new Error(`engine_sdk_plugin_missing: cannot read Game Plugin root ${configuredRoot}${error instanceof Error ? ` (${error.message})` : ""}`);
  }
  const plugin = packageJson(resolve3(pluginRoot, "package.json"));
  const installRoot = installationRoot(pluginRoot);
  if (!confined(installRoot, pluginRoot)) {
    throw new Error(`engine_sdk_plugin_escape: ${pluginRoot} is outside its installation root`);
  }
  if (plugin.name !== "@forgeax/game")
    throw new Error(`engine_sdk_plugin_invalid: ${pluginRoot}`);
  if (plugin.dependencies?.[ENGINE_SDK_PACKAGE] !== ENGINE_VERSION) {
    throw new Error(`engine_sdk_dependency_mismatch: ${ENGINE_SDK_PACKAGE} must be ${ENGINE_VERSION}`);
  }
  if (plugin.dependencies?.pnpm !== PNPM_VERSION) {
    throw new Error(`pnpm_dependency_mismatch: pnpm must be ${PNPM_VERSION}`);
  }
  const carrier = resolveDependency(pluginRoot, installRoot, ENGINE_SDK_PACKAGE, "engine_sdk_carrier_missing");
  if (carrier.manifest.name !== ENGINE_SDK_PACKAGE || carrier.manifest.version !== ENGINE_VERSION) {
    throw new Error(`engine_sdk_carrier_mismatch: installed SDK carrier must be ${ENGINE_SDK_PACKAGE}@${ENGINE_VERSION}`);
  }
  const sdkRoot = resolve3(carrier.root, "sdk");
  if (!existsSync2(sdkRoot) || !lstatSync2(sdkRoot).isDirectory()) {
    throw new Error(`engine_sdk_root_missing: ${sdkRoot}`);
  }
  const canonicalSdkRoot = realpathSync3(sdkRoot);
  if (!confined(carrier.root, canonicalSdkRoot))
    throw new Error("engine_sdk_root_escape: SDK root escaped carrier");
  const manifest = sdkManifest(resolve3(canonicalSdkRoot, "sdk-manifest.json"));
  const cliPath = canonicalRegularFile(resolve3(canonicalSdkRoot, ...SDK_CLI_RELATIVE), "engine_sdk_cli_invalid", canonicalSdkRoot);
  const pnpm = resolveDependency(pluginRoot, installRoot, "pnpm", "pnpm_missing");
  if (pnpm.manifest.name !== "pnpm" || pnpm.manifest.version !== PNPM_VERSION) {
    throw new Error(`pnpm_version_mismatch: installed pnpm must be ${PNPM_VERSION}`);
  }
  const pnpmCliPath = canonicalRegularFile(resolve3(pnpm.root, packageBin(pnpm.manifest, "pnpm")), "pnpm_cli_invalid", pnpm.root);
  return {
    pluginRoot,
    root: carrier.root,
    sdkRoot: canonicalSdkRoot,
    cliPath,
    pnpmRoot: pnpm.root,
    pnpmCliPath,
    sdkManifest: manifest
  };
}
function emptyTarget(targetRoot) {
  const absolute = resolve3(targetRoot);
  if (!existsSync2(absolute) || !lstatSync2(absolute).isDirectory()) {
    throw new Error(`project_target_invalid: ${absolute} must be an existing directory`);
  }
  const entries = readdirSync2(absolute);
  if (entries.length !== 0)
    throw new Error(`project_target_not_empty: ${absolute}`);
  return absolute;
}
function createPnpmShim(pnpmCliPath) {
  const root = mkdtempSync(resolve3(tmpdir(), "forgeax-game-pnpm-"));
  try {
    if (process.platform === "win32") {
      const path = resolve3(root, "pnpm.cmd");
      writeFileSync2(path, `@echo off\r
"${process.execPath}" "${pnpmCliPath}" %*\r
`, "utf8");
    } else {
      const path = resolve3(root, "pnpm");
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      writeFileSync2(path, `#!/bin/sh
exec ${quote(process.execPath)} ${quote(pnpmCliPath)} "$@"
`, "utf8");
      chmodSync(path, 493);
    }
    return { root, cleanup: () => rmSync2(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync2(root, { recursive: true, force: true });
    throw error;
  }
}
function carrierEnvironment(pnpmShimRoot) {
  const environment = {};
  for (const key of CARRIER_ENVIRONMENT_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined)
      environment[key] = value;
  }
  const systemPath = process.platform === "win32" ? [dirname4(process.execPath), "C:\\Windows\\System32", "C:\\Windows"] : [dirname4(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  environment.FORGEAX_DISABLE_UPDATE_CHECK = "1";
  environment.PATH = [pnpmShimRoot, ...new Set(systemPath)].join(delimiter);
  for (const key of CARRIER_ENVIRONMENT_EXCLUDE)
    delete environment[key];
  return environment;
}
function runCarrierProcess(carrier, args, environment) {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(process.execPath, ["./bin/forgeax.mjs", ...args], {
      cwd: carrier.sdkRoot,
      env: environment,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const status = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      if (error !== null && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        rejectOutput(new Error(`engine_sdk_${args[0]}_failed: output exceeded 32 MiB`));
        return;
      }
      resolveOutput({ status, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
function parseSuccessEnvelope(output, command) {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    throw new Error(`engine_sdk_${command}_envelope_invalid: expected exactly one JSON success envelope`);
  }
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`engine_sdk_${command}_envelope_invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== undefined || value.command !== `project ${command}` || !Array.isArray(value.artifacts) || value.ok !== true || value.value === null || typeof value.value !== "object" || Array.isArray(value.value)) {
    throw new Error(`engine_sdk_${command}_envelope_invalid: expected one ${command} success envelope`);
  }
  return value;
}
function failureDetail(output, command) {
  const trimmed = output.stdout.trim();
  if (trimmed.length > 0) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const error = parsed.error;
        if (error !== undefined)
          return JSON.stringify(error);
      }
    } catch {}
  }
  return output.stderr.trim() || output.stdout.trim() || `exit status ${output.status} during ${command}`;
}
function assertIdentity(command, envelope, targetRoot) {
  const value = envelope.value;
  const commitValid = command === "init" ? value.engineCommit === ENGINE_COMMIT : value.engineCommit === undefined || value.engineCommit === ENGINE_COMMIT;
  const pnpmValid = command === "init" ? value.pnpm === PNPM_VERSION : value.pnpm === undefined || value.pnpm === PNPM_VERSION;
  if (value.sdkVersion !== ENGINE_VERSION || !commitValid || !pnpmValid) {
    throw new Error(`engine_sdk_${command}_identity_mismatch: expected ${ENGINE_VERSION}/${ENGINE_COMMIT}`);
  }
  if (targetRoot !== undefined && (value.root !== targetRoot || value.template !== "empty")) {
    throw new Error(`engine_sdk_${command}_identity_mismatch: created project root/template was not ${targetRoot}/empty`);
  }
}
async function createEmptyGameWithCarrier(targetRoot, options = {}) {
  const target = emptyTarget(targetRoot);
  const carrier = resolveGamePluginCarrier(options);
  const shim = createPnpmShim(carrier.pnpmCliPath);
  const environment = carrierEnvironment(shim.root);
  try {
    const initOutput = await runCarrierProcess(carrier, ["project", "init", "--json"], environment);
    if (initOutput.status !== 0) {
      throw new Error(`engine_sdk_init_failed: ${failureDetail(initOutput, "init")}`);
    }
    const init = parseSuccessEnvelope(initOutput.stdout, "init");
    assertIdentity("init", init);
    const newOutput = await runCarrierProcess(carrier, ["project", "new", "--root", target, "--template", "empty", "--json"], environment);
    if (newOutput.status !== 0) {
      throw new Error(`engine_sdk_new_failed: ${failureDetail(newOutput, "new")}`);
    }
    const created = parseSuccessEnvelope(newOutput.stdout, "new");
    assertIdentity("new", created, target);
    return { carrier, init, created };
  } finally {
    shim.cleanup();
  }
}

// src/engine/release.ts
function readManifest(path) {
  let value;
  try {
    value = JSON.parse(readFileSync4(path, "utf8"));
  } catch (error) {
    throw new Error(`engine_release_manifest_invalid: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`engine_release_manifest_invalid: ${path} is not a JSON object`);
  }
  return value;
}
function confined2(root, candidate) {
  const rel = relative3(root, candidate);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep2}`) && !isAbsolute2(rel);
}
function exactPackage(root, name) {
  const parts = name.slice(1).split("/");
  const packageRoot = resolve4(root, "node_modules", `@${parts[0]}`, parts[1]);
  const manifestPath = resolve4(packageRoot, "package.json");
  if (!existsSync3(manifestPath) || !lstatSync3(manifestPath).isFile()) {
    throw new Error(`engine_release_missing: ${name} is not installed under ${root}`);
  }
  const canonicalRoot = realpathSync4(packageRoot);
  const canonicalModules = realpathSync4(resolve4(root, "node_modules"));
  if (!confined2(canonicalModules, canonicalRoot)) {
    throw new Error(`engine_release_escape: ${name} resolves outside the game node_modules tree`);
  }
  return { root: canonicalRoot, manifest: readManifest(realpathSync4(manifestPath)) };
}
function resolveEngineRelease(gameRoot, options = {}) {
  const canonicalGameRoot = realpathSync4(resolve4(gameRoot));
  const gameManifest = readManifest(resolve4(canonicalGameRoot, "package.json"));
  const declared = gameManifest.dependencies?.["@forgeax/engine"];
  if (declared !== ENGINE_VERSION) {
    throw new Error(`engine_release_mismatch: game declares @forgeax/engine=${String(declared)}, expected ${ENGINE_VERSION}`);
  }
  const engine = exactPackage(canonicalGameRoot, "@forgeax/engine");
  if (engine.manifest.name !== "@forgeax/engine" || engine.manifest.version !== ENGINE_VERSION) {
    throw new Error(`engine_release_mismatch: installed Engine must be @forgeax/engine@${ENGINE_VERSION} from ${ENGINE_COMMIT}`);
  }
  const carrier = resolveGamePluginCarrier(options);
  const carrierCommit = carrier.sdkManifest.engineCommit;
  if (carrierCommit !== ENGINE_COMMIT) {
    throw new Error(`engine_release_mismatch: SDK carrier does not identify Engine commit ${ENGINE_COMMIT}`);
  }
  const declaredCommit = engine.manifest.forgeax?.engineCommit;
  if (declaredCommit !== undefined && declaredCommit !== carrierCommit) {
    throw new Error(`engine_release_mismatch: installed Engine declares ${String(declaredCommit)}, expected ${String(carrierCommit)}`);
  }
  const cliPath = resolve4(engine.root, "dist", "bin", "forgeax.mjs");
  if (!existsSync3(cliPath) || !lstatSync3(cliPath).isFile()) {
    throw new Error(`engine_cli_missing: ${cliPath}`);
  }
  const canonicalCli = realpathSync4(cliPath);
  if (!confined2(engine.root, canonicalCli)) {
    throw new Error("engine_cli_escape: Engine CLI resolves outside @forgeax/engine");
  }
  return {
    gameRoot: canonicalGameRoot,
    packageRoot: engine.root,
    cliPath: canonicalCli,
    carrierRoot: carrier.root,
    version: ENGINE_VERSION,
    commit: ENGINE_COMMIT
  };
}

// src/run/engine-preview.ts
import { createHash as createHash2, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync as spawnSync2 } from "node:child_process";
import {
  appendFileSync as appendFileSync2,
  chmodSync as chmodSync2,
  closeSync,
  existsSync as existsSync4,
  mkdirSync as mkdirSync3,
  openSync,
  readFileSync as readFileSync5,
  readdirSync as readdirSync3,
  realpathSync as realpathSync5,
  renameSync as renameSync2,
  rmSync as rmSync3,
  statSync as statSync3,
  unlinkSync,
  writeFileSync as writeFileSync3
} from "node:fs";
import { dirname as dirname5, join as join4, resolve as resolve5 } from "node:path";
var STATE_SCHEMA = "forgeax.engine-preview-state/1.0.0";
var ENVELOPE_LIMIT = 1024 * 1024;
var LOG_LIMIT = 8 * 1024 * 1024;
var ENGINE_PREVIEW_TOTAL_DEADLINE_MS = 150000;
var DEFAULT_READY_DEADLINE_MS = 15000;
var ENGINE_PREVIEW_CLEANUP_DEADLINE_MS = 5000;
var HEALTH_PATH = "/.forgeax/preview-health";
var trackedStates = new Map;
var liveChildren = new Map;
var directChildren = new Set;
function trackDirectChild(child) {
  directChildren.add(child);
  child.once("exit", () => directChildren.delete(child));
}
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function processStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0)
    return;
  try {
    const stat = readFileSync5(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    const startTicks = fields[19];
    if (startTicks)
      return `proc:${startTicks}`;
  } catch {}
  const result = spawnSync2("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2000
  });
  const value = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
  return value ? `ps:${value}` : undefined;
}
function previewPaths(projectRoot, gameRoot) {
  const canonicalProject = realpathSync5(resolve5(projectRoot));
  const canonicalGame = realpathSync5(resolve5(gameRoot));
  const gameRootHash = createHash2("sha256").update(canonicalGame).digest("hex");
  const dir = join4(canonicalProject, ".forgeax", "run", "engine-preview", gameRootHash);
  return {
    dir,
    lock: join4(dir, "lock"),
    state: join4(dir, "state.json"),
    stdout: join4(dir, "stdout.log"),
    stderr: join4(dir, "stderr.log")
  };
}
function preparePaths(paths) {
  mkdirSync3(paths.dir, { recursive: true, mode: 448 });
  chmodSync2(paths.dir, 448);
  for (const path of [paths.stdout, paths.stderr]) {
    const fd = openSync(path, "a", 384);
    closeSync(fd);
    chmodSync2(path, 384);
  }
}
function rotateLog(path, incomingBytes) {
  let bytes = 0;
  try {
    bytes = statSync3(path).size;
  } catch {}
  if (bytes + incomingBytes <= LOG_LIMIT)
    return;
  const older = `${path}.2`;
  const previous = `${path}.1`;
  rmSync3(older, { force: true });
  if (existsSync4(previous))
    renameSync2(previous, older);
  if (existsSync4(path))
    renameSync2(path, previous);
}
function appendLog(path, chunk) {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  rotateLog(path, value.byteLength);
  appendFileSync2(path, value, { mode: 384 });
  chmodSync2(path, 384);
}
function redactingLog(path, secret) {
  let pending = "";
  const drain = () => {
    pending = pending.replaceAll(secret, "[REDACTED]");
    let retain = Math.min(secret.length - 1, pending.length);
    while (retain > 0 && !secret.startsWith(pending.slice(-retain)))
      retain--;
    const safeLength = pending.length - retain;
    if (safeLength > 0)
      appendLog(path, pending.slice(0, safeLength));
    pending = pending.slice(safeLength);
  };
  return {
    write(chunk) {
      pending += chunk.toString("utf8");
      drain();
    },
    flush() {
      if (pending)
        appendLog(path, pending.replaceAll(secret, "[REDACTED]"));
      pending = "";
    }
  };
}
function readState(paths) {
  try {
    const state = JSON.parse(readFileSync5(paths.state, "utf8"));
    if (state.schemaVersion !== STATE_SCHEMA || typeof state.pid !== "number" || typeof state.processStartIdentity !== "string" || typeof state.instanceToken !== "string")
      return;
    return state;
  } catch {
    return;
  }
}
function writeState(paths, state) {
  const temp = `${paths.state}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync3(temp, `${JSON.stringify(state, null, 2)}
`, { mode: 384, flag: "wx" });
  chmodSync2(temp, 384);
  renameSync2(temp, paths.state);
  chmodSync2(paths.state, 384);
}
function acquireLock(paths) {
  preparePaths(paths);
  const owner = JSON.stringify({
    pid: process.pid,
    identity: processStartIdentity(process.pid) ?? "unknown",
    token: randomUUID()
  });
  for (let attempt = 0;attempt < 2; attempt++) {
    try {
      writeFileSync3(paths.lock, `${owner}
`, { flag: "wx", mode: 384 });
      return {
        acquired: true,
        release() {
          try {
            if (readFileSync5(paths.lock, "utf8").trim() === owner)
              unlinkSync(paths.lock);
          } catch {}
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      let raw;
      try {
        raw = readFileSync5(paths.lock, "utf8");
      } catch {
        return { acquired: false, release() {} };
      }
      try {
        const parsed = JSON.parse(raw);
        const pid = Number(parsed.pid);
        const identity = processStartIdentity(pid);
        if (processAlive(pid) && identity !== undefined && parsed.identity === identity) {
          return { acquired: false, release() {} };
        }
        unlinkSync(paths.lock);
      } catch {
        try {
          unlinkSync(paths.lock);
        } catch {
          return { acquired: false, release() {} };
        }
      }
    }
  }
  return { acquired: false, release() {} };
}
function parseEnvelope(stdout, command) {
  if (Buffer.byteLength(stdout, "utf8") > ENVELOPE_LIMIT + 1) {
    throw new Error(`${command}_envelope_too_large`);
  }
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let envelope;
  let envelopeIndex = -1;
  for (const [index, line] of lines.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${command}_envelope_invalid: unexpected JSON frame`);
    }
    if (envelope !== undefined)
      throw new Error(`${command}_envelope_invalid: multiple JSON frames`);
    envelope = parsed;
    envelopeIndex = index;
  }
  if (envelope === undefined)
    throw new Error(`${command}_envelope_invalid: JSON frame is missing`);
  if (envelopeIndex !== lines.length - 1) {
    throw new Error(`${command}_envelope_invalid: diagnostics after JSON frame`);
  }
  if (envelope.schemaVersion !== undefined || !Array.isArray(envelope.artifacts) || envelope.command !== `project ${command}` || typeof envelope.ok !== "boolean") {
    throw new Error(`${command}_envelope_invalid: wrong schema or command`);
  }
  if (!envelope.ok) {
    const error = envelope.error && typeof envelope.error === "object" ? JSON.stringify(envelope.error) : "unknown Engine failure";
    throw new Error(`${command}_failed: ${error}`);
  }
  return envelope;
}
async function waitForExit(child, deadlineMs) {
  if (child.exitCode !== null)
    return child.exitCode;
  return await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise(null);
    }, Math.max(0, deadlineMs));
    const exited = (code) => {
      cleanup();
      resolvePromise(code ?? 0);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", exited);
    };
    child.once("exit", exited);
  });
}
async function terminateDirectChild(child, cleanupMs) {
  if (child.exitCode !== null || child.pid === undefined)
    return;
  child.kill("SIGTERM");
  const grace = Math.max(0, Math.floor(cleanupMs * 0.8));
  if (await waitForExit(child, grace) !== null)
    return;
  child.kill("SIGKILL");
  if (await waitForExit(child, cleanupMs - grace) === null) {
    throw new Error("preview_stop_failed");
  }
}
async function runBuild(cliPath, gameRoot, paths, deadlineAt, cleanupMs) {
  const child = spawn(process.execPath, [cliPath, "project", "build", "--json"], {
    cwd: gameRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  trackDirectChild(child);
  let stdout = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    appendLog(paths.stdout, chunk);
    if (Buffer.byteLength(stdout, "utf8") > ENVELOPE_LIMIT + 1)
      child.kill("SIGTERM");
  });
  child.stderr?.on("data", (chunk) => appendLog(paths.stderr, chunk));
  const exit = await waitForExit(child, deadlineAt - Date.now());
  if (exit === null) {
    await terminateDirectChild(child, cleanupMs);
    throw new Error("engine_build_timeout");
  }
  parseEnvelope(stdout, "build");
  if (exit !== 0)
    throw new Error(`engine_build_exit_${exit}`);
}
function previewIdentity(value, fallback) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("preview_envelope_invalid: value is not an object");
  }
  const identity = value;
  if (typeof identity.root !== "string" || identity.urls === null || typeof identity.urls !== "object" || !Array.isArray(identity.urls.local) || !Array.isArray(identity.urls.network))
    throw new Error("preview_envelope_invalid: root or urls are missing");
  const fields = ["engineVersion", "engineCommit", "buildDigest", "previewInstanceId"];
  for (const field of fields) {
    if (identity[field] !== undefined && typeof identity[field] !== "string") {
      throw new Error(`preview_envelope_invalid: ${field} is not a string`);
    }
    if (field !== "previewInstanceId" && identity[field] !== undefined && fallback !== undefined && identity[field] !== fallback[field]) {
      throw new Error(`preview_envelope_invalid: ${field} conflicts with the verified release`);
    }
  }
  const normalized = {
    root: identity.root,
    urls: identity.urls,
    engineVersion: identity.engineVersion ?? fallback?.engineVersion,
    engineCommit: identity.engineCommit ?? fallback?.engineCommit,
    buildDigest: identity.buildDigest ?? fallback?.buildDigest,
    previewInstanceId: identity.previewInstanceId ?? fallback?.previewInstanceId
  };
  if (fields.some((field) => typeof normalized[field] !== "string")) {
    throw new Error("preview_envelope_invalid: identity fields are missing");
  }
  return normalized;
}
function loopbackUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === "http:" && url.username === "" && url.password === "" && (host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127."));
  } catch {
    return false;
  }
}
function selectUrl(identity) {
  const urls = [...identity.urls.local, ...identity.urls.network];
  if (urls.length === 0 || urls.some((url) => typeof url !== "string" || !loopbackUrl(url))) {
    throw new Error("preview_loopback_url_invalid");
  }
  return urls.sort((left, right) => left.localeCompare(right))[0];
}
async function readPreviewEnvelope(child, logStdout, timeoutMs, fallback) {
  return await new Promise((resolvePromise, reject) => {
    let stdout = "";
    const onRemaining = (chunk) => logStdout(chunk);
    const timer = setTimeout(() => finish(new Error("engine_preview_readiness_timeout")), timeoutMs);
    const finish = (error, identity) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.stdout?.off("data", onData);
      child.stdout?.on("data", onRemaining);
      child.once("exit", () => child.stdout?.off("data", onRemaining));
      if (error)
        reject(error);
      else
        resolvePromise(identity);
    };
    const onExit = (code) => finish(new Error(`engine_preview_exit_${code ?? "signal"}`));
    const onData = (chunk) => {
      logStdout(chunk);
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > ENVELOPE_LIMIT + 1) {
        finish(new Error("preview_envelope_too_large"));
        return;
      }
      if (!stdout.includes(`
`))
        return;
      try {
        const envelope = parseEnvelope(stdout, "preview");
        finish(undefined, previewIdentity(envelope.value, fallback));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    child.once("exit", onExit);
    child.stdout?.on("data", onData);
  });
}
async function fetchHealth(state, selectedUrl, token, timeoutMs) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(HEALTH_PATH, selectedUrl).toString();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    if (response.status === 404 || response.ok && !response.headers.get("content-type")?.includes("application/json")) {
      const manifestResponse = await fetch(new URL("forgeax-dist.json", selectedUrl), { signal: controller.signal });
      if (!manifestResponse.ok)
        throw new Error(`static manifest HTTP ${manifestResponse.status}`);
      const manifest = Buffer.from(await manifestResponse.arrayBuffer());
      if (manifest.byteLength > ENVELOPE_LIMIT)
        throw new Error("static manifest is too large");
      const digest = createHash2("sha256").update(manifest).digest("hex");
      if (digest !== state.buildDigest)
        throw new Error("preview_static_digest_mismatch");
      return state;
    }
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`);
    const health = previewIdentity(await response.json());
    if (realpathSync5(health.root) !== realpathSync5(state.root) || health.engineVersion !== state.engineVersion || health.engineCommit !== state.engineCommit || health.buildDigest !== state.buildDigest || health.previewInstanceId !== state.previewInstanceId)
      throw new Error("preview_health_identity_mismatch");
    return health;
  } finally {
    clearTimeout(timer);
  }
}
function distDigest(gameRoot) {
  return createHash2("sha256").update(readFileSync5(join4(gameRoot, "dist", "forgeax-dist.json"))).digest("hex");
}
async function verifiedExistingState(paths, desiredDigest, deadlineAt, cleanupMs) {
  const state = readState(paths);
  if (!state) {
    if (existsSync4(paths.state))
      throw new Error("preview_ownership_unverified: state is malformed");
    return;
  }
  if (!processAlive(state.pid)) {
    rmSync3(paths.state, { force: true });
    trackedStates.delete(paths.state);
    liveChildren.delete(paths.state);
    return;
  }
  if (processStartIdentity(state.pid) !== state.processStartIdentity) {
    throw new Error("preview_ownership_unverified: process start identity changed");
  }
  try {
    await fetchHealth(state, state.selectedUrl, state.instanceToken, Math.max(1, Math.min(2000, deadlineAt - Date.now())));
  } catch (error) {
    throw new Error(`preview_ownership_unverified: ${error instanceof Error ? error.message : String(error)}`);
  }
  trackedStates.set(paths.state, state);
  if (state.root === realpathSync5(state.root) && state.engineVersion === ENGINE_VERSION && state.engineCommit === ENGINE_COMMIT && state.buildDigest === desiredDigest)
    return state;
  await stopVerifiedState(paths, state, cleanupMs);
  return;
}
async function stopVerifiedState(paths, state, cleanupMs) {
  if (!processAlive(state.pid)) {
    rmSync3(paths.state, { force: true });
    return;
  }
  if (processStartIdentity(state.pid) !== state.processStartIdentity) {
    throw new Error("preview_ownership_unverified: refusing to signal reused PID");
  }
  const started = Date.now();
  try {
    await fetchHealth(state, state.selectedUrl, state.instanceToken, Math.min(2000, cleanupMs));
  } catch (error) {
    throw new Error(`preview_ownership_unverified: ${error instanceof Error ? error.message : String(error)}`);
  }
  const child = liveChildren.get(paths.state);
  if (child?.pid === state.pid)
    child.kill("SIGTERM");
  else
    process.kill(state.pid, "SIGTERM");
  while (processAlive(state.pid) && Date.now() - started < Math.floor(cleanupMs * 0.8))
    await sleep(25);
  if (processAlive(state.pid)) {
    if (processStartIdentity(state.pid) !== state.processStartIdentity) {
      throw new Error("preview_ownership_unverified: identity changed before forced stop");
    }
    if (child?.pid === state.pid)
      child.kill("SIGKILL");
    else
      process.kill(state.pid, "SIGKILL");
  }
  while (processAlive(state.pid) && Date.now() - started < cleanupMs)
    await sleep(25);
  if (processAlive(state.pid))
    throw new Error("preview_stop_failed");
  rmSync3(paths.state, { force: true });
  trackedStates.delete(paths.state);
  liveChildren.delete(paths.state);
}
async function startEnginePreview(projectRoot, gameRoot, options = {}) {
  const totalMs = options.totalDeadlineMs ?? ENGINE_PREVIEW_TOTAL_DEADLINE_MS;
  const readyMs = options.readyDeadlineMs ?? DEFAULT_READY_DEADLINE_MS;
  const cleanupMs = options.cleanupDeadlineMs ?? ENGINE_PREVIEW_CLEANUP_DEADLINE_MS;
  const deadlineAt = Date.now() + totalMs;
  const release = resolveEngineRelease(gameRoot, options.carrierPluginRoot === undefined ? {} : { pluginRoot: options.carrierPluginRoot });
  const canonicalProject = realpathSync5(resolve5(projectRoot));
  const paths = previewPaths(canonicalProject, release.gameRoot);
  const lock = acquireLock(paths);
  if (!lock.acquired)
    throw new Error("preview_busy");
  try {
    await runBuild(release.cliPath, release.gameRoot, paths, deadlineAt, cleanupMs);
    const digest = distDigest(release.gameRoot);
    const existing = await verifiedExistingState(paths, digest, deadlineAt, cleanupMs);
    if (existing) {
      return {
        identity: existing,
        selectedUrl: existing.selectedUrl,
        pid: existing.pid,
        reused: true,
        paths
      };
    }
    const token = randomBytes(32).toString("hex");
    const previewInstanceId = randomUUID();
    const child = spawn(process.execPath, [release.cliPath, "project", "preview", "--port", "0", "--json"], {
      cwd: release.gameRoot,
      detached: true,
      env: { ...process.env, FORGEAX_PREVIEW_INSTANCE_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"]
    });
    trackDirectChild(child);
    const stdoutLog = redactingLog(paths.stdout, token);
    const stderrLog = redactingLog(paths.stderr, token);
    child.stderr?.on("data", (chunk) => stderrLog.write(chunk));
    child.once("exit", () => {
      stdoutLog.flush();
      stderrLog.flush();
    });
    if (!child.pid)
      throw new Error("engine_preview_pid_missing");
    let identity;
    try {
      identity = await readPreviewEnvelope(child, (chunk) => stdoutLog.write(chunk), Math.max(1, Math.min(readyMs, deadlineAt - Date.now())), {
        engineVersion: release.version,
        engineCommit: release.commit,
        buildDigest: digest,
        previewInstanceId
      });
      const selectedUrl = selectUrl(identity);
      if (realpathSync5(identity.root) !== release.gameRoot || identity.engineVersion !== release.version || identity.engineCommit !== release.commit || identity.buildDigest !== digest)
        throw new Error("preview_identity_mismatch");
      await fetchHealth(identity, selectedUrl, token, Math.max(1, Math.min(readyMs, deadlineAt - Date.now())));
      const startIdentity = processStartIdentity(child.pid);
      if (!startIdentity)
        throw new Error("preview_process_identity_unavailable");
      const state = {
        ...identity,
        schemaVersion: STATE_SCHEMA,
        projectRoot: canonicalProject,
        selectedUrl,
        pid: child.pid,
        processStartIdentity: startIdentity,
        instanceToken: token,
        startedAt: new Date().toISOString()
      };
      writeState(paths, state);
      child.unref();
      trackedStates.set(paths.state, state);
      liveChildren.set(paths.state, child);
      child.once("exit", () => liveChildren.delete(paths.state));
      return { identity, selectedUrl, pid: child.pid, reused: false, paths };
    } catch (error) {
      await terminateDirectChild(child, cleanupMs).catch(() => {
        return;
      });
      throw error;
    }
  } finally {
    lock.release();
  }
}
async function stopEnginePreview(projectRoot, gameRoot, options = {}) {
  const paths = previewPaths(projectRoot, gameRoot);
  const lock = acquireLock(paths);
  if (!lock.acquired)
    throw new Error("preview_busy");
  try {
    const state = readState(paths);
    if (!state) {
      if (existsSync4(paths.state))
        throw new Error("preview_ownership_unverified: state is malformed");
      return { stopped: false, paths };
    }
    if (!processAlive(state.pid)) {
      rmSync3(paths.state, { force: true });
      trackedStates.delete(paths.state);
      liveChildren.delete(paths.state);
      return { stopped: false, paths };
    }
    await stopVerifiedState(paths, state, options.cleanupDeadlineMs ?? ENGINE_PREVIEW_CLEANUP_DEADLINE_MS);
    return { stopped: true, paths };
  } finally {
    lock.release();
  }
}
function inspectEnginePreview(projectRoot, gameRoot) {
  const paths = previewPaths(projectRoot, gameRoot);
  const state = readState(paths);
  return {
    paths,
    ...state ? { state } : {},
    processLive: state ? processAlive(state.pid) : false,
    processIdentityMatches: state ? processStartIdentity(state.pid) === state.processStartIdentity : false
  };
}
async function stopTrackedEnginePreviews() {
  await Promise.all([...directChildren].map(async (child) => {
    await terminateDirectChild(child, ENGINE_PREVIEW_CLEANUP_DEADLINE_MS).catch(() => {
      return;
    });
  }));
  const entries = [...trackedStates.entries()];
  await Promise.all(entries.map(async ([statePath, state]) => {
    const paths = {
      dir: dirname5(statePath),
      lock: join4(dirname5(statePath), "lock"),
      state: statePath,
      stdout: join4(dirname5(statePath), "stdout.log"),
      stderr: join4(dirname5(statePath), "stderr.log")
    };
    const lock = acquireLock(paths);
    if (!lock.acquired)
      return;
    try {
      await stopVerifiedState(paths, state, ENGINE_PREVIEW_CLEANUP_DEADLINE_MS).catch(() => {
        return;
      });
    } finally {
      lock.release();
    }
  }));
}

// src/status/collect.ts
var AGENTS_DOC_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];
function readAgentsDoc(root) {
  for (const name of AGENTS_DOC_CANDIDATES) {
    try {
      return readFileSync6(join5(root, name), "utf8");
    } catch {}
  }
  return;
}
function deriveNextAction(s) {
  if (!s.project.root)
    return "Open an external released Engine SDK game, then retry.";
  if (s.games.length === 0)
    return "Create a game with the released Engine `forgeax new` command.";
  if (!s.activeGame)
    return `Select one game with \`forgeax-game use <slug>\` (${s.games.join(", ")}).`;
  if (!s.engine.installed)
    return `Install the exact released Engine package in the game. ${s.engine.error ?? ""}`.trim();
  if (!s.devKit.installed)
    return "Run `forgeax-game devkit install`, then start a new host session.";
  if (s.agentsBlock.status !== "current")
    return "Run `forgeax-game agents update`, then start a new host session.";
  if (s.preview?.live && s.preview.identityMatches) {
    return "Engine Preview is live. Edit the game and call `forgeax_run_current_game` to rebuild or reuse it.";
  }
  return "When Preview is needed, call `forgeax_run_current_game` for the bounded Engine build and verified Preview lifecycle. Resolve task prerequisites first; status does not require an empty-template baseline run.";
}
async function collectStatus(explicitDir) {
  const project = resolveProject(explicitDir);
  if (!project.root) {
    const base2 = {
      project,
      games: [],
      agentsBlock: inspectBlock(undefined, ROUTING_TEXT),
      devKit: { installed: false, version: DEVKIT_VERSION, engineSkills: 0, availableEngineSkills: 0 },
      engine: { installed: false }
    };
    return { ...base2, nextAction: deriveNextAction(base2) };
  }
  const root = project.root;
  const slug = activeGame(root);
  const selectedGame = slug ? gameDir(root, slug) : undefined;
  let engine = { installed: false };
  if (selectedGame) {
    try {
      const release = resolveEngineRelease(selectedGame);
      engine = {
        installed: true,
        version: release.version,
        commit: release.commit,
        cliPath: release.cliPath
      };
    } catch (error) {
      engine = { installed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const preview = selectedGame ? (() => {
    const inspected = inspectEnginePreview(root, selectedGame);
    return {
      live: inspected.processLive,
      identityMatches: inspected.processIdentityMatches,
      ...inspected.state ? { state: inspected.state } : {},
      stateFile: inspected.paths.state,
      stdoutLog: inspected.paths.stdout,
      stderrLog: inspected.paths.stderr
    };
  })() : undefined;
  const base = {
    project,
    ...slug ? { activeGame: slug } : {},
    games: listGames(root),
    agentsBlock: inspectBlock(readAgentsDoc(root), ROUTING_TEXT),
    devKit: {
      installed: hasDevKit(root),
      version: DEVKIT_VERSION,
      engineSkills: installedEngineSkills(root).length,
      availableEngineSkills: bundledEngineSkillCount(root)
    },
    engine,
    ...preview ? { preview } : {}
  };
  return { ...base, nextAction: deriveNextAction(base) };
}

// src/status/render.ts
var BLOCK_EXPLANATION = {
  missing_file: "no AGENTS.md or CLAUDE.md in the project",
  missing_block: "project doc carries no ForgeaX routing block",
  outdated: "routing block is stale",
  current: "up to date"
};
function renderStatus(s) {
  const lines = ["# ForgeaX status", "", "## Project"];
  if (s.project.root) {
    lines.push(`- root: ${s.project.root}`);
    lines.push(`- active game: ${s.activeGame ?? "(none selected)"}`);
    lines.push(`- games (${s.games.length}): ${s.games.join(", ") || "(none)"}`);
  } else {
    lines.push("- root: (not a ForgeaX project or Engine game)");
    lines.push(`- searched upward from: ${s.project.searchedFrom}`);
  }
  lines.push("", "## Engine release");
  if (s.engine.installed) {
    lines.push(`- version: ${s.engine.version}`);
    lines.push(`- commit: ${s.engine.commit}`);
    lines.push(`- CLI: ${s.engine.cliPath}`);
    lines.push("- owner: released @forgeax/engine + @forgeax/engine-devkit (no legacy Runtime or alternate server)");
  } else {
    lines.push(`- status: unavailable${s.engine.error ? ` (${s.engine.error})` : ""}`);
  }
  lines.push("", "## Project rules");
  lines.push(`- AGENTS.md routing block: ${s.agentsBlock.status} — ${BLOCK_EXPLANATION[s.agentsBlock.status]}`);
  lines.push(`- game development kit: ${s.devKit.installed ? "installed" : "missing"} (v${s.devKit.version})`);
  lines.push(`- Engine authoring skills: ${s.devKit.engineSkills} installed of ${s.devKit.availableEngineSkills} available from the selected game`);
  if (s.preview) {
    lines.push("", "## Engine Preview");
    lines.push(`- process: ${s.preview.live ? "live" : "not live"}`);
    lines.push(`- process identity: ${s.preview.identityMatches ? "matches recorded start identity" : "unverified"}`);
    if (s.preview.state) {
      lines.push(`- pid: ${s.preview.state.pid}`);
      lines.push(`- URL: ${s.preview.state.selectedUrl}`);
      lines.push(`- instance: ${s.preview.state.previewInstanceId}`);
      lines.push(`- build digest: ${s.preview.state.buildDigest}`);
    }
    lines.push(`- state: ${s.preview.stateFile}`);
    lines.push(`- stdout: ${s.preview.stdoutLog}`);
    lines.push(`- stderr: ${s.preview.stderrLog}`);
  }
  lines.push("", "## Next action", s.nextAction);
  return `${lines.join(`
`)}
`;
}

// src/project/completion.ts
import { createHash as createHash3, randomUUID as randomUUID2 } from "node:crypto";
import {
  chmodSync as chmodSync3,
  lstatSync as lstatSync4,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync7,
  readdirSync as readdirSync4,
  readlinkSync,
  renameSync as renameSync3,
  writeFileSync as writeFileSync4
} from "node:fs";
import { dirname as dirname6, extname, join as join6, relative as relative4, resolve as resolve6 } from "node:path";
var BASELINE_SCHEMA = "forgeax.game-authoring-baseline/1.1.0";
var BASELINE_PATH = [".forgeax", "game-authoring-baseline.json"];
var AUTHOR_INPUTS = ["forge.json", "package.json", "README.md", "src", "assets"];
function fileBytesOrEmpty(path) {
  try {
    return readFileSync7(path);
  } catch {
    return Buffer.alloc(0);
  }
}
function isTestPath(name) {
  return name.split("/").includes("__tests__") || /(?:^|\/)test(?:s)?\//.test(name) || /\.(?:test|spec)\.[^.]+$/.test(name);
}
function authorDigests(root) {
  const canonicalRoot = resolve6(root);
  const rows = [];
  const gameplayRows = [];
  const testRows = [];
  const visit = (path) => {
    let stat;
    try {
      stat = lstatSync4(path);
    } catch {
      return;
    }
    const name = relative4(canonicalRoot, path).split("\\").join("/");
    if (stat.isSymbolicLink()) {
      const row = `L\x00${name}\x00${readlinkSync(path)}`;
      rows.push(row);
      if (isTestPath(name))
        testRows.push(row);
      else if (name.startsWith("src/") || name.startsWith("assets/"))
        gameplayRows.push(row);
      return;
    }
    if (stat.isDirectory()) {
      rows.push(`D\x00${name}`);
      for (const child of readdirSync4(path).sort())
        visit(join6(path, child));
      return;
    }
    if (stat.isFile()) {
      const digest = createHash3("sha256").update(readFileSync7(path)).digest("hex");
      const row = `F\x00${name}\x00${digest}`;
      rows.push(row);
      if (isTestPath(name))
        testRows.push(row);
      else if (name.startsWith("src/") || name.startsWith("assets/"))
        gameplayRows.push(row);
    }
  };
  for (const input of AUTHOR_INPUTS)
    visit(join6(canonicalRoot, input));
  const hashRows = (value) => createHash3("sha256").update(value.join(`
`)).digest("hex");
  return {
    author: hashRows(rows),
    gameplay: hashRows(gameplayRows),
    tests: hashRows(testRows),
    readme: createHash3("sha256").update(fileBytesOrEmpty(join6(root, "README.md"))).digest("hex")
  };
}
function ensureAuthoringBaseline(gameRoot) {
  const path = join6(gameRoot, ...BASELINE_PATH);
  try {
    const existing = JSON.parse(readFileSync7(path, "utf8"));
    if (existing.schemaVersion === BASELINE_SCHEMA && [existing.authorDigest, existing.gameplayDigest, existing.testsDigest, existing.readmeDigest].every((digest) => /^[a-f0-9]{64}$/.test(digest)))
      return path;
  } catch {}
  mkdirSync4(join6(gameRoot, ".forgeax"), { recursive: true, mode: 448 });
  const digests = authorDigests(gameRoot);
  const forge = JSON.parse(readFileSync7(join6(gameRoot, "forge.json"), "utf8"));
  const pkg = JSON.parse(readFileSync7(join6(gameRoot, "package.json"), "utf8"));
  const value = {
    schemaVersion: BASELINE_SCHEMA,
    authorDigest: digests.author,
    gameplayDigest: digests.gameplay,
    testsDigest: digests.tests,
    readmeDigest: digests.readme,
    wasEmptyTemplate: forge.id === "template-empty" || forge.name === "Empty" || pkg.name === "@forgeax/template-game-empty",
    recordedAt: new Date().toISOString()
  };
  const temp = `${path}.${process.pid}.${randomUUID2()}.tmp`;
  writeFileSync4(temp, `${JSON.stringify(value, null, 2)}
`, { flag: "wx", mode: 384 });
  chmodSync3(temp, 384);
  renameSync3(temp, path);
  chmodSync3(path, 384);
  return path;
}
function assertGameAuthoringComplete(gameRoot) {
  const path = join6(gameRoot, ...BASELINE_PATH);
  let baseline;
  try {
    baseline = JSON.parse(readFileSync7(path, "utf8"));
  } catch {
    return;
  }
  if (baseline.schemaVersion !== BASELINE_SCHEMA || [baseline.authorDigest, baseline.gameplayDigest, baseline.testsDigest, baseline.readmeDigest].some((digest) => !/^[a-f0-9]{64}$/.test(digest))) {
    throw new Error("game_authoring_baseline_invalid: rerun `forgeax-game init`");
  }
  const current = authorDigests(gameRoot);
  if (current.author === baseline.authorDigest)
    return;
  const forge = JSON.parse(readFileSync7(join6(gameRoot, "forge.json"), "utf8"));
  const pkg = JSON.parse(readFileSync7(join6(gameRoot, "package.json"), "utf8"));
  const readme = fileBytesOrEmpty(join6(gameRoot, "README.md")).toString("utf8");
  const stale = [];
  if (forge.id === "template-empty")
    stale.push("forge.json id");
  if (forge.name === "Empty")
    stale.push("forge.json name");
  if (pkg.name === "@forgeax/template-game-empty")
    stale.push("package.json name");
  if (/^#\s+ForgeaX Empty Game\s*$/m.test(readme))
    stale.push("README title");
  if (readme.trim() === "")
    stale.push("README content");
  if (/forgeax-empty-game-web\.zip/.test(readme))
    stale.push("README package output");
  const headings = readme.match(/^#\s+.+$/gm) ?? [];
  if (headings.length !== 1)
    stale.push(`README top-level headings (${headings.length})`);
  const authoredGameplay = baseline.wasEmptyTemplate && current.gameplay !== baseline.gameplayDigest;
  if (authoredGameplay && current.tests === baseline.testsDigest)
    stale.push("gameplay tests");
  if (authoredGameplay && current.readme === baseline.readmeDigest)
    stale.push("README content");
  if (authoredGameplay && hasDirectDocumentBodyMount(readGameplaySource(gameRoot))) {
    stale.push("Engine Host UI mount (direct document.body mutation)");
  }
  if (authoredGameplay && !hasGameplayBehaviorTest(gameRoot)) {
    stale.push("gameplay behavior tests (export and exercise a named gameplay function)");
  }
  for (const testMarker of ["empty game starter", "ForgeaX Empty Game"]) {
    if (authoredGameplay && readAuthorTests(gameRoot).includes(testMarker)) {
      stale.push(`template test marker ${JSON.stringify(testMarker)}`);
    }
  }
  if (stale.length > 0) {
    throw new Error(`game_completion_incomplete: gameplay changed but completion evidence is stale: ${stale.join(", ")}; finalize identity, Host UI mounting, README/controls, and behavior tests before claiming completion`);
  }
}
function readAuthorTestFiles(root) {
  const values = [];
  const visit = (path) => {
    let stat;
    try {
      stat = lstatSync4(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync4(path).sort())
        visit(join6(path, child));
      return;
    }
    const name = relative4(root, path).split("\\").join("/");
    if (stat.isFile() && isTestPath(name))
      values.push({ path, content: readFileSync7(path, "utf8") });
  };
  visit(join6(root, "src"));
  return values;
}
function readAuthorTests(root) {
  return readAuthorTestFiles(root).map((test) => test.content).join(`
`);
}
function readGameplaySource(root) {
  const values = [];
  const visit = (path) => {
    let stat;
    try {
      stat = lstatSync4(path);
    } catch {
      return;
    }
    const name = relative4(root, path).split("\\").join("/");
    if (stat.isDirectory()) {
      for (const child of readdirSync4(path).sort())
        visit(join6(path, child));
      return;
    }
    if (stat.isFile() && !isTestPath(name) && /\.[cm]?[jt]sx?$/.test(name)) {
      values.push(readFileSync7(path, "utf8"));
    }
  };
  visit(join6(root, "src"));
  return values.join(`
`);
}
function hasDirectDocumentBodyMount(source) {
  return /\bdocument\s*\.\s*body\s*\.\s*(?:append|appendChild|prepend|replaceChildren|insertAdjacentElement|insertAdjacentHTML)\s*\(/u.test(source) || /\bdocument\s*\.\s*body\s*\.\s*(?:innerHTML|outerHTML|textContent)\s*=/u.test(source) || /\bdocument\s*\.\s*querySelector\s*\(\s*['"]body['"]\s*\)\s*\??\.\s*(?:append|appendChild|prepend|replaceChildren)\s*\(/u.test(source);
}
function sourceModule(testPath, specifier) {
  if (!specifier.startsWith("."))
    return;
  const unresolved = resolve6(dirname6(testPath), specifier);
  const extension = extname(unresolved);
  const candidates = extension === ".js" || extension === ".jsx" ? [`${unresolved.slice(0, -extension.length)}.ts`, `${unresolved.slice(0, -extension.length)}.tsx`, unresolved] : [unresolved, `${unresolved}.ts`, `${unresolved}.tsx`, join6(unresolved, "index.ts")];
  for (const path of candidates) {
    try {
      if (!lstatSync4(path).isFile())
        continue;
      return { path, content: readFileSync7(path, "utf8") };
    } catch {}
  }
  return;
}
function hasGameplayBehaviorTest(root) {
  for (const test of readAuthorTestFiles(root)) {
    if (!/\b(?:expect|assert)\s*\(/u.test(test.content))
      continue;
    const imports = test.content.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gu);
    for (const imported of imports) {
      const module = sourceModule(test.path, imported[2]);
      if (!module)
        continue;
      const moduleName = relative4(root, module.path).split("\\").join("/");
      if (!moduleName.startsWith("src/") || isTestPath(moduleName))
        continue;
      const body = test.content.replace(imported[0], "");
      for (const rawBinding of imported[1].split(",")) {
        const parts = rawBinding.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u);
        const exported = parts[0]?.trim();
        const local = parts.at(-1)?.trim();
        if (!exported || !local)
          continue;
        const exportPattern = new RegExp(`\\bexport\\s+(?:(?:async\\s+)?function\\s+${exported}\\b|const\\s+${exported}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>)`, "u");
        const invocationPattern = new RegExp(`\\b${local}\\s*\\(`, "u");
        if (exportPattern.test(module.content) && invocationPattern.test(body))
          return true;
      }
    }
  }
  return false;
}

// src/run/run-game.ts
var RUN_TOOL_SCHEMA = {
  type: "object",
  properties: {
    game: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9-]{0,40}$",
      description: "Game slug to run. Defaults to the project active game."
    },
    target_dir: {
      type: "string",
      description: "Directory to resolve the ForgeaX project from. Defaults to the server working directory."
    },
    start_services: {
      type: "boolean",
      description: "Start Engine Preview when absent. Default true; false performs a read-only availability check."
    }
  },
  additionalProperties: false
};
function resolveSlug(root, requested) {
  if (requested !== undefined && !SLUG_RE.test(requested)) {
    return { error: `error: invalid game slug: ${JSON.stringify(requested)}.` };
  }
  const games = listGames(root);
  if (games.length === 0) {
    return { error: "error: this project has no Engine game. Create one with the released `forgeax new` command." };
  }
  const slug = requested ?? activeGame(root) ?? (games.length === 1 ? games[0] : undefined);
  if (!slug) {
    return {
      error: `error: no active game selected and this project has ${games.length} games (${games.join(", ")}). Pass \`game\` or run \`forgeax-game use <slug>\`.`
    };
  }
  const dir = gameDir(root, slug);
  return dir ? { slug, dir } : { error: `error: game ${JSON.stringify(slug)} not found. Available: ${games.join(", ")}.` };
}
async function runCurrentGame(rawArgs, cwd) {
  const args = rawArgs;
  const dir = typeof args.target_dir === "string" ? args.target_dir : cwd;
  const project = resolveProject(dir);
  if (!project.root) {
    throw new Error([
      `error: no released Engine game found searching upward from ${project.searchedFrom}.`,
      "Create an external game with the released Engine SDK."
    ].join(`
`));
  }
  const slug = resolveSlug(project.root, typeof args.game === "string" ? args.game : undefined);
  if ("error" in slug)
    throw new Error(slug.error);
  if (args.start_services === false) {
    return `game: ${slug.slug}
source: ${slug.dir}
not running check requested; no Engine child was launched.`;
  }
  assertGameAuthoringComplete(slug.dir);
  const result = await startEnginePreview(project.root, slug.dir);
  return [
    `game: ${slug.slug}`,
    `source: ${slug.dir}`,
    "tier: engine-preview",
    "preview.status: ready",
    `preview_url: ${result.selectedUrl}`,
    `engine.version: ${result.identity.engineVersion}`,
    `engine.commit: ${result.identity.engineCommit}`,
    `preview.root: ${result.identity.root}`,
    `preview.instance_id: ${result.identity.previewInstanceId}`,
    `preview.build_digest: ${result.identity.buildDigest}`,
    `preview.pid: ${result.pid}`,
    `preview.reused: ${result.reused}`,
    `preview.state_file: ${result.paths.state}`,
    `preview.stdout_log: ${result.paths.stdout}`,
    `preview.stderr_log: ${result.paths.stderr}`,
    "This tool verifies Engine build and Preview ownership only; gameplay, input, and visible UI have not been tested by this tool.",
    "Open only this returned loopback URL. HTTP availability without this exact verified identity is not Preview evidence."
  ].join(`
`);
}

// src/gen/generate.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync5, readFileSync as readFileSync8, writeFileSync as writeFileSync5 } from "node:fs";
import { basename as basename2, extname as extname2, join as join7, relative as relative5 } from "node:path";

// src/gen/config.ts
var DEFAULT_MODELS = {
  textToImage: "gemini-3-pro-image",
  textTo3d: "tripo-3d-text",
  imageTo3d: "tripo-3d-image"
};
function env(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
function resolveLiteLlmConfig() {
  const apiKey = env("FORGEAX_LITELLM_API_KEY");
  if (!apiKey) {
    throw new Error("FORGEAX_LITELLM_API_KEY is not set. Export the LiteLLM key so the asset tools can reach the gateway, e.g. `export FORGEAX_LITELLM_API_KEY=sk-...`.");
  }
  const configuredBaseUrl = env("FORGEAX_LITELLM_BASE_URL");
  if (!configuredBaseUrl) {
    throw new Error("FORGEAX_LITELLM_BASE_URL is not set. Set the LiteLLM gateway URL before using the asset generation tools.");
  }
  const baseUrl = configuredBaseUrl.replace(/\/+$/, "");
  return {
    baseUrl,
    apiKey,
    models: {
      textToImage: env("FORGEAX_GEN_IMAGE_MODEL") ?? DEFAULT_MODELS.textToImage,
      textTo3d: env("FORGEAX_GEN_3D_TEXT_MODEL") ?? DEFAULT_MODELS.textTo3d,
      imageTo3d: env("FORGEAX_GEN_3D_IMAGE_MODEL") ?? DEFAULT_MODELS.imageTo3d
    }
  };
}

// src/gen/cos.ts
import { createHash as createHash4, createHmac } from "node:crypto";
var DEFAULT_EXPIRES_SEC = 3600;
var SKEW_SEC = 60;
function env2(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
function resolveCosConfig() {
  const bucket = env2("FORGEAX_COS_BUCKET");
  const region = env2("FORGEAX_COS_REGION");
  const secretId = env2("FORGEAX_COS_SECRET_ID");
  const secretKey = env2("FORGEAX_COS_SECRET_KEY");
  if (!bucket || !region || !secretId || !secretKey)
    return;
  return { bucket, region, secretId, secretKey };
}
function cosHost(cfg) {
  return `${cfg.bucket}.cos.${cfg.region}.myqcloud.com`;
}
function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function formatKv(map) {
  const lowered = {};
  for (const [k, v] of Object.entries(map))
    lowered[k.toLowerCase()] = v;
  const keys = Object.keys(lowered).sort();
  return {
    serialized: keys.map((k) => `${rfc3986(k)}=${rfc3986(lowered[k])}`).join("&"),
    keyList: keys.map((k) => rfc3986(k)).join(";")
  };
}
function buildAuthorization(cfg, opts) {
  const start = opts.nowSec - SKEW_SEC;
  const end = opts.nowSec + (opts.expiresSec ?? DEFAULT_EXPIRES_SEC);
  const signTime = `${start};${end}`;
  const signKey = createHmac("sha1", cfg.secretKey).update(signTime).digest("hex");
  const { serialized: paramStr, keyList: paramList } = formatKv(opts.params ?? {});
  const { serialized: headerStr, keyList: headerList } = formatKv(opts.headers ?? {});
  const httpString = `${opts.method.toLowerCase()}
${opts.pathname}
${paramStr}
${headerStr}
`;
  const httpStringSha1 = createHash4("sha1").update(httpString).digest("hex");
  const stringToSign = `sha1
${signTime}
${httpStringSha1}
`;
  const signature = createHmac("sha1", signKey).update(stringToSign).digest("hex");
  return [
    "q-sign-algorithm=sha1",
    `q-ak=${cfg.secretId}`,
    `q-sign-time=${signTime}`,
    `q-key-time=${signTime}`,
    `q-header-list=${headerList}`,
    `q-url-param-list=${paramList}`,
    `q-signature=${signature}`
  ].join("&");
}
function presignGetUrl(cfg, key, expiresSec = DEFAULT_EXPIRES_SEC, nowSec = Math.floor(Date.now() / 1000)) {
  const pathname = key.startsWith("/") ? key : `/${key}`;
  const auth = buildAuthorization(cfg, { method: "get", pathname, nowSec, expiresSec });
  return `https://${cosHost(cfg)}${pathname}?${auth}`;
}
async function uploadObject(cfg, key, bytes, contentType) {
  const host = cosHost(cfg);
  const pathname = key.startsWith("/") ? key : `/${key}`;
  const auth = buildAuthorization(cfg, {
    method: "put",
    pathname,
    headers: { host },
    nowSec: Math.floor(Date.now() / 1000),
    expiresSec: 600
  });
  const ctrl = new AbortController;
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(`https://${host}${pathname}`, {
      method: "PUT",
      headers: { authorization: auth, "content-type": contentType },
      body: bytes,
      signal: ctrl.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`COS upload of ${key} failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 400)}` : ""}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
async function uploadAndPresign(cfg, key, bytes, contentType, expiresSec = DEFAULT_EXPIRES_SEC) {
  await uploadObject(cfg, key, bytes, contentType);
  return presignGetUrl(cfg, key, expiresSec);
}

// src/gen/litellm.ts
var TASK_TIMEOUT_MS = 420000;
var POLL_INTERVAL_MS = 3000;
var REQUEST_TIMEOUT_MS = 60000;
function authHeaders(cfg) {
  return { authorization: `Bearer ${cfg.apiKey}` };
}
async function request(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LiteLLM ${init.method ?? "GET"} ${url} failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 600)}` : ""}`);
    }
    return res;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`LiteLLM request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
function decodeImagePayload(item) {
  if (!item)
    return {};
  const b64 = typeof item.b64_json === "string" ? item.b64_json : undefined;
  const url = typeof item.url === "string" ? item.url : undefined;
  return { b64, url };
}
function sniffImageExt(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "jpg";
  return "png";
}
async function materializeImage(payload) {
  if (payload.b64) {
    const bytes = new Uint8Array(Buffer.from(payload.b64, "base64"));
    return { bytes, ext: sniffImageExt(bytes) };
  }
  if (payload.url) {
    const res = await request(payload.url, { method: "GET" });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, ext: sniffImageExt(bytes) };
  }
  throw new Error("LiteLLM image response contained neither b64_json nor url.");
}
async function generateImage(cfg, opts) {
  const res = await request(`${cfg.baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: { ...authHeaders(cfg), "content-type": "application/json" },
    body: JSON.stringify({ model: opts.model, prompt: opts.prompt, n: 1, ...opts.size ? { size: opts.size } : {} })
  });
  const json = await res.json();
  return materializeImage(decodeImagePayload(json.data?.[0]));
}
async function editImage(cfg, opts) {
  const form = new FormData;
  form.set("model", opts.model);
  form.set("prompt", opts.prompt);
  form.set("n", "1");
  form.set("image", new Blob([opts.image]), opts.filename);
  const res = await request(`${cfg.baseUrl}/v1/images/edits`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: form
  });
  const json = await res.json();
  return materializeImage(decodeImagePayload(json.data?.[0]));
}
async function submit3dTask(cfg, body) {
  const res = await request(`${cfg.baseUrl}/v1/3d/generations`, {
    method: "POST",
    headers: { ...authHeaders(cfg), "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!json.id)
    throw new Error(`LiteLLM 3D submit returned no task id: ${JSON.stringify(json).slice(0, 400)}`);
  return json.id;
}
async function poll3dTask(cfg, id, onProgress) {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  for (;; ) {
    const res = await request(`${cfg.baseUrl}/v1/3d/tasks/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: authHeaders(cfg)
    });
    const state = await res.json();
    if (typeof state.progress === "number")
      onProgress?.(state.progress);
    const status = state.status?.toLowerCase();
    if (status === "succeeded" || status === "success" || status === "completed")
      return state;
    if (status === "failed" || status === "error" || status === "cancelled") {
      throw new Error(`LiteLLM 3D task ${id} ${state.status}${state.error ? `: ${JSON.stringify(state.error).slice(0, 300)}` : ""}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`LiteLLM 3D task ${id} did not finish within ${TASK_TIMEOUT_MS / 1000}s (last status: ${state.status}).`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
async function downloadMesh(state) {
  const assets = (state.data ?? []).map((d) => ({
    url: typeof d.url === "string" ? d.url : undefined,
    type: typeof d.type === "string" ? d.type : "",
    format: typeof d.format === "string" ? d.format : ""
  }));
  const mesh = assets.find((a) => a.url && (a.type === "mesh" || /\.(glb|gltf|obj|fbx|usdz)/i.test(a.url ?? ""))) ?? assets.find((a) => a.url);
  if (!mesh?.url)
    throw new Error(`LiteLLM 3D task ${state.id} completed with no downloadable mesh asset.`);
  const res = await request(mesh.url, { method: "GET" });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const ext = mesh.format || (mesh.url.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1] ?? "glb").toLowerCase();
  return { bytes, ext, assetType: mesh.type || "mesh" };
}
async function generate3dFromText(cfg, opts) {
  const id = await submit3dTask(cfg, { model: opts.model, prompt: opts.prompt });
  return downloadMesh(await poll3dTask(cfg, id, opts.onProgress));
}
async function generate3dFromImageUrl(cfg, opts) {
  const id = await submit3dTask(cfg, { model: opts.model, image_url: opts.imageUrl, ...opts.prompt ? { prompt: opts.prompt } : {} });
  return downloadMesh(await poll3dTask(cfg, id, opts.onProgress));
}

// src/gen/generate.ts
function assetsDirFor(cwd, explicitGame) {
  const binding = resolveProject(cwd);
  if (!binding.root) {
    throw new Error(`No ForgeaX project found from ${binding.searchedFrom}. Run \`forgeax-game init --game <slug>\` in the workspace first, or pass \`game\`/\`target_dir\`.`);
  }
  const slug = explicitGame?.trim() || activeGame(binding.root);
  if (!slug) {
    const games = listGames(binding.root);
    throw new Error(`No active game to save the asset into.${games.length ? ` Pass one of: ${games.join(", ")}` : " Create one with `forgeax-game init --game <slug>`."}`);
  }
  const dir = gameDir(binding.root, slug);
  if (!dir)
    throw new Error(`Game ${JSON.stringify(slug)} not found in this project.`);
  const assets = join7(dir, "assets");
  mkdirSync5(assets, { recursive: true });
  return { dir: assets, root: binding.root, slug };
}
function safeStem(preferred, fallback) {
  const source = (preferred ?? fallback).toLowerCase();
  const stem = source.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return stem || "asset";
}
function uniquePath(dir, stem, ext) {
  let candidate = join7(dir, `${stem}.${ext}`);
  for (let i = 1;existsSync5(candidate); i += 1)
    candidate = join7(dir, `${stem}-${i}.${ext}`);
  return candidate;
}
function logProgress(label) {
  let last = -1;
  return (pct) => {
    const step = Math.floor(pct / 10);
    if (step !== last) {
      last = step;
      process.stderr.write(`[forgeax] ${label}: ${pct}%
`);
    }
  };
}
var GAME_PROPERTY = {
  game: {
    type: "string",
    description: "Game slug to save the asset into. Defaults to the active game."
  },
  target_dir: {
    type: "string",
    description: "Directory to resolve the ForgeaX project from. Defaults to the server working directory."
  },
  name: {
    type: "string",
    description: "Base file name for the saved asset (without extension). Defaults to a slug of the prompt."
  }
};
var GENERATE_IMAGE_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "What to draw. Required for both text-to-image and editing an input image." },
    image: {
      type: "string",
      description: "Optional local image path to edit (image-to-image). When set, the prompt describes the desired change."
    },
    model: { type: "string", description: "Override the image model. Defaults to the configured text-to-image model." },
    ...GAME_PROPERTY
  },
  required: ["prompt"],
  additionalProperties: false
};
var GENERATE_3D_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Text description for text-to-3D. Provide this or `image`." },
    image: {
      type: "string",
      description: "Image for image-to-3D: a public https URL, or a local file path when COS is configured (FORGEAX_COS_*) — local files are uploaded to COS and passed as a short-lived presigned URL. Without COS, only a public URL works."
    },
    model: { type: "string", description: "Override the 3D model. Defaults to the configured text/image-to-3D model." },
    ...GAME_PROPERTY
  },
  additionalProperties: false
};
var HTTP_URL_RE = /^https?:\/\//i;
async function generateImageTool(args, cwd) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt)
    throw new Error("`prompt` is required.");
  const cfg = resolveLiteLlmConfig();
  const targetDir = typeof args.target_dir === "string" ? args.target_dir : cwd;
  const { dir, root, slug } = assetsDirFor(targetDir, typeof args.game === "string" ? args.game : undefined);
  const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : cfg.models.textToImage;
  let result;
  let mode;
  const inputImage = typeof args.image === "string" ? args.image.trim() : "";
  if (inputImage) {
    if (HTTP_URL_RE.test(inputImage)) {
      throw new Error("Image-to-image expects a LOCAL image path, not a URL. Download it first, then pass the path.");
    }
    if (!existsSync5(inputImage))
      throw new Error(`Input image not found: ${inputImage}`);
    const bytes = new Uint8Array(readFileSync8(inputImage));
    result = await editImage(cfg, { model, prompt, image: bytes, filename: basename2(inputImage) });
    mode = "image-to-image";
  } else {
    result = await generateImage(cfg, { model, prompt });
    mode = "text-to-image";
  }
  const stem = safeStem(typeof args.name === "string" ? args.name : undefined, prompt);
  const outPath = uniquePath(dir, stem, result.ext);
  writeFileSync5(outPath, result.bytes);
  const rel = relative5(root, outPath);
  return `Saved ${mode} asset to \`${rel}\` (game: ${slug}, model: ${model}, ${result.bytes.length} bytes). Reference it from game code by this path.`;
}
function imageContentType(path) {
  const ext = extname2(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg")
    return "image/jpeg";
  if (ext === ".webp")
    return "image/webp";
  return "image/png";
}
async function resolveImageUrlFor3d(image, slug) {
  if (HTTP_URL_RE.test(image))
    return image;
  if (!existsSync5(image))
    throw new Error(`Input image not found: ${image}`);
  const cos = resolveCosConfig();
  if (!cos) {
    throw new Error("Image-to-3D from a local file needs COS configured (FORGEAX_COS_BUCKET/REGION/SECRET_ID/SECRET_KEY) so the image can be hosted for the backend to fetch. Alternatively pass a public https URL.");
  }
  const bytes = new Uint8Array(readFileSync8(image));
  const stem = safeStem(basename2(image, extname2(image)), "input");
  const ext = (extname2(image).replace(".", "") || "png").toLowerCase();
  const key = `forgeax/${slug}/${stem}-${Date.now()}.${ext}`;
  return uploadAndPresign(cos, key, bytes, imageContentType(image));
}
async function generate3dTool(args, cwd) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const image = typeof args.image === "string" ? args.image.trim() : "";
  if (!prompt && !image)
    throw new Error("Provide `prompt` (text-to-3D) or `image` (image-to-3D).");
  const targetDir = typeof args.target_dir === "string" ? args.target_dir : cwd;
  const { dir, root, slug } = assetsDirFor(targetDir, typeof args.game === "string" ? args.game : undefined);
  const imageUrl = image ? await resolveImageUrlFor3d(image, slug) : undefined;
  const cfg = resolveLiteLlmConfig();
  let result;
  let mode;
  if (imageUrl) {
    const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : cfg.models.imageTo3d;
    result = await generate3dFromImageUrl(cfg, { model, imageUrl, prompt: prompt || undefined, onProgress: logProgress("image-to-3D") });
    mode = "image-to-3D";
  } else {
    const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : cfg.models.textTo3d;
    result = await generate3dFromText(cfg, { model, prompt, onProgress: logProgress("text-to-3D") });
    mode = "text-to-3D";
  }
  const stem = safeStem(typeof args.name === "string" ? args.name : undefined, prompt || "model");
  const outPath = uniquePath(dir, stem, result.ext);
  writeFileSync5(outPath, result.bytes);
  const rel = relative5(root, outPath);
  return `Saved ${mode} ${result.assetType} to \`${rel}\` (game: ${slug}, ${result.bytes.length} bytes). Reference it from game code by this path.`;
}

// src/mcp/game-files.ts
import { createHash as createHash5, randomUUID as randomUUID3 } from "node:crypto";
import {
  existsSync as existsSync6,
  lstatSync as lstatSync5,
  mkdirSync as mkdirSync6,
  readFileSync as readFileSync9,
  readdirSync as readdirSync5,
  renameSync as renameSync4,
  rmSync as rmSync4,
  statSync as statSync4,
  writeFileSync as writeFileSync6
} from "node:fs";
import { dirname as dirname7, extname as extname3, join as join8, relative as relative6, resolve as resolve7, sep as sep3 } from "node:path";
var MAX_TEXT_BYTES = 1024 * 1024;
var MAX_LISTED_FILES = 500;
var MAX_LOG_BYTES = 256 * 1024;
var BLOCKED_SEGMENTS = new Set(["node_modules", ".git", ".env", ".ssh", ".npmrc"]);
var TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".css",
  ".html",
  ".txt",
  ".glsl",
  ".wgsl",
  ".vert",
  ".frag",
  ".toml",
  ".yaml",
  ".yml"
]);
function sha256(content) {
  return createHash5("sha256").update(content).digest("hex");
}
function selectedGame(cwd, raw) {
  const project = resolveProject(cwd);
  if (!project.root)
    throw new Error(`no ForgeaX project found from ${cwd}`);
  const slug = typeof raw === "string" && raw !== "" ? raw : activeGame(project.root);
  if (!slug || !SLUG_RE.test(slug))
    throw new Error("game must name an existing game slug, or an active game must be selected");
  const dir = gameDir(project.root, slug);
  if (!dir)
    throw new Error(`game ${JSON.stringify(slug)} was not found`);
  return { root: project.root, slug, dir };
}
function safeSegments(raw) {
  if (typeof raw !== "string" || raw.trim() === "")
    throw new Error("path must be a non-empty relative path");
  if (raw.includes("\\") || raw.includes("\x00") || raw.startsWith("/")) {
    throw new Error("path must use relative POSIX segments");
  }
  const segments = raw.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("path contains an unsafe segment");
  }
  if (segments.some((segment) => segment.startsWith(".") || BLOCKED_SEGMENTS.has(segment))) {
    throw new Error("path targets a hidden or dependency-owned location");
  }
  if (!TEXT_EXTENSIONS.has(extname3(segments.at(-1)).toLowerCase())) {
    throw new Error("path must name a supported UTF-8 text file");
  }
  return segments;
}
function confinedPath(gameRoot, raw, allowMissing) {
  const segments = safeSegments(raw);
  const root = resolve7(gameRoot);
  const path = resolve7(root, ...segments);
  const rel = relative6(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep3}`))
    throw new Error("path escapes the game root");
  let cursor = root;
  for (const segment of segments) {
    cursor = join8(cursor, segment);
    if (!existsSync6(cursor)) {
      if (!allowMissing)
        throw new Error(`file does not exist: ${segments.join("/")}`);
      continue;
    }
    if (lstatSync5(cursor).isSymbolicLink())
      throw new Error("path traverses a symbolic link");
  }
  return { path, relativePath: segments.join("/") };
}
function listTextFiles(gameRoot) {
  const rows = [];
  const visit = (dir) => {
    for (const entry of readdirSync5(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (rows.length >= MAX_LISTED_FILES)
        return;
      if (entry.name.startsWith(".") || BLOCKED_SEGMENTS.has(entry.name) || entry.isSymbolicLink())
        continue;
      const path = join8(dir, entry.name);
      if (entry.isDirectory())
        visit(path);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(extname3(entry.name).toLowerCase())) {
        rows.push({ path: relative6(gameRoot, path).split(sep3).join("/"), bytes: statSync4(path).size });
      }
    }
  };
  visit(gameRoot);
  return rows;
}
function readGameFile(gameRoot, rawPath) {
  const file = confinedPath(gameRoot, rawPath, false);
  if (!statSync4(file.path).isFile())
    throw new Error(`path is not a file: ${file.relativePath}`);
  const content = readFileSync9(file.path);
  if (content.length > MAX_TEXT_BYTES)
    throw new Error(`file exceeds ${MAX_TEXT_BYTES} bytes`);
  if (content.includes(0))
    throw new Error("binary files are not readable through the text authoring tool");
  return { path: file.relativePath, bytes: content.length, sha256: sha256(content), content: content.toString("utf8") };
}
function readRuntimeLogs(cwd, rawLines) {
  const project = resolveProject(cwd);
  if (!project.root)
    throw new Error(`no ForgeaX project found from ${cwd}`);
  const lines = rawLines === undefined ? 200 : Number(rawLines);
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > 400)
    throw new Error("lines must be an integer from 1 to 400");
  const candidates = [
    join8(project.root, ".forgeax", "runtime", "stack.log"),
    join8(project.root, ".forgeax", "logs", "runtime", "runtime.log")
  ];
  const path = candidates.find((candidate) => existsSync6(candidate) && statSync4(candidate).isFile());
  if (!path)
    return { available: false, searched: candidates.map((candidate) => relative6(project.root, candidate)) };
  const size = statSync4(path).size;
  const content = readFileSync9(path);
  const tail = content.subarray(Math.max(0, content.length - MAX_LOG_BYTES)).toString("utf8");
  const rows = tail.split(/\r?\n/);
  if (rows.at(-1) === "")
    rows.pop();
  return {
    available: true,
    path: relative6(project.root, path).split(sep3).join("/"),
    bytes: size,
    truncatedBytes: content.length > MAX_LOG_BYTES,
    content: rows.slice(-lines).join(`
`)
  };
}
function writeGameFile(gameRoot, args) {
  const file = confinedPath(gameRoot, args.path, true);
  if (typeof args.content !== "string")
    throw new Error("content must be a string");
  const bytes = Buffer.byteLength(args.content);
  if (bytes > MAX_TEXT_BYTES)
    throw new Error(`content exceeds ${MAX_TEXT_BYTES} bytes`);
  const exists = existsSync6(file.path);
  if (exists) {
    if (!statSync4(file.path).isFile())
      throw new Error(`path is not a file: ${file.relativePath}`);
    if (typeof args.expected_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(args.expected_sha256)) {
      throw new Error("expected_sha256 is required when replacing an existing file");
    }
    const current = sha256(readFileSync9(file.path));
    if (current !== args.expected_sha256) {
      throw new Error(`file changed since it was read: expected ${args.expected_sha256}, current ${current}`);
    }
  } else if (args.expected_sha256 !== undefined) {
    throw new Error("expected_sha256 must be omitted when creating a new file");
  }
  mkdirSync6(dirname7(file.path), { recursive: true });
  const temporary = `${file.path}.${process.pid}.${randomUUID3()}.tmp`;
  try {
    writeFileSync6(temporary, args.content, { encoding: "utf8", flag: "wx" });
    renameSync4(temporary, file.path);
  } finally {
    rmSync4(temporary, { force: true });
  }
  return { path: file.relativePath, bytes, sha256: sha256(args.content), created: !exists };
}
var GAME_PROPERTY2 = {
  game: {
    type: "string",
    description: "Game slug. Defaults to the active game.",
    pattern: "^[a-z0-9][a-z0-9-]{0,40}$"
  }
};
function gameFileTools() {
  return [
    {
      name: "forgeax_game_list_files",
      description: "List editable files under one game. Hidden paths, dependencies, and symbolic links are excluded.",
      inputSchema: { type: "object", properties: { ...GAME_PROPERTY2 }, additionalProperties: false },
      run: (args, ctx) => {
        const game = selectedGame(ctx.cwd, args.game);
        const files = listTextFiles(game.dir);
        return { game: game.slug, files, truncated: files.length >= MAX_LISTED_FILES };
      }
    },
    {
      name: "forgeax_game_read_file",
      description: "Read one UTF-8 game file and return its SHA-256. Read before replacing a file.",
      inputSchema: {
        type: "object",
        properties: { ...GAME_PROPERTY2, path: { type: "string" } },
        required: ["path"],
        additionalProperties: false
      },
      run: (args, ctx) => {
        const game = selectedGame(ctx.cwd, args.game);
        return { game: game.slug, ...readGameFile(game.dir, args.path) };
      }
    },
    {
      name: "forgeax_game_read_logs",
      description: "Read the bounded tail of the supervisor or packaged Runtime log for the bound project.",
      inputSchema: {
        type: "object",
        properties: { lines: { type: "integer", minimum: 1, maximum: 400, default: 200 } },
        additionalProperties: false
      },
      run: (args, ctx) => readRuntimeLogs(ctx.cwd, args.lines)
    },
    {
      name: "forgeax_game_write_file",
      description: "Create or atomically replace one UTF-8 game file. Replacing requires the SHA-256 returned by forgeax_game_read_file.",
      inputSchema: {
        type: "object",
        properties: {
          ...GAME_PROPERTY2,
          path: { type: "string" },
          content: { type: "string" },
          expected_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }
        },
        required: ["path", "content"],
        additionalProperties: false
      },
      run: (args, ctx) => {
        const game = selectedGame(ctx.cwd, args.game);
        return { game: game.slug, ...writeGameFile(game.dir, args) };
      }
    }
  ];
}
// package.json
var package_default = {
  packageManager: "bun@1.4.0",
  name: "@forgeax/game",
  version: "0.3.10",
  private: false,
  type: "module",
  description: "@forgeax/game — an MCP/CLI connector for exact released ForgeaX Engine games and Engine-owned Preview.",
  main: "./dist/main.js",
  bin: {
    "forgeax-game": "dist/main.js",
    game: "dist/main.js"
  },
  engines: {
    node: ">=22.13.0"
  },
  publishConfig: {
    access: "public",
    registry: "https://registry.npmjs.org/"
  },
  files: [
    "dist",
    "assets",
    "docs/asset3d.md",
    "docs/plugin-integration-standard.md",
    "docs/engine-0.2.1-to-0.3.3-migration.md",
    "README.md"
  ],
  scripts: {
    build: "bun build.mjs",
    "release:check": "bun scripts/check-package-artifact.ts",
    acceptance: "bun scripts/accept-packed-consumer.ts",
    "release:publish": "bun scripts/publish-package.ts",
    prepack: "bun build.mjs",
    typecheck: "tsc --noEmit",
    test: "bun test test/*.test.ts",
    start: "bun src/main.ts",
    "mcp:inspect": "npx @modelcontextprotocol/inspector node dist/main.js"
  },
  keywords: [
    "forgeax",
    "mcp",
    "model-context-protocol",
    "game-development",
    "codex",
    "claude-code"
  ],
  license: "MIT",
  dependencies: {
    "@forgeax/engine-sdk": "0.3.3",
    pnpm: "11.7.0"
  },
  devDependencies: {
    fflate: "0.8.2",
    "@types/bun": "^1.2.0",
    typescript: "^5.9.2"
  },
  directories: {
    doc: "docs",
    test: "test"
  },
  author: ""
};

// src/install/release-manifest.ts
var RELEASE_IDENTITY_SCHEMA = "forgeax.game.release-identity/1";
var RELEASE_IDENTITY_URI = "forgeax://release-identity";
var RELEASE_IDENTITY_MIME = "application/vnd.forgeax.game-release-identity+json";
var RELEASE_IDENTITY = Object.freeze({
  schema: RELEASE_IDENTITY_SCHEMA,
  gamePackage: "@forgeax/game",
  gameVersion: package_default.version,
  gameBin: "forgeax-game",
  engineSdkPackage: ENGINE_SDK_PACKAGE,
  engineSdkVersion: ENGINE_VERSION,
  engineSourceCommit: ENGINE_COMMIT,
  carrierIntegrity: "sha512-G5ovsbdzkWWeMfFy3MxVk0qcAvWnZxJnlypMGgxFUDaKr3Wv9uVuhPV88LZ1A9mhFJJSfrE1d5R3WvHgulygRQ==",
  sdkManifestDigest: `sha256:${"0".repeat(64)}`,
  sdkTreeDigest: `sha256:${"0".repeat(64)}`,
  fullZipDigest: `sha256:${"0".repeat(64)}`,
  pnpmVersion: PNPM_VERSION,
  releaseDigest: `sha256:${"0".repeat(64)}`
});
var RELEASE_KEYS = Object.freeze([
  "schema",
  "gamePackage",
  "gameVersion",
  "gameBin",
  "engineSdkPackage",
  "engineSdkVersion",
  "engineSourceCommit",
  "carrierIntegrity",
  "sdkManifestDigest",
  "sdkTreeDigest",
  "fullZipDigest",
  "pnpmVersion",
  "releaseDigest"
]);
function releaseIdentityJson(identity = RELEASE_IDENTITY) {
  return `${JSON.stringify(identity)}
`;
}

// src/mcp/forgeax-server.ts
function publicPreviewResult(result, publicOrigin) {
  if (!publicOrigin)
    return result;
  let origin;
  try {
    origin = new URL(publicOrigin);
  } catch {
    return result;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:")
    return result;
  return result.replace(/^preview_url:\s+(\S+)$/m, (line, rawUrl) => {
    try {
      const local = new URL(rawUrl);
      return `preview_url: ${new URL(`${local.pathname}${local.search}${local.hash}`, origin).toString()}`;
    } catch {
      return line;
    }
  });
}
function packageVersion() {
  for (const relative7 of ["../package.json", "../../package.json"]) {
    try {
      const version = JSON.parse(readFileSync10(new URL(relative7, import.meta.url), "utf8")).version;
      if (version)
        return version;
    } catch {}
  }
  return "0.0.0";
}
var TARGET_DIR_PROPERTY = {
  target_dir: {
    type: "string",
    description: "Directory to resolve the ForgeaX project from. Defaults to the server working directory. Pass the user current working directory when it differs."
  }
};
function createForgeaxMcpServer(options = {}) {
  const allowTargetDir = options.allowTargetDir ?? options.root === undefined;
  const cwd = options.root ? resolve8(options.root) : undefined;
  const { target_dir: _targetDir, ...fixedRunProperties } = RUN_TOOL_SCHEMA.properties;
  const runInputSchema = allowTargetDir ? RUN_TOOL_SCHEMA : { ...RUN_TOOL_SCHEMA, properties: fixedRunProperties };
  return {
    serverInfo: { name: "forgeax", version: packageVersion() },
    instructions: ROUTING_TEXT,
    buildContext: () => ({ cwd: cwd ?? process.cwd() }),
    shutdown: stopTrackedEnginePreviews,
    resources: [
      {
        uri: RELEASE_IDENTITY_URI,
        name: "ForgeaX game release identity",
        description: "Immutable package, Engine, carrier, SDK, pnpm, and release digest identity. Readable before a game is bound; performs no discovery or network request.",
        mimeType: RELEASE_IDENTITY_MIME,
        read: () => releaseIdentityJson()
      },
      {
        uri: "forgeax://status",
        name: "ForgeaX status",
        description: "Preferred entry point. Game binding, exact Engine/DevKit/carrier identity, Preview state, development kit and routing-rule freshness, and the single next action. Read-only.",
        mimeType: "text/markdown",
        read: async (ctx) => renderStatus(await collectStatus(ctx.cwd))
      }
    ],
    tools: [
      {
        name: "forgeax_status_lite",
        description: "Compatibility fallback for clients that cannot read MCP resources; prefer the `forgeax://status` resource when available. Reports game binding, exact Engine/DevKit/carrier identity, Preview state, development kit and routing-rule freshness, and the next action. Read-only — never writes to the workspace.",
        inputSchema: {
          type: "object",
          properties: allowTargetDir ? { ...TARGET_DIR_PROPERTY } : {},
          additionalProperties: false
        },
        run: async (args, ctx) => {
          const dir = allowTargetDir && typeof args.target_dir === "string" ? args.target_dir : ctx.cwd;
          return renderStatus(await collectStatus(dir));
        }
      },
      {
        name: "forgeax_run_current_game",
        description: "Build and preview the active game through the exact released Engine CLI. The call runs the bounded Engine build, starts or reuses one release-aware verified Engine Preview child, and reports its exact Engine/build/instance identity plus state and log paths. Call this after a requested game change.",
        inputSchema: runInputSchema,
        run: async (args, ctx) => publicPreviewResult(await runCurrentGame(allowTargetDir ? args : { ...args, target_dir: ctx.cwd }, ctx.cwd), options.publicOrigin)
      },
      {
        name: "forgeax_generate_image",
        description: "Generate a game image asset from a text prompt (text-to-image), or edit a local image when `image` is set (image-to-image). Saves the PNG/JPG into the active game's `assets/` directory and returns its project-relative path to reference from game code. Backed by the ForgeaX LiteLLM gateway; requires FORGEAX_LITELLM_API_KEY. Use when the user asks for a sprite, texture, icon, background, or concept art.",
        inputSchema: GENERATE_IMAGE_SCHEMA,
        run: async (args, ctx) => generateImageTool(args, ctx.cwd)
      },
      {
        name: "forgeax_generate_3d",
        description: "Generate a 3D model (.glb) for the game. Provide `prompt` for text-to-3D, or `image` for image-to-3D — a public https URL, or a local file path when COS is configured (the file is uploaded and passed as a short-lived presigned URL). Runs the async generation to completion (~1–2 min) and saves the mesh into the active game's `assets/` directory, returning its project-relative path. Backed by the ForgeaX LiteLLM gateway; requires FORGEAX_LITELLM_API_KEY (and FORGEAX_COS_* for local-file image-to-3D).",
        inputSchema: GENERATE_3D_SCHEMA,
        run: async (args, ctx) => generate3dTool(args, ctx.cwd)
      },
      ...options.authoringTools ? gameFileTools() : []
    ]
  };
}

// src/mcp/http.ts
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
var DEFAULT_BODY_LIMIT = 1024 * 1024;
function loopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
function json(response, status, payload) {
  const body = `${JSON.stringify(payload)}
`;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION
  });
  response.end(body);
}
function unauthorized(response) {
  response.setHeader("www-authenticate", "Bearer");
  json(response, 401, { error: "unauthorized" });
}
function authorized(request2, token) {
  if (!token)
    return true;
  const header = request2.headers.authorization;
  if (!header?.startsWith("Bearer "))
    return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function originAllowed(request2, allowed) {
  const origin = request2.headers.origin;
  if (!origin)
    return true;
  return allowed.has(origin);
}
async function readMessage(request2, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request2) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit)
      throw new Error(`request body exceeds ${limit} bytes`);
    chunks.push(buffer);
  }
  if (chunks.length === 0)
    throw new Error("request body is empty");
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be one JSON-RPC object");
  }
  return value;
}
async function startHttpMcpServer(spec, options) {
  const endpointPath = options.path ?? "/mcp";
  const token = options.authToken?.trim() || undefined;
  if ((options.requireAuth || !loopbackHost(options.host)) && !token) {
    throw new Error("HTTP MCP authentication token is required for this listener");
  }
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const server = createServer((request2, response) => {
    (async () => {
      const requestPath = new URL(request2.url ?? "/", "http://mcp.invalid").pathname;
      if (requestPath === "/healthz") {
        json(response, 200, { status: "ok", name: spec.serverInfo.name, transport: "streamable-http" });
        return;
      }
      if (requestPath !== endpointPath) {
        json(response, 404, { error: "not_found" });
        return;
      }
      if (!originAllowed(request2, allowedOrigins)) {
        json(response, 403, { error: "origin_not_allowed" });
        return;
      }
      if (!authorized(request2, token)) {
        unauthorized(response);
        return;
      }
      if (request2.method !== "POST") {
        response.setHeader("allow", "POST");
        json(response, 405, { error: "method_not_allowed" });
        return;
      }
      if (!(request2.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(response, 415, { error: "content_type_must_be_application_json" });
        return;
      }
      let message;
      try {
        message = await readMessage(request2, bodyLimit);
      } catch (error) {
        json(response, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: errorMessage(error) }
        });
        return;
      }
      try {
        const result = await dispatch(spec, message);
        if (result === null) {
          response.writeHead(202, { "cache-control": "no-store", "mcp-protocol-version": MCP_PROTOCOL_VERSION });
          response.end();
          return;
        }
        json(response, 200, result);
      } catch (error) {
        json(response, 500, {
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32603, message: errorMessage(error) }
        });
      }
    })().catch((error) => {
      if (!response.headersSent) {
        json(response, 500, { error: "internal_error", message: errorMessage(error) });
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
  await new Promise((resolve9, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve9();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const displayHost = options.host === "::1" ? "[::1]" : options.host;
  const origin = `http://${displayHost}:${port}`;
  return {
    server,
    origin,
    url: `${origin}${endpointPath}`,
    close: () => new Promise((resolve9, reject) => {
      server.close((error) => error ? reject(error) : resolve9());
    })
  };
}

// src/cli/dispatch.ts
import { existsSync as existsSync9, readFileSync as readFileSync14, writeFileSync as writeFileSync10 } from "node:fs";
import { join as join11 } from "node:path";

// src/install/clients.ts
import { homedir as homedir2 } from "node:os";
import { join as join9, relative as relative7, resolve as resolve9, sep as sep4 } from "node:path";
import { lstatSync as lstatSync6, realpathSync as realpathSync6 } from "node:fs";
function configuredHome() {
  const configured = process.env.HOME || process.env.USERPROFILE || homedir2();
  try {
    return realpathSync6.native(resolve9(configured));
  } catch {
    return resolve9(configured);
  }
}
var INSTALL_CLIENT_IDS = ["codex", "cursor", "claude"];
function userPath(...parts) {
  return join9(configuredHome(), ...parts);
}
var CLIENTS = [
  {
    id: "codex",
    label: "Codex CLI",
    format: "toml",
    scope: "user",
    path: () => userPath(".codex", "config.toml"),
    commandShape: "split",
    postInstallNote: "Restart Codex, then run /mcp to confirm the server is connected."
  },
  {
    id: "claude",
    label: "the reference agent CLI",
    format: "json",
    scope: "user",
    path: () => userPath(".claude.json"),
    serverMapKey: ["mcpServers"],
    commandShape: "split",
    postInstallNote: "Restart the reference agent CLI, then run /mcp to confirm the server is connected."
  },
  {
    id: "cursor",
    label: "Cursor",
    format: "json",
    scope: "user",
    path: () => userPath(".cursor", "mcp.json"),
    serverMapKey: ["mcpServers"],
    commandShape: "split",
    postInstallNote: "Reload Cursor, then check Settings > MCP."
  },
  {
    id: "trae",
    label: "Trae (project)",
    format: "json",
    scope: "project",
    path: (projectRoot) => join9(projectRoot, ".trae", "mcp.json"),
    serverMapKey: ["mcpServers"],
    commandShape: "split",
    postInstallNote: "Reload Trae, then check the project MCP server list."
  },
  {
    id: "codebuddy",
    aliases: ["workbuddy"],
    label: "a peer agent CLI / WorkBuddy",
    format: "json",
    scope: "user",
    path: () => userPath(".codebuddy", ".mcp.json"),
    serverMapKey: ["mcpServers"],
    commandShape: "split",
    postInstallNote: "Restart a peer agent CLI or WorkBuddy, then run /mcp to confirm the server is connected."
  },
  {
    id: "windsurf",
    label: "Windsurf",
    format: "json",
    scope: "user",
    path: () => userPath(".codeium", "windsurf", "mcp_config.json"),
    serverMapKey: ["mcpServers"],
    commandShape: "split",
    postInstallNote: "Reload Windsurf to pick up the new server."
  },
  {
    id: "vscode",
    label: "VS Code (workspace)",
    format: "json",
    scope: "project",
    path: (projectRoot) => join9(projectRoot, ".vscode", "mcp.json"),
    serverMapKey: ["servers"],
    commandShape: "split",
    postInstallNote: 'Open .vscode/mcp.json and click Start, or run "MCP: List Servers".'
  },
  {
    id: "zcode",
    label: "ZCode",
    format: "json",
    scope: "user",
    path: () => userPath(".zcode", "cli", "config.json"),
    serverMapKey: ["mcp", "servers"],
    commandShape: "split",
    postInstallNote: "Start a new ZCode session, then run /mcp status to confirm the server is connected."
  },
  {
    id: "opencode",
    label: "OpenCode",
    format: "json",
    scope: "user",
    path: () => userPath(".config", "opencode", "opencode.json"),
    serverMapKey: ["mcp"],
    commandShape: "argv",
    extraEntryFields: { type: "local", enabled: true },
    postInstallNote: "Restart OpenCode to pick up the new server."
  }
];
var CLIENT_IDS = CLIENTS.map((c) => c.id);
var INSTALL_CLIENTS = INSTALL_CLIENT_IDS.map((id) => CLIENTS.find((client) => client.id === id));
var CLIENT_CHOICES = CLIENTS.flatMap((client) => [
  client.id,
  ...client.aliases ?? []
]);
function findClient(id) {
  return CLIENTS.find((client) => client.id === id || client.aliases?.includes(id));
}
var SERVER_KEY = "forgeax";
function launchSpec(mode) {
  if (mode === "local") {
    return { command: process.execPath, args: [resolve9(process.argv[1] ?? ""), "mcp"] };
  }
  return {
    command: "npx",
    args: ["-y", "-p", `@forgeax/game@${RELEASE_IDENTITY.gameVersion}`, "forgeax-game", "mcp"]
  };
}

// src/install/write-config.ts
import { copyFileSync as copyFileSync2, existsSync as existsSync7, mkdirSync as mkdirSync7, readFileSync as readFileSync11, writeFileSync as writeFileSync7 } from "node:fs";
import { basename as basename3, dirname as dirname8, isAbsolute as isAbsolute3, resolve as resolve10 } from "node:path";

// src/install/toml-section.ts
var HEADER_RE = /^[ \t]*\[([^[\]\r\n]+)\][ \t]*(?:#[^\r\n]*)?\r?$/gm;
function parseSimpleDottedKey(header) {
  const parts = header.split(/\s*\.\s*/);
  const decoded = [];
  for (const part of parts) {
    if (/^[A-Za-z0-9_-]+$/.test(part)) {
      decoded.push(part);
      continue;
    }
    if (part.startsWith('"') && part.endsWith('"')) {
      try {
        const jsonCompatible = part.replace(/\\U([0-9a-fA-F]{8})/g, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
        const value = JSON.parse(jsonCompatible);
        if (typeof value !== "string")
          return;
        decoded.push(value);
        continue;
      } catch {
        return;
      }
    }
    if (part.startsWith("'") && part.endsWith("'") && !part.slice(1, -1).includes("'")) {
      decoded.push(part.slice(1, -1));
      continue;
    }
    return;
  }
  return decoded;
}
function sameHeader(actual, expected) {
  const left = parseSimpleDottedKey(actual.trim());
  const right = parseSimpleDottedKey(expected.trim());
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}
function assignmentPath(line) {
  let quote;
  let escaped = false;
  for (let i = 0;i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote)
        quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#")
      return;
    if (char === "=")
      return parseSimpleDottedKey(line.slice(0, i).trim());
  }
  return;
}
function hasAssignment(content, expectedPath) {
  return content.split(/\r?\n/).some((line) => JSON.stringify(assignmentPath(line)) === JSON.stringify(expectedPath));
}
function hasCompetingInlineOwner(content, tableHeader, headerLines) {
  const path = parseSimpleDottedKey(tableHeader);
  if (!path || path.length < 2)
    return false;
  if (hasAssignment(content, path))
    return true;
  if (hasAssignment(content, [path[0]]))
    return true;
  const parent = path.slice(0, -1).join(".");
  const leaf = path.at(-1);
  const parentIndex = headerLines.findIndex((match) => sameHeader(match[1], parent));
  if (parentIndex < 0)
    return false;
  const start = headerLines[parentIndex].index + headerLines[parentIndex][0].length;
  const end = headerLines[parentIndex + 1]?.index ?? content.length;
  return hasAssignment(content.slice(start, end), [leaf]);
}
function encodeTomlString(value) {
  return JSON.stringify(value);
}
function encodeTomlStringArray(values) {
  return `[${values.map(encodeTomlString).join(", ")}]`;
}
function renderTable(table) {
  return [`[${table.header}]`, ...table.body].join(`
`);
}
function upsertTomlTable(content, table) {
  const rendered = renderTable(table);
  if (content.trim() === "")
    return `${rendered}
`;
  const headerLines = [...content.matchAll(HEADER_RE)];
  if (hasCompetingInlineOwner(content, table.header, headerLines)) {
    throw new Error(`TOML already defines [${table.header}] through an inline or parent-table key; refusing to append a duplicate table.`);
  }
  const ownedIndexes = headerLines.flatMap((match, index) => sameHeader(match[1], table.header) ? [index] : []);
  if (ownedIndexes.length > 1) {
    throw new Error(`TOML contains duplicate tables equivalent to [${table.header}]; fix the file before installing.`);
  }
  const ownedIndex = ownedIndexes[0] ?? -1;
  if (ownedIndex === -1) {
    return `${content}${content.endsWith(`
`) ? `
` : `

`}${rendered}
`;
  }
  const owned = headerLines[ownedIndex];
  const next = headerLines[ownedIndex + 1];
  const start = owned.index;
  const end = next?.index ?? content.length;
  const prefix = content.slice(0, start);
  const suffix = content.slice(end);
  const renderedOwned = [owned[0].replace(/\r$/, ""), ...table.body].join(`
`);
  return `${prefix}${renderedOwned}
${suffix ? `
` : ""}${suffix}`;
}
function hasTomlTable(content, header) {
  return [...content.matchAll(HEADER_RE)].some((match) => sameHeader(match[1], header));
}
function readTomlTable(content, header) {
  const headerLines = [...content.matchAll(HEADER_RE)];
  const ownedIndexes = headerLines.flatMap((match, index) => sameHeader(match[1], header) ? [index] : []);
  if (ownedIndexes.length !== 1)
    return;
  const ownedIndex = ownedIndexes[0];
  const owned = headerLines[ownedIndex];
  const next = headerLines[ownedIndex + 1];
  return content.slice(owned.index, next?.index ?? content.length);
}
function hasCompetingTomlDefinition(content, header) {
  const headerLines = [...content.matchAll(HEADER_RE)];
  return hasCompetingInlineOwner(content, header, headerLines);
}
function removeTomlTable(content, header) {
  const lines = content.split(`
`);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const isHeader = /^\[[^\]]+\]$/.test(trimmed);
    if (isHeader) {
      const name = trimmed.slice(1, -1).replace(/"/g, "");
      skipping = name === header || name.startsWith(`${header}.`);
      if (skipping)
        continue;
    }
    if (!skipping)
      out.push(line);
  }
  return out.join(`
`).replace(/\n{3,}/g, `

`);
}

// src/install/write-config.ts
var JSON_WHITESPACE = /^[ \t\r\n]*$/;
function buildEntry(spec, launch) {
  const command = spec.commandShape === "argv" ? { command: [launch.command, ...launch.args] } : { command: launch.command, args: [...launch.args] };
  return { ...command, ...spec.extraEntryFields ?? {} };
}

class JsonRangeParser {
  source;
  index = 0;
  constructor(source) {
    this.source = source;
  }
  parse() {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length)
      throw new Error("trailing data after JSON value");
    return value;
  }
  parseValue() {
    this.skipWhitespace();
    const start = this.index;
    const char = this.source[this.index];
    if (char === "{")
      return this.parseObject(start);
    if (char === "[")
      return this.parseArray(start);
    if (char === '"') {
      this.parseString();
      return { type: "primitive", start, end: this.index };
    }
    if (char === "-" || char !== undefined && /[0-9]/.test(char)) {
      this.parseNumber();
      return { type: "primitive", start, end: this.index };
    }
    for (const literal of ["true", "false", "null"]) {
      if (this.source.startsWith(literal, this.index)) {
        this.index += literal.length;
        return { type: "primitive", start, end: this.index };
      }
    }
    throw new Error(`unexpected JSON token at offset ${this.index}`);
  }
  parseObject(start) {
    this.index++;
    const members = [];
    const seen = new Set;
    this.skipWhitespace();
    if (this.source[this.index] === "}") {
      this.index++;
      return { type: "object", start, end: this.index, members };
    }
    while (this.index < this.source.length) {
      this.skipWhitespace();
      const keyStart = this.index;
      const encodedKey = this.parseString();
      let key;
      try {
        key = JSON.parse(encodedKey);
      } catch {
        throw new Error(`invalid JSON object key at offset ${keyStart}`);
      }
      if (typeof key !== "string")
        throw new Error(`JSON object key is not a string at offset ${keyStart}`);
      if (seen.has(key))
        throw new Error(`duplicate JSON object key ${JSON.stringify(key)}`);
      seen.add(key);
      const keyEnd = this.index;
      this.skipWhitespace();
      if (this.source[this.index] !== ":")
        throw new Error(`missing ':' after JSON key at offset ${this.index}`);
      this.index++;
      const value = this.parseValue();
      members.push({ key, keyStart, keyEnd, value });
      this.skipWhitespace();
      const delimiter2 = this.source[this.index];
      if (delimiter2 === "}") {
        this.index++;
        return { type: "object", start, end: this.index, members };
      }
      if (delimiter2 !== ",")
        throw new Error(`missing ',' in JSON object at offset ${this.index}`);
      this.index++;
      this.skipWhitespace();
      if (this.source[this.index] === "}")
        throw new Error(`trailing comma in JSON object at offset ${this.index}`);
    }
    throw new Error("unterminated JSON object");
  }
  parseArray(start) {
    this.index++;
    this.skipWhitespace();
    if (this.source[this.index] === "]") {
      this.index++;
      return { type: "array", start, end: this.index };
    }
    while (this.index < this.source.length) {
      this.parseValue();
      this.skipWhitespace();
      const delimiter2 = this.source[this.index];
      if (delimiter2 === "]") {
        this.index++;
        return { type: "array", start, end: this.index };
      }
      if (delimiter2 !== ",")
        throw new Error(`missing ',' in JSON array at offset ${this.index}`);
      this.index++;
      this.skipWhitespace();
      if (this.source[this.index] === "]")
        throw new Error(`trailing comma in JSON array at offset ${this.index}`);
    }
    throw new Error("unterminated JSON array");
  }
  parseString() {
    const start = this.index;
    if (this.source[this.index] !== '"')
      throw new Error(`expected JSON string at offset ${this.index}`);
    this.index++;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === '"') {
        this.index++;
        const encoded = this.source.slice(start, this.index);
        try {
          JSON.parse(encoded);
          return encoded;
        } catch {
          throw new Error(`invalid JSON string at offset ${start}`);
        }
      }
      if (char === "\\") {
        this.index += 1;
        if (this.index >= this.source.length)
          throw new Error(`unterminated JSON escape at offset ${start}`);
        if (this.source[this.index] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.source.slice(this.index + 1, this.index + 5))) {
            throw new Error(`invalid JSON unicode escape at offset ${this.index}`);
          }
          this.index += 5;
        } else {
          this.index += 1;
        }
        continue;
      }
      if (char.charCodeAt(0) < 32)
        throw new Error(`control character in JSON string at offset ${this.index}`);
      this.index++;
    }
    throw new Error(`unterminated JSON string at offset ${start}`);
  }
  parseNumber() {
    const remaining = this.source.slice(this.index);
    const match = remaining.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match)
      throw new Error(`invalid JSON number at offset ${this.index}`);
    this.index += match[0].length;
  }
  skipWhitespace() {
    while (this.index < this.source.length && /[ \t\r\n]/.test(this.source[this.index]))
      this.index++;
  }
}
function jsonObjectMembers(node, label) {
  if (node.type !== "object" || !node.members) {
    throw new Error(`${label} must be a JSON object; refusing to overwrite existing user data`);
  }
  return node.members;
}
function jsonMember(members, key, label) {
  const found = members.filter((member) => member.key === key);
  if (found.length > 1)
    throw new Error(`${label} contains duplicate ${JSON.stringify(key)} keys`);
  return found[0];
}
function replaceJsonValue(source, value, replacement) {
  return `${source.slice(0, value.start)}${replacement}${source.slice(value.end)}`;
}
function appendJsonMember(source, object, members, key, value) {
  const encoded = `${JSON.stringify(key)}:${value}`;
  if (members.length === 0) {
    return `${source.slice(0, object.start + 1)}${encoded}${source.slice(object.start + 1)}`;
  }
  const last = members[members.length - 1];
  return `${source.slice(0, last.value.end)},${encoded}${source.slice(last.value.end)}`;
}
function parseJsonForMerge(existing, path) {
  try {
    const root = new JsonRangeParser(existing).parse();
    return { source: existing, root };
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}
function validateTomlSyntax(source) {
  let quote;
  const brackets = [];
  for (let index = 0;index < source.length; index++) {
    const char = source[index];
    if (quote === "basic") {
      if (char === "\\") {
        index++;
        continue;
      }
      if (char === '"')
        quote = undefined;
      continue;
    }
    if (quote === "literal") {
      if (char === "'")
        quote = undefined;
      continue;
    }
    if (quote === "basic-multiline") {
      if (char === "\\") {
        index++;
        continue;
      }
      if (source.startsWith('"""', index)) {
        quote = undefined;
        index += 2;
      }
      continue;
    }
    if (quote === "literal-multiline") {
      if (source.startsWith("'''", index)) {
        quote = undefined;
        index += 2;
      }
      continue;
    }
    if (char === "#") {
      const newline = source.indexOf(`
`, index);
      if (newline < 0)
        break;
      index = newline;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        quote = "basic-multiline";
        index += 2;
      } else {
        quote = "basic";
      }
      continue;
    }
    if (char === "'") {
      if (source.startsWith("'''", index)) {
        quote = "literal-multiline";
        index += 2;
      } else {
        quote = "literal";
      }
      continue;
    }
    if (char === "[" || char === "{") {
      brackets.push(char);
      continue;
    }
    if (char === "]" || char === "}") {
      const opener = char === "]" ? "[" : "{";
      if (brackets.pop() !== opener)
        throw new Error(`unmatched TOML delimiter ${char} at offset ${index}`);
    }
  }
  if (quote)
    throw new Error("unterminated TOML string");
  if (brackets.length)
    throw new Error("unterminated TOML array or inline table");
}
function validTomlTableHeader(line) {
  const arrayTable = line.startsWith("[[");
  const openingWidth = arrayTable ? 2 : 1;
  let quote;
  for (let index = openingWidth;index < line.length; index++) {
    const char = line[index];
    if (quote === "basic") {
      if (char === "\\") {
        index++;
        continue;
      }
      if (char === '"')
        quote = undefined;
      continue;
    }
    if (quote === "literal") {
      if (char === "'")
        quote = undefined;
      continue;
    }
    if (char === '"') {
      quote = "basic";
      continue;
    }
    if (char === "'") {
      quote = "literal";
      continue;
    }
    const closes = arrayTable ? line.startsWith("]]", index) : char === "]";
    if (!closes)
      continue;
    const body = line.slice(openingWidth, index).trim();
    const suffix = line.slice(index + openingWidth);
    return body.length > 0 && /^[ \t]*(?:#.*)?$/.test(suffix);
  }
  return false;
}
function mergeJsonConfig(existing, spec, entry, serverKey = SERVER_KEY) {
  const path = spec.path("");
  const mapKey = spec.serverMapKey ?? ["mcpServers"];
  const wanted = JSON.stringify(entry);
  if (!existing || existing.trim() === "") {
    if (existing && JSON_WHITESPACE.test(existing)) {
      let nested2 = { [serverKey]: entry };
      for (let index = mapKey.length - 1;index >= 0; index--) {
        nested2 = { [mapKey[index]]: nested2 };
      }
      return { content: `${existing}${JSON.stringify(nested2)}
`, changed: true };
    }
    let nested = { [serverKey]: entry };
    for (let index = mapKey.length - 1;index >= 0; index--) {
      nested = { [mapKey[index]]: nested };
    }
    return { content: `${JSON.stringify(nested, null, 2)}
`, changed: true };
  }
  const { source, root } = parseJsonForMerge(existing, path);
  const rootMembers = jsonObjectMembers(root, `${path} top level`);
  let container = root;
  let members = rootMembers;
  for (let index = 0;index < mapKey.length; index++) {
    const key = mapKey[index];
    const found = jsonMember(members, key, path);
    if (!found) {
      let nested = { [serverKey]: entry };
      for (let nestedIndex = mapKey.length - 1;nestedIndex >= index; nestedIndex--) {
        nested = { [mapKey[nestedIndex]]: nested };
      }
      return {
        content: appendJsonMember(source, container, members, key, JSON.stringify(nested[key])),
        changed: true
      };
    }
    const nestedMembers = jsonObjectMembers(found.value, `${path}.${mapKey.slice(0, index + 1).join(".")}`);
    container = found.value;
    members = nestedMembers;
  }
  const mapMembers = members;
  const owned = jsonMember(mapMembers, serverKey, `${path}.${mapKey.join(".")}`);
  if (owned) {
    let before;
    try {
      before = JSON.parse(source.slice(owned.value.start, owned.value.end));
    } catch {
      throw new Error(`${path}.mcpServers.${serverKey} is not valid JSON`);
    }
    if (JSON.stringify(before) === wanted)
      return { content: existing, changed: false };
    return { content: replaceJsonValue(source, owned.value, wanted), changed: true };
  }
  return {
    content: appendJsonMember(source, container, mapMembers, serverKey, wanted),
    changed: true
  };
}
function mergeTomlConfig(existing, entry, serverKey = SERVER_KEY) {
  if (existing !== undefined && existing.trim() !== "") {
    validateTomlSyntax(existing);
    for (const [index, line] of existing.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[") && !validTomlTableHeader(trimmed)) {
        throw new Error(`line ${index + 1} has an invalid TOML table header`);
      }
    }
  }
  const body = [];
  const command = entry.command;
  if (typeof command === "string")
    body.push(`command = ${encodeTomlString(command)}`);
  const args = entry.args;
  if (Array.isArray(args))
    body.push(`args = ${encodeTomlStringArray(args)}`);
  const content = upsertTomlTable(existing ?? "", { header: `mcp_servers.${serverKey}`, body });
  return { content, changed: content !== (existing ?? "") };
}
function jsonServerEntry(parsed, spec, serverKey) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return;
  let cursor = parsed;
  for (const key of spec.serverMapKey ?? ["mcpServers"]) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor))
      return;
    cursor = cursor[key];
  }
  if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor))
    return;
  return cursor[serverKey];
}
function gameVersionFromEntryText(entry) {
  const pinned = entry.match(/@forgeax\/game@([0-9A-Za-z][0-9A-Za-z.+_-]*)/);
  if (pinned)
    return pinned[1];
  if (entry.includes("@forgeax/game"))
    return "unversioned";
  return "local/custom";
}
function configuredGameVersion(spec, projectRoot, serverKey = SERVER_KEY) {
  const path = spec.path(projectRoot);
  if (!existsSync7(path))
    return;
  try {
    const existing = readFileSync11(path, "utf8");
    if (spec.format === "toml") {
      const table = readTomlTable(existing, `mcp_servers.${serverKey}`);
      return table === undefined ? undefined : gameVersionFromEntryText(table);
    }
    const entry = jsonServerEntry(JSON.parse(existing), spec, serverKey);
    return entry === undefined ? undefined : gameVersionFromEntryText(JSON.stringify(entry));
  } catch {
    return;
  }
}
function inspectConfig(spec, projectRoot, launch, serverKey = SERVER_KEY) {
  const path = spec.path(projectRoot);
  if (!existsSync7(path))
    return { path, state: "missing" };
  let existing;
  try {
    existing = readFileSync11(path, "utf8");
    if (spec.format === "toml") {
      const header = `mcp_servers.${serverKey}`;
      if (!hasTomlTable(existing, header)) {
        if (hasCompetingTomlDefinition(existing, header)) {
          return {
            path,
            state: "invalid",
            detail: `${header} is defined through an unsupported inline or parent-table key`
          };
        }
        return { path, state: "not_configured" };
      }
      return {
        path,
        state: mergeTomlConfig(existing, buildEntry(spec, launch), serverKey).changed ? "different" : "current"
      };
    }
    const parsed = JSON.parse(existing);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { path, state: "invalid", detail: "top level is not a JSON object" };
    }
    const entry = jsonServerEntry(parsed, spec, serverKey);
    if (entry === undefined)
      return { path, state: "not_configured" };
    return {
      path,
      state: JSON.stringify(entry) === JSON.stringify(buildEntry(spec, launch)) ? "current" : "different"
    };
  } catch (error) {
    return { path, state: "invalid", detail: error instanceof Error ? error.message : String(error) };
  }
}
function applyConfig(spec, projectRoot, launch, serverKey = SERVER_KEY) {
  const path = spec.path(projectRoot);
  const existing = existsSync7(path) ? readFileSync11(path, "utf8") : undefined;
  const entry = buildEntry(spec, launch);
  const merged = spec.format === "toml" ? mergeTomlConfig(existing, entry, serverKey) : mergeJsonConfig(existing, spec, entry, serverKey);
  if (!merged.changed)
    return { path, changed: false };
  mkdirSync7(dirname8(path), { recursive: true });
  let backup;
  if (existing !== undefined) {
    backup = `${path}.bak.latest`;
    copyFileSync2(path, backup);
  }
  writeFileSync7(path, merged.content);
  return { path, changed: true, ...backup ? { backup } : {} };
}
function removeConfig(spec, projectRoot, serverKey = SERVER_KEY, backupSuffix = ".bak.latest") {
  const path = spec.path(projectRoot);
  if (!existsSync7(path))
    return { path, changed: false };
  const existing = readFileSync11(path, "utf8");
  let content;
  if (spec.format === "toml") {
    content = removeTomlTable(existing, `mcp_servers.${serverKey}`);
  } else {
    let parsed;
    try {
      parsed = JSON.parse(existing);
    } catch {
      return { path, changed: false };
    }
    let cursor = parsed;
    for (const key of spec.serverMapKey ?? ["mcpServers"]) {
      const next = cursor?.[key];
      if (!next || typeof next !== "object")
        return { path, changed: false };
      cursor = next;
    }
    if (!(serverKey in cursor))
      return { path, changed: false };
    delete cursor[serverKey];
    content = `${JSON.stringify(parsed, null, 2)}
`;
  }
  if (content === existing)
    return { path, changed: false };
  const backup = `${path}${backupSuffix}`;
  copyFileSync2(path, backup);
  writeFileSync7(path, content);
  return { path, changed: true, backup };
}
function retireAsset3dConfig(spec, projectRoot) {
  const key = "asset3d-search";
  const path = spec.path(projectRoot);
  if (!existsSync7(path))
    return "absent";
  try {
    const text = readFileSync11(path, "utf8");
    let entry;
    if (spec.format === "toml") {
      const table = readTomlTable(text, `mcp_servers.${key}`);
      if (table === undefined) {
        return hasCompetingTomlDefinition(text, `mcp_servers.${key}`) ? "preserved" : "absent";
      }
      const command2 = table.match(/^command\s*=\s*(".*")\s*$/m)?.[1];
      const args2 = table.match(/^args\s*=\s*(\[.*\])\s*$/m)?.[1];
      if (!command2 || !args2)
        return "preserved";
      entry = { command: JSON.parse(command2), args: JSON.parse(args2) };
      const expected = readTomlTable(mergeTomlConfig(undefined, entry, key).content, `mcp_servers.${key}`);
      if (table.trim() !== expected?.trim() || /^\s*\[.*asset3d-search.*\.\s*[\w"']/m.test(text))
        return "preserved";
    } else {
      entry = jsonServerEntry(JSON.parse(text), spec, key);
      if (entry === undefined)
        return "absent";
    }
    if (!entry || typeof entry !== "object")
      return "preserved";
    const command = spec.commandShape === "argv" && Array.isArray(entry.command) ? entry.command[0] : entry.command;
    const args = spec.commandShape === "argv" && Array.isArray(entry.command) ? entry.command.slice(1) : entry.args;
    if (typeof command !== "string" || !Array.isArray(args) || !args.every((x) => typeof x === "string"))
      return "preserved";
    const published = command === "npx" && args.length === 6 && args[0] === "-y" && args[1] === "-p" && /^@forgeax\/game@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(args[2]) && args[3] === "forgeax-game" && args[4] === "asset3d" && args[5] === "mcp";
    let local = false;
    if (isAbsolute3(command) && /^(node|node.exe)$/.test(basename3(command)) && args.length === 3 && isAbsolute3(args[0]) && args[1] === "asset3d" && args[2] === "mcp" && basename3(args[0]) === "main.js" && basename3(dirname8(args[0])) === "dist") {
      const pkg = JSON.parse(readFileSync11(resolve10(dirname8(args[0]), "..", "package.json"), "utf8"));
      local = pkg.name === "@forgeax/game";
    }
    if (!(published || local) || inspectConfig(spec, projectRoot, { command, args }, key).state !== "current")
      return "preserved";
    return removeConfig(spec, projectRoot, key, ".asset3d-retired.bak").changed ? "removed" : "absent";
  } catch {
    return "preserved";
  }
}

// src/install/verify.ts
import { spawn as spawn2 } from "node:child_process";
var REQUIRED_TOOLS = ["forgeax_status_lite", "forgeax_run_current_game"];
var REQUIRED_RESOURCES = ["forgeax://status"];
var INSTALL_VERIFY_TIMEOUT_MS = 120000;
function commandText(launch) {
  return [launch.command, ...launch.args].map((part) => JSON.stringify(part)).join(" ");
}
function rpcRequest(child, pending, id, method, params = {}) {
  return new Promise((resolve11, reject) => {
    pending.set(id, resolve11);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}
`, (error) => {
      if (!error)
        return;
      pending.delete(id);
      reject(error);
    });
  });
}
function namesFrom(result, key) {
  const entries = result?.[key];
  if (!Array.isArray(entries))
    return [];
  return entries.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null)
      return [];
    const record = entry;
    const value = key === "resources" ? record.uri : record.name;
    return typeof value === "string" ? [value] : [];
  });
}
async function verifyLaunch(launch, timeoutMs = 30000) {
  return verifyLaunchInternal(launch, timeoutMs, false);
}
async function verifyLaunchInternal(launch, timeoutMs, requireReleaseIdentity) {
  const child = spawn2(launch.command, [...launch.args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env
  });
  const pending = new Map;
  let stdout = "";
  let stderr = "";
  let settled = false;
  const failOnExit = new Promise((_, reject) => {
    child.once("error", (error) => reject(new Error(`could not launch ${commandText(launch)}: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (settled)
        return;
      const detail = stderr.trim();
      reject(new Error(`MCP server exited before handshake completed (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})${detail ? `: ${detail}` : ""}`));
    });
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16384);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf(`
`)) >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line)
        continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof response.id !== "number")
        continue;
      const resolve11 = pending.get(response.id);
      if (!resolve11)
        continue;
      pending.delete(response.id);
      resolve11(response);
    }
  });
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`MCP handshake timed out after ${timeoutMs}ms for ${commandText(launch)}`));
    }, timeoutMs);
    timer.unref?.();
  });
  const checked = (async () => {
    const handshake = [];
    const initialized = await rpcRequest(child, pending, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "forgeax-game-installer", version: "1" }
    });
    handshake.push("initialize");
    if (initialized.error)
      throw new Error(`initialize failed: ${initialized.error.message ?? initialized.error.code}`);
    const serverInfo = initialized.result?.serverInfo;
    if (typeof serverInfo !== "object" || serverInfo === null) {
      throw new Error("initialize response did not include serverInfo");
    }
    const info = serverInfo;
    if (info.name !== "forgeax") {
      throw new Error(`initialize returned unexpected server ${JSON.stringify(info.name)}`);
    }
    const toolsResponse = await rpcRequest(child, pending, 2, "tools/list");
    handshake.push("tools/list");
    if (toolsResponse.error) {
      throw new Error(`tools/list failed: ${toolsResponse.error.message ?? toolsResponse.error.code}`);
    }
    const tools = namesFrom(toolsResponse.result, "tools");
    const missingTools = REQUIRED_TOOLS.filter((name) => !tools.includes(name));
    if (missingTools.length)
      throw new Error(`MCP server is missing tools: ${missingTools.join(", ")}`);
    const resourcesResponse = await rpcRequest(child, pending, 3, "resources/list");
    handshake.push("resources/list");
    if (resourcesResponse.error) {
      throw new Error(`resources/list failed: ${resourcesResponse.error.message ?? resourcesResponse.error.code}`);
    }
    const resources = namesFrom(resourcesResponse.result, "resources");
    const missingResources = REQUIRED_RESOURCES.filter((uri) => !resources.includes(uri));
    if (missingResources.length) {
      throw new Error(`MCP server is missing resources: ${missingResources.join(", ")}`);
    }
    const base = {
      serverName: String(info.name),
      serverVersion: typeof info.version === "string" ? info.version : "unknown",
      tools,
      resources
    };
    if (!requireReleaseIdentity)
      return base;
    if (!resources.includes(RELEASE_IDENTITY_URI)) {
      throw new Error(`MCP server is missing resource: ${RELEASE_IDENTITY_URI}`);
    }
    const identityResponse = await rpcRequest(child, pending, 4, "resources/read", {
      uri: RELEASE_IDENTITY_URI
    });
    handshake.push("resources/read");
    if (identityResponse.error) {
      throw new Error(`resources/read failed: ${identityResponse.error.message ?? identityResponse.error.code}`);
    }
    const contents = identityResponse.result?.contents;
    if (!Array.isArray(contents) || contents.length !== 1) {
      throw new Error("release identity resource returned an unexpected content list");
    }
    const content = contents[0];
    if (typeof content !== "object" || content === null) {
      throw new Error("release identity resource returned a non-object content");
    }
    const record = content;
    if (record.uri !== RELEASE_IDENTITY_URI || record.mimeType !== RELEASE_IDENTITY_MIME) {
      throw new Error("release identity resource URI or media type mismatched");
    }
    if (typeof record.text !== "string")
      throw new Error("release identity resource did not return JSON text");
    let identity;
    try {
      identity = JSON.parse(record.text);
    } catch {
      throw new Error("release identity resource returned invalid JSON");
    }
    return {
      ...base,
      releaseIdentity: identity,
      releaseIdentityMimeType: String(record.mimeType),
      handshake
    };
  })();
  try {
    const result = await Promise.race([checked, failOnExit, timeout]);
    settled = true;
    return result;
  } finally {
    settled = true;
    pending.clear();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null)
      child.kill();
  }
}

// src/devkit/engine-mounts.ts
import { lstatSync as lstatSync7, readFileSync as readFileSync12, readdirSync as readdirSync6, readlinkSync as readlinkSync2, rmdirSync, unlinkSync as unlinkSync2, writeFileSync as writeFileSync8 } from "node:fs";
import { dirname as dirname9, join as join10, resolve as resolve11 } from "node:path";
var HOSTS = {
  ".agents/skills": ["codex"],
  ".claude/skills": ["claude"],
  ".cursor/skills": ["cursor"],
  ".codebuddy/skills": ["codebuddy", "workbuddy"],
  ".workbuddy/skills": ["workbuddy"]
};
function pruneUnselectedEngineMounts(root, clients) {
  const manifestPath = join10(root, ".forgeax", "skill-install-manifest.json");
  const regular = (path) => {
    try {
      const stat = lstatSync7(path);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  };
  const directory = (path) => {
    try {
      const stat = lstatSync7(path);
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  };
  if (!directory(join10(root, ".forgeax")) || !regular(manifestPath))
    return [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync12(manifestPath, "utf8"));
  } catch {
    return [];
  }
  if (!manifest || manifest.schemaVersion !== "1.0.0" || manifest.sourceRoot !== "skills" || !Array.isArray(manifest.mounts))
    return [];
  const removed = [];
  for (const mount of manifest.mounts) {
    if (!mount || typeof mount.root !== "string" || !Object.hasOwn(HOSTS, mount.root))
      continue;
    const hosts = HOSTS[mount.root];
    if (!hosts || hosts.some((host) => clients.includes(host)) || !Array.isArray(mount.skills))
      continue;
    if (!mount.skills.length || !mount.skills.every((id) => /^forgeax-engine-[a-z0-9-]+$/.test(id)) || new Set(mount.skills).size !== mount.skills.length)
      continue;
    const path = join10(root, mount.root);
    if (!directory(dirname9(path)) || !directory(path))
      continue;
    const expected = [".gitignore", ...mount.skills].sort();
    if (JSON.stringify(readdirSync6(path).sort()) !== JSON.stringify(expected))
      continue;
    const ignore = join10(path, ".gitignore");
    const expectedIgnore = ["# BEGIN FORGEAX MANAGED SKILLS", ...mount.skills.map((id) => `/${id}`), "# END FORGEAX MANAGED SKILLS", ""].join(`
`);
    if (!regular(ignore) || readFileSync12(ignore, "utf8") !== expectedIgnore)
      continue;
    if (!mount.skills.every((id) => {
      const link = join10(path, id);
      return lstatSync7(link).isSymbolicLink() && resolve11(path, readlinkSync2(link)) === resolve11(root, "skills", id);
    }))
      continue;
    for (const id of mount.skills)
      unlinkSync2(join10(path, id));
    unlinkSync2(ignore);
    rmdirSync(path);
    if (readdirSync6(dirname9(path)).length === 0)
      rmdirSync(dirname9(path));
    removed.push(mount.root);
  }
  if (removed.length) {
    manifest.mounts = manifest.mounts.filter((mount) => !mount || !removed.includes(mount.root));
    writeFileSync8(manifestPath, `${JSON.stringify(manifest, null, 2)}
`);
  }
  return removed;
}

// src/extensions/manager.ts
import { createHash as createHash6, randomUUID as randomUUID4 } from "node:crypto";
import { existsSync as existsSync8, lstatSync as lstatSync8, mkdirSync as mkdirSync8, readFileSync as readFileSync13, readdirSync as readdirSync7, realpathSync as realpathSync7, renameSync as renameSync5, rmSync as rmSync5, rmdirSync as rmdirSync2, writeFileSync as writeFileSync9 } from "node:fs";
import { dirname as dirname10, isAbsolute as isAbsolute4, relative as relative8, resolve as resolve12, sep as sep5 } from "node:path";
import { fileURLToPath as fileURLToPath3, pathToFileURL } from "node:url";
var mounts = {
  codex: ".agents/skills",
  claude: ".claude/skills",
  cursor: ".cursor/skills",
  trae: ".trae/skills",
  codebuddy: ".codebuddy/skills",
  windsurf: ".codeium/windsurf/skills",
  vscode: ".vscode/skills",
  zcode: ".zcode/skills",
  opencode: ".config/opencode/skills"
};
var reserved = new Set(["install", "init", "uninstall", "update", "use", "doctor", "preview", "devkit", "agents", "help", "version"]);
var validId = (id) => /^[a-z][a-z0-9-]{0,63}$/.test(id) && !reserved.has(id);
var digest = (data) => createHash6("sha256").update(data).digest("hex");
function safe(root, path) {
  const target = resolve12(root, path);
  const rel = relative8(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep5}`) || isAbsolute4(rel))
    throw new Error("extension_path_escape");
  let cursor = root;
  for (const part of rel.split(sep5)) {
    cursor = resolve12(cursor, part);
    try {
      if (lstatSync8(cursor).isSymbolicLink())
        throw new Error("extension_symlink_not_allowed");
    } catch (error) {
      if (error.code !== "ENOENT")
        throw error;
    }
  }
  return target;
}
function write(path, content) {
  mkdirSync8(dirname10(path), { recursive: true });
  const temp = `${path}.${randomUUID4()}.tmp`;
  writeFileSync9(temp, content, { mode: 384 });
  renameSync5(temp, path);
}
function json2(path) {
  const bytes = readFileSync13(path);
  if (bytes.length > 1024 * 1024)
    throw new Error("extension_state_too_large");
  return JSON.parse(bytes.toString());
}
function extensionRoot() {
  const here = dirname10(fileURLToPath3(import.meta.url));
  return [resolve12(here, "../assets/extensions"), resolve12(here, "../../extensions")].find(existsSync8) ?? resolve12(here, "../assets/extensions");
}
function discoverExtensions(root = extensionRoot()) {
  if (!existsSync8(root))
    return [];
  const found = [];
  for (const id of readdirSync7(root)) {
    if (!validId(id))
      continue;
    const directory = safe(root, id);
    if (!lstatSync8(directory).isDirectory())
      continue;
    const value = json2(safe(directory, "extension.json"));
    if (value.schemaVersion !== 1 || value.id !== id || typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version) || typeof value.cli !== "string" || !value.cli.endsWith(".mjs") || !Array.isArray(value.skills) || !value.skills.length || value.skills.some((s) => typeof s !== "string" || !/^skills\/[a-z][a-z0-9-]*$/.test(s))) {
      throw new Error(`extension_manifest_invalid: ${id}`);
    }
    safe(directory, value.cli);
    for (const skill of value.skills)
      safe(directory, skill + "/SKILL.md");
    found.push({ ...value, directory });
  }
  return found;
}
function extensionState(root, id) {
  if (!validId(id))
    throw new Error("extension_id_invalid");
  return safe(root, `.forgeax/extensions/${id}`);
}
function installation(root, id) {
  const path = safe(root, `.forgeax/extensions/${id}/install.json`);
  if (!existsSync8(path))
    return;
  const record = json2(path);
  if (record.schemaVersion !== 1 || record.id !== id || !Array.isArray(record.files))
    throw new Error("extension_install_invalid");
  for (const file of record.files) {
    if (typeof file.path !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !Object.values(mounts).some((mount) => file.path.startsWith(mount + "/")) || !file.path.endsWith("/SKILL.md"))
      throw new Error("extension_install_invalid");
    safe(root, file.path);
  }
  return record;
}
async function load(extension) {
  let entry = safe(extension.directory, extension.cli);
  if (!existsSync8(entry) && existsSync8(entry.replace(/\.mjs$/, ".ts")))
    entry = entry.replace(/\.mjs$/, ".ts");
  const mod = await import(pathToFileURL(entry).href);
  if (typeof mod.check !== "function" || typeof mod.run !== "function")
    throw new Error("extension_cli_invalid");
  return mod;
}
function context(root, id) {
  return { projectRoot: root, stateDir: extensionState(root, id), packageVersion: RELEASE_IDENTITY.gameVersion };
}
function lock(root) {
  const path = safe(realpathSync7(root), ".forgeax/extension-operation.lock");
  mkdirSync8(dirname10(path), { recursive: true });
  try {
    mkdirSync8(path);
  } catch {
    throw new Error("extension_busy: another operation or an interrupted lock requires attention");
  }
  return () => rmdirSync2(path);
}
var userState = () => resolve12(process.env.FORGEAX_USER_STATE_DIR ?? resolve12(configuredHome(), ".forgeax"));
var registryPath = () => resolve12(userState(), "extension-projects.json");
function registeredProjects() {
  if (!existsSync8(registryPath()))
    return [];
  const value = json2(registryPath());
  if (!Array.isArray(value) || value.some((p) => typeof p !== "string" || !isAbsolute4(p)))
    throw new Error("extension_registry_invalid");
  return value;
}
function register(root, enabled) {
  mkdirSync8(userState(), { recursive: true });
  safe(realpathSync7(userState()), "extension-projects.json");
  const projects = new Set(registeredProjects());
  enabled ? projects.add(root) : projects.delete(root);
  if (projects.size)
    write(registryPath(), JSON.stringify([...projects]) + `
`);
  else if (existsSync8(registryPath()))
    rmSync5(registryPath());
}
async function enableExtension(rootInput, extension, hosts, args, localEntry) {
  const release = lock(rootInput);
  try {
    return await enableUnlocked(rootInput, extension, hosts, args, localEntry);
  } finally {
    release();
  }
}
async function enableUnlocked(rootInput, extension, hosts, args, localEntry) {
  const root = realpathSync7(rootInput);
  const state = extensionState(root, extension.id);
  const previous = installation(root, extension.id);
  if (!hosts.length || hosts.some((host) => !mounts[host]))
    throw new Error("extension_host_required: select installed agents with --ide");
  const command = localEntry ? `node '${realpathSync7(localEntry).replaceAll("'", "'\\''")}' ${extension.id}` : `npx -y @forgeax/game@${RELEASE_IDENTITY.gameVersion} ${extension.id}`;
  const files = hosts.flatMap((host) => extension.skills.map((skill) => {
    const content = readFileSync13(safe(extension.directory, `${skill}/SKILL.md`), "utf8").replaceAll("{{CLI}}", command);
    return { path: `${mounts[host]}/${skill.slice("skills/".length)}/SKILL.md`, sha256: digest(content), content };
  }));
  for (const file of files) {
    const target = safe(root, file.path);
    if (existsSync8(target) && digest(readFileSync13(target)) !== previous?.files.find((f) => f.path === file.path)?.sha256) {
      throw new Error("extension_skill_conflict: " + file.path);
    }
  }
  const cli = await load(extension);
  const config = await cli.check(context(root, extension.id), args);
  const targets = new Map;
  const remember = (path) => {
    targets.set(path, existsSync8(path) ? readFileSync13(path) : undefined);
  };
  for (const file of files)
    remember(safe(root, file.path));
  remember(safe(root, `.forgeax/extensions/${extension.id}/config.json`));
  remember(safe(root, `.forgeax/extensions/${extension.id}/install.json`));
  try {
    write(resolve12(state, "config.json"), JSON.stringify(config) + `
`);
    for (const file of files)
      write(safe(root, file.path), file.content);
    const record = {
      schemaVersion: 1,
      id: extension.id,
      version: extension.version,
      packageVersion: RELEASE_IDENTITY.gameVersion,
      files: [...previous?.files.filter((f) => !files.some((n) => n.path === f.path)) ?? [], ...files.map(({ path, sha256: sha2562 }) => ({ path, sha256: sha2562 }))]
    };
    write(resolve12(state, "install.json"), JSON.stringify(record) + `
`);
    register(root, true);
  } catch (error) {
    for (const [path, old] of targets) {
      if (old)
        write(path, old.toString());
      else if (existsSync8(path))
        rmSync5(path);
    }
    throw error;
  }
  return { enabled: true, id: extension.id, version: extension.version, skillFiles: files.length };
}
function disableExtension(rootInput, id) {
  const release = lock(rootInput);
  try {
    return disableUnlocked(rootInput, id);
  } finally {
    release();
  }
}
function disableUnlocked(rootInput, id) {
  const root = realpathSync7(rootInput);
  const previous = installation(root, id);
  if (!previous)
    return { disabled: true, id, removed: 0, backups: [] };
  const backups = [];
  let removed = 0;
  for (const file of previous.files) {
    const path = safe(root, file.path);
    if (existsSync8(path)) {
      if (digest(readFileSync13(path)) !== file.sha256) {
        const backup = safe(root, `.forgeax/extension-backups/${id}/${randomUUID4()}/${file.path}`);
        mkdirSync8(dirname10(backup), { recursive: true });
        renameSync5(path, backup);
        backups.push(backup);
      } else
        rmSync5(path);
      removed++;
    }
    try {
      rmdirSync2(dirname10(path));
    } catch {}
  }
  rmSync5(extensionState(root, id), { recursive: true });
  const installed = installedExtensions(root);
  if (!installed.length)
    register(root, false);
  return { disabled: true, id, removed, backups };
}
function installedExtensions(root) {
  const dir = safe(root, ".forgeax/extensions");
  return existsSync8(dir) ? readdirSync7(dir).filter((id) => validId(id) && installation(root, id)) : [];
}
function disableAllExtensions(root) {
  return installedExtensions(root).map((id) => disableExtension(root, id));
}
async function runExtension(root, extension, args) {
  const release = lock(root);
  try {
    const record = installation(root, extension.id);
    if (!record)
      throw new Error("extension_not_enabled: run " + extension.id + " enable");
    if (record.version !== extension.version || record.packageVersion !== RELEASE_IDENTITY.gameVersion)
      throw new Error("extension_version_mismatch: enable with this version");
    return await (await load(extension)).run(context(root, extension.id), args);
  } finally {
    release();
  }
}

// src/cli/dispatch.ts
var HELP = `ForgeaX game development plugin

Usage:
  forgeax-game install [--ide ${CLIENT_CHOICES.join(",")}] [--local]
  forgeax-game uninstall [--ide ...] [--purge]
  forgeax-game uninstall --all-projects [--ide ...]
  forgeax-game <extension> enable [--ide ...] [--local] [extension options]
  forgeax-game <extension> disable
  forgeax-game <extension> <operation> [options]
  forgeax-game init
  forgeax-game use <slug>
  forgeax-game doctor
  forgeax-game preview stop [--game <slug>] [--target-dir <path>] [--json]
  forgeax-game devkit install
  forgeax-game agents update
  forgeax-game update [--ide ...]
  forgeax-game version
  forgeax-game help

With no arguments, forgeax-game runs the stdio MCP server.
`;
function parseInstallArgs(args) {
  let mode = "npx";
  let ids;
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    if (arg === "--local") {
      mode = "local";
      continue;
    }
    if (arg === "--ide") {
      const value = args[++i];
      if (!value)
        throw new Error("--ide requires a comma-separated client list");
      ids = value.split(",").map((id) => id.trim()).filter(Boolean);
      continue;
    }
    if (arg.startsWith("--ide=")) {
      ids = arg.slice("--ide=".length).split(",").map((id) => id.trim()).filter(Boolean);
      continue;
    }
    throw new Error(`unknown install option: ${arg}`);
  }
  const selected = ids ?? [...CLIENT_IDS];
  if (selected.length === 0)
    throw new Error("--ide did not name any clients");
  const uniqueNames = [...new Set(selected)];
  const unknown = uniqueNames.filter((id) => !findClient(id));
  if (unknown.length) {
    throw new Error(`unknown client${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Choose from ${CLIENT_CHOICES.join(", ")}.`);
  }
  const clients = uniqueNames.map((id) => findClient(id));
  return { clients: [...new Map(clients.map((client) => [client.id, client])).values()], mode };
}
function requireProject() {
  const project = resolveProject();
  if (!project.root) {
    throw new Error(`no released Engine game found searching upward from ${project.searchedFrom}; run this command inside a game created by the released Engine SDK`);
  }
  return project.root;
}
function updateAgentsFile(root) {
  const path = join11(root, "AGENTS.md");
  const existing = existsSync9(path) ? readFileSync14(path, "utf8") : undefined;
  const content = upsertBlock(existing, ROUTING_TEXT);
  if (content === existing)
    return { path, changed: false };
  writeFileSync10(path, content);
  return { path, changed: true };
}
function removeAgentsBlock(root) {
  const path = join11(root, "AGENTS.md");
  if (!existsSync9(path))
    return { path, changed: false };
  const existing = readFileSync14(path, "utf8");
  const content = removeBlock(existing);
  if (content === existing)
    return { path, changed: false };
  writeFileSync10(path, content);
  return { path, changed: true };
}
async function installCommand(args) {
  const parsed = parseInstallArgs(args);
  const launch = launchSpec(parsed.mode);
  process.stdout.write(`Verifying ${launch.command} ${launch.args.join(" ")} ...
`);
  const verified = await verifyLaunch(launch, INSTALL_VERIFY_TIMEOUT_MS);
  process.stdout.write(`Handshake OK: ${verified.serverName} ${verified.serverVersion}, ${verified.tools.length} tools, ${verified.resources.length} resource.
`);
  const project = resolveProject();
  let failures = 0;
  for (const client of parsed.clients) {
    if (client.scope === "project" && !project.root) {
      failures++;
      process.stderr.write(`FAIL ${client.label}: workspace config requires running install inside a ForgeaX project.
`);
      continue;
    }
    try {
      const result = applyConfig(client, project.root ?? process.cwd(), launch);
      retireAsset3dHost(client, project.root ?? process.cwd());
      process.stdout.write(`${result.changed ? "UPDATED" : "CURRENT"} ${client.label}: ${result.path}${result.backup ? ` (backup: ${result.backup})` : ""}
`);
      if (client.postInstallNote)
        process.stdout.write(`  ${client.postInstallNote}
`);
    } catch (error) {
      failures++;
      process.stderr.write(`FAIL ${client.label}: ${error instanceof Error ? error.message : String(error)}
`);
    }
  }
  if (project.root) {
    const devkit = installDevKit(project.root, parsed.clients.map((client) => client.id));
    const agents = updateAgentsFile(project.root);
    process.stdout.write(`${devkit.changed ? "UPDATED" : "CURRENT"} game development skills: ${devkit.skillIds.length} in ${devkit.skillsRoot}
  ${devkit.note}
`);
    process.stdout.write(`${agents.changed ? "UPDATED" : "CURRENT"} routing rules: ${agents.path}
`);
  } else {
    process.stdout.write("INFO no ForgeaX project is bound; project Skill/rules and AGENTS.md will be prepared after `forgeax-game init`.\n");
  }
  return failures === 0 ? 0 : 1;
}
async function initCommand(args) {
  if (args.length)
    throw new Error("usage: forgeax-game init");
  let binding = resolveProject();
  if (!binding.root) {
    await createEmptyGameWithCarrier(process.cwd());
    binding = resolveProject();
    if (!binding.root) {
      throw new Error("engine_sdk_new_succeeded_but_project_unbound: the created directory is not a released Engine game");
    }
  }
  const root = binding.root;
  const slug = activeGame(root);
  const selectedGame2 = slug ? gameDir(root, slug) : undefined;
  if (!slug || !selectedGame2)
    throw new Error("no active Engine game is available");
  const release = resolveEngineRelease(selectedGame2);
  const baseline = ensureAuthoringBaseline(selectedGame2);
  const agents = updateAgentsFile(root);
  const selection = selectClients(root, undefined);
  reportMissingClients(selection.missing);
  const hosts = selection.selected;
  const devkit = installDevKit(root, hosts);
  const removedMounts = pruneUnselectedEngineMounts(root, hosts);
  if (removedMounts.length)
    process.stdout.write(`Removed unused Engine-generated skill mounts: ${removedMounts.join(", ")}.
`);
  process.stdout.write(`Bound Engine game ${slug} at ${selectedGame2}.
`);
  process.stdout.write(`Engine ${release.version} (${release.commit}).
`);
  process.stdout.write(`Authoring baseline: ${baseline}.
`);
  process.stdout.write(`${agents.changed ? "Updated" : "Kept current"} routing rules in ${agents.path}.
`);
  if (hosts.length === 0) {
    process.stdout.write(selection.missing.length ? `None of the named clients is installed, so no skills were installed.
` : "No agent client is configured yet, so no skills were installed. Run `forgeax-game install --ide <hosts>`.\n");
  } else {
    process.stdout.write(`${devkit.changed ? "Updated" : "Kept current"} ${devkit.skillIds.length} game development skills for: ${hosts.join(", ")}.
`);
    process.stdout.write(`${devkit.note}
`);
  }
  return 0;
}
async function useCommand(args) {
  if (args.length !== 1)
    throw new Error("usage: forgeax-game use <slug>");
  const slug = args[0];
  if (!SLUG_RE.test(slug))
    throw new Error(`invalid game slug: ${slug}`);
  const root = requireProject();
  if (!gameDir(root, slug)) {
    throw new Error(`game ${JSON.stringify(slug)} not found. Available: ${listGames(root).join(", ") || "(none)"}`);
  }
  if (listGames(root).length > 1) {
    writeFileSync10(join11(root, ".forgeax", "active-game.json"), `${JSON.stringify({ version: 1, slug }, null, 2)}
`, "utf8");
  }
  process.stdout.write(`Active game: ${slug}
`);
  return 0;
}
async function previewCommand(args) {
  if (args[0] !== "stop") {
    throw new Error("usage: forgeax-game preview stop [--game <slug>] [--target-dir <path>] [--json]");
  }
  let requested;
  let targetDir;
  let json3 = false;
  for (let index = 1;index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") {
      json3 = true;
      continue;
    }
    if (arg === "--game" || arg === "--target-dir") {
      const value = args[++index];
      if (!value)
        throw new Error(`${arg} requires a value`);
      if (arg === "--game")
        requested = value;
      else
        targetDir = value;
      continue;
    }
    throw new Error("usage: forgeax-game preview stop [--game <slug>] [--target-dir <path>] [--json]");
  }
  const project = resolveProject(targetDir);
  if (!project.root)
    throw new Error("no ForgeaX project or Engine game found");
  const slug = requested ?? activeGame(project.root) ?? listGames(project.root)[0];
  const selectedGame2 = slug ? gameDir(project.root, slug) : undefined;
  if (!slug || !selectedGame2)
    throw new Error("no matching Engine game found");
  const result = await stopEnginePreview(project.root, selectedGame2);
  const envelope = { schemaVersion: "1.0.0", command: "preview.stop", ok: true, value: { game: slug, stopped: result.stopped, stateFile: result.paths.state } };
  process.stdout.write(json3 ? `${JSON.stringify(envelope)}
` : `${result.stopped ? "Stopped" : "No live"} Engine Preview for ${slug}.
`);
  return 0;
}
async function agentsCommand(args) {
  if (args.length !== 1 || args[0] !== "update") {
    throw new Error("usage: forgeax-game agents update");
  }
  const result = updateAgentsFile(requireProject());
  process.stdout.write(`${result.changed ? "Updated" : "Already current"}: ${result.path}
`);
  return 0;
}
async function devkitCommand(args) {
  if (args.length !== 1 || args[0] !== "install") {
    throw new Error("usage: forgeax-game devkit install");
  }
  const root = requireProject();
  const result = installDevKit(root, configuredClientIds(root));
  const agents = updateAgentsFile(root);
  process.stdout.write(`${result.changed ? "UPDATED" : "CURRENT"} game development skills: ${result.skillIds.length} in ${result.skillsRoot}
`);
  process.stdout.write(`${result.note}
`);
  process.stdout.write(`${agents.changed ? "UPDATED" : "CURRENT"} routing rules: ${agents.path}
`);
  return 0;
}
function configuredClientIds(projectRoot) {
  const npx = launchSpec("npx");
  const local = launchSpec("local");
  return CLIENTS.filter((client) => [npx, local].some((launch) => inspectConfig(client, projectRoot, launch).state === "current")).map((client) => client.id);
}
async function uninstallCommand(args) {
  const purge = args.includes("--purge");
  const allProjects = args.includes("--all-projects");
  const rest = args.filter((arg) => arg !== "--purge" && arg !== "--all-projects");
  const requested = parseIdeSelector(rest, "usage: forgeax-game uninstall [--ide codex,claude,...] [--purge]");
  const binding = resolveProject();
  const root = binding.root;
  const targets = requested ? requested.map((id) => id === "workbuddy" ? "codebuddy" : id) : root ? configuredClientIds(root) : [...CLIENT_IDS];
  const clients = CLIENTS.filter((client) => targets.includes(client.id));
  let failures = 0;
  const projects = allProjects ? registeredProjects() : root ? [root] : [];
  for (const project of projects) {
    try {
      const removed = disableAllExtensions(project);
      process.stdout.write(`DISABLED ${removed.length} extensions: ${project}
`);
      for (const item of removed)
        for (const backup of item.backups)
          process.stdout.write(`BACKUP ${backup}
`);
      if (allProjects && project !== root) {
        removeDevKit(project);
        removeAgentsBlock(project);
      }
    } catch (error) {
      failures++;
      process.stderr.write(`FAIL extension cleanup: ${project}: ${error instanceof Error ? error.message : String(error)}
`);
    }
  }
  for (const client of clients) {
    try {
      const result = removeConfig(client, root ?? process.cwd());
      process.stdout.write(`${result.changed ? "REMOVED" : "ABSENT "} ${client.label}: ${result.path}
`);
    } catch (error) {
      failures++;
      process.stderr.write(`FAIL ${client.label}: ${error instanceof Error ? error.message : String(error)}
`);
    }
  }
  if (root) {
    const removal = removeDevKit(root);
    process.stdout.write(`REMOVED ${removal.skillCount} skill/rule entries from ${removal.removed.length} host mounts
`);
    const agents = removeAgentsBlock(root);
    process.stdout.write(`${agents.changed ? "REMOVED" : "ABSENT "} routing block: ${agents.path}
`);
    process.stdout.write(`KEPT    your games and project metadata: ${join11(root, ".forgeax")}
`);
  } else {
    process.stdout.write(`INFO  no ForgeaX project bound; only client configuration was touched.
`);
  }
  if (purge && root) {
    const slug = activeGame(root);
    const selectedGame2 = slug ? gameDir(root, slug) : undefined;
    if (selectedGame2) {
      const stopped = await stopEnginePreview(root, selectedGame2);
      process.stdout.write(`${stopped.stopped ? "STOPPED" : "ABSENT "} Engine Preview: ${stopped.paths.state}
`);
    }
  }
  process.stdout.write(`Restart your agent client so it drops the forgeax MCP server.
`);
  return failures === 0 ? 0 : 1;
}
function parseIdeSelector(args, usage) {
  let ids;
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    if (arg === "--ide") {
      const value = args[++i];
      if (!value)
        throw new Error("--ide requires a comma-separated client list");
      ids = value.split(",").map((id) => id.trim()).filter(Boolean);
      continue;
    }
    if (arg.startsWith("--ide=")) {
      ids = arg.slice("--ide=".length).split(",").map((id) => id.trim()).filter(Boolean);
      continue;
    }
    throw new Error(usage);
  }
  if (!ids)
    return;
  const unique = [...new Set(ids)];
  const unknown = unique.filter((id) => !findClient(id));
  if (unknown.length) {
    throw new Error(`unknown client${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Choose from ${CLIENT_CHOICES.join(", ")}.`);
  }
  return unique;
}
function selectClients(projectRoot, requested) {
  const configured = new Set(configuredClientIds(projectRoot));
  if (!requested)
    return { selected: [...configured], missing: [] };
  const canonical = requested.map((id) => id === "workbuddy" ? "codebuddy" : id);
  return {
    selected: canonical.filter((id) => configured.has(id)),
    missing: canonical.filter((id) => !configured.has(id))
  };
}
function reportMissingClients(missing) {
  for (const id of missing) {
    const label = findClient(id)?.label ?? id;
    process.stdout.write(`SKIPPED ${label}: not installed yet. Run \`forgeax-game install --ide ${id}\` first, then re-run this command.
`);
  }
}
function doctorConfigState(client, root, npxLaunch, localLaunch) {
  const npx = inspectConfig(client, root, npxLaunch);
  if (npx.state === "current") {
    return { line: `OK ${client.label}: ${npx.path} (npx)`, configured: true, warning: false };
  }
  const local = inspectConfig(client, root, localLaunch);
  if (local.state === "current") {
    return { line: `OK ${client.label}: ${local.path} (local binary)`, configured: true, warning: false };
  }
  if ((npx.state === "missing" || npx.state === "not_configured") && (local.state === "missing" || local.state === "not_configured")) {
    return {
      line: `INFO ${client.label}: not configured (${npx.path})`,
      configured: false,
      warning: false
    };
  }
  const detail = npx.detail ? `: ${npx.detail}` : "";
  return {
    line: `WARN ${client.label}: ${npx.path} (${npx.state}${detail})`,
    configured: true,
    warning: true
  };
}
async function doctorCommand(args) {
  if (args.length)
    throw new Error("usage: forgeax-game doctor");
  let warnings = 0;
  const [major = 0, minor = 0] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  if (major > 22 || major === 22 && minor >= 13)
    process.stdout.write(`OK Node ${process.versions.node}
`);
  else {
    warnings++;
    process.stdout.write(`FAIL Node ${process.versions.node}; Node 22.13 or newer is required
`);
  }
  const project = resolveProject();
  if (project.root) {
    process.stdout.write(`OK project ${project.root}; active=${activeGame(project.root) ?? "(none)"}; games=${listGames(project.root).join(", ") || "(none)"}
`);
    if (hasDevKit(project.root)) {
      const engine = installedEngineSkills(project.root);
      const bundled = bundledEngineSkillCount(project.root);
      process.stdout.write(`OK game development skill installed; Engine authoring skills: ${engine.length}
`);
      if (engine.length < bundled) {
        warnings++;
        process.stdout.write(`WARN this build bundles ${bundled} Engine authoring skills but only ${engine.length} are installed; run \`forgeax-game devkit install\`
`);
      }
    } else {
      warnings++;
      process.stdout.write("WARN game development skill missing; run `forgeax-game devkit install`\n");
    }
  } else {
    warnings++;
    process.stdout.write(`WARN no released Engine game found from ${project.searchedFrom}
`);
  }
  if (project.root) {
    const slug = activeGame(project.root);
    const selectedGame2 = slug ? gameDir(project.root, slug) : undefined;
    try {
      if (!selectedGame2)
        throw new Error("no active Engine game");
      const release = resolveEngineRelease(selectedGame2);
      process.stdout.write(`OK Engine ${release.version} (${release.commit})
`);
      const preview = inspectEnginePreview(project.root, selectedGame2);
      process.stdout.write(`${preview.processLive && preview.processIdentityMatches ? "OK" : "INFO"} Engine Preview ${preview.processLive ? "live" : "not running"} (${preview.paths.state})
`);
    } catch (error) {
      warnings++;
      process.stdout.write(`WARN ${error instanceof Error ? error.message : String(error)}
`);
    }
  }
  const root = project.root ?? process.cwd();
  const npxLaunch = launchSpec("npx");
  const localLaunch = launchSpec("local");
  let configuredClients = 0;
  for (const client of CLIENTS) {
    if (client.scope === "project" && !project.root) {
      process.stdout.write(`INFO ${client.label}: workspace config not checked without a project
`);
      continue;
    }
    const result = doctorConfigState(client, root, npxLaunch, localLaunch);
    if (result.configured)
      configuredClients++;
    if (result.warning)
      warnings++;
    process.stdout.write(`${result.line}
`);
  }
  if (configuredClients === 0) {
    warnings++;
    process.stdout.write("WARN no MCP client is configured; run `forgeax-game install --ide <client>`\n");
  }
  return warnings === 0 ? 0 : 1;
}
var UPDATE_USAGE = "usage: forgeax-game update [--ide codex,claude,cursor,...]";
function retireAsset3dHost(client, root) {
  const state = retireAsset3dConfig(client, root);
  if (state === "removed")
    process.stdout.write(`REMOVED ${client.label}: retired asset3d-search MCP; assets now use the project Skill + CLI. Restart the client.
`);
  if (state === "preserved")
    process.stderr.write(`WARN ${client.label}: asset3d-search is not an exact recognized package launcher; preserved for manual review.
`);
}
function versionCommand(args) {
  if (args.length > 0)
    throw new Error("usage: forgeax-game version");
  process.stdout.write(`${RELEASE_IDENTITY.gamePackage} ${RELEASE_IDENTITY.gameVersion}
`);
  return 0;
}
function formatVersionTransition(previousVersion, currentVersion = RELEASE_IDENTITY.gameVersion) {
  return previousVersion === currentVersion ? currentVersion : `${previousVersion ?? "unknown"} -> ${currentVersion}`;
}
async function updateCommand(args) {
  const requested = parseIdeSelector(args, UPDATE_USAGE);
  const project = resolveProject();
  const root = project.root ?? process.cwd();
  const launch = launchSpec("npx");
  const wanted = requested ? new Set(requested.map((id) => id === "workbuddy" ? "codebuddy" : id)) : undefined;
  const configured = CLIENTS.filter((client) => {
    if (client.scope === "project" && !project.root)
      return false;
    if (wanted && !wanted.has(client.id))
      return false;
    const state = inspectConfig(client, root, launch).state;
    return state === "current" || state === "different";
  });
  if (wanted) {
    reportMissingClients([...wanted].filter((id) => !configured.some((client) => client.id === id)));
  }
  if (configured.length === 0) {
    throw new Error(wanted ? "none of the named clients is installed; run `forgeax-game install --ide <client>` first" : "no ForgeaX client configuration found; run `forgeax-game install --ide <client>` first");
  }
  process.stdout.write(`Verifying current published launch command before changing configuration ...
`);
  await verifyLaunch(launch);
  for (const client of configured) {
    const previousVersion = configuredGameVersion(client, root);
    const result = applyConfig(client, root, launch);
    retireAsset3dHost(client, root);
    process.stdout.write(`${result.changed ? "UPDATED" : "CURRENT"} ${client.label}: ${result.path} (plugin ${formatVersionTransition(previousVersion)})
`);
  }
  if (project.root) {
    const devkit = installDevKit(project.root, configured.map((client) => client.id));
    const agents = updateAgentsFile(project.root);
    process.stdout.write(`${devkit.changed ? "UPDATED" : "CURRENT"} game development skills: ${devkit.skillIds.length} in ${devkit.skillsRoot}
`);
    process.stdout.write(`${devkit.note}
`);
    process.stdout.write(`${agents.changed ? "UPDATED" : "CURRENT"} routing rules: ${agents.path}
`);
  } else {
    process.stdout.write(`Skipped AGENTS.md routing update: no ForgeaX project is bound.
`);
  }
  return 0;
}
async function extensionCommand(id, args) {
  const pretty = args.includes("--pretty");
  args = args.filter((arg) => arg !== "--pretty");
  const [operation, ...rest] = args;
  const emit = (ok, value) => process.stdout.write(JSON.stringify({
    schemaVersion: "1.0.0",
    command: `${id}.${operation}`,
    ok,
    ...ok ? { value } : { error: value }
  }, null, pretty ? 2 : undefined) + `
`);
  try {
    const extension = discoverExtensions().find((item) => item.id === id);
    if (operation === "help" || operation === "--help") {
      process.stdout.write(`${id}: enable [--ide ...] [--local], disable, or a business operation documented in its Skill. Add --pretty for readable JSON; values and exit status are unchanged.
`);
      return 0;
    }
    const root = requireProject();
    if (operation === "enable") {
      const options = [];
      let hosts;
      let local = false;
      for (let i = 0;i < rest.length; i++) {
        const arg = rest[i];
        if (arg === "--local")
          local = true;
        else if (arg === "--ide" || arg.startsWith("--ide=")) {
          const value = arg === "--ide" ? rest[++i] : arg.slice(6);
          if (!value)
            throw new Error("extension_host_required");
          hosts = value.split(",").map((name) => {
            const client = findClient(name);
            if (!client)
              throw new Error("extension_host_invalid: " + name);
            return client.id;
          });
        } else
          options.push(arg);
      }
      const selected = [...new Set(hosts ?? selectClients(root, undefined).selected)];
      local ||= selected.some((host) => inspectConfig(findClient(host), root, launchSpec("local")).state === "current");
      emit(true, await enableExtension(root, extension, selected, options, local ? launchSpec("local").args[0] : undefined));
    } else if (operation === "disable") {
      if (rest.some((arg) => arg !== "--json"))
        throw new Error("extension_arguments_invalid");
      emit(true, disableExtension(root, id));
    } else {
      const value = await runExtension(root, extension, args);
      const failed = value && typeof value === "object" && "failed" in value && Number(value.failed) > 0;
      emit(!failed, value);
      if (failed)
        return 1;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(false, { code: message.split(":")[0], message: message.slice(0, 256) });
    return 1;
  }
}
async function runCli(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "install":
      return installCommand(args);
    case "init":
      return initCommand(args);
    case "use":
      return useCommand(args);
    case "uninstall":
      return uninstallCommand(args);
    case "doctor":
      return doctorCommand(args);
    case "preview":
      return previewCommand(args);
    case "devkit":
      return devkitCommand(args);
    case "agents":
      return agentsCommand(args);
    case "update":
      return updateCommand(args);
    case "version":
    case "--version":
    case "-v":
      return versionCommand(args);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      if (command && discoverExtensions().some((extension) => extension.id === command))
        return extensionCommand(command, args);
      process.stderr.write(`Unknown command: ${command ?? "(none)"}

${HELP}`);
      return 2;
  }
}

// src/main.ts
var argv = process.argv.slice(2);
function valueAfter(args, index, option) {
  const value = args[index + 1];
  if (!value)
    throw new Error(`${option} requires a value`);
  return value;
}
function parsePort(raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) {
    throw new Error(`MCP HTTP port must be an integer from 0 to 65535, got ${raw}`);
  }
  return value;
}
function parseMcpArgs(args) {
  let transport = "stdio";
  let host = process.env.FORGEAX_MCP_HOST?.trim() || "127.0.0.1";
  let port = parsePort(process.env.FORGEAX_MCP_PORT?.trim() || "18940");
  let root = process.env.FORGEAX_MCP_ROOT?.trim() || process.cwd();
  let requireAuth = process.env.FORGEAX_MCP_REQUIRE_AUTH === "1";
  let allowedOrigins = (process.env.FORGEAX_MCP_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    if (arg === "--transport") {
      const value = valueAfter(args, i, arg);
      if (value !== "stdio" && value !== "http")
        throw new Error("--transport must be stdio or http");
      transport = value;
      i++;
    } else if (arg.startsWith("--transport=")) {
      const value = arg.slice("--transport=".length);
      if (value !== "stdio" && value !== "http")
        throw new Error("--transport must be stdio or http");
      transport = value;
    } else if (arg === "--host") {
      host = valueAfter(args, i, arg);
      i++;
    } else if (arg.startsWith("--host="))
      host = arg.slice("--host=".length);
    else if (arg === "--port") {
      port = parsePort(valueAfter(args, i, arg));
      i++;
    } else if (arg.startsWith("--port="))
      port = parsePort(arg.slice("--port=".length));
    else if (arg === "--root") {
      root = valueAfter(args, i, arg);
      i++;
    } else if (arg.startsWith("--root="))
      root = arg.slice("--root=".length);
    else if (arg === "--require-auth")
      requireAuth = true;
    else if (arg === "--allowed-origin") {
      allowedOrigins = [...allowedOrigins, valueAfter(args, i, arg)];
      i++;
    } else if (arg.startsWith("--allowed-origin=")) {
      allowedOrigins = [...allowedOrigins, arg.slice("--allowed-origin=".length)];
    } else
      throw new Error(`unknown MCP option: ${arg}`);
  }
  return { transport, host, port, root: resolve14(root), requireAuth, allowedOrigins };
}
async function runMcp(args) {
  const options = parseMcpArgs(args);
  if (options.transport === "stdio") {
    if (args.length > 0) {
      const unsupported = args.filter((arg) => arg !== "--transport" && arg !== "stdio" && arg !== "--transport=stdio");
      if (unsupported.length > 0)
        throw new Error("stdio MCP does not accept HTTP listener options");
    }
    runStdioServer(createForgeaxMcpServer());
    return;
  }
  const running = await startHttpMcpServer(createForgeaxMcpServer({
    root: options.root,
    authoringTools: true,
    allowTargetDir: false,
    existingServicesOnly: process.env.FORGEAX_MCP_EXISTING_SERVICES === "1",
    publicOrigin: process.env.FORGEAX_PUBLIC_ORIGIN
  }), {
    host: options.host,
    port: options.port,
    authToken: process.env.FORGEAX_REMOTE_MCP_TOKEN,
    requireAuth: options.requireAuth,
    allowedOrigins: options.allowedOrigins
  });
  process.stderr.write(`forgeax-game MCP listening at ${running.url} (root=${options.root})
`);
  const close = () => {
    running.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
if (argv.length === 0 || argv[0] === "mcp") {
  runMcp(argv.length === 0 ? [] : argv.slice(1)).catch((error) => {
    process.stderr.write(`forgeax-game: ${error instanceof Error ? error.message : String(error)}
`);
    process.exit(1);
  });
} else {
  runCli(argv).then((code) => process.exit(code), (error) => {
    process.stderr.write(`forgeax-game: ${error instanceof Error ? error.message : String(error)}
`);
    process.exit(1);
  });
}
