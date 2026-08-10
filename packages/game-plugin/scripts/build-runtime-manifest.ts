#!/usr/bin/env bun
/** Create the manifest consumed by the installed plugin. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { resolve } from 'node:path';

const args = new Map<string, string>();
for (let index = 2; index < Bun.argv.length; index += 1) {
  const key = Bun.argv[index];
  if (!key?.startsWith('--')) continue;
  const value = Bun.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
  args.set(key.slice(2), value);
  index += 1;
}
const artifact = args.get('artifact');
const version = args.get('version');
const output = args.get('output');
if (!artifact || !version || !output) {
  throw new Error('usage: bun scripts/build-runtime-manifest.ts --artifact <file> --version <version> --output <manifest> [--source <path-or-https-url>] [--platform <platform>] [--arch <arch>] [--format file|archive] [--command <command>] [--args-json <json>]');
}
const artifactPath = resolve(artifact);
const size = statSync(artifactPath).size;
if (size === 0) throw new Error(`runtime artifact is empty: ${artifactPath}`);
const sha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
const source = args.get('source') ?? artifactPath;
if (/^http:\/\//i.test(source) || (/^https?:\/\//i.test(source) && !/^https:\/\//i.test(source))) {
  throw new Error('runtime manifest source URL must use HTTPS');
}
const manifest = {
  schemaVersion: 1,
  runtimeId: 'forgeax-game-runtime',
  artifacts: [{
    version,
    platform: args.get('platform') ?? platform(),
    arch: args.get('arch') ?? arch(),
    source,
    sha256,
    format: args.get('format') === 'archive' ? 'archive' : 'file',
    ...(args.get('command') ? { command: args.get('command') } : {}),
    ...(args.get('args-json') ? { args: JSON.parse(args.get('args-json')!) as string[] } : {}),
  }],
};
writeFileSync(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Wrote ${resolve(output)} (${size} bytes, sha256 ${sha256})`);
