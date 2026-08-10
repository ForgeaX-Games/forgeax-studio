/**
 * Render a status snapshot as text.
 *
 * The audience is a language model, so this is prose-shaped rather than JSON: section
 * headers it can scan, one fact per line, and an explicit next action at the end. Pure
 * function over the snapshot, so the wording is testable without any IO.
 */
import type { StatusSnapshot } from './collect';
import type { BlockStatus } from '../agents-md/managed-block';

const BLOCK_EXPLANATION: Record<BlockStatus, string> = {
  missing_file: 'no AGENTS.md or CLAUDE.md in the project',
  missing_block: 'project doc exists but carries no ForgeaX routing block',
  outdated: 'routing block is present but stale',
  current: 'up to date',
};

const TIER_EXPLANATION = {
  local: 'filesystem only — can inspect the project; cannot build, run, or preview',
  backend: 'server up — can scaffold, edit, and statically verify; cannot run the game',
  runtime: 'server and engine up — the game can run and be previewed',
} as const;

export function renderStatus(s: StatusSnapshot): string {
  const lines: string[] = ['# ForgeaX status', ''];

  lines.push('## Project');
  if (s.project.root) {
    lines.push(`- root: ${s.project.root}`);
    lines.push(`- resolved via: ${s.project.source}`);
    lines.push(`- active game: ${s.activeGame ?? '(none selected)'}`);
    lines.push(`- games (${s.games.length}): ${s.games.length ? s.games.join(', ') : '(none)'}`);
  } else {
    lines.push('- root: (not a ForgeaX project)');
    lines.push(`- searched upward from: ${s.project.searchedFrom}`);
  }
  lines.push('');

  lines.push('## Capability');
  lines.push(`- tier: ${s.capabilities.tier} — ${TIER_EXPLANATION[s.capabilities.tier]}`);
  for (const svc of s.capabilities.services) {
    const detail = svc.reachable ? 'up' : `down (${svc.reason ?? 'unreachable'})`;
    lines.push(`- ${svc.name} ${svc.url}: ${detail}`);
  }
  lines.push('');

  lines.push('## Managed Runtime');
  if (s.runtime.installed) {
    lines.push(`- status: installed (v${s.runtime.version ?? 'unknown'})`);
    if (s.runtime.root) lines.push(`- root: ${s.runtime.root}`);
  } else {
    lines.push('- status: not installed (first run verifies and extracts the bundled Runtime automatically)');
  }
  lines.push('');

  lines.push('## Engine SDK');
  lines.push(
    `- status: ${s.engineSdk.installed ? 'installed' : 'missing'}${s.engineSdk.commit ? ` (Engine commit ${s.engineSdk.commit})` : ''}`,
  );
  lines.push('- development types/examples and Runtime must report the same Engine identity before acceptance');
  lines.push(
    `- Engine authoring skills: ${s.devKit.engineSkills} installed of ${s.devKit.bundledEngineSkills} bundled — read these for how the Engine is meant to be used`,
  );
  if (s.engineSdk.sourceRoot) {
    lines.push(`- Engine source (escalate here only when a skill and the declarations still leave a choice open): ${s.engineSdk.sourceRoot}`);
  }
  lines.push('');

  lines.push('## Project rules');
  lines.push(`- AGENTS.md routing block: ${s.agentsBlock.status} — ${BLOCK_EXPLANATION[s.agentsBlock.status]}`);
  lines.push(`- game development kit: ${s.devKit.installed ? 'installed' : 'missing'} (v${s.devKit.version})`);
  if (s.agentsBlock.foundVersion !== undefined && s.agentsBlock.foundVersion !== s.agentsBlock.expectedVersion) {
    lines.push(`- block version: found v${s.agentsBlock.foundVersion}, expected v${s.agentsBlock.expectedVersion}`);
  }
  lines.push('');

  if (s.runtimeLogs) {
    const st = s.runtimeLogs.state;
    lines.push('## Runtime logs');
    lines.push(`- log file: ${s.runtimeLogs.localFile}`);
    lines.push('- read this file with your own file tool; it is not exposed as an MCP tool');
    if (st?.game) lines.push(`- captured for game: ${st.game}`);
    if (st?.lastSuccessAt) lines.push(`- last write: ${st.lastSuccessAt}`);
    if (st?.stoppedAt) lines.push(`- watcher stopped: ${st.stoppedAt} (${st.stopReason ?? 'no reason recorded'})`);
    else if (st?.pid && s.runtimeLogs.live) lines.push(`- detached stack launcher running: pid ${st.pid}`);
    else if (st?.pid) lines.push(`- detached stack launcher no longer running: pid ${st.pid}; log may be stale`);
    if (st?.consecutiveFailures) lines.push(`- consecutive poll failures: ${st.consecutiveFailures}`);
    if (st?.lastError) lines.push(`- last error: ${st.lastError}`);
    lines.push('');
  }

  lines.push('## Next action');
  lines.push(s.nextAction);

  return `${lines.join('\n')}\n`;
}
