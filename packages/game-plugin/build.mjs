#!/usr/bin/env bun
import { chmod, copyFile, cp, mkdir, rm, readdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = import.meta.dir;
const dist = resolve(root, 'dist');
const assets = resolve(root, 'assets');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await rm(assets, { recursive: true, force: true });
await mkdir(resolve(assets, 'skills'), { recursive: true });
await cp(resolve(root, 'skills', 'forgeax-game'), resolve(assets, 'skills', 'forgeax-game'), {
  recursive: true,
});
for (const id of await readdir(resolve(root, 'extensions'))) {
  const source = resolve(root, 'extensions', id);
  const manifest = JSON.parse(await readFile(resolve(source, 'extension.json'), 'utf8'));
  if (manifest.id !== id || manifest.schemaVersion !== 1 || !/^cli\.mjs$/.test(manifest.cli)) throw new Error('invalid extension: ' + id);
  const target = resolve(assets, 'extensions', id);
  await mkdir(target, { recursive: true });
  await copyFile(resolve(source, 'extension.json'), resolve(target, 'extension.json'));
  for (const skill of manifest.skills) {
    if (!/^skills\/[a-z][a-z0-9-]*$/.test(skill)) throw new Error('invalid skill path');
    await mkdir(resolve(target, skill), { recursive: true });
    await copyFile(resolve(source, skill, 'SKILL.md'), resolve(target, skill, 'SKILL.md'));
  }
  let entry = resolve(source, manifest.cli);
  try { await access(entry); } catch { entry = entry.replace(/\.mjs$/, '.ts'); }
  const compiled = await Bun.build({ entrypoints: [entry], outdir: target, naming: 'cli.mjs', target: 'node', format: 'esm' });
  if (!compiled.success) throw new Error(compiled.logs.join('\n'));
}

await mkdir(resolve(assets, 'licenses'), { recursive: true });
await copyFile(resolve(root, 'node_modules/fflate/LICENSE'), resolve(assets, 'licenses/fflate.txt'));

const result = await Bun.build({
  entrypoints: [resolve(root, 'src/main.ts')],
  outdir: dist,
  naming: 'main.js',
  target: 'node',
  format: 'esm',
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await chmod(resolve(dist, 'main.js'), 0o755);
console.log('Built dist/main.js');
