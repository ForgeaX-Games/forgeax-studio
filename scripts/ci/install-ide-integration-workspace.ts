#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runIdeWorkspaceInstall } from '../lib/ide-install-diagnostics.ts';
import {
  createIdeIntegrationRootManifest,
  ensureIdeIntegrationPackageLinks,
  writeIdeIntegrationWorkspaceManifest,
} from '../lib/ide-integration-workspace.ts';

const root = resolve(import.meta.dir, '../..');
async function install(cwd: string): Promise<number> {
  return (await runIdeWorkspaceInstall({
    root,
    args: ['install', '--ignore-scripts'],
    cwd,
    env: process.env,
  })).status ?? 1;
}

if (process.platform === 'win32') {
  // Bun cannot currently link workspace members located above the workspace
  // root on Windows (oven-sh/bun#23960). This checkout is disposable CI state,
  // so install the same graph from the Studio root and restore its manifest.
  const manifestPath = join(root, 'package.json');
  const originalManifest = readFileSync(manifestPath, 'utf8');
  try {
    const manifest = createIdeIntegrationRootManifest(JSON.parse(originalManifest));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const status = await install(root);
    if (status === 0) ensureIdeIntegrationPackageLinks(root);
    process.exitCode = status;
  } finally {
    writeFileSync(manifestPath, originalManifest);
  }
} else {
  const workspaceDir = join(root, '.forgeax/ide-source-workspace');
  writeIdeIntegrationWorkspaceManifest(workspaceDir);
  const status = await install(workspaceDir);
  if (status === 0) ensureIdeIntegrationPackageLinks(root);
  process.exitCode = status;
}
