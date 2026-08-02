import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageRoot = join(import.meta.dir, '..');
const sandbox = mkdtempSync(join(tmpdir(), 'forgeax-npc-client-pack-'));

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: sandbox,
      USERPROFILE: sandbox,
      XDG_CACHE_HOME: join(sandbox, 'cache'),
      NPM_CONFIG_CACHE: join(sandbox, 'npm-cache'),
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

try {
  run('bun', ['run', 'build'], packageRoot);
  const packOutput = run('npm', ['pack', '--json', '--pack-destination', sandbox], packageRoot);
  const [{ filename }] = JSON.parse(packOutput) as Array<{ filename: string }>;
  const tarball = join(sandbox, filename);
  const consumer = join(sandbox, 'consumer');
  run('mkdir', ['-p', consumer], sandbox);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', tarball], consumer);
  writeFileSync(
    join(consumer, 'smoke.mjs'),
    [
      "import { NPC_PROTOCOL_VERSION, NpcClient } from '@forgeax/npc-client';",
      "if (NPC_PROTOCOL_VERSION !== 1 || typeof NpcClient !== 'function') process.exit(1);",
      "const client = new NpcClient({ game: 'smoke', npcIds: ['guide'] });",
      "if (client.lod('guide') !== 'spotlight') process.exit(1);",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(consumer, 'smoke.ts'),
    [
      "import { NpcClient, type PerceptionSnapshot } from '@forgeax/npc-client';",
      "const client: NpcClient = new NpcClient({ game: 'smoke', npcIds: ['guide'] });",
      "const snapshot: PerceptionSnapshot = { v: 1, eventId: 'e', game: 'smoke', npcId: 'guide', t: 0, trigger: 'heartbeat', self: { pos: { x: 0, y: 0 }, activity: 'idle' }, nearby: [], events: [], affordances: [] };",
      "void client.decide(snapshot);",
      '',
    ].join('\n'),
  );
  run(process.execPath, ['smoke.mjs'], consumer);
  const tsc = Bun.which('tsc');
  if (!tsc) throw new Error('tsc is required for the packed declaration smoke');
  run(tsc, ['--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'smoke.ts'], consumer);
  const packed = JSON.parse(readFileSync(join(consumer, 'node_modules/@forgeax/npc-client/package.json'), 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  if (!packed.exports?.['.']) throw new Error('packed package has no root export');
  console.log('[pack-smoke] standalone npm consumer imported @forgeax/npc-client');
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
