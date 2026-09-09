#!/usr/bin/env bun
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { engineSdkRoot } from '@forgeax/game-runtime';

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

const skillsRoot = resolve(engineSdkRoot(), 'skills');
if (existsSync(skillsRoot)) {
  const ids = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && existsSync(resolve(skillsRoot, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
  const rows = await Promise.all(ids.map(async (id) => {
    const text = await readFile(resolve(skillsRoot, id, 'SKILL.md'), 'utf8');
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    const raw = /description:\s*(>-?|\|-?)?\r?\n?([\s\S]*?)(?=\r?\n[a-zA-Z_-]+:|$)/.exec(block)?.[2] ?? '';
    const summary = raw.replace(/\s+/g, ' ').trim();
    const firstSentence = /^(.*?[.。])\s/.exec(summary)?.[1] ?? summary;
    return `| \`${id}\` | ${firstSentence.slice(0, 180) || '(no description)'} |`;
  }));
  const pluginPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const runtimeVersion = pluginPackage.dependencies?.['@forgeax/game-runtime'] ?? 'unknown';
  const reference = `# Engine skills available in Runtime ${runtimeVersion}

Derived from the Engine skills carried by the installed Runtime package. Invoke only
ids listed here; Engine package names and skill ids are not interchangeable.

| Skill id | Covers |
|:--|:--|
${rows.join('\n')}
`;
  const references = resolve(assets, 'skills', 'forgeax-game', 'references');
  await mkdir(references, { recursive: true });
  await writeFile(resolve(references, 'engine-skills.md'), reference, 'utf8');
}

const result = await Bun.build({
  entrypoints: [resolve(root, 'src/main.ts')],
  outdir: dist,
  naming: 'main.js',
  target: 'node',
  format: 'esm',
  external: ['@forgeax/game-runtime'],
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await chmod(resolve(dist, 'main.js'), 0o755);
console.log('Built dist/main.js');
