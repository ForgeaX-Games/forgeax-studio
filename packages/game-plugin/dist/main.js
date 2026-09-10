#!/usr/bin/env node

// src/main.ts
import { resolve as resolve7 } from "node:path";

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
import { readFileSync as readFileSync8 } from "node:fs";
import { resolve as resolve5 } from "node:path";

// src/status/collect.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { join as join5 } from "node:path";

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
import { engineSdkRoot } from "@forgeax/game-runtime";

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
- Generating art or 3D assets ("make a sprite", "I need a texture", "generate a
  model of…"): call \`forgeax_generate_image\` (text-to-image, or image-to-image
  with a local \`image\`) or \`forgeax_generate_3d\` (text-to-3D via \`prompt\`,
  image-to-3D via \`image\`). Both save into the active game's \`assets/\` directory
  and return the project-relative path to reference from code. Image-to-3D accepts a
  public https URL, or a local file path when COS is configured (it is uploaded and
  passed as a short-lived presigned URL). They need \`FORGEAX_LITELLM_API_KEY\` (and
  \`FORGEAX_COS_*\` for local-file image-to-3D) in the environment.
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
function skillRoots() {
  const here = dirname3(fileURLToPath(import.meta.url));
  const isPluginSkill = (id) => id === PLUGIN_SKILL_ID;
  const anySkill = () => true;
  return [
    { path: resolve2(here, "..", "assets", "skills"), accepts: anySkill },
    { path: resolve2(here, "..", "..", "assets", "skills"), accepts: anySkill },
    { path: resolve2(engineSdkRoot(), "skills"), accepts: isEngineSkill },
    { path: resolve2(here, "..", "..", "skills"), accepts: isPluginSkill }
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
  for (const mount of new Set(Object.values(HOST_MOUNTS).map((entry) => entry.skills))) {
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

// src/status/collect.ts
import { resolveInstalledRuntime } from "@forgeax/game-runtime";
var AGENTS_DOC_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];
function readAgentsDoc(root) {
  for (const name of AGENTS_DOC_CANDIDATES) {
    try {
      return readFileSync4(join5(root, name), "utf8");
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
    return "Bundled Engine SDK is not installed. Run `forgeax-game init` or `forgeax-game upgrade` to materialize the version-matched Engine types, templates, skills, and source.";
  }
  if (s.agentsBlock.status === "missing_file" || s.agentsBlock.status === "missing_block") {
    return "Project routing rules are not installed in AGENTS.md. Run `forgeax-game agents update`, then start a new session so the client re-reads the file.";
  }
  if (s.agentsBlock.status === "outdated") {
    return "Project routing rules in AGENTS.md are stale. Run `forgeax-game agents update`, then start a new session so the client re-reads the file.";
  }
  if (!s.runtime.installed) {
    return "Managed ForgeaX Runtime is not installed. Call `forgeax_run_current_game`; it will verify, cache, and build the selected npm Runtime package preview.";
  }
  if (s.runtimeLogs?.live && s.runtimeLogs.state?.previewUrl) {
    return `Static preview is live for \`.forgeax/games/${s.activeGame}\`. Edit the game and call \`forgeax_run_current_game\` to rebuild it.`;
  }
  if (s.capabilities.tier !== "runtime") {
    return `Ready to edit \`.forgeax/games/${s.activeGame}/\`. To run or preview the game, call \`forgeax_run_current_game\` — it will build and serve a static preview.`;
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
      const value = JSON.parse(readFileSync4(join5(project.root, ".forgeax", "engine-sdk.json"), "utf8"));
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
    lines.push("- status: not installed (first run verifies and extracts the selected Runtime package automatically)");
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
import { closeSync as closeSync2, existsSync as existsSync3, mkdirSync as mkdirSync6, openSync as openSync2, readFileSync as readFileSync5 } from "node:fs";
import { join as join6 } from "node:path";

// src/services/launch.ts
import { spawn } from "node:child_process";
import {
  ensureRuntime,
  launcherForRuntime,
  resolveInstalledRuntime as resolveInstalledRuntime2,
  runtimeEnvironment
} from "@forgeax/game-runtime";
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
  const installed = resolveInstalledRuntime2();
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
    "Install a supported @forgeax/game-runtime package, then call this tool again.",
    "",
    "Advanced override (not recommended for normal installs):",
    '  export FORGEAX_START_COMMAND="<command that brings up server :18900 and engine :15173>"'
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

// src/run/run-game.ts
import { allocateRuntimePorts, resolveInstalledRuntime as resolveInstalledRuntime3 } from "@forgeax/game-runtime";

// src/run/static-preview.ts
import { spawn as spawn2, spawnSync as spawnSync2 } from "node:child_process";
import { closeSync, mkdirSync as mkdirSync5, openSync } from "node:fs";
import { isAbsolute as isAbsolute2, resolve as resolve3 } from "node:path";
import {
  allocatePort,
  ensureRuntime as ensureRuntime2,
  installEngineSdk,
  parsePreviewBuildManifest,
  parsePreviewHealthIdentity,
  runtimeEnvironment as runtimeEnvironment2
} from "@forgeax/game-runtime";
function runtimeCommand(runtime) {
  return isAbsolute2(runtime.command) ? runtime.command : resolve3(runtime.root, runtime.command);
}
function lastJsonLine(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1;index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }
  throw new Error(`Runtime returned no JSON result:
${output}`);
}
function buildPreview(runtime, projectRoot, gameRoot, gameId) {
  const result = spawnSync2(runtimeCommand(runtime), [
    resolve3(runtime.root, runtime.capabilities.build.script),
    "--project-root",
    projectRoot,
    "--game-root",
    gameRoot,
    "--game-id",
    gameId,
    "--runtime-version",
    runtime.version,
    "--engine-commit",
    runtime.engineCommit
  ], {
    cwd: runtime.root,
    encoding: "utf8",
    env: runtimeEnvironment2({ FORGEAX_PROJECT_ROOT: projectRoot }),
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `preview build exited ${result.status}`).trim());
  }
  const parsed = lastJsonLine(result.stdout);
  return {
    manifest: parsePreviewBuildManifest(parsed.manifest),
    reused: parsed.reused === true
  };
}
async function waitForHealth(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok)
        return parsePreviewHealthIdentity(await response.json());
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error(`preview did not become ready: ${lastError}`);
}
async function buildAndStartStaticPreview(projectRoot, gameRoot, gameId) {
  const runtime = await ensureRuntime2();
  const sdk = installEngineSdk(projectRoot);
  if (sdk.engineCommit && sdk.engineCommit !== runtime.engineCommit) {
    throw new Error(`Engine SDK ${sdk.engineCommit} does not match Runtime ${runtime.engineCommit}; reinstall matching packages`);
  }
  const build = buildPreview(runtime, projectRoot, gameRoot, gameId);
  const existing = readWatcherState(projectRoot);
  if (existing?.pid && existing.outputRoot === build.manifest.outputRoot && existing.previewUrl) {
    try {
      process.kill(existing.pid, 0);
      const healthUrl2 = new URL("__forgeax_health", existing.previewUrl).toString();
      const health2 = await waitForHealth(healthUrl2, 2000);
      return {
        previewUrl: existing.previewUrl,
        health: health2,
        runtime,
        reused: true,
        pid: existing.pid
      };
    } catch {}
  }
  if (existing?.pid) {
    try {
      process.kill(existing.pid, "SIGTERM");
    } catch {}
  }
  const port = await allocatePort();
  const previewUrl2 = `http://127.0.0.1:${port}/preview/`;
  const healthUrl = `${previewUrl2}__forgeax_health`;
  const paths = runtimeLogPaths(projectRoot);
  mkdirSync5(paths.dir, { recursive: true });
  const logFd = openSync(paths.logFile, "a");
  let child;
  try {
    child = spawn2(runtimeCommand(runtime), [
      resolve3(runtime.root, runtime.capabilities.serve.script),
      "--output-root",
      build.manifest.outputRoot,
      "--host",
      "127.0.0.1",
      "--port",
      String(port)
    ], {
      cwd: runtime.root,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: runtimeEnvironment2({ FORGEAX_PROJECT_ROOT: projectRoot })
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
  if (!child.pid)
    throw new Error("preview server did not return a process id");
  updateWatcherState(projectRoot, {
    game: gameId,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    stoppedAt: undefined,
    stopReason: undefined,
    previewUrl: previewUrl2,
    outputRoot: build.manifest.outputRoot,
    buildHash: build.manifest.buildHash,
    runtimeVersion: runtime.version,
    engineCommit: runtime.engineCommit
  });
  const health = await waitForHealth(healthUrl);
  updateWatcherState(projectRoot, { lastSuccessAt: new Date().toISOString() });
  return { previewUrl: previewUrl2, health, runtime, reused: build.reused, pid: child.pid };
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
    sdkCommit = JSON.parse(readFileSync5(join6(root, ".forgeax", "engine-sdk.json"), "utf8")).engineCommit;
  } catch {}
  return { sdkCommit, runtimeVersion: resolveInstalledRuntime3()?.version };
}
var START_TIMEOUT_MS = 90000;
async function runCurrentGame(rawArgs, cwd, options = {}) {
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
  if (!process.env.FORGEAX_START_COMMAND?.trim() && !options.existingServicesOnly) {
    return runPackagedPreview(root, slug, startServices);
  }
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
    if (options.existingServicesOnly) {
      return [
        `not running: the supervisor-owned Studio stack is at tier "${caps.tier}".`,
        ...caps.services.filter((service) => !service.reachable).map((service) => `- ${service.name} ${service.url}: down (${service.reason ?? "unreachable"})`)
      ].join(`
`);
    }
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
  if (runtimeLogIsLive(root) && existsSync3(paths.logFile)) {
    lines.push(`runtime_logs.local_file: ${paths.logFile}`);
    lines.push("Read that file with your own file tool to see vite transform errors, build failures and server logs.");
  } else if (existsSync3(paths.logFile)) {
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
async function runPackagedPreview(root, slug, startServices) {
  const paths = runtimeLogPaths(root);
  if (!startServices) {
    const state = readWatcherState(root);
    return state?.previewUrl && runtimeLogIsLive(root) ? `game: ${slug.slug}
tier: runtime
preview_url: ${state.previewUrl}` : "not running: static preview is down and start_services was false.";
  }
  const lock = acquireStartLock(root);
  if (!lock.acquired) {
    return "another plugin request is already building this game preview; call forgeax_run_current_game again shortly.";
  }
  try {
    const result = await buildAndStartStaticPreview(root, slug.dir, slug.slug);
    return [
      `game: ${slug.slug}`,
      `source: ${slug.dir}`,
      "tier: runtime",
      `preview_url: ${result.previewUrl}`,
      `runtime.version: ${result.runtime.version}`,
      `engine_sdk.commit: ${result.runtime.engineCommit}`,
      `preview.instance_root: ${result.health.projectRoot}`,
      `preview.runtime_version: ${result.health.runtimeVersion}`,
      `preview.engine_version: ${result.health.engineCommit}`,
      `preview.build_hash: ${result.health.buildHash}`,
      `engine.identity: runtime=${result.runtime.version} sdk=${result.runtime.engineCommit} project=${root}`,
      `build.reused: ${result.reused}`,
      "",
      `runtime_logs.local_file: ${paths.logFile}`,
      "Open that URL to see the prebuilt game preview. Call this tool again after edits to rebuild it."
    ].join(`
`);
  } catch (error) {
    return [
      `error: ${error instanceof Error ? error.message : String(error)}`,
      `runtime_logs.local_file: ${paths.logFile}`
    ].join(`
`);
  } finally {
    lock.release();
  }
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

// src/gen/generate.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync7, readFileSync as readFileSync6, writeFileSync as writeFileSync4 } from "node:fs";
import { basename, extname, join as join7, relative as relative3 } from "node:path";

// src/gen/config.ts
var DEFAULT_LITELLM_BASE_URL = "http://21.214.33.175:4000";
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
  const baseUrl = (env("FORGEAX_LITELLM_BASE_URL") ?? DEFAULT_LITELLM_BASE_URL).replace(/\/+$/, "");
  const apiKey = env("FORGEAX_LITELLM_API_KEY");
  if (!apiKey) {
    throw new Error("FORGEAX_LITELLM_API_KEY is not set. Export the LiteLLM key so the asset tools can reach the gateway, e.g. `export FORGEAX_LITELLM_API_KEY=sk-...`.");
  }
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
import { createHash as createHash2, createHmac } from "node:crypto";
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
  const httpStringSha1 = createHash2("sha1").update(httpString).digest("hex");
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
  mkdirSync7(assets, { recursive: true });
  return { dir: assets, root: binding.root, slug };
}
function safeStem(preferred, fallback) {
  const source = (preferred ?? fallback).toLowerCase();
  const stem = source.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return stem || "asset";
}
function uniquePath(dir, stem, ext) {
  let candidate = join7(dir, `${stem}.${ext}`);
  for (let i = 1;existsSync4(candidate); i += 1)
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
    if (!existsSync4(inputImage))
      throw new Error(`Input image not found: ${inputImage}`);
    const bytes = new Uint8Array(readFileSync6(inputImage));
    result = await editImage(cfg, { model, prompt, image: bytes, filename: basename(inputImage) });
    mode = "image-to-image";
  } else {
    result = await generateImage(cfg, { model, prompt });
    mode = "text-to-image";
  }
  const stem = safeStem(typeof args.name === "string" ? args.name : undefined, prompt);
  const outPath = uniquePath(dir, stem, result.ext);
  writeFileSync4(outPath, result.bytes);
  const rel = relative3(root, outPath);
  return `Saved ${mode} asset to \`${rel}\` (game: ${slug}, model: ${model}, ${result.bytes.length} bytes). Reference it from game code by this path.`;
}
function imageContentType(path) {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg")
    return "image/jpeg";
  if (ext === ".webp")
    return "image/webp";
  return "image/png";
}
async function resolveImageUrlFor3d(image, slug) {
  if (HTTP_URL_RE.test(image))
    return image;
  if (!existsSync4(image))
    throw new Error(`Input image not found: ${image}`);
  const cos = resolveCosConfig();
  if (!cos) {
    throw new Error("Image-to-3D from a local file needs COS configured (FORGEAX_COS_BUCKET/REGION/SECRET_ID/SECRET_KEY) so the image can be hosted for the backend to fetch. Alternatively pass a public https URL.");
  }
  const bytes = new Uint8Array(readFileSync6(image));
  const stem = safeStem(basename(image, extname(image)), "input");
  const ext = (extname(image).replace(".", "") || "png").toLowerCase();
  const key = `forgeax/${slug}/${stem}-${Date.now()}.${ext}`;
  return uploadAndPresign(cos, key, bytes, imageContentType(image));
}
async function generate3dTool(args, cwd) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const image = typeof args.image === "string" ? args.image.trim() : "";
  if (!prompt && !image)
    throw new Error("Provide `prompt` (text-to-3D) or `image` (image-to-3D).");
  const cfg = resolveLiteLlmConfig();
  const targetDir = typeof args.target_dir === "string" ? args.target_dir : cwd;
  const { dir, root, slug } = assetsDirFor(targetDir, typeof args.game === "string" ? args.game : undefined);
  let result;
  let mode;
  if (image) {
    const imageUrl = await resolveImageUrlFor3d(image, slug);
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
  writeFileSync4(outPath, result.bytes);
  const rel = relative3(root, outPath);
  return `Saved ${mode} ${result.assetType} to \`${rel}\` (game: ${slug}, ${result.bytes.length} bytes). Reference it from game code by this path.`;
}

// src/mcp/game-files.ts
import { createHash as createHash3, randomUUID } from "node:crypto";
import {
  existsSync as existsSync5,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync8,
  readFileSync as readFileSync7,
  readdirSync as readdirSync3,
  renameSync as renameSync2,
  rmSync as rmSync2,
  statSync as statSync4,
  writeFileSync as writeFileSync5
} from "node:fs";
import { dirname as dirname4, extname as extname2, join as join8, relative as relative4, resolve as resolve4, sep as sep2 } from "node:path";
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
  return createHash3("sha256").update(content).digest("hex");
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
  if (!TEXT_EXTENSIONS.has(extname2(segments.at(-1)).toLowerCase())) {
    throw new Error("path must name a supported UTF-8 text file");
  }
  return segments;
}
function confinedPath(gameRoot, raw, allowMissing) {
  const segments = safeSegments(raw);
  const root = resolve4(gameRoot);
  const path = resolve4(root, ...segments);
  const rel = relative4(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep2}`))
    throw new Error("path escapes the game root");
  let cursor = root;
  for (const segment of segments) {
    cursor = join8(cursor, segment);
    if (!existsSync5(cursor)) {
      if (!allowMissing)
        throw new Error(`file does not exist: ${segments.join("/")}`);
      continue;
    }
    if (lstatSync2(cursor).isSymbolicLink())
      throw new Error("path traverses a symbolic link");
  }
  return { path, relativePath: segments.join("/") };
}
function listTextFiles(gameRoot) {
  const rows = [];
  const visit = (dir) => {
    for (const entry of readdirSync3(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (rows.length >= MAX_LISTED_FILES)
        return;
      if (entry.name.startsWith(".") || BLOCKED_SEGMENTS.has(entry.name) || entry.isSymbolicLink())
        continue;
      const path = join8(dir, entry.name);
      if (entry.isDirectory())
        visit(path);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(extname2(entry.name).toLowerCase())) {
        rows.push({ path: relative4(gameRoot, path).split(sep2).join("/"), bytes: statSync4(path).size });
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
  const content = readFileSync7(file.path);
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
  const path = candidates.find((candidate) => existsSync5(candidate) && statSync4(candidate).isFile());
  if (!path)
    return { available: false, searched: candidates.map((candidate) => relative4(project.root, candidate)) };
  const size = statSync4(path).size;
  const content = readFileSync7(path);
  const tail = content.subarray(Math.max(0, content.length - MAX_LOG_BYTES)).toString("utf8");
  const rows = tail.split(/\r?\n/);
  if (rows.at(-1) === "")
    rows.pop();
  return {
    available: true,
    path: relative4(project.root, path).split(sep2).join("/"),
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
  const exists = existsSync5(file.path);
  if (exists) {
    if (!statSync4(file.path).isFile())
      throw new Error(`path is not a file: ${file.relativePath}`);
    if (typeof args.expected_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(args.expected_sha256)) {
      throw new Error("expected_sha256 is required when replacing an existing file");
    }
    const current = sha256(readFileSync7(file.path));
    if (current !== args.expected_sha256) {
      throw new Error(`file changed since it was read: expected ${args.expected_sha256}, current ${current}`);
    }
  } else if (args.expected_sha256 !== undefined) {
    throw new Error("expected_sha256 must be omitted when creating a new file");
  }
  mkdirSync8(dirname4(file.path), { recursive: true });
  const temporary = `${file.path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync5(temporary, args.content, { encoding: "utf8", flag: "wx" });
    renameSync2(temporary, file.path);
  } finally {
    rmSync2(temporary, { force: true });
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
  for (const relative5 of ["../package.json", "../../package.json"]) {
    try {
      const version = JSON.parse(readFileSync8(new URL(relative5, import.meta.url), "utf8")).version;
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
  const cwd = options.root ? resolve5(options.root) : undefined;
  const { target_dir: _targetDir, ...fixedRunProperties } = RUN_TOOL_SCHEMA.properties;
  const runInputSchema = allowTargetDir ? RUN_TOOL_SCHEMA : { ...RUN_TOOL_SCHEMA, properties: fixedRunProperties };
  return {
    serverInfo: { name: "forgeax", version: packageVersion() },
    instructions: ROUTING_TEXT,
    buildContext: () => ({ cwd: cwd ?? process.cwd() }),
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
        description: 'Build, preview, reload, or verify the active game. One call covers what the user means by "run it", "let me see it", "reload", or "does it work": it installs the selected Runtime when needed, builds or reuses a static preview, returns a preview URL to open, and reports the Runtime log file. Read an available `runtime_logs.local_file` with your own file tool — log tailing is intentionally not a tool. Call this after a requested game change, not for ordinary edits the user has not asked to see.',
        inputSchema: runInputSchema,
        run: async (args, ctx) => publicPreviewResult(await runCurrentGame(allowTargetDir ? args : { ...args, target_dir: ctx.cwd }, ctx.cwd, { existingServicesOnly: options.existingServicesOnly }), options.publicOrigin)
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
  await new Promise((resolve6, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve6();
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
    close: () => new Promise((resolve6, reject) => {
      server.close((error) => error ? reject(error) : resolve6());
    })
  };
}

// src/cli/dispatch.ts
import { existsSync as existsSync7, readFileSync as readFileSync10, rmSync as rmSync3, writeFileSync as writeFileSync7 } from "node:fs";
import { basename as basename2, join as join10 } from "node:path";

// src/install/clients.ts
import { homedir as homedir3 } from "node:os";
import { join as join9, resolve as resolve6 } from "node:path";
var HOME = homedir3();
var CLIENTS = [
  {
    id: "codex",
    label: "Codex CLI",
    format: "toml",
    scope: "user",
    path: () => join9(HOME, ".codex", "config.toml"),
    commandShape: "split",
    postInstallNote: "Restart Codex, then run /mcp to confirm the server is connected."
  },
  {
    id: "claude",
    label: "the reference agent CLI",
    format: "json",
    scope: "user",
    path: () => join9(HOME, ".claude.json"),
    serverMapKey: ["mcpServers"],
    commandShape: "split",
    postInstallNote: "Restart the reference agent CLI, then run /mcp to confirm the server is connected."
  },
  {
    id: "cursor",
    label: "Cursor",
    format: "json",
    scope: "user",
    path: () => join9(HOME, ".cursor", "mcp.json"),
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
    path: () => join9(HOME, ".codebuddy", ".mcp.json"),
    serverMapKey: ["mcpServers"],
    commandShape: "split",
    postInstallNote: "Restart a peer agent CLI or WorkBuddy, then run /mcp to confirm the server is connected."
  },
  {
    id: "windsurf",
    label: "Windsurf",
    format: "json",
    scope: "user",
    path: () => join9(HOME, ".codeium", "windsurf", "mcp_config.json"),
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
    path: () => join9(HOME, ".zcode", "cli", "config.json"),
    serverMapKey: ["mcp", "servers"],
    commandShape: "split",
    postInstallNote: "Start a new ZCode session, then run /mcp status to confirm the server is connected."
  },
  {
    id: "opencode",
    label: "OpenCode",
    format: "json",
    scope: "user",
    path: () => join9(HOME, ".config", "opencode", "opencode.json"),
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
import { copyFileSync as copyFileSync2, existsSync as existsSync6, mkdirSync as mkdirSync9, readFileSync as readFileSync9, writeFileSync as writeFileSync6 } from "node:fs";
import { dirname as dirname5 } from "node:path";

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
  if (!existsSync6(path))
    return { path, state: "missing" };
  let existing;
  try {
    existing = readFileSync9(path, "utf8");
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
  const existing = existsSync6(path) ? readFileSync9(path, "utf8") : undefined;
  const entry = buildEntry(spec, launch);
  const merged = spec.format === "toml" ? mergeTomlConfig(existing, entry) : mergeJsonConfig(existing, spec, entry);
  if (!merged.changed)
    return { path, changed: false };
  mkdirSync9(dirname5(path), { recursive: true });
  let backup;
  if (existing !== undefined) {
    backup = `${path}.bak.latest`;
    copyFileSync2(path, backup);
  }
  writeFileSync6(path, merged.content);
  return { path, changed: true, ...backup ? { backup } : {} };
}
function removeConfig(spec, projectRoot) {
  const path = spec.path(projectRoot);
  if (!existsSync6(path))
    return { path, changed: false };
  const existing = readFileSync9(path, "utf8");
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
  copyFileSync2(path, backup);
  writeFileSync6(path, content);
  return { path, changed: true, backup };
}

// src/install/verify.ts
import { spawn as spawn3 } from "node:child_process";
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
  const child = spawn3(launch.command, [...launch.args], {
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

// src/cli/dispatch.ts
import {
  installEngineSdk as installEngineSdk2,
  loadRuntimeManifest,
  resolveInstalledRuntime as resolveInstalledRuntime4,
  runtimeCacheRoot
} from "@forgeax/game-runtime";
var HELP = `ForgeaX game development plugin

Usage:
  forgeax-game install [--ide ${CLIENT_CHOICES.join(",")}] [--local]
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
  const path = join10(root, "AGENTS.md");
  const existing = existsSync7(path) ? readFileSync10(path, "utf8") : undefined;
  const content = upsertBlock(existing, ROUTING_TEXT);
  if (content === existing)
    return { path, changed: false };
  writeFileSync7(path, content);
  return { path, changed: true };
}
function removeAgentsBlock(root) {
  const path = join10(root, "AGENTS.md");
  if (!existsSync7(path))
    return { path, changed: false };
  const existing = readFileSync10(path, "utf8");
  const content = removeBlock(existing);
  if (content === existing)
    return { path, changed: false };
  writeFileSync7(path, content);
  return { path, changed: true };
}
async function apiWrite(method, path, body) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), 1e4);
  try {
    const response = await fetch(`${serverBaseUrl()}${path}`, {
      method,
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
var apiPost = (path, body) => apiWrite("POST", path, body);
var apiPut = (path, body) => apiWrite("PUT", path, body);
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
    const response = await apiPost("/api/projects", { slug, name: slug, brief: "" });
    if (!gameDir(root, slug)) {
      throw new Error(`server created ${JSON.stringify(response.gameDir ?? slug)}, but it is not under ${root}/.forgeax/games; run the CLI against the same instance root as the server`);
    }
  } else {
    const local = initLocalGame(root, slug);
    process.stdout.write(`Created a local ForgeaX project and game ${slug} at ${local.gameRoot} (no matching server; online scaffold will be used for later games).
`);
  }
  const sdk = installEngineSdk2(root);
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
  await apiPut("/api/projects/active", { slug });
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
    process.stdout.write(`KEPT    your games and project metadata: ${join10(root, ".forgeax")}
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
  const runtime = resolveInstalledRuntime4();
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
    const sdk = installEngineSdk2(project.root);
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
  return { transport, host, port, root: resolve7(root), requireAuth, allowedOrigins };
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
