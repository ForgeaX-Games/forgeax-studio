/**
 * `forgeax_run_current_game` — the one high-frequency tool.
 *
 * It is deliberately one call rather than the four it decomposes into (validate,
 * start, preview, observe). Every seam between tools is a place the model can stall,
 * pick the wrong next step, or stop early and report success before anything ran; and
 * "run it" is a single intention in the user's head, so it should be a single call.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeGame, gameDir, listGames, resolveProject, SLUG_RE } from '../project/locate';
import {
  assertEngineProjectRoot,
  assertServerProjectRoot,
  fetchEngineRuntimeIdentity,
  previewUrl,
  probeServices,
  tierAtLeast,
  waitForTier,
} from '../services/probe';
import { ensureRuntimeLauncher, launchGuidance, startStack } from '../services/launch';
import { allocateRuntimePorts } from '../runtime/ports';
import { resolveInstalledRuntime } from '../runtime/manager';
import {
  acquireStartLock,
  runtimeLogIsLive,
  runtimeLogPaths,
  updateWatcherState,
} from './log-paths';

export const RUN_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    game: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9-]{0,40}$',
      description: 'Game slug to run. Defaults to the project active game.',
    },
    target_dir: {
      type: 'string',
      description: 'Directory to resolve the ForgeaX project from. Defaults to the server working directory.',
    },
    start_services: {
      type: 'boolean',
      description:
        'Start the stack if it is not already up. Default true. Set false to check runnability without launching anything.',
    },
  },
  additionalProperties: false,
} as const;

function engineIdentity(root: string): { sdkCommit?: string; runtimeVersion?: string } {
  let sdkCommit: string | undefined;
  try {
    sdkCommit = (JSON.parse(readFileSync(join(root, '.forgeax', 'engine-sdk.json'), 'utf8')) as {
      engineCommit?: unknown;
    }).engineCommit as string | undefined;
  } catch {
    /* The SDK is optional for legacy projects. */
  }
  return { sdkCommit, runtimeVersion: resolveInstalledRuntime()?.version };
}

/** How long a cold stack gets to come up before we report what we can see. */
const START_TIMEOUT_MS = 90_000;

interface RunArgs {
  game?: unknown;
  target_dir?: unknown;
  start_services?: unknown;
}

export async function runCurrentGame(rawArgs: Record<string, unknown>, cwd: string): Promise<string> {
  const args = rawArgs as RunArgs;
  const dir = typeof args.target_dir === 'string' ? args.target_dir : cwd;
  const startServices = args.start_services !== false;

  const project = resolveProject(dir);
  if (!project.root) {
    return [
      `error: no ForgeaX project found searching upward from ${project.searchedFrom}.`,
      'Run `forgeax-game init --game <slug>` in this directory first, or pass a directory that already contains `.forgeax/` as `target_dir`.',
    ].join('\n');
  }
  const root = project.root;

  const slug = resolveSlug(root, typeof args.game === 'string' ? args.game : undefined);
  if ('error' in slug) return slug.error;

  const lines: string[] = [];
  let caps = await probeServices();
  if (tierAtLeast(caps.tier, 'backend')) {
    try {
      await assertServerProjectRoot(root);
      if (tierAtLeast(caps.tier, 'runtime')) await assertEngineProjectRoot(root);
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (!tierAtLeast(caps.tier, 'runtime')) {
    if (!startServices) {
      return [
        `not running: stack is at tier "${caps.tier}" and start_services was false.`,
        ...caps.services.filter((s) => !s.reachable).map((s) => `- ${s.name} ${s.url}: down`),
      ].join('\n');
    }

    const paths = runtimeLogPaths(root);
    const lock = acquireStartLock(root);
    try {
      if (lock.acquired) {
        // Allocate only after claiming the project lock. A concurrent MCP request
        // must wait for this instance instead of probing a port set that another
        // request did not actually launch.
        const ports = await allocateRuntimePorts();
        const portEnv = {
          FORGEAX_PROJECT_ROOT: root,
          FORGEAX_SERVER_PORT: String(ports.server),
          FORGEAX_ENGINE_PORT: String(ports.engine),
          FORGEAX_INTERFACE_PORT: String(ports.interface),
        } as const;
        Object.assign(process.env, portEnv);
        const launcher = await ensureRuntimeLauncher(root, portEnv);
        if (!launcher) return launchGuidance();
        mkdirSync(paths.dir, { recursive: true });
        const logFd = openSync(paths.logFile, 'a');
        try {
          const { pid } = startStack(launcher, logFd);
          updateWatcherState(root, {
            game: slug.slug,
            pid,
            startedAt: new Date().toISOString(),
            stoppedAt: undefined,
            stopReason: undefined,
          });
          lines.push(`started stack via ${launcher.description} (pid ${pid ?? 'unknown'})`);
        } finally {
          // The child holds its own duplicate of the descriptor.
          closeSync(logFd);
        }
      } else {
        lines.push('another plugin request is already starting this project stack; waiting for it');
      }

      caps = await waitForTier('runtime', START_TIMEOUT_MS);
      updateWatcherState(root, { lastPollAt: new Date().toISOString() });
    } finally {
      lock.release();
    }
    if (tierAtLeast(caps.tier, 'backend')) {
      try {
        await assertServerProjectRoot(root);
        if (tierAtLeast(caps.tier, 'runtime')) await assertEngineProjectRoot(root);
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  const paths = runtimeLogPaths(root);
  const reachedRuntime = tierAtLeast(caps.tier, 'runtime');

  lines.push(`game: ${slug.slug}`);
  lines.push(`source: ${slug.dir}`);
  lines.push(`tier: ${caps.tier}`);
  for (const s of caps.services) {
    lines.push(`- ${s.name} ${s.url}: ${s.reachable ? 'up' : `down (${s.reason ?? 'unreachable'})`}`);
  }

  if (reachedRuntime) {
    lines.push('');
    lines.push(`preview_url: ${previewUrl(slug.slug)}`);
    const identity = engineIdentity(root);
    lines.push(`runtime.version: ${identity.runtimeVersion ?? 'unknown'}`);
    lines.push(`engine_sdk.commit: ${identity.sdkCommit ?? 'unknown'}`);
    let previewIdentity;
    try {
      previewIdentity = await fetchEngineRuntimeIdentity();
    } catch {
      previewIdentity = undefined;
    }
    lines.push(`preview.instance_root: ${previewIdentity?.instanceRootAbs ?? 'unknown'}`);
    lines.push(`preview.runtime_version: ${previewIdentity?.runtimeVersion ?? 'unknown'}`);
    lines.push(`preview.engine_version: ${previewIdentity?.engineVersion ?? 'unknown'}`);
    lines.push(
      `engine.identity: runtime=${identity.runtimeVersion ?? 'unknown'} sdk=${identity.sdkCommit ?? 'unknown'} project=${root}`,
    );
    lines.push('Open that URL to see the game. Edits to the game source hot-reload.');
  } else {
    lines.push('');
    lines.push(
      `stack did not reach runtime tier within ${Math.round(START_TIMEOUT_MS / 1000)}s. Check the log below for the reason.`,
    );
  }

  lines.push('');
  if (runtimeLogIsLive(root) && existsSync(paths.logFile)) {
    lines.push(`runtime_logs.local_file: ${paths.logFile}`);
    lines.push(
      'Read that file with your own file tool to see vite transform errors, build failures and server logs.',
    );
  } else if (existsSync(paths.logFile)) {
    lines.push(`runtime_logs.local_file: ${paths.logFile} (existing startup log; it may be stale)`);
    lines.push('The currently running stack was not launched by this live plugin process, so new output is not guaranteed.');
  } else {
    lines.push('runtime_logs.local_file: unavailable');
    lines.push('The stack was already running, so this plugin cannot capture its existing process output retroactively.');
  }
  lines.push(
    'It captures stack process output only. Errors thrown inside the running game reach the browser console, not this file.',
  );

  return lines.join('\n');
}

type SlugResolution = { slug: string; dir: string } | { error: string };

/**
 * Pick the game to run.
 *
 * A single-game project needs no ceremony, so an unset active game resolves to the
 * only game rather than an error the user has to clear before doing anything.
 */
export function resolveSlug(root: string, requested?: string): SlugResolution {
  if (requested !== undefined && !SLUG_RE.test(requested)) {
    return { error: `error: invalid game slug: ${JSON.stringify(requested)}.` };
  }
  const games = listGames(root);
  if (games.length === 0) {
    return { error: 'error: this project has no games. Run `forgeax-game init --game <slug>` to scaffold one.' };
  }

  const slug = requested ?? activeGame(root) ?? (games.length === 1 ? games[0] : undefined);
  if (!slug) {
    return {
      error: `error: no active game selected and this project has ${games.length} games (${games.join(', ')}). Pass \`game\`, or run \`forgeax-game use <slug>\`.`,
    };
  }

  const dir = gameDir(root, slug);
  if (!dir) {
    return { error: `error: game ${JSON.stringify(slug)} not found. Available: ${games.join(', ')}.` };
  }
  return { slug, dir };
}
