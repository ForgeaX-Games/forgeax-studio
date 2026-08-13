# Validation loop

Use the narrowest proof that exercises the user's real path, then run the repository
gate before shipping a product change.

1. Call `forgeax://status` or `forgeax_status_lite` and record the active game.
2. Run focused tests for the changed code.
3. Call `forgeax_run_current_game` and use the returned URLs.
4. For Studio or viewport behavior, open `http://localhost:18920` and exercise the
   embedded editor path. For standalone Play behavior, exercise the returned Play URL.
5. Inspect browser errors and the runtime log returned by the tool.
6. Run `bun fx check` for a normal repository change. Run the owning repository's
   `bun fx ci` before creating or updating a pull request.

## Evidence boundary

| Result | What it proves |
|:--|:--|
| MCP handshake and status | The host can load the plugin and bind the project |
| Focused tests | The changed code's asserted contract |
| Play URL responds | The standalone runtime is reachable |
| Real Studio interaction | The assembled product path works |
| Full repository gate | The broader source tree remains compatible |

Do not collapse these into one “green” claim. Mark any layer that was not exercised as
unverified.
