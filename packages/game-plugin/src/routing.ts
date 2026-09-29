/**
 * The capability routing text — single source for two delivery channels.
 *
 * The same words are returned from MCP `initialize.instructions` (read by clients that
 * support it, at zero token cost until the model needs them) and written into the
 * project's `AGENTS.md` managed block (read by every client, including those that
 * ignore `instructions`). Writing it twice guarantees the two drift apart.
 */

export const ROUTING_TEXT = `## ForgeaX game development

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
