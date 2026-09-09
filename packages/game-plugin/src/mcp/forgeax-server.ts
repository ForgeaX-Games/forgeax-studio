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
import { resolve } from 'node:path';
import { collectStatus } from '../status/collect';
import { renderStatus } from '../status/render';
import { ROUTING_TEXT } from '../routing';
import { runCurrentGame, RUN_TOOL_SCHEMA } from '../run/run-game';
import {
  generate3dTool,
  generateImageTool,
  GENERATE_3D_SCHEMA,
  GENERATE_IMAGE_SCHEMA,
} from '../gen/generate';
import { gameFileTools } from './game-files';
import type { McpServerSpec } from './protocol';

/** Per-request environment. `cwd` is where project resolution starts by default. */
export interface ServerCtx {
  readonly cwd: string;
}

export interface ForgeaxMcpServerOptions {
  /** Fixed root for long-lived HTTP servers. Stdio intentionally resolves cwd per request. */
  readonly root?: string;
  /** Remote HTTP clients need bounded file tools because they cannot see the server filesystem. */
  readonly authoringTools?: boolean;
  /** Only local stdio clients may redirect a request to their current working directory. */
  readonly allowTargetDir?: boolean;
  /** A parent supervisor owns Server/Engine; this MCP process must not start a second Runtime. */
  readonly existingServicesOnly?: boolean;
  /** Public origin used to turn loopback preview URLs into browser-reachable URLs. */
  readonly publicOrigin?: string;
}

export function publicPreviewResult(result: string, publicOrigin: string | undefined): string {
  if (!publicOrigin) return result;
  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    return result;
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return result;
  return result.replace(/^preview_url:\s+(\S+)$/m, (line, rawUrl: string) => {
    try {
      const local = new URL(rawUrl);
      return `preview_url: ${new URL(`${local.pathname}${local.search}${local.hash}`, origin).toString()}`;
    } catch {
      return line;
    }
  });
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

export function createForgeaxMcpServer(
  options: ForgeaxMcpServerOptions = {},
): McpServerSpec<ServerCtx> {
  const allowTargetDir = options.allowTargetDir ?? options.root === undefined;
  const cwd = options.root ? resolve(options.root) : undefined;
  const { target_dir: _targetDir, ...fixedRunProperties } = RUN_TOOL_SCHEMA.properties;
  const runInputSchema = allowTargetDir
    ? RUN_TOOL_SCHEMA
    : { ...RUN_TOOL_SCHEMA, properties: fixedRunProperties };
  return {
    serverInfo: { name: 'forgeax', version: packageVersion() },
    instructions: ROUTING_TEXT,

    buildContext: () => ({ cwd: cwd ?? process.cwd() }),

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
        inputSchema: {
          type: 'object',
          properties: allowTargetDir ? { ...TARGET_DIR_PROPERTY } : {},
          additionalProperties: false,
        },
        run: async (args, ctx) => {
          const dir = allowTargetDir && typeof args.target_dir === 'string' ? args.target_dir : ctx.cwd;
          return renderStatus(await collectStatus(dir));
        },
      },
      {
        name: 'forgeax_run_current_game',
        description:
          'Build, preview, reload, or verify the active game. One call covers what the user means by "run it", "let me see it", "reload", or "does it work": it installs the selected Runtime when needed, builds or reuses a static preview, returns a preview URL to open, and reports the Runtime log file. Read an available `runtime_logs.local_file` with your own file tool — log tailing is intentionally not a tool. Call this after a requested game change, not for ordinary edits the user has not asked to see.',
        inputSchema: runInputSchema,
        run: async (args, ctx) => publicPreviewResult(
          await runCurrentGame(
            allowTargetDir ? args : { ...args, target_dir: ctx.cwd },
            ctx.cwd,
            { existingServicesOnly: options.existingServicesOnly },
          ),
          options.publicOrigin,
        ),
      },
      {
        name: 'forgeax_generate_image',
        description:
          'Generate a game image asset from a text prompt (text-to-image), or edit a local image when `image` is set (image-to-image). Saves the PNG/JPG into the active game\'s `assets/` directory and returns its project-relative path to reference from game code. Backed by the ForgeaX LiteLLM gateway; requires FORGEAX_LITELLM_API_KEY. Use when the user asks for a sprite, texture, icon, background, or concept art.',
        inputSchema: GENERATE_IMAGE_SCHEMA,
        run: async (args, ctx) => generateImageTool(args, ctx.cwd),
      },
      {
        name: 'forgeax_generate_3d',
        description:
          'Generate a 3D model (.glb) for the game. Provide `prompt` for text-to-3D, or `image` for image-to-3D — a public https URL, or a local file path when COS is configured (the file is uploaded and passed as a short-lived presigned URL). Runs the async generation to completion (~1–2 min) and saves the mesh into the active game\'s `assets/` directory, returning its project-relative path. Backed by the ForgeaX LiteLLM gateway; requires FORGEAX_LITELLM_API_KEY (and FORGEAX_COS_* for local-file image-to-3D).',
        inputSchema: GENERATE_3D_SCHEMA,
        run: async (args, ctx) => generate3dTool(args, ctx.cwd),
      },
      ...(options.authoringTools ? gameFileTools<ServerCtx>() : []),
    ],
  };
}
