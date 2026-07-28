#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

const repoRoot = resolve(import.meta.dir, '../..');
const configPath = resolve(import.meta.dir, 'tsconfig.json');
const config = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
if (config.error) {
  console.error(ts.formatDiagnosticsWithColorAndContext([config.error], {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => '\n',
  }));
  process.exit(1);
}
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, import.meta.dir, undefined, configPath);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => {
  if (!diagnostic.file) return true;
  const path = relative(repoRoot, diagnostic.file.fileName).replaceAll('\\', '/');
  return path.startsWith('scripts/ai-native/');
});
if (diagnostics.length > 0) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => '\n',
  }));
  process.exit(1);
}
process.stdout.write(`[typecheck:ai-native] PASS files=${parsed.fileNames.length}\n`);
