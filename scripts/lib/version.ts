// scripts/lib/version.ts — forgeax-studio version helper (library + CLI).
//
// Version scheme: v0.M.D.N — 0 pre-1.0 epoch · M.D = latest commit month.day ·
// N = cumulative main commit count (monotone). Replaces version.sh; run.ts and
// build-desktop.ts import the functions, `bun scripts/version.ts <cmd>` is the CLI.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface VersionInfo {
  version: string;
  sha: string;
  date: string;
  totalCommits: number;
  branch: string;
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return '';
  }
}

/** Derive the full version info from git (or .version fallback). */
export function versionInfo(root: string): VersionInfo {
  const inGit = git(root, ['rev-parse', '--git-dir']) !== '';
  if (!inGit) {
    const vf = join(root, '.version');
    if (existsSync(vf)) return { version: readFileSync(vf, 'utf8').trim(), sha: '?', date: '?', totalCommits: 0, branch: '?' };
    return { version: 'v0.0.0.0-unversioned', sha: '?', date: '?', totalCommits: 0, branch: '?' };
  }
  const sha = git(root, ['log', '-1', '--pretty=format:%h', 'HEAD']);
  const date = git(root, ['log', '-1', '--pretty=format:%ad', '--date=short', 'HEAD']);
  // strip leading zeros from month/day (Git-for-Windows lacks strftime "-" no-pad)
  const md = git(root, ['log', '-1', '--pretty=format:%ad', '--date=format:%m.%d', 'HEAD']).replace(/(^|\.)0/g, '$1');
  const n = Number.parseInt(git(root, ['rev-list', '--count', 'HEAD']) || '0', 10);
  let branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') branch = sha;
  const dirty = isDirty(root) ? '+dirty' : '';
  return { version: `v0.${md}.${n}${dirty}`, sha, date, totalCommits: n, branch };
}

function isDirty(root: string): boolean {
  try {
    execFileSync('git', ['-C', root, 'diff', '--quiet'], { windowsHide: true });
    execFileSync('git', ['-C', root, 'diff', '--cached', '--quiet'], { windowsHide: true });
    return false;
  } catch {
    return true;
  }
}

export function versionString(root: string): string {
  return versionInfo(root).version;
}

/** Compact 3-line startup banner (run.ts / server boot). */
export function vanityBanner(root: string): string {
  const v = versionInfo(root);
  const b = '\x1b[1m';
  const y = '\x1b[33m';
  const m = '\x1b[90m';
  const r = '\x1b[0m';
  return [
    `${b}╔════════════════════════════════════════════════════════════╗${r}`,
    `${b}║${r}  ${y}ForgeaX Studio${r}  ·  ${b}${v.version}${r}`,
    `${b}║${r}  ${m}commit ${v.sha} · ${v.date} · branch ${v.branch}${r}`,
    `${b}║${r}  ${m}CHANGELOG: ${join(root, 'CHANGELOG.md')}${r}`,
    `${b}╚════════════════════════════════════════════════════════════╝${r}`,
  ].join('\n');
}

/** Warn (never fail) if CHANGELOG.md top version trails git by >3 commits. */
export function versionCheck(root: string): void {
  const changelog = join(root, 'CHANGELOG.md');
  if (!existsSync(changelog)) {
    console.error(`warn: CHANGELOG.md not found at ${changelog}`);
    return;
  }
  const v = versionInfo(root);
  const top = readFileSync(changelog, 'utf8').match(/^## (v0\.\d+\.\d+\.\d+)/m)?.[1];
  if (!top) {
    console.error('warn: no version section found in CHANGELOG.md');
    return;
  }
  const bare = v.version.replace(/\+dirty$/, '');
  if (top === bare) {
    console.log(`✓ CHANGELOG synced (${top})`);
    return;
  }
  const diff = v.totalCommits - Number.parseInt(top.split('.').pop() ?? '0', 10);
  if (diff <= 3) {
    console.log(`✓ CHANGELOG within 3 commits (${top} vs ${bare})`);
    return;
  }
  console.error(`⚠  CHANGELOG ${top} is ${diff} commits behind ${bare}.`);
  console.error('   Consider adding entries — see CHANGELOG.md rules.');
}

/** Write version JSON to `out` (creating parent dirs). */
export function writeVersionJson(root: string, out: string): void {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(versionInfo(root), null, 2)}\n`);
}

// ── CLI ───────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const { dirname: d, resolve: res } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = res(d(fileURLToPath(import.meta.url)), '..', '..');
  const cmd = process.argv[2] ?? 'print';
  switch (cmd) {
    case 'print':
    case '':
      console.log(versionString(ROOT));
      break;
    case 'json':
      console.log(JSON.stringify(versionInfo(ROOT), null, 2));
      break;
    case 'banner':
      console.log(vanityBanner(ROOT));
      break;
    case 'check':
      versionCheck(ROOT);
      break;
    case 'write': {
      const out = process.argv[3];
      if (!out) {
        console.error('usage: bun scripts/version.ts write <path-to-version.json>');
        process.exit(2);
      }
      writeVersionJson(ROOT, out);
      console.log(`wrote ${out} (${versionString(ROOT)})`);
      break;
    }
    default:
      console.error(`unknown subcommand: ${cmd}`);
      process.exit(2);
  }
}
