# `@forgeax/game`

[![npm](https://img.shields.io/npm/v/@forgeax/game?label=npm)](https://www.npmjs.com/package/@forgeax/game)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](./package.json)
[![MCP](https://img.shields.io/badge/MCP-stdio-6f42c1)](https://modelcontextprotocol.io/)

ForgeaX game development as a self-contained plugin for MCP-capable agent clients.
One executable provides both surfaces:

- `forgeax-game` with no arguments runs the stdio MCP server.
- `forgeax-game <command>` performs one-time setup and project operations.

The package has no runtime dependencies and uses only Node built-ins.

> [!IMPORTANT]
> The normal user path does **not** require a ForgeaX source checkout, Bun workspace,
> or a manually started Studio. The plugin installs the matching Skill and obtains a
> versioned ForgeaX Runtime artifact on first use, then starts the server and preview
> runtime itself. `FORGEAX_START_COMMAND` is an advanced override for private or
> development deployments only.

## Install

Configure one client (this can run from any empty directory):

```bash
npx -y -p @forgeax/game forgeax-game install --ide codex
npx -y -p @forgeax/game forgeax-game init --game snake
```

Configure several clients:

```bash
npx -y -p @forgeax/game forgeax-game install --ide codex,claude,cursor
```

Omitting `--ide` configures every supported client. User-scoped clients can be
installed before a project exists; Trae and VS Code use project scope and are written
when `install` runs inside the project. The original WorkBuddy name remains accepted
as an alias of the current a peer agent CLI client:

```bash
npx -y -p @forgeax/game forgeax-game install --ide trae,workbuddy
```

Before writing any config, the installer launches the exact command it intends to
store and completes a real `initialize` → `tools/list` → `resources/list` handshake.
Existing config files are merged, and a changed file is backed up beside the original
with the `.bak.latest` suffix.

For local package development or offline use, pin the currently running executable:

```bash
bun src/main.ts install --ide codex --local
```

## Commands

| Command | Purpose |
|:--|:--|
| `install [--ide a,b] [--local]` | Verify the MCP launch command, then merge client configuration |
| `init [--game <slug>]` | Create a project/game, install routing rules, and materialize the bundled Engine SDK |
| `use <slug>` | Activate an existing game through the server |
| `doctor` | Check Node, project binding, service tiers, and client configuration |
| `devkit install` | Install the game-development Skill and host rules; use `forgeax-install` only when available |
| `agents update` | Insert or refresh only the managed ForgeaX block in `AGENTS.md` |
| `upgrade` | Verify the published launch command, refresh installed client entries, and update project routing rules |

`init` can create the minimal `.forgeax/` instance and game in an ordinary empty
directory. It also installs `.forgeax/engine-sdk/`, containing declarations, API
metadata, and the canonical example generated from the same Engine pin as the
bundled Runtime. `use`, `devkit install`, and `agents update` operate on the nearest
project root. Runtime extraction and startup are automatic; a running server is not
an `init` prerequisite.

## MCP surface

The server intentionally exposes only high-frequency development-loop operations.
Installation and project mutation stay in the CLI so models do not reconsider
one-time actions on every turn.

| Entry | Kind | Use |
|:--|:-:|:--|
| `forgeax://status` | Resource | Preferred read-only project, service, and next-action status |
| `forgeax_status_lite` | Tool | Status fallback for clients without MCP resource support |
| `forgeax_run_current_game` | Tool | Install/start missing Runtime services, return a preview URL, and identify the runtime log file |

When this plugin cold-starts the managed Runtime, runtime output is written to:

```text
<project>/.forgeax/logs/runtime/runtime.log
```

Read that file with the host client's normal file tools. Runtime process output is
captured there; exceptions thrown inside the browser remain in the browser console.
The run result reports the Runtime version, instance identity, selected ports, and
whether the log belongs to the current plugin-owned process; status reports the
cached Runtime installation state.

Runtime artifacts are cached per platform and version under `~/.forgeax/runtimes/`.
The macOS arm64 package carries the archive locally, so first run verifies and
extracts it without a network request. The cache uses a checksum-verified ready
marker and keeps the previous version until a new version has started successfully.
`forgeax_run_current_game` reports `runtime.version`, `engine_sdk.commit`, and a
combined `engine.identity`; those must match before preview acceptance.

The game SDK is available at `.forgeax/engine-sdk/`. Use its declaration files and
examples before writing imports. If an API is absent, stop and inspect the actual
Engine source instead of guessing.

## Supported clients

| Client ID | Config path | Scope |
|:--|:--|:-:|
| `codex` | `~/.codex/config.toml` | User |
| `claude` | `~/.claude.json` | User |
| `cursor` | `~/.cursor/mcp.json` | User |
| `trae` | `<project>/.trae/mcp.json` | Project |
| `codebuddy` / `workbuddy` | `~/.codebuddy/.mcp.json` | User |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | User |
| `vscode` | `<project>/.vscode/mcp.json` | Project |
| `opencode` | `~/.config/opencode/opencode.json` | User |

> [!NOTE]
> `workbuddy` is an accepted installer alias. Both names target a peer agent CLI's current
> MCP file, so selecting both does not create duplicate entries.
>
> The OpenCode entry follows its stable configuration schema (`mcp.<name>`,
> `type: "local"`, and an argv-style `command`). It is process-verified with
> OpenCode 1.17.9: `opencode mcp list` starts this package and reports
> `forgeax connected`. If a future client release changes the schema, `doctor`
> will still report whether the configured entry matches what this package writes.

## Game development Skill

The canonical Skill lives at the repository root in `skills/forgeax-game/`. Package
builds derive the copy shipped under `assets/`; there is no second handwritten source.
The Skill contains the MCP/file/browser decision loop, failure recovery, current
engine-project map, example-selection rules, scaffold/template authority, and the
real Studio-versus-Play validation boundary.

The published package also carries the host-install metadata needed to expose that
Skill directly to Codex, the reference agent CLI, Cursor and other configured clients. A harness
checkout is optional compatibility support, not a user prerequisite. Inside a ForgeaX
project, `install`, `init`, and `upgrade` refresh it automatically. It can also be
installed explicitly:

```bash
npx -y -p @forgeax/game forgeax-game devkit install
```

When the project already has a `.forgeax-harness/install-manifest.json`, the command
may replay that project's recorded `forgeax-install` specification. Otherwise the
published package uses its bundled host-install metadata and writes only its managed
Skill/rule blocks. It never reports a successful user install while silently requiring
a missing harness checkout.

## Develop

```bash
bun run typecheck
bun test
bun run build
node dist/main.js help
```

The handshake end-to-end test builds `dist/main.js`, executes that file through its
Node shebang, and verifies the real MCP surface.
