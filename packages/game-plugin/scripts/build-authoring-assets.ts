#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function runtimeCommonSdkRoot(root: string): string {
  const explicit = process.env.FORGEAX_ENGINE_SDK?.trim();
  if (explicit) return resolve(explicit);
  const require = createRequire(resolve(root, 'package.json'));
  const commonRoot = resolve(dirname(require.resolve('@forgeax/game-runtime-common')), '..');
  return resolve(commonRoot, 'assets', 'engine-sdk');
}

function skillDescription(text: string): string {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const raw = /description:\s*(>-?|\|-?)?\r?\n?([\s\S]*?)(?=\r?\n[a-zA-Z_-]+:|$)/.exec(block)?.[2] ?? '';
  const summary = raw.replace(/\s+/g, ' ').trim();
  return /^(.*?[.。])\s/.exec(summary)?.[1] ?? summary;
}

export async function prepareAuthoringAssets(root: string): Promise<{
  readonly engineSdk: string;
  readonly skillIds: readonly string[];
}> {
  const assets = resolve(root, 'assets');
  const pluginSkill = resolve(assets, 'skills', 'forgeax-game');
  await rm(resolve(assets, 'skills'), { recursive: true, force: true });
  await mkdir(resolve(assets, 'skills'), { recursive: true });
  await cp(resolve(root, 'skills', 'forgeax-game'), pluginSkill, { recursive: true });

  // An older release may have staged an independent SDK here. Remove it before every
  // build so `files: ["assets"]` can never publish stale duplicate bytes.
  await rm(resolve(assets, 'engine-sdk'), { recursive: true, force: true });

  const engineSdk = runtimeCommonSdkRoot(root);
  const skillsRoot = resolve(engineSdk, 'skills');
  if (!existsSync(skillsRoot)) throw new Error(`Runtime Common Engine skills are missing: ${skillsRoot}`);
  const skillIds = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) =>
      entry.isDirectory()
      && entry.name.startsWith('forgeax-engine-')
      && existsSync(resolve(skillsRoot, entry.name, 'SKILL.md'))
    )
    .map((entry) => entry.name)
    .sort();
  if (skillIds.length === 0) throw new Error(`Runtime Common carries no Engine authoring skills: ${skillsRoot}`);

  const rows = await Promise.all(skillIds.map(async (id) => {
    const text = await readFile(resolve(skillsRoot, id, 'SKILL.md'), 'utf8');
    return `| \`${id}\` | ${skillDescription(text).slice(0, 180) || '(no description)'} |`;
  }));
  const doc = `# Engine skills available in this build

Derived at build time from the ${skillIds.length} skills shipped by the exact
\`@forgeax/game-runtime-common\` dependency. **Invoke only ids listed here.** Skill ids
do not always match the package name you are importing — the rendering pipeline skill
is \`forgeax-engine-render-pipeline\`, not \`forgeax-engine-render\`, and material
authoring lives in \`forgeax-engine-material\`. Guessing an id fails the lookup and
silently costs you the guidance.

| Skill id | Covers |
|:--|:--|
${rows.join('\n')}
`;
  const references = resolve(pluginSkill, 'references');
  await mkdir(references, { recursive: true });
  await writeFile(resolve(references, 'engine-skills.md'), doc, 'utf8');
  return { engineSdk, skillIds };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await prepareAuthoringAssets(root);
  console.log(`Engine skill index: ${result.skillIds.length} skills from Runtime Common`);
}
