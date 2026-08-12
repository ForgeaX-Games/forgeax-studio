#!/usr/bin/env bun
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = import.meta.dir;
const dist = resolve(root, 'dist');
const assets = resolve(root, 'assets');
const runtimeArtifact = process.env.FORGEAX_RUNTIME_ARTIFACT?.trim();
const runtimeManifest = process.env.FORGEAX_RUNTIME_MANIFEST?.trim();
const engineSdk = process.env.FORGEAX_ENGINE_SDK?.trim();

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
// Keep a previously generated release manifest when `npm pack` invokes the
// prepack build without repeating the environment variable. Skill assets are
// rebuilt below; only those generated files are removed.
await rm(resolve(assets, 'skills'), { recursive: true, force: true });
await mkdir(resolve(assets, 'skills'), { recursive: true });
await cp(resolve(root, 'skills', 'forgeax-game'), resolve(assets, 'skills', 'forgeax-game'), {
  recursive: true,
});

if (runtimeArtifact) {
  const artifactName = runtimeArtifact.split(/[\\/]/).pop();
  if (!artifactName) throw new Error(`invalid runtime artifact path: ${runtimeArtifact}`);
  await rm(resolve(assets, 'runtime'), { recursive: true, force: true });
  await mkdir(resolve(assets, 'runtime', 'darwin-arm64'), { recursive: true });
  await cp(resolve(runtimeArtifact), resolve(assets, 'runtime', 'darwin-arm64', artifactName), {
    recursive: true,
  });
}
if (runtimeManifest) await cp(resolve(runtimeManifest), resolve(assets, 'runtime-manifest.json'));
if (engineSdk) {
  await rm(resolve(assets, 'engine-sdk'), { recursive: true, force: true });
  await cp(resolve(engineSdk), resolve(assets, 'engine-sdk'), {
    recursive: true,
  });
}

/**
 * Generate the Engine skill index the game skill points at.
 *
 * A model that wants rendering help reasons from the package name it is importing
 * (`@forgeax/engine-render`) and invokes a skill by that id — which does not exist, so
 * the lookup fails and the guidance is silently lost. Observed in acceptance with a real
 * host. The fix is to state what exists rather than let it be guessed, and to derive
 * that list from the shipped skills so it cannot drift from them.
 */
const skillsRoot = [resolve(assets, 'engine-sdk', 'skills'), engineSdk && resolve(engineSdk, 'skills')]
  .filter(Boolean)
  .find((candidate) => existsSync(candidate));

if (skillsRoot) {
  const ids = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && existsSync(resolve(skillsRoot, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();

  const rows = await Promise.all(ids.map(async (id) => {
    const text = await readFile(resolve(skillsRoot, id, 'SKILL.md'), 'utf8');
    // Frontmatter `description:` may be a folded block, so join its continuation lines.
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    const raw = /description:\s*(>-?|\|-?)?\r?\n?([\s\S]*?)(?=\r?\n[a-zA-Z_-]+:|$)/.exec(block)?.[2] ?? '';
    const summary = raw.replace(/\s+/g, ' ').trim();
    const firstSentence = /^(.*?[.。])\s/.exec(summary)?.[1] ?? summary;
    return `| \`${id}\` | ${firstSentence.slice(0, 180) || '(no description)'} |`;
  }));

  const doc = `# Engine skills available in this build

Derived at build time from the ${ids.length} skills this plugin ships. **Invoke only ids
listed here.** Skill ids do not always match the package name you are importing — the
rendering pipeline skill is \`forgeax-engine-render-pipeline\`, not
\`forgeax-engine-render\`, and material authoring lives in \`forgeax-engine-material\`.
Guessing an id fails the lookup and silently costs you the guidance.

| Skill id | Covers |
|:--|:--|
${rows.join('\n')}
`;
  const references = resolve(assets, 'skills', 'forgeax-game', 'references');
  await mkdir(references, { recursive: true });
  await writeFile(resolve(references, 'engine-skills.md'), doc, 'utf8');
  console.log(`Engine skill index: ${ids.length} skills`);
}

const result = await Bun.build({
  entrypoints: [resolve(root, 'src/main.ts')],
  outdir: dist,
  naming: 'main.js',
  target: 'node',
  format: 'esm',
  sourcemap: 'external',
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await chmod(resolve(dist, 'main.js'), 0o755);
console.log('Built dist/main.js');
