/**
 * Gather everything an agent needs to decide what to do next.
 *
 * Status is strictly read-only. Checking state must never dirty the workspace — an
 * agent that reads status at the top of every conversation would otherwise produce a
 * stream of spurious diffs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeGame, listGames, resolveProject, type ProjectBinding } from '../project/locate';
import {
  assertEngineProjectRoot,
  assertServerProjectRoot,
  probeServices,
  type Capabilities,
} from '../services/probe';
import { inspectBlock, type BlockState } from '../agents-md/managed-block';
import {
  bundledEngineSkillCount,
  DEVKIT_VERSION,
  hasDevKit,
  installedEngineSkills,
} from '../devkit/install';
import { ROUTING_TEXT } from '../routing';
import {
  runtimeLogIsLive,
  runtimeLogPaths,
  readWatcherState,
  type WatcherState,
} from '../run/log-paths';
import { resolveInstalledRuntime } from '../runtime/manager';

export interface StatusSnapshot {
  readonly project: ProjectBinding;
  readonly activeGame?: string;
  readonly games: readonly string[];
  readonly capabilities: Capabilities;
  readonly agentsBlock: BlockState;
  readonly devKit: {
    readonly installed: boolean;
    readonly version: number;
    /** Engine authoring skills present in the project. */
    readonly engineSkills: number;
    /** Engine authoring skills this build can install, for drift detection. */
    readonly bundledEngineSkills: number;
  };
  readonly runtime: {
    readonly installed: boolean;
    readonly version?: string;
    readonly root?: string;
  };
  readonly engineSdk: {
    readonly installed: boolean;
    readonly commit?: string;
    /** Absolute path to bundled Engine source, when this build carries it. */
    readonly sourceRoot?: string;
  };
  /** Present only when a run has produced logs in this project. */
  readonly runtimeLogs?: {
    readonly localFile: string;
    readonly live: boolean;
    readonly state?: WatcherState;
  };
  /** The single most useful thing to do next, derived from everything above. */
  readonly nextAction: string;
}

/** Candidate project doc filenames, highest precedence first. */
const AGENTS_DOC_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const;

function readAgentsDoc(root: string): string | undefined {
  for (const name of AGENTS_DOC_CANDIDATES) {
    try {
      return readFileSync(join(root, name), 'utf8');
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

/**
 * Pick the one next step worth surfacing.
 *
 * Ordered by what blocks the most: no project at all, then no game to work on, then
 * stale routing rules, then services that need starting. Returning a single action
 * rather than a checklist keeps the model from trying to satisfy all of them at once.
 */
function deriveNextAction(s: Omit<StatusSnapshot, 'nextAction'>): string {
  if (!s.project.root) {
    return 'No ForgeaX instance found from this directory. Run `forgeax-game init --game <slug>` here; the plugin creates the project and extracts the bundled ForgeaX Runtime on first run.';
  }
  if (s.games.length === 0) {
    return 'Project has no games yet. Run `forgeax-game init --game <slug>` to scaffold one.';
  }
  if (!s.activeGame) {
    return `No active game selected. Run \`forgeax-game use <slug>\` (available: ${s.games.join(', ')}).`;
  }
  if (!s.devKit.installed) {
    return 'Game development skill is not installed. Run `forgeax-game devkit install`, then start a new session so the host discovers it.';
  }
  if (s.devKit.engineSkills < s.devKit.bundledEngineSkills) {
    return `Engine authoring skills are incomplete (${s.devKit.engineSkills} of ${s.devKit.bundledEngineSkills} installed). Run \`forgeax-game devkit install\`, then start a new session so the host discovers them; without them the model has no authority for how this Engine is meant to be used.`;
  }
  if (!s.engineSdk.installed) {
    return 'Bundled Engine SDK is not installed. Run `forgeax-game init` or `forgeax-game upgrade` to materialize the version-matched Engine types and examples.';
  }
  if (s.agentsBlock.status === 'missing_file' || s.agentsBlock.status === 'missing_block') {
    return 'Project routing rules are not installed in AGENTS.md. Run `forgeax-game agents update`, then start a new session so the client re-reads the file.';
  }
  if (s.agentsBlock.status === 'outdated') {
    return 'Project routing rules in AGENTS.md are stale. Run `forgeax-game agents update`, then start a new session so the client re-reads the file.';
  }
  if (!s.runtime.installed) {
    return 'Managed ForgeaX Runtime is not installed. Call `forgeax_run_current_game`; it will verify, cache, and start the bundled Runtime from the plugin manifest.';
  }
  if (s.capabilities.tier !== 'runtime') {
    return `Ready to edit \`.forgeax/games/${s.activeGame}/\`. To run or preview the game, call \`forgeax_run_current_game\` — it will start the services that are down.`;
  }
  return `Everything is up. Edit \`.forgeax/games/${s.activeGame}/\` and call \`forgeax_run_current_game\` to reload and preview.`;
}

export async function collectStatus(explicitDir?: string): Promise<StatusSnapshot> {
  const project = resolveProject(explicitDir);
  let capabilities = await probeServices();
  const installedRuntime = resolveInstalledRuntime();
  const runtime = installedRuntime
    ? { installed: true, version: installedRuntime.version, root: installedRuntime.root }
    : { installed: false };
  const engineSdk = project.root
    ? (() => {
      try {
        const value = JSON.parse(readFileSync(join(project.root, '.forgeax', 'engine-sdk.json'), 'utf8')) as {
          engineCommit?: unknown;
          sourceRoot?: unknown;
        };
        return {
          installed: true,
          ...(typeof value.engineCommit === 'string' ? { commit: value.engineCommit } : {}),
          ...(typeof value.sourceRoot === 'string' ? { sourceRoot: value.sourceRoot } : {}),
        };
      } catch {
        return { installed: false };
      }
    })()
    : { installed: false };

  if (project.root && capabilities.services.some((service) => service.name === 'server' && service.reachable)) {
    try {
      await assertServerProjectRoot(project.root);
      if (capabilities.tier === 'runtime') await assertEngineProjectRoot(project.root);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      capabilities = {
        tier: 'local',
        services: capabilities.services.map((service) => ({
          ...service,
          reachable: false,
          reason,
        })),
      };
    }
  }

  if (!project.root) {
    const base = {
      project,
      games: [] as string[],
      capabilities,
      agentsBlock: inspectBlock(undefined, ROUTING_TEXT),
      devKit: {
        installed: false,
        version: DEVKIT_VERSION,
        engineSkills: 0,
        bundledEngineSkills: bundledEngineSkillCount(),
      },
      runtime,
      engineSdk,
    };
    return { ...base, nextAction: deriveNextAction(base) };
  }

  const root = project.root;
  const slug = activeGame(root);
  const logs = runtimeLogPaths(root);
  const watcherState = readWatcherState(root);

  const base = {
    project,
    ...(slug ? { activeGame: slug } : {}),
    games: listGames(root),
    capabilities,
    agentsBlock: inspectBlock(readAgentsDoc(root), ROUTING_TEXT),
    devKit: {
      installed: hasDevKit(root),
      version: DEVKIT_VERSION,
      engineSkills: installedEngineSkills(root).length,
      bundledEngineSkills: bundledEngineSkillCount(),
    },
    runtime,
    engineSdk,
    ...(watcherState
      ? { runtimeLogs: { localFile: logs.logFile, live: runtimeLogIsLive(root), state: watcherState } }
      : {}),
  };
  return { ...base, nextAction: deriveNextAction(base) };
}
