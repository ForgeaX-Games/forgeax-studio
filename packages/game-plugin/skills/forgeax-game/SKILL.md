---
name: forgeax-game
description: Build, preview, inspect, and repair a released ForgeaX Engine game through the @forgeax/game MCP connector.
---

# ForgeaX game development

Use this Skill for gameplay implementation and the edit-build-Preview-repair loop in
a standalone game created or bound by `forgeax-game init`. The host agent edits game code;
the connector owns Engine CLI execution and Preview lifecycle.

## Start with identity

1. Read the MCP resource `forgeax://status`. If the client cannot read resources,
   call `forgeax_status_lite` with the game's current directory as `target_dir`.
2. Confirm the status reports one consistent installed Engine version/commit and an
   exact matching DevKit/carrier. Never hardcode a historical release identity.
3. Read the game's `forge.json`, source, package declarations, and task-relevant
   Engine-owned `skills/` installed with that game. Engine declarations are in its installed
   `node_modules/@forgeax/engine*` packages; never substitute Studio or Editor source.

Status describes runtime readiness, not a requirement to launch the template first.
When gameplay depends on a library asset, follow the installed asset-library Skill
to establish availability and compatible candidates before game implementation or
a baseline Preview. Other tasks may still need a baseline to reproduce a bug.

> [!IMPORTANT]
> In an empty directory, `forgeax-game init` creates the Engine-owned standalone game
> through the exact installed carrier. In an existing exact game it refreshes the
> binding idempotently. Follow `forge.json` and the installed Engine's authoring
> layout: Engine 0.3.3 uses `assets/` Pack sources and `forge.json#roots`, not a
> `plugins[]` list. Preserve the Engine-owned project instead of moving files to a
> prescribed directory. Do not create Studio's
> hosted `.forgeax/games/<slug>` layout inside a standalone game.

## Edit and verify

1. Make the smallest coherent game-source change using normal file tools. Mount browser
   UI through the Engine Host `uiRoot` or `#game-ui`. The released standalone Host
   provides `#game-ui`; do not mutate `document.body` directly. Resolve Host access
   and lifecycle from the installed Engine declarations/examples, not a guessed
   injection name. Check that requested UI is actually mounted; optional chaining
   that silently skips required UI is not proof it works.
2. When turning the Empty template into a requested game, also replace the template
   identity in `forge.json`, `package.json`, and README; document controls and keep
   tests aligned. Export at least one named game-specific state transition or rule and
   exercise it in a behavior test. Renaming the Empty test suite is not completion.
   The run tool rejects changed gameplay with stale or superficial evidence.
3. Call `forgeax_run_current_game` with the canonical game `target_dir`.
4. Treat success only as the returned exact Engine/build/Preview identity. Open only
   its returned loopback `preview_url`.
5. When build or Preview fails, read `preview.stderr_log` and
   `preview.stdout_log`, repair the game, and call the tool again.
6. After a code change, do not reuse an old visual observation as evidence; the new
   build digest and Preview instance must be observed.

Preview `ready` proves startup and ownership, not gameplay or visible UI. For a
playable-game request, use an available browser tool to check the requested core
interaction and feedback. Choose checks to fit the game, not a fixed checklist or
browser brand. If browser access is unavailable, deliver the verified Preview URL
with gameplay explicitly unverified and short manual checks; do not block useful
implementation or claim interactions were tested. An Engine-upgrade-only request
does not require a new gameplay quality review.

## Reuse 3D assets

Read the installed `art-3d-asset-library` Skill and use its pinned CLI to search
candidates and import a selected asset. If not enabled, ask the user to enable it.
No separate Asset3D MCP tool is required. Do not substitute procedural geometry or
generation for a requested library asset without user approval.

> [!CAUTION]
> Any `forgeax_run_current_game` error means the current game is **not previewed**.
> Stop and report or repair that error. Never probe, reuse, open, or report an existing
> localhost port after a failed call; HTTP 200 is not Preview ownership evidence. Only
> a successful result containing `preview.status: ready`, `preview_url`, `preview.root`,
> `preview.build_digest`, and `preview.instance_id` authorizes a Preview claim.

The connector runs the exact installed Engine CLI with `project build --json`, then
starts or reuses `project preview --json`. It binds Preview to the canonical root,
exact release, build digest, and Preview instance ID; PID alone is not ownership.

## Stop

For explicit teardown use:

```bash
forgeax-game preview stop --target-dir <game-root>
```

The connector signals only a verified owned child. A live unverifiable PID is
left untouched and reported as `preview_ownership_unverified`.

## Scope

Image and 3D generation helpers may still be exposed, but this G0 Skill does not
claim Asset3D provider installation/import, Studio/Editor integration, visible Play,
or real EA/provider end-to-end acceptance.
