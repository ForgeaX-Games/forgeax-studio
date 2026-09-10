import { spawnSync } from 'node:child_process';

let cachedForceLocalSupport: boolean | undefined;

function supportsForceLocal(tarHelp?: string): boolean {
  if (tarHelp !== undefined) return tarHelp.includes('--force-local');
  if (cachedForceLocalSupport !== undefined) return cachedForceLocalSupport;
  const result = spawnSync('tar', ['--help'], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  cachedForceLocalSupport = output.includes('--force-local');
  return cachedForceLocalSupport;
}

function toGitTarPath(value: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  if (!match) return value;
  return `/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

export function runtimeTarArgs(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  tarHelp?: string,
): string[] {
  if (platform !== 'win32' || !supportsForceLocal(tarHelp)) return [...args];
  return ['--force-local', ...args.map(toGitTarPath)];
}
