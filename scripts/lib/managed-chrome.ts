import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ChromeTarget {
  id: string;
  type: string;
  url: string;
}

export type ManagedChromeReuse = 'focused' | 'opened-tab' | 'unavailable';

export function wantsManagedChrome(args: string[]): boolean {
  return args.includes('--managed');
}

/** One product-managed browser across checkouts; override only for isolation. */
export function managedChromeProfile(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.FORGEAX_CHROME_PROFILE ?? join(homedir(), '.forgeax', 'studio-chrome-profile'));
}

export function readDevToolsPort(profile: string): number | null {
  const file = join(profile, 'DevToolsActivePort');
  if (!existsSync(file)) return null;
  const port = Number.parseInt(readFileSync(file, 'utf8').split(/\r?\n/, 1)[0] ?? '', 10);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

export function findPageTarget(targets: ChromeTarget[], requestedUrl: string): ChromeTarget | null {
  const requested = comparableUrl(requestedUrl);
  return targets.find((target) => target.type === 'page' && comparableUrl(target.url) === requested) ?? null;
}

/** Focus the requested page, or add one tab to the existing managed browser. */
export async function reuseManagedChrome(
  profile: string,
  requestedUrl: string,
  request: typeof fetch = fetch,
): Promise<ManagedChromeReuse> {
  const port = readDevToolsPort(profile);
  if (!port) return 'unavailable';
  const endpoint = `http://127.0.0.1:${port}`;

  try {
    const list = await request(`${endpoint}/json/list`, { signal: AbortSignal.timeout(1_000) });
    if (!list.ok) return 'unavailable';
    const targets = await list.json() as ChromeTarget[];
    const existing = findPageTarget(targets, requestedUrl);
    const path = existing
      ? `/json/activate/${encodeURIComponent(existing.id)}`
      : `/json/new?${encodeURIComponent(requestedUrl)}`;
    const response = await request(endpoint + path, { method: 'PUT', signal: AbortSignal.timeout(1_000) });
    return response.ok ? (existing ? 'focused' : 'opened-tab') : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function comparableUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '') || '/'}${url.search}`;
  } catch {
    return value.replace(/\/+$/, '');
  }
}
