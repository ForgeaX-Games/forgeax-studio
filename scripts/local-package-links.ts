#!/usr/bin/env bun

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeLocalPackageLinks,
  linkLocalPackage,
  readLocalPackageLinkState,
  unlinkLocalPackage,
} from './package-delivery/local-package-links.ts';

const ROOT = resolve(import.meta.dir, '..');

function main(): void {
  const [command, packageName, producerPath] = process.argv.slice(2);
  if (command === 'link') {
    if (!packageName || !producerPath) throw new Error('usage: bun fx link-package <package> <producer-path>');
    const state = linkLocalPackage({ root: ROOT, packageName, producerPath });
    console.log(`linked ${packageName} -> ${state.links[packageName].producerPath} @ ${state.links[packageName].producerRevision}`);
    return;
  }
  if (command === 'unlink') {
    if (!packageName) throw new Error('usage: bun fx unlink-package <package>');
    unlinkLocalPackage({ root: ROOT, packageName });
    console.log(`restored ${packageName} from bun.lock`);
    return;
  }
  if (command === 'status') {
    const state = readLocalPackageLinkState(ROOT);
    for (const name of activeLocalPackageLinks(state)) {
      const link = state.links[name];
      console.log(`${name}\t${link.producerRevision}\t${link.producerPath}`);
    }
    return;
  }
  throw new Error('usage: local-package-links.ts <link|unlink|status> ...');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
