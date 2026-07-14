#!/usr/bin/env node
// build-marketplace.mjs — generate marketplace.data.json for the website's
// Marketplace page (clickable cards → info modal).
//
// Source of truth: each plugin's packages/marketplace/extensions/<dir>/forgeax-extension.json.
// Creation/update dates are derived from the marketplace repo's git history (the
// manifests carry no date). The output is keyed by plugin DIR and consumed inline by
// forgeax-website/marketplace/index.html (cards reference it via data-slug=<dir>).
//
// Run:  node scripts/website/build-marketplace.mjs
// Out:  scripts/website/marketplace.data.json
//
// NOTE: the public OSS repo for plugins is ForgeaX-Games/forgeax-marketplace; each
// plugin's source lives at /tree/main/extensions/<dir>. wb-gen3d is excluded from the
// OSS release, so it gets repoUrl=null (the modal shows a "not open-sourced" note).

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');                       // forgeax-studio
const MKT = join(ROOT, 'packages', 'marketplace');
const PLUGINS = join(MKT, 'extensions');
const OSS_BASE = 'https://github.com/ForgeaX-Games/forgeax-marketplace/tree/main/extensions';
const OSS_EXCLUDED = new Set(['wb-gen3d']);                // not in the public release

const createdDate = (dir) => {
  // oldest commit that added files under this dir
  try {
    const out = execFileSync('git', ['-C', MKT, 'log', '--diff-filter=A', '--format=%cs', '--', `plugins/${dir}`], { encoding: 'utf8' }).trim();
    const lines = out.split('\n').filter(Boolean);
    return lines.length ? lines[lines.length - 1] : '';
  } catch { return ''; }
};
const updatedDate = (dir) => {
  try {
    return execFileSync('git', ['-C', MKT, 'log', '-1', '--format=%cs', '--', `plugins/${dir}`], { encoding: 'utf8' }).trim();
  } catch { return ''; }
};

const KIND_LABEL = {
  workbench: { zh: '工作台', en: 'Workbench' },
  agent: { zh: 'Agent', en: 'Agent' },
  skill: { zh: '技能', en: 'Skill' },
  tool: { zh: '工具', en: 'Tool' },
  'cli-provider': { zh: 'CLI 后端', en: 'CLI backend' },
  'model-binding': { zh: '模型绑定', en: 'Model binding' },
};

const out = {};
const dirs = readdirSync(PLUGINS, { withFileTypes: true })
  // include symlinked plugin dirs too (some plugins are symlinks/submodules → type symlink)
  .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && d.name !== '_template')
  .map((d) => d.name)
  .filter((name) => existsSync(join(PLUGINS, name, 'forgeax-extension.json')))
  .sort();

for (const dir of dirs) {
  const mf = join(PLUGINS, dir, 'forgeax-extension.json');
  if (!existsSync(mf)) continue;
  let j;
  try { j = JSON.parse(readFileSync(mf, 'utf8')); } catch { continue; }
  if (j.hidden) continue;

  const provides = j.provides || {};
  const tools = Array.isArray(provides.tools) ? provides.tools : [];
  const skills = Array.isArray(provides.skills) ? provides.skills : [];
  const wb = provides.workbench || null;

  out[dir] = {
    slug: dir,
    id: j.id || `@forgeax-plugin/${dir}`,
    version: j.version || '0.0.0',
    kind: j.kind || 'plugin',
    kindLabel: KIND_LABEL[j.kind] || { zh: j.kind || '插件', en: j.kind || 'plugin' },
    experimental: !!j.experimental,
    name: {
      zh: (j.displayName && (j.displayName.zh || j.displayName.en)) || dir,
      en: (j.displayName && (j.displayName.en || j.displayName.zh)) || dir,
    },
    desc: {
      zh: (j.description && (j.description.zh || j.description.en)) || '',
      en: (j.description && (j.description.en || j.description.zh)) || '',
    },
    author: (j.author && (j.author.name || j.author)) || 'ForgeaX',
    keywords: Array.isArray(j.keywords) ? j.keywords.slice(0, 10) : [],
    caps: {
      workbench: wb ? (wb.id || true) : null,
      lens: wb && wb.lens ? wb.lens : null,
      skills: skills.length,
      skillTriggers: skills.map((s) => s && s.trigger).filter(Boolean).slice(0, 4),
      tools: tools.length,
      toolSample: tools.map((t) => t && t.id).filter(Boolean).slice(0, 6),
    },
    created: createdDate(dir),
    updated: updatedDate(dir),
    repoUrl: OSS_EXCLUDED.has(dir) ? null : `${OSS_BASE}/${dir}`,
  };
}

const dest = join(HERE, 'marketplace.data.json');
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`wrote ${dest} — ${Object.keys(out).length} plugins`);
// quick sanity: list the dirs the website page references
const REFERENCED = [
  'agent-arin', 'agent-reia', 'agent-iori', 'agent-suzu', 'agent-kotone', 'agent-iro', 'agent-cc-coder', 'agent-tsumugi', 'agent-yevi',
  'wb-character', 'wb-anim', 'wb-skill', 'wb-lowpoly-obj', 'wb-3d-lowpoly', 'wb-gen3d', 'wb-2d-scene-asset-generator',
  'wb-scene-generator', 'wb-ui', 'wb-items', 'wb-look', 'wb-bgm', 'wb-narrative', 'wb-reel', 'wb-balance', 'wb-code',
  'wb-observatory', 'wb-agent-persona', 'wb-plugin-author', 'admin',
  'cli-claude-code', 'cli-codex', 'cli-cursor-agent', 'cli-forgeax',
  'skill-author-plugin', 'skill-make-game-design', 'tool-balance-resim', 'model-anthropic-text',
];
const missing = REFERENCED.filter((d) => !out[d]);
if (missing.length) console.warn('WARN — referenced by page but missing manifest:', missing.join(', '));
else console.log('all 36 page-referenced plugins present');
