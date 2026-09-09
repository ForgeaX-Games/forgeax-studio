# `@forgeax/game`

[![npm](https://img.shields.io/npm/v/@forgeax/game?label=npm)](https://www.npmjs.com/package/@forgeax/game)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](./package.json)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%7C%20streamable--http-6f42c1)](https://modelcontextprotocol.io/)

ForgeaX game development as a self-contained plugin for MCP-capable agent clients.
One executable provides both surfaces:

- `forgeax-game` with no arguments runs the local stdio MCP server.
- `forgeax-game mcp --transport http ...` runs the same surface as a loopback or authenticated remote HTTP server.
- `forgeax-game <command>` performs one-time setup and project operations.

The package has one exact runtime dependency, `@forgeax/game-runtime@0.3.33`, and
externalizes it from the Game bundle.

> [!IMPORTANT]
> The normal user path does **not** require a ForgeaX source checkout, Bun workspace,
> or a manually started Studio. The plugin installs the matching Skill and obtains a
> versioned ForgeaX Runtime artifact on first use, then builds and serves a static game
> preview itself. `FORGEAX_START_COMMAND` is an advanced override for private or
> development deployments only.

## Install

### New client setup

Run this once per machine to add the ForgeaX MCP server to the selected agent client.

```bash
npx -y @forgeax/game install --ide codex,cursor,claude
```

For ZCode, use `--ide zcode`; this writes its native user configuration to
`~/.zcode/cli/config.json` and can run from any directory:

```bash
npx -y @forgeax/game install --ide zcode
```

Configure several clients in one pass:

```bash
npx -y @forgeax/game install --ide codex,claude,cursor,zcode
```

Omitting `--ide` configures every supported client. User-scoped clients can be
installed before a project exists; Trae and VS Code use project scope and are written
when `install` runs inside the project. The original WorkBuddy name remains accepted
as an alias of the current a peer agent CLI client:

```bash
npx -y @forgeax/game install --ide trae,workbuddy
```

Before writing any config, the installer launches the exact command it intends to
store and completes a real `initialize` → `tools/list` → `resources/list` handshake.
Existing config files are merged, and a changed file is backed up beside the original
with the `.bak.latest` suffix.

### Create a project

Choose an empty directory and initialize a game there:

```bash
cd /path/to/empty-directory
npx -y @forgeax/game init
```

`init` creates the ForgeaX project, installs the matching Engine SDK, and mounts the
bundled Skills for every client that already has a ForgeaX MCP entry. Use
`--game <slug>` to choose a game name or `--ide zcode` when initializing a project
for ZCode specifically.

> [!IMPORTANT]
> `init` does not install the user-level MCP entry. A new machine must run
> `install --ide zcode` once before `init`. A user who already has the `forgeax`
> entry configured in ZCode can run `init` directly for each new project.

### Refresh an existing project

For a project that was initialized previously, use `update` instead of running the
same `init` again:

```bash
cd /path/to/existing-forgeax-project
npx -y @forgeax/game update
```

If the project has no game-development Skills yet, use:

```bash
npx -y @forgeax/game devkit install
```

After installing or refreshing ZCode Skills, open the project as a ZCode workspace,
refresh Settings → Skills, and start a new session. Check Settings → MCP Servers or
run `/mcp status` to confirm `forgeax` is connected.

For local package development or offline use, pin the currently running executable:

```bash
bun src/main.ts install --ide codex --local
```

## Commands

| Command | Purpose |
|:--|:--|
| `install [--ide a,b] [--local]` | Verify the MCP launch command, then merge client configuration |
| `init [--game <slug>] [--ide ...]` | Create a project/game, install routing rules, and materialize the bundled Engine SDK |
| `use <slug>` | Activate an existing game through the server |
| `doctor` | Check Node, project binding, service tiers, and client configuration |
| `devkit install` | Install the game-development Skill and host rules; use `forgeax-install` only when available |
| `agents update` | Insert or refresh only the managed ForgeaX block in `AGENTS.md` |
| `update [--ide ...]` | Verify the published launch command, refresh installed client entries, and update project routing rules |

`init` can create the minimal `.forgeax/` instance and game in an ordinary empty
directory. It also installs `.forgeax/engine-sdk/`, containing declarations, API
metadata, both canonical templates (`game-default` and `game-empty`), authoring
skills, and the Engine implementation source generated from the same Engine pin as the
selected Runtime package. `use`, `devkit install`, and `agents update` operate on the nearest
project root. Runtime extraction and startup are automatic; a running server is not
an `init` prerequisite.

## MCP transports

Local Codex/Claude usage should keep the default stdio transport installed by
`forgeax-game install`. It inherits the client working directory and lets the host use
its native file tools.

For a shared local daemon, bind only to loopback:

```bash
forgeax-game mcp --transport http --host 127.0.0.1 --port 18940 --root "$PWD"
```

The Streamable HTTP endpoint is `http://127.0.0.1:18940/mcp`. A non-loopback listener
is rejected unless `FORGEAX_REMOTE_MCP_TOKEN` is set. Pass `--require-auth` behind a
reverse proxy even when the process itself binds to loopback. HTTP mode adds bounded
text authoring tools under the selected game's directory; existing files require the
SHA-256 returned by the read tool before replacement.

## MCP surface

The server intentionally exposes only high-frequency development-loop operations.
Installation and project mutation stay in the CLI so models do not reconsider
one-time actions on every turn.

| Entry | Kind | Use |
|:--|:-:|:--|
| `forgeax://status` | Resource | Preferred read-only project, service, and next-action status |
| `forgeax_status_lite` | Tool | Status fallback for clients without MCP resource support |
| `forgeax_run_current_game` | Tool | Build or reuse the active game's static preview, return its URL and health identity, and identify the runtime log file |
| `forgeax_generate_image` | Tool | Text-to-image, or image-to-image with a local `image`; saves a PNG/JPG into the active game's `assets/` and returns its path |
| `forgeax_generate_3d` | Tool | Text-to-3D (`prompt`) or image-to-3D (public https `image` URL); runs the async job to completion and saves a `.glb` into `assets/` |
| `forgeax_game_list_files` | HTTP tool | List non-hidden files below the active or named game |
| `forgeax_game_read_file` | HTTP tool | Read one UTF-8 game file and return its SHA-256 |
| `forgeax_game_read_logs` | HTTP tool | Read a bounded Runtime/supervisor log tail for remote diagnosis |
| `forgeax_game_write_file` | HTTP tool | Atomically create a text file or replace one with optimistic concurrency |

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
The selected `@forgeax/game-runtime-<platform>-<arch>` package carries the archive,
so first run verifies and extracts npm-installed bytes without another download.
The cache uses a checksum-verified ready
marker and keeps the previous version until a new version has started successfully.
`forgeax_run_current_game` reports `runtime.version`, `engine_sdk.commit`, and a
combined `engine.identity`; those must match before preview acceptance.

The game SDK is available at `.forgeax/engine-sdk/`. Use its declaration files and
`templates/game-default` or `templates/game-empty` before writing imports. If an API
is absent, inspect `source/<package>/src/` instead of guessing.

### Asset generation (LiteLLM)

`forgeax_generate_image` and `forgeax_generate_3d` produce art and 3D assets through a
LiteLLM gateway and save them into the active game's `assets/` directory, returning the
project-relative path to reference from game code. Configure via environment:

| Variable | Required | Default |
|:--|:-:|:--|
| `FORGEAX_LITELLM_API_KEY` | yes | — (secret; never commit it) |
| `FORGEAX_LITELLM_BASE_URL` | no | the shared ForgeaX gateway |
| `FORGEAX_GEN_IMAGE_MODEL` | no | `gemini-3-pro-image` |
| `FORGEAX_GEN_3D_TEXT_MODEL` | no | `tripo-3d-text` |
| `FORGEAX_GEN_3D_IMAGE_MODEL` | no | `tripo-3d-image` |
| `FORGEAX_COS_BUCKET` / `FORGEAX_COS_REGION` | for local image-to-3D | — |
| `FORGEAX_COS_SECRET_ID` / `FORGEAX_COS_SECRET_KEY` | for local image-to-3D | — (secret; never commit) |

- **Text-to-image / image-to-image**: `forgeax_generate_image({ prompt, image? })`. A
  local `image` path switches to editing that image with the prompt.
- **Text-to-3D**: `forgeax_generate_3d({ prompt })` — submits, polls to completion
  (~1–2 min), and downloads the `.glb`.
- **Image-to-3D**: `forgeax_generate_3d({ image })`. `image` is a **public https URL**,
  or a **local file path** when COS is configured — the file is uploaded to the COS
  bucket and passed to the backend as a short-lived presigned URL (the private bucket
  stays private; the URL expires within the hour). This makes the "generate a concept
  image, then turn it into a mesh" flow work end to end. Without COS, only a public URL
  is accepted, because the 3D endpoint rejects local paths and inline base64.

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
| `zcode` | `~/.zcode/cli/config.json` | User |
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
>
> ZCode uses its native `mcp.servers.<name>` user configuration rather than the
> `.agents/mcp.json` fallback. Project Skills are installed under `.zcode/skills`;
> start a new ZCode session and run `/mcp status` after installation.

## Game development Skill

The canonical Skill lives at the repository root in `skills/forgeax-game/`. Package
builds derive the copy shipped under `assets/`; there is no second handwritten source.
The Skill contains the MCP/file/browser decision loop, failure recovery, current
engine-project map, example-selection rules, scaffold/template authority, and the
real Studio-versus-Play validation boundary.

The published package also carries the host-install metadata needed to expose that
Skill directly to Codex, the reference agent CLI, Cursor and other configured clients. A harness
checkout is optional compatibility support, not a user prerequisite. Inside a ForgeaX
project, `install`, `init`, and `update` refresh it automatically. It can also be
installed explicitly:

```bash
npx -y @forgeax/game devkit install
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
