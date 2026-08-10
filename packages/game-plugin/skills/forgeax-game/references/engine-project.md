# Engine project map

Keep these boundaries in working memory while changing a ForgeaX game.

| Concern | Authoritative location |
|:--|:--|
| Game selected by the user | `.forgeax/active-game.json` |
| Game source and local assets | `.forgeax/games/<slug>/` |
| Engine SDK declarations and examples | `.forgeax/engine-sdk/` |
| SDK/runtime identity | `.forgeax/engine-sdk.json` and `forgeax_run_current_game` output |
| New-game scaffold | ForgeaX server `POST /api/workbench/games` |
| New-game example authority | `.forgeax/engine-sdk/examples/game-default/` |
| Runtime output owned by this plugin | `.forgeax/logs/runtime/runtime.log` |

`forgeax-game init` calls the server scaffold endpoint. Do not copy the template by
hand: that would bypass the server's active-game update and instance-root checks.

## Change a game

- Work only under the active game's directory unless the request explicitly changes
  shared engine behavior.
- Preserve the existing ECS and lifecycle style in that game; inspect neighboring
  systems before introducing a new abstraction.
- Keep asset paths relative to the game and use the existing asset-loading APIs.
- Do not make subagents independently edit `.forgeax/games/<slug>/src/`; the primary
  agent owns the source and the hot-reload feedback loop.
- Use a nearby game under `.forgeax/games/` or `packages/games/` as an example, not as
  a template to duplicate wholesale.

The plugin materializes the SDK from the same Engine pin used by its bundled Runtime.
Read the relevant `package.json`, declaration files, and example first. If the bundled
snapshot lacks an API, do not substitute a guessed import: report the missing context
or use the host's explicit source-inspection tools. A successful TypeScript transform
does not prove that the preview is running the intended Engine.
