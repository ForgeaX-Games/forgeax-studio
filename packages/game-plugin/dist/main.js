#!/usr/bin/env node

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
    process.exitCode = 0;
    process.stdin.pause();
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
}

// src/mcp/forgeax-server.ts
import { readFileSync as readFileSync9 } from "node:fs";

// src/status/collect.ts
import { readFileSync as readFileSync6 } from "node:fs";
import { join as join8 } from "node:path";

// src/project/locate.ts
import {
  existsSync,
  mkdirSync as mkdirSync2,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync as statSync2,
  writeFileSync
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname2, isAbsolute, join as join2, relative, resolve, sep } from "node:path";
var SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
function ensureLocalProject(root) {
  const projectRoot = resolve(root);
  const forgeaxRoot = join2(projectRoot, ".forgeax");
  const created = !existsSync(forgeaxRoot);
  mkdirSync2(join2(forgeaxRoot, "games"), { recursive: true });
  const metadataPath = join2(forgeaxRoot, "project.json");
  if (!existsSync(metadataPath)) {
    const name = projectRoot.split(sep).filter(Boolean).pop() || "forgeax-project";
    writeFileSync(metadataPath, `${JSON.stringify({ version: 1, type: "game", name }, null, 2)}
`, "utf8");
  }
  return { root: projectRoot, created };
}
var LOCAL_GAME_MAIN = `/** Minimal ForgeaX game scaffold. Add systems and assets here. */
export function bootstrap() {
  // The engine accepts an empty bootstrap; this keeps package-only init offline.
}
`;
function initLocalGame(root, slug) {
  const project = ensureLocalProject(root);
  const gameRoot = join2(project.root, ".forgeax", "games", slug);
  if (existsSync(gameRoot))
    throw new Error(`game ${JSON.stringify(slug)} already exists`);
  mkdirSync2(gameRoot, { recursive: true });
  writeFileSync(join2(gameRoot, "forge.json"), `${JSON.stringify({ id: slug, name: slug, schemaVersion: "1.0.0", entry: "main.ts", physics: "3d" }, null, 2)}
`, "utf8");
  writeFileSync(join2(gameRoot, "package.json"), `${JSON.stringify({ name: slug, private: true, type: "module" }, null, 2)}
`, "utf8");
  writeFileSync(join2(gameRoot, "main.ts"), LOCAL_GAME_MAIN, "utf8");
  writeFileSync(join2(gameRoot, "tsconfig.json"), `${JSON.stringify({
    extends: "../../engine-sdk/tsconfig.json",
    include: ["**/*.ts"]
  }, null, 2)}
`, "utf8");
  writeFileSync(join2(gameRoot, "FORGE.md"), `# ${slug}

_(created by the package-local ForgeaX bootstrap)_
`, "utf8");
  writeFileSync(join2(project.root, ".forgeax", "active-game.json"), `${JSON.stringify({ version: 1, slug }, null, 2)}
`, "utf8");
  return { root: project.root, gameRoot, projectCreated: project.created };
}
function isConfinedToProject(root, path) {
  try {
    const rel = relative(realpathSync(root), realpathSync(path));
    return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  } catch {
    return false;
  }
}
function isProjectRoot(dir) {
  if (resolve(dir) === resolve(homedir2()))
    return false;
  const forgeax = join2(dir, ".forgeax");
  if (!existsSync(forgeax))
    return false;
  return ["project.json", "active-game.json", "games"].some((marker) => existsSync(join2(forgeax, marker)));
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
  try {
    const raw = readFileSync(join2(root, ".forgeax", "active-game.json"), "utf8");
    const slug = JSON.parse(raw).slug;
    return typeof slug === "string" && SLUG_RE.test(slug) ? slug : undefined;
  } catch {
    return;
  }
}
function listGames(root) {
  const found = new Set;
  for (const base of [join2(root, ".forgeax", "games"), join2(root, "games")]) {
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith("_") || e.name.startsWith("."))
        continue;
      if (e.isDirectory() && isConfinedToProject(root, join2(base, e.name))) {
        found.add(e.name);
        continue;
      }
      if (e.isSymbolicLink()) {
        try {
          const path = join2(base, e.name);
          if (statSync2(path).isDirectory() && isConfinedToProject(root, path))
            found.add(e.name);
        } catch {}
      }
    }
  }
  return [...found].sort();
}
function gameDir(root, slug) {
  if (!SLUG_RE.test(slug))
    return;
  for (const base of [join2(root, ".forgeax", "games"), join2(root, "games")]) {
    const dir = join2(base, slug);
    try {
      if (statSync2(dir).isDirectory() && isConfinedToProject(root, dir))
        return dir;
    } catch {}
  }
  return;
}

// src/services/probe.ts
import { get as httpsGet } from "node:https";
import { realpathSync as realpathSync2 } from "node:fs";
var DEFAULT_PORTS = {
  server: 18900,
  interface: 18920,
  engine: 15173
};
function portOf(name) {
  const env = process.env[`FORGEAX_${name.toUpperCase()}_PORT`];
  const n = env ? Number.parseInt(env, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORTS[name];
}
function urlOf(name, port) {
  const scheme = name === "interface" && process.env.FORGEAX_INTERFACE_HTTPS === "1" ? "https" : "http";
  return `${scheme}://127.0.0.1:${port}`;
}
var PROBE_TIMEOUT_MS = 1500;
async function identityAt(url, expectedName, signal) {
  if (!url.startsWith("https://")) {
    const response = await fetch(url, { signal });
    if (!response.ok)
      return;
    const value = await response.json();
    return value.status === "ok" && value.name === expectedName && typeof value.instanceRootAbs === "string" ? {
      instanceRootAbs: value.instanceRootAbs,
      ...typeof value.runtimeVersion === "string" ? { runtimeVersion: value.runtimeVersion } : {},
      ...typeof value.engineVersion === "string" ? { engineVersion: value.engineVersion } : {}
    } : undefined;
  }
  return await new Promise((resolve2, reject) => {
    const request = httpsGet(url, { rejectUnauthorized: false, signal }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => {
        body = `${body}${chunk}`.slice(0, 16384);
      });
      response.on("end", () => {
        try {
          const value = JSON.parse(body);
          resolve2(value.status === "ok" && value.name === expectedName && typeof value.instanceRootAbs === "string" ? {
            instanceRootAbs: value.instanceRootAbs,
            ...typeof value.runtimeVersion === "string" ? { runtimeVersion: value.runtimeVersion } : {},
            ...typeof value.engineVersion === "string" ? { engineVersion: value.engineVersion } : {}
          } : undefined);
        } catch {
          resolve2(undefined);
        }
      });
    });
    request.on("error", reject);
  });
}
async function isExpectedService(name, url, signal) {
  if (name === "server") {
    const response = await fetch(`${url}/api/health`, { signal });
    if (!response.ok)
      return false;
    const health = await response.json();
    return health.status === "ok" && health.name === "@forgeax/server";
  }
  if (name === "engine") {
    return await identityAt(`${url}/preview/__forgeax_health`, "@forgeax/play-runtime", signal) !== undefined;
  }
  return await identityAt(`${url}/api/health`, "@forgeax/server", signal) !== undefined;
}
async function probeOne(name) {
  const port = portOf(name);
  const url = urlOf(name, port);
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const reachable = await isExpectedService(name, url, controller.signal);
    return {
      name,
      port,
      url,
      reachable,
      ...reachable ? {} : { reason: `endpoint did not identify as ForgeaX ${name}` }
    };
  } catch (e) {
    const reason = controller.signal.aborted ? `no response within ${PROBE_TIMEOUT_MS}ms` : e.message;
    return { name, port, url, reachable: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
async function probeServices() {
  const services = await Promise.all(Object.keys(DEFAULT_PORTS).map((n) => probeOne(n)));
  const up = (n) => services.find((s) => s.name === n)?.reachable === true;
  const tier = !up("server") ? "local" : up("engine") ? "runtime" : "backend";
  return { tier, services };
}
var TIER_ORDER = { local: 0, backend: 1, runtime: 2 };
function tierAtLeast(actual, wanted) {
  return TIER_ORDER[actual] >= TIER_ORDER[wanted];
}
async function waitForTier(wanted, timeoutMs, intervalMs = 700) {
  const deadline = Date.now() + timeoutMs;
  let last = await probeServices();
  while (!tierAtLeast(last.tier, wanted) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await probeServices();
  }
  return last;
}
function previewUrl(slug) {
  return `${urlOf("engine", portOf("engine"))}/?game=${encodeURIComponent(slug)}`;
}
function serverBaseUrl() {
  return urlOf("server", portOf("server"));
}
async function assertServerProjectRoot(root) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${serverBaseUrl()}/api/health`, { signal: controller.signal });
    if (!response.ok)
      throw new Error(`health returned HTTP ${response.status}`);
    const health = await response.json();
    if (health.status !== "ok" || health.name !== "@forgeax/server" || typeof health.instanceRootAbs !== "string") {
      throw new Error("health response did not identify a ForgeaX server with instanceRootAbs");
    }
    const expected = realpathSync2(root);
    const actual = realpathSync2(health.instanceRootAbs);
    if (actual !== expected) {
      throw new Error(`ForgeaX server at ${serverBaseUrl()} belongs to ${health.instanceRootAbs}, but this command is bound to ${root}; start the server for this project before continuing`);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${serverBaseUrl()} did not answer /api/health within ${PROBE_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function assertEngineProjectRoot(root) {
  const port = portOf("engine");
  const url = urlOf("engine", port);
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const identity = await identityAt(`${url}/preview/__forgeax_health`, "@forgeax/play-runtime", controller.signal);
    if (!identity) {
      throw new Error("health response did not identify a ForgeaX play runtime with instanceRootAbs");
    }
    const expected = realpathSync2(root);
    const actual = realpathSync2(identity.instanceRootAbs);
    if (actual !== expected) {
      throw new Error(`ForgeaX engine at ${url} belongs to ${identity.instanceRootAbs}, but this command is bound to ${root}; start the engine for this project before continuing`);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${url} did not answer runtime health within ${PROBE_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function fetchEngineRuntimeIdentity() {
  const port = portOf("engine");
  const url = urlOf("engine", port);
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await identityAt(`${url}/preview/__forgeax_health`, "@forgeax/play-runtime", controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

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
  existsSync as existsSync2,
  lstatSync,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync2,
  readdirSync as readdirSync2,
  realpathSync as realpathSync3,
  rmSync,
  statSync as statSync3,
  writeFileSync as writeFileSync2
} from "node:fs";
import { dirname as dirname3, join as join3, relative as relative2, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/routing.ts
var ROUTING_TEXT = `## ForgeaX game development

This project is a ForgeaX game workspace. Route game work through the \`forgeax\` MCP
server rather than reconstructing it from shell commands. The current host Agent owns
reasoning and game-code edits; the plugin owns ForgeaX Runtime lifecycle and feedback.

- Game implementation and failure recovery: follow the \`forgeax-game\` project skill.
  The published plugin carries the Skill and host rules; install or refresh it with
  \`forgeax-game devkit install\`. A local \`forgeax-install\` checkout is optional.

- Starting or resuming work, or unsure what is running: read the \`forgeax://status\`
  resource first. Clients without resource support call \`forgeax_status_lite\`.
  Status is read-only and never writes to the workspace.
- Running, previewing, or verifying the game ("run it", "let me see it", "does it
  work"): call \`forgeax_run_current_game\`. It installs/starts whatever Runtime
  services are missing, returns a preview URL, and reports Runtime/log identity.
- Reading runtime errors or engine logs: read the file path returned in
  \`runtime_logs.local_file\` with your own file-reading tool. Log tailing is
  deliberately not an MCP tool — the log is a file, so read it like one.
- Creating a game, switching the active game, installing or upgrading the plugin:
  these are one-time operations and are CLI subcommands, not MCP tools. Run
  \`npx -y -p @forgeax/game forgeax-game <init|use|doctor|devkit|upgrade>\`.

If no project exists yet, run \`forgeax-game init --game <slug>\` in the user's empty
workspace; do not ask them to clone ForgeaX Studio. Writing gameplay code is ordinary
file editing — use your normal editing tools against \`.forgeax/games/<slug>/\`. The
MCP server exists for the things you cannot do by editing files: knowing what is
running, and running it.`;

// src/devkit/install.ts
var PLUGIN_SKILL_ID = "forgeax-game";
var ENGINE_SKILL_PREFIX = "forgeax-engine-";
var DEVKIT_VERSION = 2;
var HOST_SKILL_MOUNTS = {
  codex: ".agents/skills",
  claude: ".claude/skills",
  cursor: ".cursor/skills",
  trae: ".trae/skills",
  codebuddy: ".codebuddy/skills",
  workbuddy: ".codebuddy/skills",
  windsurf: ".codeium/windsurf/skills",
  vscode: ".vscode/skills",
  opencode: ".config/opencode/skills"
};
var HOST_RULE_MOUNTS = {
  codex: ".agents/rules",
  claude: ".claude/rules",
  cursor: ".cursor/rules",
  trae: ".trae/rules",
  codebuddy: ".codebuddy/rules",
  workbuddy: ".codebuddy/rules",
  windsurf: ".codeium/windsurf/rules",
  vscode: ".vscode/rules",
  opencode: ".config/opencode/rules"
};
function skillRoots() {
  const here = dirname3(fileURLToPath(import.meta.url));
  const isPluginSkill = (id) => id === PLUGIN_SKILL_ID;
  const anySkill = () => true;
  return [
    { path: resolve2(here, "..", "assets", "skills"), accepts: anySkill },
    { path: resolve2(here, "..", "assets", "engine-sdk", "skills"), accepts: isEngineSkill },
    { path: resolve2(here, "..", "..", "assets", "skills"), accepts: anySkill },
    { path: resolve2(here, "..", "..", "assets", "engine-sdk", "skills"), accepts: isEngineSkill },
    { path: resolve2(here, "..", "..", "skills"), accepts: isPluginSkill },
    { path: resolve2(here, "..", "..", "..", "editor", "packages", "engine", "skills"), accepts: isEngineSkill }
  ];
}
function bundledSkills() {
  const found = new Map;
  for (const root of skillRoots()) {
    if (!existsSync2(root.path))
      continue;
    for (const entry of readdirSync2(root.path, { withFileTypes: true })) {
      if (!entry.isDirectory() || found.has(entry.name) || !root.accepts(entry.name))
        continue;
      const path = join3(root.path, entry.name);
      if (existsSync2(join3(path, "SKILL.md")))
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
  return readdirSync2(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join3(current, entry.name);
    return entry.isDirectory() ? filesUnder(root, path) : [relative2(root, path)];
  });
}
function sameFile(left, right) {
  return existsSync2(right) && readFileSync2(left).equals(readFileSync2(right));
}
function copySkill(source, destination) {
  const destinationIsSymlink = existsSync2(destination) && lstatSync(destination).isSymbolicLink();
  if (!destinationIsSymlink && existsSync2(destination) && realpathSync3(source) === realpathSync3(destination))
    return false;
  const files = filesUnder(source);
  const changed = destinationIsSymlink || files.some((path) => !sameFile(join3(source, path), join3(destination, path)));
  if (!changed)
    return false;
  if (existsSync2(destination)) {
    const backup = `${destination}.bak.latest`;
    rmSync(backup, { recursive: true, force: true });
    cpSync(destination, backup, { recursive: true });
    rmSync(destination, { recursive: true, force: true });
  }
  for (const path of files) {
    const target = join3(destination, path);
    mkdirSync3(dirname3(target), { recursive: true });
    copyFileSync(join3(source, path), target);
  }
  return true;
}
function writeTextIfChanged(path, content) {
  const destinationIsSymlink = existsSync2(path) && lstatSync(path).isSymbolicLink();
  if (!destinationIsSymlink && existsSync2(path) && readFileSync2(path, "utf8") === content)
    return false;
  if (existsSync2(path)) {
    const backup = `${path}.bak.latest`;
    rmSync(backup, { force: true });
    copyFileSync(path, backup);
    if (destinationIsSymlink)
      rmSync(path, { force: true });
  }
  mkdirSync3(dirname3(path), { recursive: true });
  writeFileSync2(path, content, "utf8");
  return true;
}
function selectedHostIds(clients) {
  return [...new Set(clients.map((id) => id === "workbuddy" ? "codebuddy" : id))].filter((id) => HOST_SKILL_MOUNTS[id]);
}
function hostSkillDirs(projectRoot) {
  return [...new Set(Object.values(HOST_SKILL_MOUNTS))].map((mount) => join3(projectRoot, mount));
}
function installHostDevKit(projectRoot, clients, skills = bundledSkills()) {
  const skillPaths = [];
  const rulePaths = [];
  let changed = false;
  for (const id of selectedHostIds(clients)) {
    const skillsDir = join3(projectRoot, HOST_SKILL_MOUNTS[id]);
    for (const skill of skills) {
      changed = copySkill(skill.path, join3(skillsDir, skill.id)) || changed;
    }
    const rulePath = join3(projectRoot, HOST_RULE_MOUNTS[id], `${PLUGIN_SKILL_ID}.md`);
    changed = writeTextIfChanged(rulePath, ROUTING_TEXT) || changed;
    skillPaths.push(skillsDir);
    rulePaths.push(rulePath);
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
  if (!existsSync2(manifestPath)) {
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
  if (!existsSync2(installer) || !existsSync2(manifest.specPath)) {
    return {
      mounted: false,
      note: "Package-owned host mounts are active; the recorded forgeax-install checkout is unavailable (optional)."
    };
  }
  const python = manifest.pythonInterpreter && existsSync2(manifest.pythonInterpreter) ? manifest.pythonInterpreter : "python3";
  const result = spawnSync(python, [installer, "--spec", manifest.specPath, "--target-root", projectRoot], { cwd: manifest.harnessRoot, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`forgeax-install could not mount ${PLUGIN_SKILL_ID}: ${detail}`);
  }
  return { mounted: true, note: "Mounted by forgeax-install into all configured agent hosts." };
}
function installDevKit(projectRoot, clients) {
  const skills = bundledSkills();
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
    return existsSync2(skillPath) && statSync3(skillPath).isFile();
  });
}
function installedEngineSkills(projectRoot) {
  const found = new Set;
  for (const dir of hostSkillDirs(projectRoot)) {
    let entries;
    try {
      entries = readdirSync2(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isEngineSkill(entry.name))
        continue;
      if (existsSync2(join3(dir, entry.name, "SKILL.md")))
        found.add(entry.name);
    }
  }
  return [...found].sort();
}
function removeDevKit(projectRoot) {
  const owned = new Set(bundledSkills().map((skill) => skill.id));
  const removed = [];
  let skillCount = 0;
  for (const mount of new Set(Object.values(HOST_SKILL_MOUNTS))) {
    const dir = join3(projectRoot, mount);
    let entries;
    try {
      entries = readdirSync2(dir, { withFileTypes: true });
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
  for (const mount of new Set(Object.values(HOST_RULE_MOUNTS))) {
    for (const suffix of [".md", ".md.bak.latest"]) {
      rmSync(join3(projectRoot, mount, `${PLUGIN_SKILL_ID}${suffix}`), { force: true });
    }
  }
  for (const legacy of ["skills", "rules"]) {
    const dir = join3(projectRoot, legacy);
    let entries;
    try {
      entries = readdirSync2(dir, { withFileTypes: true });
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
      if (readdirSync2(dir).length === 0)
        rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  return { removed, skillCount };
}
function bundledEngineSkillCount() {
  try {
    return bundledSkills().filter((skill) => isEngineSkill(skill.id)).length;
  } catch {
    return 0;
  }
}

// src/run/log-paths.ts
import { mkdirSync as mkdirSync4, readFileSync as readFileSync3, unlinkSync, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join4 } from "node:path";
function runtimeLogPaths(root) {
  const dir = join4(root, ".forgeax", "logs", "runtime");
  return {
    dir,
    logFile: join4(dir, "runtime.log"),
    stateFile: join4(dir, "state.json"),
    startLockFile: join4(dir, "start.lock")
  };
}
function readWatcherState(root) {
  try {
    return JSON.parse(readFileSync3(runtimeLogPaths(root).stateFile, "utf8"));
  } catch {
    return;
  }
}
function updateWatcherState(root, patch) {
  try {
    const paths = runtimeLogPaths(root);
    mkdirSync4(paths.dir, { recursive: true });
    const current = readWatcherState(root) ?? {};
    writeFileSync3(paths.stateFile, `${JSON.stringify({ ...current, ...patch }, null, 2)}
`);
  } catch {}
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function acquireStartLock(root) {
  const path = runtimeLogPaths(root).startLockFile;
  mkdirSync4(runtimeLogPaths(root).dir, { recursive: true });
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  for (let attempt = 0;attempt < 2; attempt++) {
    try {
      writeFileSync3(path, `${token}
`, { flag: "wx" });
      return {
        acquired: true,
        release() {
          try {
            if (readFileSync3(path, "utf8").trim() === token)
              unlinkSync(path);
          } catch {}
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      try {
        const owner = Number.parseInt(readFileSync3(path, "utf8").split(":")[0], 10);
        if (Number.isFinite(owner) && processAlive(owner)) {
          return { acquired: false, release() {} };
        }
        unlinkSync(path);
      } catch {
        return { acquired: false, release() {} };
      }
    }
  }
  return { acquired: false, release() {} };
}
function runtimeLogIsLive(root) {
  const state = readWatcherState(root);
  return typeof state?.pid === "number" && processAlive(state.pid);
}

// src/runtime/manager.ts
import { arch as arch3, platform as platform3 } from "node:os";
import { join as join7 } from "node:path";

// src/runtime/cache.ts
import { createHash as createHash2 } from "node:crypto";
import { spawnSync as spawnSync2 } from "node:child_process";
import { closeSync, copyFileSync as copyFileSync2, existsSync as existsSync3, mkdirSync as mkdirSync5, openSync, readFileSync as readFileSync4, readSync, readdirSync as readdirSync3, renameSync as renameSync2, rmSync as rmSync2, statSync as statSync4, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir3, arch, platform } from "node:os";
import { basename, isAbsolute as isAbsolute2, join as join5, relative as relative3, resolve as resolve3 } from "node:path";
function runtimeCacheRoot() {
  return process.env.FORGEAX_RUNTIME_CACHE?.trim() || join5(homedir3(), ".forgeax", "runtimes");
}
function safe(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function runtimeInstallRoot(runtimeId, version, machine = { platform: platform(), arch: arch() }, cacheRoot = runtimeCacheRoot()) {
  return join5(cacheRoot, safe(runtimeId), safe(version), `${safe(machine.platform)}-${safe(machine.arch)}`);
}
function sha256File(file) {
  const hash = createHash2("sha256");
  const handle = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;; ) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read <= 0)
        break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}
function markerPath(root) {
  return join5(root, ".ready.json");
}
function readMarker(root) {
  const marker = markerPath(root);
  if (!existsSync3(marker))
    return;
  try {
    const value = JSON.parse(readFileSync4(marker, "utf8"));
    if (value.schemaVersion !== 2 || !value.runtimeId || !value.version || !value.sha256 || !value.command)
      return;
    if (value.format !== "archive" && value.format !== "file")
      return;
    if (value.format === "file" && !value.artifactPath)
      return;
    return value;
  } catch {
    return;
  }
}
function readInstalledRuntime(runtimeId, version, machine = { platform: platform(), arch: arch() }, cacheRoot = runtimeCacheRoot()) {
  const root = runtimeInstallRoot(runtimeId, version, machine, cacheRoot);
  const marker = readMarker(root);
  if (!marker || marker.runtimeId !== runtimeId || marker.version !== version || marker.platform !== machine.platform || marker.arch !== machine.arch)
    return;
  const contained = (candidate) => {
    const relativePath = relative3(root, candidate);
    return !relativePath.startsWith("..") && !isAbsolute2(relativePath) && existsSync3(candidate);
  };
  let artifactPath;
  if (marker.format === "file") {
    artifactPath = resolve3(root, marker.artifactPath);
    if (!contained(artifactPath))
      return;
    try {
      if (sha256File(artifactPath) !== marker.sha256.toLowerCase())
        return;
    } catch {
      return;
    }
  } else {
    if (!contained(resolve3(root, marker.command)))
      return;
  }
  return { runtimeId, version, root, ...artifactPath ? { artifactPath } : {}, command: marker.command, args: marker.args, sha256: marker.sha256, platform: marker.platform, arch: marker.arch };
}
function listInstalledRuntimes(runtimeId, cacheRoot = runtimeCacheRoot()) {
  const root = join5(cacheRoot, safe(runtimeId));
  if (!existsSync3(root))
    return [];
  const result = [];
  for (const version of requireDirectoryNames(root)) {
    const runtime = readInstalledRuntime(runtimeId, version, { platform: platform(), arch: arch() }, cacheRoot);
    if (runtime)
      result.push(runtime);
  }
  return result.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}
function requireDirectoryNames(root) {
  return readdirSync3(root, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name);
}
var LOCK_FILE = ".install.lock";
function acquireRuntimeLock(root, staleAfterMs = 10 * 60000) {
  mkdirSync5(root, { recursive: true });
  const file = join5(root, LOCK_FILE);
  let fd;
  try {
    fd = openSync(file, "wx");
    writeFileSync4(fd, `${process.pid}
`, "utf8");
  } catch {
    try {
      if (Date.now() - statSync4(file).mtimeMs > staleAfterMs) {
        rmSync2(file, { force: true });
        fd = openSync(file, "wx");
        writeFileSync4(fd, `${process.pid}
`, "utf8");
      }
    } catch {
      fd = undefined;
    }
  }
  return {
    acquired: fd !== undefined,
    release: () => {
      if (fd === undefined)
        return;
      try {
        closeSync(fd);
      } catch {}
      try {
        rmSync2(file, { force: true });
      } catch {}
      fd = undefined;
    }
  };
}
async function materializeSource(source, destination, sourceRoot) {
  if (/^http:\/\//i.test(source)) {
    throw new Error("runtime artifact URL must use HTTPS");
  }
  if (/^https:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok)
      throw new Error(`runtime artifact download failed (${response.status})`);
    writeFileSync4(destination, Buffer.from(await response.arrayBuffer()));
    return;
  }
  copyFileSync2(resolve3(sourceRoot ?? process.cwd(), source), destination);
}
function validateArchive(archive) {
  const result = spawnSync2("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`runtime archive listing failed: ${result.stderr?.trim() || "tar exited unsuccessfully"}`);
  }
  for (const entry of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error(`runtime archive contains an unsafe path: ${entry}`);
    }
  }
}
function extractArchive(archive, destination) {
  validateArchive(archive);
  const keep = new Set([basename(archive), LOCK_FILE]);
  for (const entry of readdirSync3(destination, { withFileTypes: true })) {
    if (keep.has(entry.name))
      continue;
    rmSync2(join5(destination, entry.name), { recursive: true, force: true });
  }
  const result = spawnSync2("tar", ["-xzf", archive, "-C", destination, "--no-same-owner"], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`runtime archive extraction failed: ${result.stderr?.trim() || "tar exited unsuccessfully"}`);
  }
}
async function installRuntime(artifact, options = {}) {
  const runtimeId = options.runtimeId ?? artifact.runtimeId ?? "forgeax-game-runtime";
  const machine = options.machine ?? { platform: platform(), arch: arch() };
  const root = join5(options.cacheRoot ?? runtimeCacheRoot(), safe(runtimeId), safe(artifact.version), `${safe(machine.platform)}-${safe(machine.arch)}`);
  const cacheRoot = options.cacheRoot ?? runtimeCacheRoot();
  const existing = readInstalledRuntime(runtimeId, artifact.version, machine, cacheRoot);
  if (existing && existing.sha256 === artifact.sha256.toLowerCase())
    return existing;
  const lock = acquireRuntimeLock(root);
  if (!lock.acquired) {
    const waited = readInstalledRuntime(runtimeId, artifact.version, machine, cacheRoot);
    if (waited)
      return waited;
    throw new Error(`runtime ${runtimeId}@${artifact.version} is being installed by another process`);
  }
  try {
    const filename = basename(new URL(artifact.source, "file:///runtime-artifact").pathname) || "runtime-artifact";
    const artifactPath = join5(root, filename.replace(/[^a-zA-Z0-9._-]/g, "_"));
    const temporary = `${artifactPath}.part-${process.pid}`;
    await materializeSource(artifact.source, temporary, options.sourceRoot);
    const digest = sha256File(temporary);
    if (digest !== artifact.sha256.toLowerCase()) {
      rmSync2(temporary, { force: true });
      throw new Error(`runtime artifact checksum mismatch: expected ${artifact.sha256}, got ${digest}`);
    }
    renameSync2(temporary, artifactPath);
    const isArchive = artifact.format === "archive";
    if (isArchive) {
      extractArchive(artifactPath, root);
      rmSync2(artifactPath, { force: true });
    }
    const marker = {
      schemaVersion: 2,
      runtimeId,
      version: artifact.version,
      format: isArchive ? "archive" : "file",
      ...isArchive ? {} : { artifactPath: filename },
      command: artifact.command ?? filename,
      args: artifact.args ?? [],
      sha256: digest,
      platform: machine.platform,
      arch: machine.arch
    };
    const markerTmp = `${markerPath(root)}.tmp-${process.pid}`;
    writeFileSync4(markerTmp, `${JSON.stringify(marker, null, 2)}
`, "utf8");
    renameSync2(markerTmp, markerPath(root));
    return readInstalledRuntime(runtimeId, artifact.version, machine, cacheRoot);
  } finally {
    lock.release();
  }
}

// src/runtime/manifest.ts
import { existsSync as existsSync4, readFileSync as readFileSync5 } from "node:fs";
import { arch as arch2, homedir as homedir4, platform as platform2 } from "node:os";
import { dirname as dirname4, join as join6, resolve as resolve4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/runtime/types.ts
var RUNTIME_MANIFEST_VERSION = 1;
var DEFAULT_RUNTIME_ID = "forgeax-game-runtime";

// src/runtime/manifest.ts
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function artifact(value) {
  if (!isRecord(value) || typeof value.version !== "string" || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256))
    return;
  const source = typeof value.source === "string" ? value.source : typeof value.url === "string" ? value.url : undefined;
  if (!source)
    return;
  return {
    runtimeId: typeof value.runtimeId === "string" ? value.runtimeId : undefined,
    version: value.version,
    platform: typeof value.platform === "string" ? value.platform : undefined,
    arch: typeof value.arch === "string" ? value.arch : undefined,
    source,
    sha256: value.sha256.toLowerCase(),
    format: value.format === "archive" ? "archive" : "file",
    command: typeof value.command === "string" ? value.command : undefined,
    args: Array.isArray(value.args) && value.args.every((item) => typeof item === "string") ? value.args : undefined
  };
}
function parseRuntimeManifest(value) {
  if (!isRecord(value) || value.schemaVersion !== RUNTIME_MANIFEST_VERSION) {
    throw new Error(`unsupported runtime manifest schema (expected ${RUNTIME_MANIFEST_VERSION})`);
  }
  const runtimeId = typeof value.runtimeId === "string" && value.runtimeId.length > 0 ? value.runtimeId : DEFAULT_RUNTIME_ID;
  if (!Array.isArray(value.artifacts))
    throw new Error("runtime manifest artifacts must be an array");
  const artifacts = value.artifacts.map(artifact).filter((item) => item !== undefined);
  if (artifacts.length !== value.artifacts.length)
    throw new Error("runtime manifest contains an invalid artifact");
  return { schemaVersion: RUNTIME_MANIFEST_VERSION, runtimeId, artifacts };
}
function readRuntimeManifest(file) {
  return parseRuntimeManifest(JSON.parse(readFileSync5(file, "utf8")));
}
function bundledPluginRoot() {
  const here = dirname4(fileURLToPath2(import.meta.url));
  return here.endsWith("/runtime") || here.endsWith("\\runtime") ? resolve4(here, "../..") : resolve4(here, "..");
}
function runtimeManifestCandidates(pluginRoot = bundledPluginRoot()) {
  return [
    process.env.FORGEAX_RUNTIME_MANIFEST,
    join6(pluginRoot, "assets", "runtime-manifest.json"),
    join6(homedir4(), ".forgeax", "runtime-manifest.json")
  ].filter((item) => Boolean(item));
}
function runtimeManifestRoot(pluginRoot = bundledPluginRoot()) {
  return resolve4(pluginRoot);
}
function loadRuntimeManifest(pluginRoot) {
  for (const candidate of runtimeManifestCandidates(pluginRoot)) {
    if (!existsSync4(candidate))
      continue;
    try {
      return readRuntimeManifest(candidate);
    } catch (error) {
      throw new Error(`invalid ForgeaX runtime manifest at ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return;
}
function versionSort(a, b) {
  const parse = (value) => value.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a.version);
  const right = parse(b.version);
  for (let i = 0;i < Math.max(left.length, right.length); i += 1) {
    if ((right[i] ?? 0) !== (left[i] ?? 0))
      return (right[i] ?? 0) - (left[i] ?? 0);
  }
  return 0;
}
function resolveRuntimeArtifact(manifest, version, machine = { platform: platform2(), arch: arch2() }) {
  return manifest.artifacts.filter((item) => item.runtimeId === undefined || item.runtimeId === manifest.runtimeId).filter((item) => version === undefined || item.version === version).filter((item) => item.platform === undefined || item.platform === "any" || item.platform === machine.platform).filter((item) => item.arch === undefined || item.arch === "any" || item.arch === machine.arch).sort((a, b) => {
    const platformScore = (b.platform === machine.platform ? 2 : b.platform === undefined || b.platform === "any" ? 1 : 0) - (a.platform === machine.platform ? 2 : a.platform === undefined || a.platform === "any" ? 1 : 0);
    if (platformScore)
      return platformScore;
    return versionSort(a, b);
  })[0];
}

// src/runtime/env.ts
var RUNTIME_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_ENV",
  "FORGEAX_SERVER_PORT",
  "FORGEAX_ENGINE_PORT",
  "FORGEAX_INTERFACE_PORT",
  "FORGEAX_INTERFACE_HTTPS",
  "FORGEAX_RUNTIME_CACHE",
  "FORGEAX_RUNTIME_VERSION",
  "FORGEAX_PROJECT_ROOT",
  "FORGEAX_RESOURCE_ROOT",
  "FORGEAX_STARTUP_PROFILE"
];
function runtimeEnvironment(overrides = {}, source = process.env) {
  const env = {};
  for (const name of RUNTIME_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined)
      env[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!RUNTIME_ENV_ALLOWLIST.includes(name))
      continue;
    if (value === undefined)
      delete env[name];
    else
      env[name] = value;
  }
  return env;
}

// src/runtime/manager.ts
function resolveInstalledRuntime(options = {}) {
  const runtimeId = options.runtimeId ?? "forgeax-game-runtime";
  if (options.version)
    return readInstalledRuntime(runtimeId, options.version, { platform: platform3(), arch: arch3() }, options.cacheRoot ?? runtimeCacheRoot());
  const installed = listInstalledRuntimes(runtimeId, options.cacheRoot ?? runtimeCacheRoot());
  return installed[0];
}
async function ensureRuntime(options = {}) {
  const pluginRoot = runtimeManifestRoot(options.pluginRoot);
  const manifest = loadRuntimeManifest(pluginRoot);
  if (!manifest) {
    const installed2 = resolveInstalledRuntime(options);
    if (installed2)
      return installed2;
    throw new Error("no ForgeaX runtime manifest is installed; install a runtime artifact first");
  }
  const runtimeId = options.runtimeId ?? manifest.runtimeId;
  const artifact2 = resolveRuntimeArtifact(manifest, options.version);
  if (!artifact2)
    throw new Error(`no runtime artifact matches ${runtimeId}${options.version ? `@${options.version}` : ""} for ${platform3()}/${arch3()}`);
  const installed = resolveInstalledRuntime({
    ...options,
    runtimeId,
    version: artifact2.version
  });
  if (installed)
    return installed;
  return installRuntime(artifact2, {
    runtimeId,
    cacheRoot: options.cacheRoot,
    sourceRoot: join7(pluginRoot, "assets")
  });
}
function launcherForRuntime(runtime, overrides = {}) {
  const command = runtime.command.includes("/") || runtime.command.includes("\\") ? runtime.command : join7(runtime.root, runtime.command);
  return {
    runtime,
    command,
    args: runtime.args,
    cwd: runtime.root,
    env: runtimeEnvironment({
      ...overrides,
      FORGEAX_RUNTIME_VERSION: runtime.version,
      FORGEAX_RESOURCE_ROOT: runtime.root,
      FORGEAX_STARTUP_PROFILE: overrides.FORGEAX_STARTUP_PROFILE ?? "desktop-prod"
    })
  };
}

// src/status/collect.ts
var AGENTS_DOC_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];
function readAgentsDoc(root) {
  for (const name of AGENTS_DOC_CANDIDATES) {
    try {
      return readFileSync6(join8(root, name), "utf8");
    } catch {}
  }
  return;
}
function deriveNextAction(s) {
  if (!s.project.root) {
    return "No ForgeaX instance found from this directory. Run `forgeax-game init --game <slug>` here; the plugin creates the project and extracts the bundled ForgeaX Runtime on first run.";
  }
  if (s.games.length === 0) {
    return "Project has no games yet. Run `forgeax-game init --game <slug>` to scaffold one.";
  }
  if (!s.activeGame) {
    return `No active game selected. Run \`forgeax-game use <slug>\` (available: ${s.games.join(", ")}).`;
  }
  if (!s.devKit.installed) {
    return "Game development skill is not installed. Run `forgeax-game devkit install`, then start a new session so the host discovers it.";
  }
  if (s.devKit.engineSkills < s.devKit.bundledEngineSkills) {
    return `Engine authoring skills are incomplete (${s.devKit.engineSkills} of ${s.devKit.bundledEngineSkills} installed). Run \`forgeax-game devkit install\`, then start a new session so the host discovers them; without them the model has no authority for how this Engine is meant to be used.`;
  }
  if (!s.engineSdk.installed) {
    return "Bundled Engine SDK is not installed. Run `forgeax-game init` or `forgeax-game upgrade` to materialize the version-matched Engine types and examples.";
  }
  if (s.agentsBlock.status === "missing_file" || s.agentsBlock.status === "missing_block") {
    return "Project routing rules are not installed in AGENTS.md. Run `forgeax-game agents update`, then start a new session so the client re-reads the file.";
  }
  if (s.agentsBlock.status === "outdated") {
    return "Project routing rules in AGENTS.md are stale. Run `forgeax-game agents update`, then start a new session so the client re-reads the file.";
  }
  if (!s.runtime.installed) {
    return "Managed ForgeaX Runtime is not installed. Call `forgeax_run_current_game`; it will verify, cache, and start the bundled Runtime from the plugin manifest.";
  }
  if (s.capabilities.tier !== "runtime") {
    return `Ready to edit \`.forgeax/games/${s.activeGame}/\`. To run or preview the game, call \`forgeax_run_current_game\` — it will start the services that are down.`;
  }
  return `Everything is up. Edit \`.forgeax/games/${s.activeGame}/\` and call \`forgeax_run_current_game\` to reload and preview.`;
}
async function collectStatus(explicitDir) {
  const project = resolveProject(explicitDir);
  let capabilities = await probeServices();
  const installedRuntime = resolveInstalledRuntime();
  const runtime = installedRuntime ? { installed: true, version: installedRuntime.version, root: installedRuntime.root } : { installed: false };
  const engineSdk = project.root ? (() => {
    try {
      const value = JSON.parse(readFileSync6(join8(project.root, ".forgeax", "engine-sdk.json"), "utf8"));
      return {
        installed: true,
        ...typeof value.engineCommit === "string" ? { commit: value.engineCommit } : {},
        ...typeof value.sourceRoot === "string" ? { sourceRoot: value.sourceRoot } : {}
      };
    } catch {
      return { installed: false };
    }
  })() : { installed: false };
  if (project.root && capabilities.services.some((service) => service.name === "server" && service.reachable)) {
    try {
      await assertServerProjectRoot(project.root);
      if (capabilities.tier === "runtime")
        await assertEngineProjectRoot(project.root);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      capabilities = {
        tier: "local",
        services: capabilities.services.map((service) => ({
          ...service,
          reachable: false,
          reason
        }))
      };
    }
  }
  if (!project.root) {
    const base2 = {
      project,
      games: [],
      capabilities,
      agentsBlock: inspectBlock(undefined, ROUTING_TEXT),
      devKit: {
        installed: false,
        version: DEVKIT_VERSION,
        engineSkills: 0,
        bundledEngineSkills: bundledEngineSkillCount()
      },
      runtime,
      engineSdk
    };
    return { ...base2, nextAction: deriveNextAction(base2) };
  }
  const root = project.root;
  const slug = activeGame(root);
  const logs = runtimeLogPaths(root);
  const watcherState = readWatcherState(root);
  const base = {
    project,
    ...slug ? { activeGame: slug } : {},
    games: listGames(root),
    capabilities,
    agentsBlock: inspectBlock(readAgentsDoc(root), ROUTING_TEXT),
    devKit: {
      installed: hasDevKit(root),
      version: DEVKIT_VERSION,
      engineSkills: installedEngineSkills(root).length,
      bundledEngineSkills: bundledEngineSkillCount()
    },
    runtime,
    engineSdk,
    ...watcherState ? { runtimeLogs: { localFile: logs.logFile, live: runtimeLogIsLive(root), state: watcherState } } : {}
  };
  return { ...base, nextAction: deriveNextAction(base) };
}

// src/status/render.ts
var BLOCK_EXPLANATION = {
  missing_file: "no AGENTS.md or CLAUDE.md in the project",
  missing_block: "project doc exists but carries no ForgeaX routing block",
  outdated: "routing block is present but stale",
  current: "up to date"
};
var TIER_EXPLANATION = {
  local: "filesystem only — can inspect the project; cannot build, run, or preview",
  backend: "server up — can scaffold, edit, and statically verify; cannot run the game",
  runtime: "server and engine up — the game can run and be previewed"
};
function renderStatus(s) {
  const lines = ["# ForgeaX status", ""];
  lines.push("## Project");
  if (s.project.root) {
    lines.push(`- root: ${s.project.root}`);
    lines.push(`- resolved via: ${s.project.source}`);
    lines.push(`- active game: ${s.activeGame ?? "(none selected)"}`);
    lines.push(`- games (${s.games.length}): ${s.games.length ? s.games.join(", ") : "(none)"}`);
  } else {
    lines.push("- root: (not a ForgeaX project)");
    lines.push(`- searched upward from: ${s.project.searchedFrom}`);
  }
  lines.push("");
  lines.push("## Capability");
  lines.push(`- tier: ${s.capabilities.tier} — ${TIER_EXPLANATION[s.capabilities.tier]}`);
  for (const svc of s.capabilities.services) {
    const detail = svc.reachable ? "up" : `down (${svc.reason ?? "unreachable"})`;
    lines.push(`- ${svc.name} ${svc.url}: ${detail}`);
  }
  lines.push("");
  lines.push("## Managed Runtime");
  if (s.runtime.installed) {
    lines.push(`- status: installed (v${s.runtime.version ?? "unknown"})`);
    if (s.runtime.root)
      lines.push(`- root: ${s.runtime.root}`);
  } else {
    lines.push("- status: not installed (first run verifies and extracts the bundled Runtime automatically)");
  }
  lines.push("");
  lines.push("## Engine SDK");
  lines.push(`- status: ${s.engineSdk.installed ? "installed" : "missing"}${s.engineSdk.commit ? ` (Engine commit ${s.engineSdk.commit})` : ""}`);
  lines.push("- development types/examples and Runtime must report the same Engine identity before acceptance");
  lines.push(`- Engine authoring skills: ${s.devKit.engineSkills} installed of ${s.devKit.bundledEngineSkills} bundled — read these for how the Engine is meant to be used`);
  if (s.engineSdk.sourceRoot) {
    lines.push(`- Engine source (escalate here only when a skill and the declarations still leave a choice open): ${s.engineSdk.sourceRoot}`);
  }
  lines.push("");
  lines.push("## Project rules");
  lines.push(`- AGENTS.md routing block: ${s.agentsBlock.status} — ${BLOCK_EXPLANATION[s.agentsBlock.status]}`);
  lines.push(`- game development kit: ${s.devKit.installed ? "installed" : "missing"} (v${s.devKit.version})`);
  if (s.agentsBlock.foundVersion !== undefined && s.agentsBlock.foundVersion !== s.agentsBlock.expectedVersion) {
    lines.push(`- block version: found v${s.agentsBlock.foundVersion}, expected v${s.agentsBlock.expectedVersion}`);
  }
  lines.push("");
  if (s.runtimeLogs) {
    const st = s.runtimeLogs.state;
    lines.push("## Runtime logs");
    lines.push(`- log file: ${s.runtimeLogs.localFile}`);
    lines.push("- read this file with your own file tool; it is not exposed as an MCP tool");
    if (st?.game)
      lines.push(`- captured for game: ${st.game}`);
    if (st?.lastSuccessAt)
      lines.push(`- last write: ${st.lastSuccessAt}`);
    if (st?.stoppedAt)
      lines.push(`- watcher stopped: ${st.stoppedAt} (${st.stopReason ?? "no reason recorded"})`);
    else if (st?.pid && s.runtimeLogs.live)
      lines.push(`- detached stack launcher running: pid ${st.pid}`);
    else if (st?.pid)
      lines.push(`- detached stack launcher no longer running: pid ${st.pid}; log may be stale`);
    if (st?.consecutiveFailures)
      lines.push(`- consecutive poll failures: ${st.consecutiveFailures}`);
    if (st?.lastError)
      lines.push(`- last error: ${st.lastError}`);
    lines.push("");
  }
  lines.push("## Next action");
  lines.push(s.nextAction);
  return `${lines.join(`
`)}
`;
}

// src/run/run-game.ts
import { closeSync as closeSync2, existsSync as existsSync6, mkdirSync as mkdirSync6, openSync as openSync2, readFileSync as readFileSync8 } from "node:fs";
import { join as join10 } from "node:path";

// src/services/launch.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync5, readFileSync as readFileSync7 } from "node:fs";
import { dirname as dirname5, join as join9, resolve as resolve5 } from "node:path";
var STUDIO_PACKAGE_NAME = "forgeax-studio";
function findStudioCheckout(start) {
  let dir = resolve5(start);
  for (;; ) {
    const pkg = join9(dir, "package.json");
    if (existsSync5(pkg)) {
      try {
        const name = JSON.parse(readFileSync7(pkg, "utf8")).name;
        if (name === STUDIO_PACKAGE_NAME)
          return dir;
      } catch {}
    }
    const parent = dirname5(dir);
    if (parent === dir)
      return;
    dir = parent;
  }
}
function resolveLauncher(projectRoot, overrides = {}) {
  const explicit = process.env.FORGEAX_START_COMMAND?.trim();
  if (explicit) {
    const [command, ...args] = explicit.split(/\s+/);
    if (command) {
      return {
        kind: "explicit",
        command,
        args,
        cwd: projectRoot,
        env: runtimeEnvironment(overrides),
        description: `FORGEAX_START_COMMAND=${explicit}`
      };
    }
  }
  const installed = resolveInstalledRuntime();
  if (installed) {
    const launcher = launcherForRuntime(installed, overrides);
    return {
      kind: "installed-runtime",
      command: launcher.command,
      args: launcher.args,
      cwd: launcher.cwd,
      env: launcher.env,
      description: `installed ForgeaX runtime ${installed.version} (${installed.root})`
    };
  }
  const checkout = process.env.FORGEAX_RUNTIME_DEV_FALLBACK === "1" ? findStudioCheckout(projectRoot) : undefined;
  if (checkout) {
    return {
      kind: "development-fallback",
      command: "bun",
      args: ["scripts/fx.ts", "start"],
      cwd: checkout,
      env: runtimeEnvironment(overrides),
      description: `development fallback: Studio checkout at ${checkout}`
    };
  }
  return;
}
async function ensureRuntimeLauncher(projectRoot, overrides = {}) {
  if (process.env.FORGEAX_START_COMMAND?.trim())
    return resolveLauncher(projectRoot, overrides);
  try {
    await ensureRuntime();
  } catch {
    return resolveLauncher(projectRoot, overrides);
  }
  return resolveLauncher(projectRoot, overrides);
}
function launchGuidance() {
  return [
    "Cannot start the ForgeaX stack: no verified ForgeaX runtime is installed,",
    "and FORGEAX_START_COMMAND is not set.",
    "",
    "The published plugin must include assets/runtime-manifest.json and the bundled",
    "Runtime archive (or set FORGEAX_RUNTIME_MANIFEST for a private deployment).",
    "Install a release that includes those assets, then call this tool again.",
    "",
    "Advanced override (not recommended for normal installs):",
    '  export FORGEAX_START_COMMAND="<command that brings up server :18900 and engine :15173>"',
    "",
    "Contributor-only fallback:",
    "  export FORGEAX_RUNTIME_DEV_FALLBACK=1"
  ].join(`
`);
}
function startStack(launcher, logFd) {
  const child = spawn(launcher.command, [...launcher.args], {
    cwd: launcher.cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: launcher.env ?? runtimeEnvironment()
  });
  child.unref();
  return { pid: child.pid };
}

// src/runtime/ports.ts
import { createServer } from "node:net";
async function allocatePort(preferred) {
  const server = createServer();
  await new Promise((resolve6, reject) => {
    server.once("error", reject);
    server.listen(preferred ?? 0, "127.0.0.1", () => resolve6());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve6) => server.close(() => resolve6()));
  if (!port)
    throw new Error("runtime port allocator did not receive a port");
  return port;
}
async function allocateRuntimePorts(preferred = {}) {
  const used = new Set;
  const next = async (requested) => {
    let value = await allocatePort(requested);
    while (used.has(value))
      value = await allocatePort();
    used.add(value);
    return value;
  };
  const server = await next(preferred.server);
  const engine = await next(preferred.engine);
  const interfacePort = await next(preferred.interface);
  return { server, engine, interface: interfacePort };
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
      description: "Start the stack if it is not already up. Default true. Set false to check runnability without launching anything."
    }
  },
  additionalProperties: false
};
function engineIdentity(root) {
  let sdkCommit;
  try {
    sdkCommit = JSON.parse(readFileSync8(join10(root, ".forgeax", "engine-sdk.json"), "utf8")).engineCommit;
  } catch {}
  return { sdkCommit, runtimeVersion: resolveInstalledRuntime()?.version };
}
var START_TIMEOUT_MS = 90000;
async function runCurrentGame(rawArgs, cwd) {
  const args = rawArgs;
  const dir = typeof args.target_dir === "string" ? args.target_dir : cwd;
  const startServices = args.start_services !== false;
  const project = resolveProject(dir);
  if (!project.root) {
    return [
      `error: no ForgeaX project found searching upward from ${project.searchedFrom}.`,
      "Run `forgeax-game init --game <slug>` in this directory first, or pass a directory that already contains `.forgeax/` as `target_dir`."
    ].join(`
`);
  }
  const root = project.root;
  const slug = resolveSlug(root, typeof args.game === "string" ? args.game : undefined);
  if ("error" in slug)
    return slug.error;
  const lines = [];
  let caps = await probeServices();
  if (tierAtLeast(caps.tier, "backend")) {
    try {
      await assertServerProjectRoot(root);
      if (tierAtLeast(caps.tier, "runtime"))
        await assertEngineProjectRoot(root);
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (!tierAtLeast(caps.tier, "runtime")) {
    if (!startServices) {
      return [
        `not running: stack is at tier "${caps.tier}" and start_services was false.`,
        ...caps.services.filter((s) => !s.reachable).map((s) => `- ${s.name} ${s.url}: down`)
      ].join(`
`);
    }
    const paths2 = runtimeLogPaths(root);
    const lock = acquireStartLock(root);
    try {
      if (lock.acquired) {
        const ports = await allocateRuntimePorts();
        const portEnv = {
          FORGEAX_PROJECT_ROOT: root,
          FORGEAX_SERVER_PORT: String(ports.server),
          FORGEAX_ENGINE_PORT: String(ports.engine),
          FORGEAX_INTERFACE_PORT: String(ports.interface)
        };
        Object.assign(process.env, portEnv);
        const launcher = await ensureRuntimeLauncher(root, portEnv);
        if (!launcher)
          return launchGuidance();
        mkdirSync6(paths2.dir, { recursive: true });
        const logFd = openSync2(paths2.logFile, "a");
        try {
          const { pid } = startStack(launcher, logFd);
          updateWatcherState(root, {
            game: slug.slug,
            pid,
            startedAt: new Date().toISOString(),
            stoppedAt: undefined,
            stopReason: undefined
          });
          lines.push(`started stack via ${launcher.description} (pid ${pid ?? "unknown"})`);
        } finally {
          closeSync2(logFd);
        }
      } else {
        lines.push("another plugin request is already starting this project stack; waiting for it");
      }
      caps = await waitForTier("runtime", START_TIMEOUT_MS);
      updateWatcherState(root, { lastPollAt: new Date().toISOString() });
    } finally {
      lock.release();
    }
    if (tierAtLeast(caps.tier, "backend")) {
      try {
        await assertServerProjectRoot(root);
        if (tierAtLeast(caps.tier, "runtime"))
          await assertEngineProjectRoot(root);
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  const paths = runtimeLogPaths(root);
  const reachedRuntime = tierAtLeast(caps.tier, "runtime");
  lines.push(`game: ${slug.slug}`);
  lines.push(`source: ${slug.dir}`);
  lines.push(`tier: ${caps.tier}`);
  for (const s of caps.services) {
    lines.push(`- ${s.name} ${s.url}: ${s.reachable ? "up" : `down (${s.reason ?? "unreachable"})`}`);
  }
  if (reachedRuntime) {
    lines.push("");
    lines.push(`preview_url: ${previewUrl(slug.slug)}`);
    const identity = engineIdentity(root);
    lines.push(`runtime.version: ${identity.runtimeVersion ?? "unknown"}`);
    lines.push(`engine_sdk.commit: ${identity.sdkCommit ?? "unknown"}`);
    let previewIdentity;
    try {
      previewIdentity = await fetchEngineRuntimeIdentity();
    } catch {
      previewIdentity = undefined;
    }
    lines.push(`preview.instance_root: ${previewIdentity?.instanceRootAbs ?? "unknown"}`);
    lines.push(`preview.runtime_version: ${previewIdentity?.runtimeVersion ?? "unknown"}`);
    lines.push(`preview.engine_version: ${previewIdentity?.engineVersion ?? "unknown"}`);
    lines.push(`engine.identity: runtime=${identity.runtimeVersion ?? "unknown"} sdk=${identity.sdkCommit ?? "unknown"} project=${root}`);
    lines.push("Open that URL to see the game. Edits to the game source hot-reload.");
  } else {
    lines.push("");
    lines.push(`stack did not reach runtime tier within ${Math.round(START_TIMEOUT_MS / 1000)}s. Check the log below for the reason.`);
  }
  lines.push("");
  if (runtimeLogIsLive(root) && existsSync6(paths.logFile)) {
    lines.push(`runtime_logs.local_file: ${paths.logFile}`);
    lines.push("Read that file with your own file tool to see vite transform errors, build failures and server logs.");
  } else if (existsSync6(paths.logFile)) {
    lines.push(`runtime_logs.local_file: ${paths.logFile} (existing startup log; it may be stale)`);
    lines.push("The currently running stack was not launched by this live plugin process, so new output is not guaranteed.");
  } else {
    lines.push("runtime_logs.local_file: unavailable");
    lines.push("The stack was already running, so this plugin cannot capture its existing process output retroactively.");
  }
  lines.push("It captures stack process output only. Errors thrown inside the running game reach the browser console, not this file.");
  return lines.join(`
`);
}
function resolveSlug(root, requested) {
  if (requested !== undefined && !SLUG_RE.test(requested)) {
    return { error: `error: invalid game slug: ${JSON.stringify(requested)}.` };
  }
  const games = listGames(root);
  if (games.length === 0) {
    return { error: "error: this project has no games. Run `forgeax-game init --game <slug>` to scaffold one." };
  }
  const slug = requested ?? activeGame(root) ?? (games.length === 1 ? games[0] : undefined);
  if (!slug) {
    return {
      error: `error: no active game selected and this project has ${games.length} games (${games.join(", ")}). Pass \`game\`, or run \`forgeax-game use <slug>\`.`
    };
  }
  const dir = gameDir(root, slug);
  if (!dir) {
    return { error: `error: game ${JSON.stringify(slug)} not found. Available: ${games.join(", ")}.` };
  }
  return { slug, dir };
}

// src/mcp/forgeax-server.ts
function packageVersion() {
  for (const relative4 of ["../package.json", "../../package.json"]) {
    try {
      const version = JSON.parse(readFileSync9(new URL(relative4, import.meta.url), "utf8")).version;
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
function createForgeaxMcpServer() {
  return {
    serverInfo: { name: "forgeax", version: packageVersion() },
    instructions: ROUTING_TEXT,
    buildContext: () => ({ cwd: process.cwd() }),
    resources: [
      {
        uri: "forgeax://status",
        name: "ForgeaX status",
        description: "Preferred entry point. Project binding, capability tier, service health, game development kit and routing-rule freshness, and the single next action. Read-only.",
        mimeType: "text/markdown",
        read: async (ctx) => renderStatus(await collectStatus(ctx.cwd))
      }
    ],
    tools: [
      {
        name: "forgeax_status_lite",
        description: "Compatibility fallback for clients that cannot read MCP resources; prefer the `forgeax://status` resource when available. Reports project binding, capability tier, service health, game development kit and routing-rule freshness, and the next action. Read-only — never writes to the workspace.",
        inputSchema: { type: "object", properties: { ...TARGET_DIR_PROPERTY }, additionalProperties: false },
        run: async (args, ctx) => {
          const dir = typeof args.target_dir === "string" ? args.target_dir : ctx.cwd;
          return renderStatus(await collectStatus(dir));
        }
      },
      {
        name: "forgeax_run_current_game",
        description: 'Run, preview, reload, or verify the active game. One call covers what the user means by "run it", "let me see it", "reload", or "does it work": it starts whatever services are down, returns a preview URL to open, and reports whether this plugin owns a runtime log file. Read an available `runtime_logs.local_file` with your own file tool — log tailing is intentionally not a tool. A stack that was already running cannot have its process output captured retroactively. Starting services from cold takes a few seconds, so do not call this for ordinary code edits the user has not asked to see.',
        inputSchema: RUN_TOOL_SCHEMA,
        run: async (args, ctx) => runCurrentGame(args, ctx.cwd)
      }
    ]
  };
}

// src/cli/dispatch.ts
import { existsSync as existsSync9, readFileSync as readFileSync12, rmSync as rmSync3, writeFileSync as writeFileSync7 } from "node:fs";
import { basename as basename2, join as join13 } from "node:path";

// src/install/clients.ts
import { homedir as homedir5 } from "node:os";
import { join as join11, resolve as resolve6 } from "node:path";
var HOME = homedir5();
var CLIENTS = [
  {
    id: "codex",
    label: "Codex CLI",
    format: "toml",
    scope: "user",
    path: () => join11(HOME, ".codex", "config.toml"),
    commandShape: "split",
    postInstallNote: "Restart Codex, then run /mcp to confirm the server is connected."
  },
  {
    id: "claude",
    label: "the reference agent CLI",
    format: "json",
    scope: "user",
    path: () => join11(HOME, ".claude.json"),
    serverMapKey: ["mcpServers"],
    commandShape: "split",
    postInstallNote: "Restart the reference agent CLI, then run /mcp to confirm the server is connected."
  },
  {
    id: "cursor",
    label: "Cursor",
    format: "json",
    scope: "user",
    path: () => join11(HOME, ".cursor", "mcp.json"),
    serverMapKey: ["mcpServers"],
    commandShape: "split",
    postInstallNote: "Reload Cursor, then check Settings > MCP."
  },
  {
    id: "trae",
    label: "Trae (project)",
    format: "json",
    scope: "project",
    path: (projectRoot) => join11(projectRoot, ".trae", "mcp.json"),
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
    path: () => join11(HOME, ".codebuddy", ".mcp.json"),
    serverMapKey: ["mcpServers"],
    commandShape: "split",
    postInstallNote: "Restart a peer agent CLI or WorkBuddy, then run /mcp to confirm the server is connected."
  },
  {
    id: "windsurf",
    label: "Windsurf",
    format: "json",
    scope: "user",
    path: () => join11(HOME, ".codeium", "windsurf", "mcp_config.json"),
    serverMapKey: ["mcpServers"],
    commandShape: "split",
    postInstallNote: "Reload Windsurf to pick up the new server."
  },
  {
    id: "vscode",
    label: "VS Code (workspace)",
    format: "json",
    scope: "project",
    path: (projectRoot) => join11(projectRoot, ".vscode", "mcp.json"),
    serverMapKey: ["servers"],
    commandShape: "split",
    postInstallNote: 'Open .vscode/mcp.json and click Start, or run "MCP: List Servers".'
  },
  {
    id: "opencode",
    label: "OpenCode",
    format: "json",
    scope: "user",
    path: () => join11(HOME, ".config", "opencode", "opencode.json"),
    serverMapKey: ["mcp"],
    commandShape: "argv",
    extraEntryFields: { type: "local", enabled: true },
    postInstallNote: "Restart OpenCode to pick up the new server."
  }
];
var CLIENT_IDS = CLIENTS.map((c) => c.id);
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
    return { command: process.execPath, args: [resolve6(process.argv[1] ?? ""), "mcp"] };
  }
  return { command: "npx", args: ["-y", "-p", "@forgeax/game", "forgeax-game", "mcp"] };
}

// src/install/write-config.ts
import { copyFileSync as copyFileSync3, existsSync as existsSync7, mkdirSync as mkdirSync7, readFileSync as readFileSync10, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname6 } from "node:path";

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
function buildEntry(spec, launch) {
  const command = spec.commandShape === "argv" ? { command: [launch.command, ...launch.args] } : { command: launch.command, args: [...launch.args] };
  return { ...command, ...spec.extraEntryFields ?? {} };
}
function mergeJsonConfig(existing, spec, entry) {
  let root = {};
  if (existing && existing.trim() !== "") {
    let parsed;
    try {
      parsed = JSON.parse(existing);
    } catch (e) {
      throw new Error(`${spec.path("")} is not valid JSON (${e.message}). Fix or move the file, then re-run install.`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${spec.path("")} does not contain a JSON object at the top level.`);
    }
    root = parsed;
  }
  const mapKey = spec.serverMapKey ?? ["mcpServers"];
  let cursor = root;
  for (const key of mapKey) {
    const next = cursor[key];
    if (next === undefined) {
      cursor[key] = {};
    } else if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new Error(`${spec.path("")} has ${mapKey.join(".")} with an incompatible value; refusing to overwrite existing user data.`);
    }
    cursor = cursor[key];
  }
  const before = JSON.stringify(cursor[SERVER_KEY]);
  cursor[SERVER_KEY] = entry;
  const content = `${JSON.stringify(root, null, 2)}
`;
  return { content, changed: before !== JSON.stringify(entry) };
}
function mergeTomlConfig(existing, entry) {
  const body = [];
  const command = entry.command;
  if (typeof command === "string")
    body.push(`command = ${encodeTomlString(command)}`);
  const args = entry.args;
  if (Array.isArray(args))
    body.push(`args = ${encodeTomlStringArray(args)}`);
  const content = upsertTomlTable(existing ?? "", { header: `mcp_servers.${SERVER_KEY}`, body });
  return { content, changed: content !== (existing ?? "") };
}
function inspectConfig(spec, projectRoot, launch) {
  const path = spec.path(projectRoot);
  if (!existsSync7(path))
    return { path, state: "missing" };
  let existing;
  try {
    existing = readFileSync10(path, "utf8");
    if (spec.format === "toml") {
      const header = `mcp_servers.${SERVER_KEY}`;
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
        state: mergeTomlConfig(existing, buildEntry(spec, launch)).changed ? "different" : "current"
      };
    }
    const parsed = JSON.parse(existing);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { path, state: "invalid", detail: "top level is not a JSON object" };
    }
    let cursor = parsed;
    for (const key of spec.serverMapKey ?? ["mcpServers"]) {
      if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
        return { path, state: "not_configured" };
      }
      cursor = cursor[key];
    }
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return { path, state: "not_configured" };
    }
    const entry = cursor[SERVER_KEY];
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
function applyConfig(spec, projectRoot, launch) {
  const path = spec.path(projectRoot);
  const existing = existsSync7(path) ? readFileSync10(path, "utf8") : undefined;
  const entry = buildEntry(spec, launch);
  const merged = spec.format === "toml" ? mergeTomlConfig(existing, entry) : mergeJsonConfig(existing, spec, entry);
  if (!merged.changed)
    return { path, changed: false };
  mkdirSync7(dirname6(path), { recursive: true });
  let backup;
  if (existing !== undefined) {
    backup = `${path}.bak.latest`;
    copyFileSync3(path, backup);
  }
  writeFileSync5(path, merged.content);
  return { path, changed: true, ...backup ? { backup } : {} };
}
function removeConfig(spec, projectRoot) {
  const path = spec.path(projectRoot);
  if (!existsSync7(path))
    return { path, changed: false };
  const existing = readFileSync10(path, "utf8");
  let content;
  if (spec.format === "toml") {
    content = removeTomlTable(existing, `mcp_servers.${SERVER_KEY}`);
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
    if (!(SERVER_KEY in cursor))
      return { path, changed: false };
    delete cursor[SERVER_KEY];
    content = `${JSON.stringify(parsed, null, 2)}
`;
  }
  if (content === existing)
    return { path, changed: false };
  const backup = `${path}.bak.latest`;
  copyFileSync3(path, backup);
  writeFileSync5(path, content);
  return { path, changed: true, backup };
}

// src/install/verify.ts
import { spawn as spawn2 } from "node:child_process";
var REQUIRED_TOOLS = ["forgeax_status_lite", "forgeax_run_current_game"];
var REQUIRED_RESOURCES = ["forgeax://status"];
function commandText(launch) {
  return [launch.command, ...launch.args].map((part) => JSON.stringify(part)).join(" ");
}
function rpcRequest(child, pending, id, method, params = {}) {
  return new Promise((resolve7, reject) => {
    pending.set(id, resolve7);
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
      const resolve7 = pending.get(response.id);
      if (!resolve7)
        continue;
      pending.delete(response.id);
      resolve7(response);
    }
  });
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`MCP handshake timed out after ${timeoutMs}ms for ${commandText(launch)}`));
    }, timeoutMs);
    timer.unref?.();
  });
  const checked = (async () => {
    const initialized = await rpcRequest(child, pending, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "forgeax-game-installer", version: "1" }
    });
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
    if (toolsResponse.error) {
      throw new Error(`tools/list failed: ${toolsResponse.error.message ?? toolsResponse.error.code}`);
    }
    const tools = namesFrom(toolsResponse.result, "tools");
    const missingTools = REQUIRED_TOOLS.filter((name) => !tools.includes(name));
    if (missingTools.length)
      throw new Error(`MCP server is missing tools: ${missingTools.join(", ")}`);
    const resourcesResponse = await rpcRequest(child, pending, 3, "resources/list");
    if (resourcesResponse.error) {
      throw new Error(`resources/list failed: ${resourcesResponse.error.message ?? resourcesResponse.error.code}`);
    }
    const resources = namesFrom(resourcesResponse.result, "resources");
    const missingResources = REQUIRED_RESOURCES.filter((uri) => !resources.includes(uri));
    if (missingResources.length) {
      throw new Error(`MCP server is missing resources: ${missingResources.join(", ")}`);
    }
    return {
      serverName: String(info.name),
      serverVersion: typeof info.version === "string" ? info.version : "unknown",
      tools,
      resources
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

// src/project/engine-sdk.ts
import { cpSync as cpSync2, existsSync as existsSync8, mkdirSync as mkdirSync8, readdirSync as readdirSync4, readFileSync as readFileSync11, writeFileSync as writeFileSync6 } from "node:fs";
import { join as join12, sep as sep2 } from "node:path";
function bundledSdkRoot() {
  return join12(runtimeManifestRoot(), "assets", "engine-sdk");
}
function installEngineSdk(projectRoot) {
  const source = bundledSdkRoot();
  const destination = join12(projectRoot, ".forgeax", "engine-sdk");
  if (!existsSync8(source)) {
    return { changed: false, sdkRoot: destination };
  }
  mkdirSync8(join12(projectRoot, ".forgeax"), { recursive: true });
  cpSync2(source, destination, {
    recursive: true,
    dereference: true,
    force: true,
    filter: (entry) => {
      if (entry === source)
        return true;
      const top = entry.slice(source.length + 1).split(sep2)[0];
      return top !== "skills" && top !== "source";
    }
  });
  let engineCommit;
  try {
    engineCommit = JSON.parse(readFileSync11(join12(destination, "engine-version.json"), "utf8")).engineCommit;
  } catch {}
  const bundledSource = join12(source, "source");
  const sourceRoot = existsSync8(bundledSource) ? bundledSource : undefined;
  writeFileSync6(join12(projectRoot, ".forgeax", "engine-sdk.json"), `${JSON.stringify({
    version: 2,
    engineCommit: engineCommit ?? "unknown",
    sdkRoot: destination,
    ...sourceRoot ? { sourceRoot } : {}
  }, null, 2)}
`, "utf8");
  const gamesRoot = join12(projectRoot, ".forgeax", "games");
  if (existsSync8(gamesRoot)) {
    for (const entry of readdirSync4(gamesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory())
        continue;
      const gameRoot = join12(gamesRoot, entry.name);
      const tsconfig = join12(gameRoot, "tsconfig.json");
      if (!existsSync8(tsconfig)) {
        writeFileSync6(tsconfig, `${JSON.stringify({
          extends: "../../engine-sdk/tsconfig.json",
          include: ["**/*.ts"]
        }, null, 2)}
`, "utf8");
      }
    }
  }
  return { changed: true, sdkRoot: destination, engineCommit, ...sourceRoot ? { sourceRoot } : {} };
}

// src/cli/dispatch.ts
var HELP = `ForgeaX game development plugin

Usage:
  forgeax-game install [--ide codex,claude,cursor,trae,opencode,workbuddy] [--local]
  forgeax-game uninstall [--ide ...] [--purge]
  forgeax-game init [--game <slug>] [--ide ...]
  forgeax-game use <slug>
  forgeax-game doctor
  forgeax-game devkit install
  forgeax-game agents update
  forgeax-game update [--ide ...]
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
    throw new Error(`no ForgeaX project found searching upward from ${project.searchedFrom}; run this command inside a directory containing .forgeax/`);
  }
  return project.root;
}
function updateAgentsFile(root) {
  const path = join13(root, "AGENTS.md");
  const existing = existsSync9(path) ? readFileSync12(path, "utf8") : undefined;
  const content = upsertBlock(existing, ROUTING_TEXT);
  if (content === existing)
    return { path, changed: false };
  writeFileSync7(path, content);
  return { path, changed: true };
}
function removeAgentsBlock(root) {
  const path = join13(root, "AGENTS.md");
  if (!existsSync9(path))
    return { path, changed: false };
  const existing = readFileSync12(path, "utf8");
  const content = removeBlock(existing);
  if (content === existing)
    return { path, changed: false };
  writeFileSync7(path, content);
  return { path, changed: true };
}
async function apiPost(path, body) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), 1e4);
  try {
    const response = await fetch(`${serverBaseUrl()}${path}`, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: text };
      }
    }
    if (!response.ok) {
      throw new Error(`${path} returned HTTP ${response.status}: ${String(payload.error ?? response.statusText)}`);
    }
    return payload;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${serverBaseUrl()} did not answer ${path} within 10s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function installCommand(args) {
  const parsed = parseInstallArgs(args);
  const launch = launchSpec(parsed.mode);
  process.stdout.write(`Verifying ${launch.command} ${launch.args.join(" ")} ...
`);
  const verified = await verifyLaunch(launch);
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
function defaultSlug(root) {
  const raw = basename2(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return SLUG_RE.test(raw) ? raw : "my-game";
}
var INIT_USAGE = "usage: forgeax-game init [--game <slug>] [--ide codex,claude,cursor,...]";
function parseInitArgs(args, root) {
  const rest = [];
  let slug;
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    if (arg === "--game") {
      const value = args[++i];
      if (!value)
        throw new Error(INIT_USAGE);
      slug = value;
      continue;
    }
    if (arg.startsWith("--game=")) {
      slug = arg.slice("--game=".length);
      continue;
    }
    rest.push(arg);
  }
  const ide = parseIdeSelector(rest, INIT_USAGE);
  return { slug: slug ?? defaultSlug(root), ...ide ? { ide } : {} };
}
async function initCommand(args) {
  const binding = resolveProject();
  const root = binding.root ?? process.cwd();
  const parsedInit = parseInitArgs(args, root);
  const slug = parsedInit.slug;
  if (!SLUG_RE.test(slug)) {
    throw new Error("game slug must be 1-41 lowercase ASCII letters, digits, or hyphens, starting with a letter or digit");
  }
  if (gameDir(root, slug))
    throw new Error(`game ${JSON.stringify(slug)} already exists`);
  const capabilities = await probeServices();
  let useServer = capabilities.tier !== "local";
  if (useServer && !binding.root) {
    try {
      await assertServerProjectRoot(root);
    } catch {
      useServer = false;
    }
  }
  if (useServer) {
    if (binding.root)
      await assertServerProjectRoot(root);
    if (!binding.root)
      ensureLocalProject(root);
    const response = await apiPost("/api/workbench/games", { slug, name: slug, brief: "" });
    if (!gameDir(root, slug)) {
      throw new Error(`server created ${JSON.stringify(response.gameDir ?? slug)}, but it is not under ${root}/.forgeax/games; run the CLI against the same instance root as the server`);
    }
  } else {
    const local = initLocalGame(root, slug);
    process.stdout.write(`Created a local ForgeaX project and game ${slug} at ${local.gameRoot} (no matching server; online scaffold will be used for later games).
`);
  }
  const sdk = installEngineSdk(root);
  process.stdout.write(`${sdk.changed ? "UPDATED" : "CURRENT"} bundled Engine SDK: ${sdk.sdkRoot}${sdk.engineCommit ? ` (${sdk.engineCommit})` : ""}
`);
  if (sdk.sourceRoot)
    process.stdout.write(`Engine source available for escalation: ${sdk.sourceRoot}
`);
  const agents = updateAgentsFile(root);
  const selection = selectClients(root, parsedInit.ide);
  reportMissingClients(selection.missing);
  const hosts = selection.selected;
  const devkit = installDevKit(root, hosts);
  process.stdout.write(`Created and activated game ${slug} at ${gameDir(root, slug)}.
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
  await assertServerProjectRoot(root);
  await apiPost(`/api/workbench/games/${encodeURIComponent(slug)}/activate`);
  process.stdout.write(`Active game: ${slug}
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
  const rest = args.filter((arg) => arg !== "--purge");
  const requested = parseIdeSelector(rest, "usage: forgeax-game uninstall [--ide codex,claude,...] [--purge]");
  const binding = resolveProject();
  const root = binding.root;
  const targets = requested ? requested.map((id) => id === "workbuddy" ? "codebuddy" : id) : root ? configuredClientIds(root) : [...CLIENT_IDS];
  const clients = CLIENTS.filter((client) => targets.includes(client.id));
  let failures = 0;
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
    process.stdout.write(`KEPT    your games and project metadata: ${join13(root, ".forgeax")}
`);
  } else {
    process.stdout.write(`INFO  no ForgeaX project bound; only client configuration was touched.
`);
  }
  if (purge) {
    const cache = runtimeCacheRoot();
    rmSync3(cache, { recursive: true, force: true });
    process.stdout.write(`PURGED managed Runtime cache: ${cache}
`);
  } else {
    process.stdout.write(`KEPT    managed Runtime cache (use --purge to remove): ${runtimeCacheRoot()}
`);
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
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (major >= 18)
    process.stdout.write(`OK Node ${process.versions.node}
`);
  else {
    warnings++;
    process.stdout.write(`FAIL Node ${process.versions.node}; Node 18 or newer is required
`);
  }
  const project = resolveProject();
  if (project.root) {
    process.stdout.write(`OK project ${project.root}; active=${activeGame(project.root) ?? "(none)"}; games=${listGames(project.root).join(", ") || "(none)"}
`);
    if (hasDevKit(project.root)) {
      const engine = installedEngineSkills(project.root);
      const bundled = bundledEngineSkillCount();
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
    process.stdout.write(`WARN no ForgeaX project found from ${project.searchedFrom}
`);
  }
  const runtime = resolveInstalledRuntime();
  if (runtime) {
    process.stdout.write(`OK managed ForgeaX Runtime ${runtime.version} (${runtime.platform}/${runtime.arch})
`);
  } else if (loadRuntimeManifest()) {
    warnings++;
    process.stdout.write(`WARN managed Runtime is not installed; first run will download and verify the selected artifact
`);
  } else {
    warnings++;
    process.stdout.write(`WARN no Runtime manifest found; publish/install assets/runtime-manifest.json or set FORGEAX_RUNTIME_MANIFEST
`);
  }
  let capabilities = await probeServices();
  if (project.root && capabilities.services.some((service) => service.name === "server" && service.reachable)) {
    try {
      await assertServerProjectRoot(project.root);
      if (capabilities.tier === "runtime")
        await assertEngineProjectRoot(project.root);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      capabilities = {
        tier: "local",
        services: capabilities.services.map((service) => ({ ...service, reachable: false, reason }))
      };
    }
  }
  process.stdout.write(`Capability tier: ${capabilities.tier}
`);
  for (const service of capabilities.services) {
    if (!service.reachable)
      warnings++;
    process.stdout.write(`${service.reachable ? "OK" : "WARN"} ${service.name} ${service.url}${service.reason ? `: ${service.reason}` : ""}
`);
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
    const result = applyConfig(client, root, launch);
    process.stdout.write(`${result.changed ? "UPDATED" : "CURRENT"} ${client.label}: ${result.path}
`);
  }
  if (project.root) {
    const sdk = installEngineSdk(project.root);
    const devkit = installDevKit(project.root, configured.map((client) => client.id));
    const agents = updateAgentsFile(project.root);
    process.stdout.write(`${sdk.changed ? "UPDATED" : "CURRENT"} bundled Engine SDK: ${sdk.sdkRoot}
`);
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
    case "devkit":
      return devkitCommand(args);
    case "agents":
      return agentsCommand(args);
    case "update":
      return updateCommand(args);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command ?? "(none)"}

${HELP}`);
      return 2;
  }
}

// src/main.ts
var argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "mcp") {
  runStdioServer(createForgeaxMcpServer());
} else {
  runCli(argv).then((code) => process.exit(code), (e) => {
    process.stderr.write(`forgeax-game: ${e instanceof Error ? e.message : String(e)}
`);
    process.exit(1);
  });
}

//# debugId=79A7B44191D7FDBA64756E2164756E21
