import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';

type ParserContract = {
  specVersion: number;
  parser: {
    name: string;
    version: string;
    archive: string;
    releaseUrl: string;
    sha256: string;
    ignore: string[];
  };
  sourceSet: {
    directories: string[];
    extensions: string[];
  };
};

const contractPath = fileURLToPath(new URL('./workflow-parser-contract.json', import.meta.url));
const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as ParserContract;

if (
  contract.specVersion !== 1 ||
  !contract.parser?.name ||
  !contract.parser.version ||
  !contract.parser.archive ||
  !contract.parser.releaseUrl ||
  !/^[a-f0-9]{64}$/.test(contract.parser.sha256) ||
  !Array.isArray(contract.parser.ignore) ||
  !Array.isArray(contract.sourceSet?.directories) ||
  contract.sourceSet.directories.length === 0 ||
  !Array.isArray(contract.sourceSet.extensions) ||
  contract.sourceSet.extensions.length === 0
) {
  throw new Error(`Invalid workflow parser contract: ${contractPath}`);
}

export const WORKFLOW_PARSER_CONTRACT = contract;

const SKIP_DIRECTORIES = new Set(['.git', '.forgeax-harness', '.worktrees', 'dist', 'node_modules']);

function visit(directory: string, root: string, output: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(absolute, root, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const path = relative(root, absolute).split('\\').join('/');
    if (
      WORKFLOW_PARSER_CONTRACT.sourceSet.extensions.some((extension) => path.endsWith(extension))
    ) {
      output.push(path);
    }
  }
}

export function discoverWorkflowSourcePaths(root: string): string[] {
  const resolvedRoot = resolve(root);
  const paths: string[] = [];
  for (const directory of WORKFLOW_PARSER_CONTRACT.sourceSet.directories) {
    const absolute = join(resolvedRoot, directory);
    const before = paths.length;
    try {
      if (statSync(absolute).isDirectory()) visit(absolute, resolvedRoot, paths);
    } catch (error) {
      throw new Error(`workflow parser source directory is missing: ${absolute}`, { cause: error });
    }
    if (paths.length === before) {
      throw new Error(`workflow parser source directory is empty: ${absolute}`);
    }
  }
  return [...new Set(paths)].sort();
}

export type WorkflowSource = {
  path: string;
  content: string;
};

export function readWorkflowSources(root: string): WorkflowSource[] {
  const resolvedRoot = resolve(root);
  return discoverWorkflowSourcePaths(resolvedRoot).map((path) => ({
    path,
    content: readFileSync(join(resolvedRoot, path), 'utf8'),
  }));
}
