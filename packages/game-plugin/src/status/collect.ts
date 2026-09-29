/** Read-only status for the exact Engine release and Engine-owned Preview. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectBlock, type BlockState } from '../agents-md/managed-block';
import {
  bundledEngineSkillCount,
  DEVKIT_VERSION,
  hasDevKit,
  installedEngineSkills,
} from '../devkit/install';
import { resolveEngineRelease } from '../engine/release';
import { activeGame, gameDir, listGames, resolveProject, type ProjectBinding } from '../project/locate';
import { inspectEnginePreview, type PreviewState } from '../run/engine-preview';
import { ROUTING_TEXT } from '../routing';

export interface StatusSnapshot {
  readonly project: ProjectBinding;
  readonly activeGame?: string;
  readonly games: readonly string[];
  readonly agentsBlock: BlockState;
  readonly devKit: {
    readonly installed: boolean;
    readonly version: number;
    readonly engineSkills: number;
    readonly availableEngineSkills: number;
  };
  readonly engine: {
    readonly installed: boolean;
    readonly version?: string;
    readonly commit?: string;
    readonly cliPath?: string;
    readonly error?: string;
  };
  readonly preview?: {
    readonly live: boolean;
    readonly identityMatches: boolean;
    readonly state?: PreviewState;
    readonly stateFile: string;
    readonly stdoutLog: string;
    readonly stderrLog: string;
  };
  readonly nextAction: string;
}

const AGENTS_DOC_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const;

function readAgentsDoc(root: string): string | undefined {
  for (const name of AGENTS_DOC_CANDIDATES) {
    try {
      return readFileSync(join(root, name), 'utf8');
    } catch {
      /* try the next project-owned instruction file */
    }
  }
  return undefined;
}

function deriveNextAction(s: Omit<StatusSnapshot, 'nextAction'>): string {
  if (!s.project.root) return 'Open an external released Engine SDK game, then retry.';
  if (s.games.length === 0) return 'Create a game with the released Engine `forgeax new` command.';
  if (!s.activeGame) return `Select one game with \`forgeax-game use <slug>\` (${s.games.join(', ')}).`;
  if (!s.engine.installed) return `Install the exact released Engine package in the game. ${s.engine.error ?? ''}`.trim();
  if (!s.devKit.installed) return 'Run `forgeax-game devkit install`, then start a new host session.';
  if (s.agentsBlock.status !== 'current') return 'Run `forgeax-game agents update`, then start a new host session.';
  if (s.preview?.live && s.preview.identityMatches) {
    return 'Engine Preview is live. Edit the game and call `forgeax_run_current_game` to rebuild or reuse it.';
  }
  return 'When Preview is needed, call `forgeax_run_current_game` for the bounded Engine build and verified Preview lifecycle. Resolve task prerequisites first; status does not require an empty-template baseline run.';
}

export async function collectStatus(explicitDir?: string): Promise<StatusSnapshot> {
  const project = resolveProject(explicitDir);
  if (!project.root) {
    const base = {
      project,
      games: [] as string[],
      agentsBlock: inspectBlock(undefined, ROUTING_TEXT),
      devKit: { installed: false, version: DEVKIT_VERSION, engineSkills: 0, availableEngineSkills: 0 },
      engine: { installed: false },
    };
    return { ...base, nextAction: deriveNextAction(base) };
  }

  const root = project.root;
  const slug = activeGame(root);
  const selectedGame = slug ? gameDir(root, slug) : undefined;
  let engine: StatusSnapshot['engine'] = { installed: false };
  if (selectedGame) {
    try {
      const release = resolveEngineRelease(selectedGame);
      engine = {
        installed: true,
        version: release.version,
        commit: release.commit,
        cliPath: release.cliPath,
      };
    } catch (error) {
      engine = { installed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const preview = selectedGame
    ? (() => {
        const inspected = inspectEnginePreview(root, selectedGame);
        return {
          live: inspected.processLive,
          identityMatches: inspected.processIdentityMatches,
          ...(inspected.state ? { state: inspected.state } : {}),
          stateFile: inspected.paths.state,
          stdoutLog: inspected.paths.stdout,
          stderrLog: inspected.paths.stderr,
        };
      })()
    : undefined;
  const base = {
    project,
    ...(slug ? { activeGame: slug } : {}),
    games: listGames(root),
    agentsBlock: inspectBlock(readAgentsDoc(root), ROUTING_TEXT),
    devKit: {
      installed: hasDevKit(root),
      version: DEVKIT_VERSION,
      engineSkills: installedEngineSkills(root).length,
      availableEngineSkills: bundledEngineSkillCount(root),
    },
    engine,
    ...(preview ? { preview } : {}),
  };
  return { ...base, nextAction: deriveNextAction(base) };
}
