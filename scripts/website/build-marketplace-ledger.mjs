#!/usr/bin/env node
// Generate the public Marketplace identity snapshot from the Marketplace ledger.
// Product repositories consume extension implementations from npm; Marketplace
// owns discovery metadata and must not be treated as an implementation checkout.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CATALOG = process.env.MARKETPLACE_CATALOG
  ? resolve(process.env.MARKETPLACE_CATALOG)
  : join(ROOT, 'packages', 'marketplace', 'catalog', 'extension-identities.json');

const KIND_LABEL = {
  authoring: { zh: '创作扩展', en: 'Authoring extension' },
  agent: { zh: 'Agent', en: 'Agent' },
  skill: { zh: '技能', en: 'Skill' },
  tool: { zh: '工具', en: 'Tool' },
  'cli-provider': { zh: 'CLI 后端', en: 'CLI backend' },
  'model-binding': { zh: '模型绑定', en: 'Model binding' },
};

function kindFor(directory) {
  if (directory.startsWith('agent-')) return 'agent';
  if (directory.startsWith('cli-')) return 'cli-provider';
  if (directory.startsWith('model-')) return 'model-binding';
  if (directory.startsWith('skill-')) return 'skill';
  if (directory.startsWith('tool-')) return 'tool';
  return 'authoring';
}

function repositoryUrl(entry) {
  if (entry.sourceVisibility !== 'public' || !entry.repository) return null;
  return `https://github.com/${entry.owner || 'ForgeaX-Games'}/${entry.repository}`;
}

const ledger = JSON.parse(readFileSync(CATALOG, 'utf8'));
const entries = Array.isArray(ledger.extensions) ? ledger.extensions : [];
const output = {};

for (const entry of entries) {
  if (!entry || entry.disposition === 'excluded' || !entry.directory) continue;
  const kind = kindFor(entry.directory);
  output[entry.directory] = {
    slug: entry.directory,
    id: entry.canonicalIdentity || entry.package || entry.manifestId,
    package: entry.package,
    version: entry.version,
    kind,
    kindLabel: KIND_LABEL[kind],
    repository: entry.repository,
    repoUrl: repositoryUrl(entry),
    sourcePath: entry.sourcePath,
    sourceVisibility: entry.sourceVisibility,
    npmVisibility: entry.npmVisibility,
    hostCompatibility: entry.hostCompatibility,
  };
}

const ordered = Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
const destination = process.env.MARKETPLACE_DATA_OUT
  ? resolve(process.env.MARKETPLACE_DATA_OUT)
  : join(HERE, 'marketplace.data.json');
writeFileSync(destination, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
console.log(`wrote ${destination} — ${Object.keys(ordered).length} extensions`);
