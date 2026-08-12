/**
 * Bringing the ForgeaX stack up.
 *
 * The npm package ships the plugin plus a verified Runtime distribution manifest.
 * Normal consumers never need a Studio checkout: the first run installs the selected
 * Runtime into the user cache and starts it. The explicit command and contributor
 * fallback remain useful for development and migration, but are never inferred.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ensureRuntime, launcherForRuntime, resolveInstalledRuntime } from '../runtime/manager';
import { runtimeEnvironment, type RuntimeEnvOverrides } from '../runtime/env';

/** Marker package name identifying a Studio checkout that can run `bun fx start`. */
const STUDIO_PACKAGE_NAME = 'forgeax-studio';

export interface StackLauncher {
  readonly kind: 'explicit' | 'installed-runtime' | 'development-fallback';
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string>;
  /** Human-readable account of why this launcher was chosen. */
  readonly description: string;
}

/** Walk up looking for a Studio checkout, identified by its root package.json name. */
function findStudioCheckout(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name;
        if (name === STUDIO_PACKAGE_NAME) return dir;
      } catch {
        /* unreadable package.json — keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Work out how (or whether) the stack can be started from here.
 *
 * `FORGEAX_START_COMMAND` is the escape hatch for anyone running a non-standard
 * layout; it is split on whitespace, which is enough for the shapes this needs.
 */
export function resolveLauncher(
  projectRoot: string,
  overrides: RuntimeEnvOverrides = {},
): StackLauncher | undefined {
  const explicit = process.env.FORGEAX_START_COMMAND?.trim();
  if (explicit) {
    const [command, ...args] = explicit.split(/\s+/);
    if (command) {
      return {
        kind: 'explicit',
        command,
        args,
        cwd: projectRoot,
        env: runtimeEnvironment(overrides),
        description: `FORGEAX_START_COMMAND=${explicit}`,
      };
    }
  }

  const installed = resolveInstalledRuntime();
  if (installed) {
    const launcher = launcherForRuntime(installed, overrides);
    return {
      kind: 'installed-runtime',
      command: launcher.command,
      args: launcher.args,
      cwd: launcher.cwd,
      env: launcher.env,
      description: `installed ForgeaX runtime ${installed.version} (${installed.root})`,
    };
  }

  // Studio discovery is deliberately opt-in. It is a useful contributor fallback,
  // but a published plugin must not silently depend on a sibling checkout.
  const checkout = process.env.FORGEAX_RUNTIME_DEV_FALLBACK === '1' ? findStudioCheckout(projectRoot) : undefined;
  if (checkout) {
    return {
      kind: 'development-fallback',
      command: 'bun',
      args: ['scripts/fx.ts', 'start'],
      cwd: checkout,
      env: runtimeEnvironment(overrides),
      description: `development fallback: Studio checkout at ${checkout}`,
    };
  }

  return undefined;
}

/**
 * Ensure the normal user path has a verified Runtime before resolving a launcher.
 * The manifest/artifact is intentionally resolved here rather than in the MCP
 * protocol layer so CLI and MCP startup share exactly the same cache and integrity
 * rules. An absent manifest remains an explicit, actionable error.
 */
export async function ensureRuntimeLauncher(
  projectRoot: string,
  overrides: RuntimeEnvOverrides = {},
): Promise<StackLauncher | undefined> {
  if (process.env.FORGEAX_START_COMMAND?.trim()) return resolveLauncher(projectRoot, overrides);
  try {
    await ensureRuntime();
  } catch {
    // Keep the caller's single next-action guidance. The detailed manifest error is
    // surfaced by the CLI/doctor path, while run_current_game remains concise.
    return resolveLauncher(projectRoot, overrides);
  }
  return resolveLauncher(projectRoot, overrides);
}

/** Guidance returned when nothing can be launched, phrased for the model to relay. */
export function launchGuidance(): string {
  return [
    'Cannot start the ForgeaX stack: no verified ForgeaX runtime is installed,',
    'and FORGEAX_START_COMMAND is not set.',
    '',
    'The published plugin must include assets/runtime-manifest.json and the bundled',
    'Runtime archive (or set FORGEAX_RUNTIME_MANIFEST for a private deployment).',
    'Install a release that includes those assets, then call this tool again.',
    '',
    'Advanced override (not recommended for normal installs):',
    '  export FORGEAX_START_COMMAND="<command that brings up server :18900 and engine :15173>"',
    '',
    'Contributor-only fallback:',
    '  export FORGEAX_RUNTIME_DEV_FALLBACK=1',
  ].join('\n');
}

/**
 * Start the stack in the background, teeing its output to a log file.
 *
 * Detached, because the stack outlives this MCP request by design. Output goes to a
 * file descriptor rather than a pipe: an inherited pipe that nobody drains will
 * eventually block a verbose dev server, and this process is not going to stay around
 * to drain it.
 *
 * That log file is the whole runtime-observation story. ForgeaX runs its engine
 * locally, so vite transform errors, build failures and server logs are just this
 * process's stderr — there is nothing to poll and no watcher process to supervise.
 */
export function startStack(launcher: StackLauncher, logFd: number): { pid?: number } {
  const child = spawn(launcher.command, [...launcher.args], {
    cwd: launcher.cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: launcher.env ?? runtimeEnvironment(),
  });
  child.unref();
  return { pid: child.pid };
}
