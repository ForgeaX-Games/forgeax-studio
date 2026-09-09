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
