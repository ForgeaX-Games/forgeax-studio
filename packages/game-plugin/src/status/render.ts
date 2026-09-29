import type { BlockStatus } from '../agents-md/managed-block';
import type { StatusSnapshot } from './collect';

const BLOCK_EXPLANATION: Record<BlockStatus, string> = {
  missing_file: 'no AGENTS.md or CLAUDE.md in the project',
  missing_block: 'project doc carries no ForgeaX routing block',
  outdated: 'routing block is stale',
  current: 'up to date',
};

export function renderStatus(s: StatusSnapshot): string {
  const lines: string[] = ['# ForgeaX status', '', '## Project'];
  if (s.project.root) {
    lines.push(`- root: ${s.project.root}`);
    lines.push(`- active game: ${s.activeGame ?? '(none selected)'}`);
    lines.push(`- games (${s.games.length}): ${s.games.join(', ') || '(none)'}`);
  } else {
    lines.push('- root: (not a ForgeaX project or Engine game)');
    lines.push(`- searched upward from: ${s.project.searchedFrom}`);
  }
  lines.push('', '## Engine release');
  if (s.engine.installed) {
    lines.push(`- version: ${s.engine.version}`);
    lines.push(`- commit: ${s.engine.commit}`);
    lines.push(`- CLI: ${s.engine.cliPath}`);
    lines.push('- owner: released @forgeax/engine + @forgeax/engine-devkit (no legacy Runtime or alternate server)');
  } else {
    lines.push(`- status: unavailable${s.engine.error ? ` (${s.engine.error})` : ''}`);
  }
  lines.push('', '## Project rules');
  lines.push(`- AGENTS.md routing block: ${s.agentsBlock.status} — ${BLOCK_EXPLANATION[s.agentsBlock.status]}`);
  lines.push(`- game development kit: ${s.devKit.installed ? 'installed' : 'missing'} (v${s.devKit.version})`);
  lines.push(`- Engine authoring skills: ${s.devKit.engineSkills} installed of ${s.devKit.availableEngineSkills} available from the selected game`);

  if (s.preview) {
    lines.push('', '## Engine Preview');
    lines.push(`- process: ${s.preview.live ? 'live' : 'not live'}`);
    lines.push(`- process identity: ${s.preview.identityMatches ? 'matches recorded start identity' : 'unverified'}`);
    if (s.preview.state) {
      lines.push(`- pid: ${s.preview.state.pid}`);
      lines.push(`- URL: ${s.preview.state.selectedUrl}`);
      lines.push(`- instance: ${s.preview.state.previewInstanceId}`);
      lines.push(`- build digest: ${s.preview.state.buildDigest}`);
    }
    lines.push(`- state: ${s.preview.stateFile}`);
    lines.push(`- stdout: ${s.preview.stdoutLog}`);
    lines.push(`- stderr: ${s.preview.stderrLog}`);
  }
  lines.push('', '## Next action', s.nextAction);
  return `${lines.join('\n')}\n`;
}
