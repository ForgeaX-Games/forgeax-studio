/** Engine-owned build/Preview adapter behind `forgeax_run_current_game`. */
import { activeGame, gameDir, listGames, resolveProject, SLUG_RE } from '../project/locate';
import { assertGameAuthoringComplete } from '../project/completion';
import { startEnginePreview } from './engine-preview';

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
      description: 'Start Engine Preview when absent. Default true; false performs a read-only availability check.',
    },
  },
  additionalProperties: false,
} as const;

interface RunArgs {
  game?: unknown;
  target_dir?: unknown;
  start_services?: unknown;
}

type SlugResolution = { slug: string; dir: string } | { error: string };

export function resolveSlug(root: string, requested?: string): SlugResolution {
  if (requested !== undefined && !SLUG_RE.test(requested)) {
    return { error: `error: invalid game slug: ${JSON.stringify(requested)}.` };
  }
  const games = listGames(root);
  if (games.length === 0) {
    return { error: 'error: this project has no Engine game. Create one with the released `forgeax new` command.' };
  }
  const slug = requested ?? activeGame(root) ?? (games.length === 1 ? games[0] : undefined);
  if (!slug) {
    return {
      error: `error: no active game selected and this project has ${games.length} games (${games.join(', ')}). Pass \`game\` or run \`forgeax-game use <slug>\`.`,
    };
  }
  const dir = gameDir(root, slug);
  return dir
    ? { slug, dir }
    : { error: `error: game ${JSON.stringify(slug)} not found. Available: ${games.join(', ')}.` };
}

export async function runCurrentGame(rawArgs: Record<string, unknown>, cwd: string): Promise<string> {
  const args = rawArgs as RunArgs;
  const dir = typeof args.target_dir === 'string' ? args.target_dir : cwd;
  const project = resolveProject(dir);
  if (!project.root) {
    throw new Error([
      `error: no released Engine game found searching upward from ${project.searchedFrom}.`,
      'Create an external game with the released Engine SDK.',
    ].join('\n'));
  }
  const slug = resolveSlug(project.root, typeof args.game === 'string' ? args.game : undefined);
  if ('error' in slug) throw new Error(slug.error);
  if (args.start_services === false) {
    return `game: ${slug.slug}\nsource: ${slug.dir}\nnot running check requested; no Engine child was launched.`;
  }

  assertGameAuthoringComplete(slug.dir);
  const result = await startEnginePreview(project.root, slug.dir);
  return [
    `game: ${slug.slug}`,
    `source: ${slug.dir}`,
    'tier: engine-preview',
    'preview.status: ready',
    `preview_url: ${result.selectedUrl}`,
    `engine.version: ${result.identity.engineVersion}`,
    `engine.commit: ${result.identity.engineCommit}`,
    `preview.root: ${result.identity.root}`,
    `preview.instance_id: ${result.identity.previewInstanceId}`,
    `preview.build_digest: ${result.identity.buildDigest}`,
    `preview.pid: ${result.pid}`,
    `preview.reused: ${result.reused}`,
    `preview.state_file: ${result.paths.state}`,
    `preview.stdout_log: ${result.paths.stdout}`,
    `preview.stderr_log: ${result.paths.stderr}`,
    'This tool verifies Engine build and Preview ownership only; gameplay, input, and visible UI have not been tested by this tool.',
    'Open only this returned loopback URL. HTTP availability without this exact verified identity is not Preview evidence.',
  ].join('\n');
}
