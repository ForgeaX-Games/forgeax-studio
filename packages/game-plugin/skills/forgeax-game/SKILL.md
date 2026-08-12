---
name: forgeax-game
description: Build, run, and verify ForgeaX games through the bounded @forgeax/game MCP surface. Use when an agent must inspect a ForgeaX project, edit the active game, recover a broken local stack, launch the current game, or validate a game change in the real Studio and Play surfaces.
---

# ForgeaX Game

Treat the project files as the source of truth and `@forgeax/game` as the ForgeaX
control surface around them. The current host Agent (Codex, the reference agent CLI, Cursor, or
another supported client) writes the game code. Use MCP for project/runtime state and
launching; use normal file, shell, and browser tools for implementation and
verification. The plugin obtains the matching ForgeaX Runtime automatically; do not
ask the user to clone ForgeaX Studio or start `bun fx`.

## Enter the loop

1. If the current directory is not a ForgeaX project, run `forgeax-game init --game
   <slug>` once. This creates the minimal project and prepares the managed Runtime.
2. Read `forgeax://status`. If the host cannot read MCP resources, call
   `forgeax_status_lite`.
3. Confirm the returned project root, active game, Runtime version, and Engine SDK
   commit before editing anything. The SDK and Runtime identities must match.
4. Read [references/engine-project.md](references/engine-project.md) before changing
   game code or assets.
5. Climb the Engine knowledge ladder in order, stopping as soon as the question is
   answered. Never invent an Engine symbol from memory — every rung is already on disk.
   1. **`forgeax-engine-*` skills** — how this Engine is meant to be used: schedules,
      lifecycles, and the invariants a type signature cannot state. Start here for any
      "how do I ..." question; `forgeax-engine-ecs` governs components and systems.
      **Read [references/engine-skills.md](references/engine-skills.md) to pick the id.**
      Ids do not track package names — importing `@forgeax/engine-render` does not mean a
      `forgeax-engine-render` skill exists. A guessed id fails the lookup silently.
   2. **`.forgeax/engine-sdk/`** — the exact API surface: `packages/*/dist/*.d.ts` for
      signatures, `examples/game-default/` for a game that already works.
      Read [references/engine-authoring-traps.md](references/engine-authoring-traps.md)
      first: it lists the failures that render or run without error while still being
      wrong (fov units, dead keyboard, function-valued readpoints).
   3. **Engine source** — the implementation. Read it when a skill plus the
      declarations still leave a real choice open, or when observed behavior
      contradicts them and you must trace an Engine-side bug. `forgeax://status`
      reports its path, also recorded as `sourceRoot` in `.forgeax/engine-sdk.json`.
6. Make the smallest coherent change in the active game's directory.
7. Call `forgeax_run_current_game`. It starts the verified bundled Runtime when
   needed and reports the Runtime/Engine identity used by preview.
8. Open the returned Play URL and verify the requested behavior. Follow
   [references/validation.md](references/validation.md).

## Choose the right surface

| Need | Surface |
|:--|:--|
| Project, game, service, or next-action status | `forgeax://status` |
| Status when resources are unavailable | `forgeax_status_lite` |
| Install/start the bundled Runtime and obtain preview/log locations | `forgeax_run_current_game` |
| Learn how the Engine is meant to be used | `forgeax-engine-*` skills — ids in [references/engine-skills.md](references/engine-skills.md) |
| Inspect Engine declarations, metadata, and examples | `.forgeax/engine-sdk/` |
| Trace Engine behavior a skill and the declarations cannot settle | Engine source (`sourceRoot`) |
| Diagnose a game that runs but renders or steers wrong | [references/engine-authoring-traps.md](references/engine-authoring-traps.md) |
| Read or edit game source and assets | Host file tools |
| Run focused tests or inspect runtime logs | Host shell tools |
| Prove Studio, viewport, or Play behavior | Host browser tools |
| Create a game or change the active game | `forgeax-game init` / `forgeax-game use` |

Do not turn one-time setup or arbitrary shell execution into MCP calls. The bounded
surface exists so the model sees only high-frequency game-loop operations.

## Recover deliberately

- **No project:** run `forgeax-game init --game <slug>`; do not ask the user to prepare
  a ForgeaX checkout.
- **No active game:** list `.forgeax/games/`, then run `forgeax-game use <slug>`.
- **Runtime down:** call `forgeax_run_current_game`; it installs and starts the
  manifest-selected bundled Runtime. Do not silently fall back to a Studio checkout.
- **Engine SDK missing:** run `forgeax-game upgrade` (or re-run `init`) before writing
  imports. Do not guess an API that is absent from the bundled snapshot.
- **Engine authoring skills missing or incomplete:** `forgeax://status` reports how many
  of the bundled `forgeax-engine-*` skills are installed. If any are missing, run
  `forgeax-game devkit install` and start a new session; writing game code without them
  means guessing at Engine conventions the skills already state.
- **Wrong instance root:** stop and align the CLI working directory with the running
  ForgeaX server. Never write into a different checkout to make the check pass.
- **Launch failure:** read the runtime log path returned by the tool. Browser-only
  exceptions still require the browser console.
- **Viewport or Play defect:** reproduce through the real Studio UI. A direct curl to
  the Play server does not prove the embedded editor path.

## Finish with evidence

Report the changed game and files, the MCP status/launch result, the exact browser
surface exercised, and any remaining unverified boundary. A passing unit test is not
evidence that the game rendered or behaved correctly.
