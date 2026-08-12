/**
 * The ForgeaX MCP server surface.
 *
 * Deliberately tiny. Everything one-time — creating a game, switching games,
 * installing config, upgrading — is a CLI subcommand, because a low-frequency
 * operation parked in the tool list is something the model has to consider and
 * possibly misfire on during every single turn. What stays here is the high-frequency
 * development loop and the state read that precedes it.
 */
import { readFileSync } from 'node:fs';
import { collectStatus } from '../status/collect';
import { renderStatus } from '../status/render';
import { ROUTING_TEXT } from '../routing';
import { runCurrentGame, RUN_TOOL_SCHEMA } from '../run/run-game';
import type { McpServerSpec } from './protocol';

/** Per-request environment. `cwd` is where project resolution starts by default. */
export interface ServerCtx {
  readonly cwd: string;
}

function packageVersion(): string {
  // Source execution lives at src/mcp/forgeax-server.ts; the bundle lives at
  // dist/main.js. Try the package-root-relative location for both layouts.
  for (const relative of ['../package.json', '../../package.json']) {
    try {
      const version = (JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as {
        version?: string;
      }).version;
      if (version) return version;
    } catch {
      /* try the other layout */
    }
  }
  return '0.0.0';
}

/** Shared by the status resource and its tool fallback. */
const TARGET_DIR_PROPERTY = {
  target_dir: {
    type: 'string',
    description:
      'Directory to resolve the ForgeaX project from. Defaults to the server working directory. Pass the user current working directory when it differs.',
  },
} as const;

export function createForgeaxMcpServer(): McpServerSpec<ServerCtx> {
  return {
    serverInfo: { name: 'forgeax', version: packageVersion() },
    instructions: ROUTING_TEXT,

    buildContext: () => ({ cwd: process.cwd() }),

    resources: [
      {
        uri: 'forgeax://status',
        name: 'ForgeaX status',
        description:
          'Preferred entry point. Project binding, capability tier, service health, game development kit and routing-rule freshness, and the single next action. Read-only.',
        mimeType: 'text/markdown',
        read: async (ctx) => renderStatus(await collectStatus(ctx.cwd)),
      },
    ],

    tools: [
      {
        name: 'forgeax_status_lite',
        description:
          'Compatibility fallback for clients that cannot read MCP resources; prefer the `forgeax://status` resource when available. Reports project binding, capability tier, service health, game development kit and routing-rule freshness, and the next action. Read-only — never writes to the workspace.',
        inputSchema: { type: 'object', properties: { ...TARGET_DIR_PROPERTY }, additionalProperties: false },
        run: async (args, ctx) => {
          const dir = typeof args.target_dir === 'string' ? args.target_dir : ctx.cwd;
          return renderStatus(await collectStatus(dir));
        },
      },
      {
        name: 'forgeax_run_current_game',
        description:
          'Run, preview, reload, or verify the active game. One call covers what the user means by "run it", "let me see it", "reload", or "does it work": it starts whatever services are down, returns a preview URL to open, and reports whether this plugin owns a runtime log file. Read an available `runtime_logs.local_file` with your own file tool — log tailing is intentionally not a tool. A stack that was already running cannot have its process output captured retroactively. Starting services from cold takes a few seconds, so do not call this for ordinary code edits the user has not asked to see.',
        inputSchema: RUN_TOOL_SCHEMA,
        run: async (args, ctx) => runCurrentGame(args, ctx.cwd),
      },
    ],
  };
}
